import {
  actionGeneric,
  anyComponents,
  componentsOf,
  composeApp,
  createEngine,
  defineApp,
  defineSchema,
  defineTable,
  EmberError,
  errorInfo,
  isAppError,
  mutationGeneric,
  queryGeneric,
  v,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, test } from "vitest";
import { assertAllowed, edgeLimit, HOUR, MINUTE, rateLimit, rateLimitErrors, RateLimiter, SECOND, type RateLimitComponentApi, type RateLimitInstallConfig } from "../src/index.ts";
import type { Job } from "@freecorps/ember-server";

const app = defineApp()
  .use(rateLimit)
  .use(rateLimit, { name: "configured", config: { limits: { daily: { kind: "fixed window", rate: 2, period: 24 * 60 * MINUTE } } } });

// Typed references: the helper accepts the installed component's generated API.
const components = componentsOf(app);
const limiter = new RateLimiter(components.rateLimit, {
  send: { kind: "token bucket", rate: 6, period: MINUTE, capacity: 2 },
  global: { kind: "fixed window", rate: 3, period: MINUTE },
});

const schema = defineSchema({ tables: { messages: defineTable({ to: v.string() }) } });

const fns = {
  messages: {
    send: mutationGeneric({
      args: { user: v.string(), fail: v.optional(v.boolean()) },
      handler: (ctx: any, a: { user: string; fail?: boolean }) => {
        const r = limiter.limit(ctx, "send", { key: a.user });
        if (!r.ok) return r;
        ctx.db.insert("messages", { to: a.user });
        if (a.fail) throw new Error("send failed");
        return r;
      },
    }),
    sendOrThrow: mutationGeneric({
      args: { user: v.string() },
      handler: (ctx: any, a: { user: string }) => limiter.limit(ctx, "send", { key: a.user, throws: true }),
    }),
    global: mutationGeneric({ args: {}, handler: (ctx: any) => limiter.limit(ctx, "global") }),
    left: queryGeneric({ args: { user: v.string() }, handler: (ctx: any, a: { user: string }) => limiter.getValue(ctx, "send", { key: a.user }).value }),
    canSend: queryGeneric({ args: { user: v.string() }, handler: (ctx: any, a: { user: string }) => limiter.check(ctx, "send", { key: a.user }) }),
    canSendN: queryGeneric({ args: { n: v.number() }, handler: (ctx: any, a: { n: number }) => limiter.check(ctx, "send", { key: "n", count: a.n }) }),
    reset: mutationGeneric({ args: { user: v.string() }, handler: (ctx: any, a: { user: string }) => limiter.reset(ctx, "send", { key: a.user }) }),
    daily: mutationGeneric({ args: {}, handler: (ctx: any) => ctx.runMutation(anyComponents.configured.lib.limit, { name: "daily", key: "k" }) }),
    unknown: mutationGeneric({ args: {}, handler: (ctx: any) => ctx.runMutation(anyComponents.configured.lib.limit, { name: "nope" }) }),
    rawLimit: mutationGeneric({ args: { config: v.any() }, handler: (ctx: any, a: any) => ctx.runMutation(anyComponents.rateLimit.lib.limit, { name: "raw", config: a.config }) }),
    rawCheck: queryGeneric({ args: { config: v.any() }, handler: (ctx: any, a: any) => ctx.runQuery(anyComponents.rateLimit.lib.check, { name: "raw", config: a.config }) }),
    rawValue: queryGeneric({ args: { config: v.any() }, handler: (ctx: any, a: any) => ctx.runQuery(anyComponents.rateLimit.lib.getValue, { name: "raw", config: a.config }) }),
  },
};

/** `from`: the shard (driver and clock) of an earlier setup, as a redeploy with another install config finds it. */
function setup(installed = app, from?: { driver: ReturnType<typeof createNodeSqliteDriver>; now: () => number }) {
  let now = from?.now() ?? 1_700_000_000_000;
  const composed = composeApp({ schema, functions: fns, app: installed });
  const driver = from?.driver ?? createNodeSqliteDriver();
  // A minimal scheduler: jobs from every mutation, run by `runDue` once due; `get` for the GC's liveness check.
  const jobs = new Map<string, { job: Job; state: "pending" | "inProgress" | "success" | "failed" | "canceled" }>();
  const engine = createEngine({
    schema: composed.schema,
    functions: composed.functions,
    driver,
    now: () => now,
    scheduledFunctions: {
      get: (id) => {
        const e = jobs.get(id);
        return e ? { id, _creationTime: 0, name: e.job.fn, args: e.job.args, scheduledTime: e.job.runAt, state: { kind: e.state } as never, attempts: 0 } : null;
      },
      list: () => [],
    },
  });
  engine.migrate();
  const track = <R extends { scheduled: Job[]; cancelled: string[] }>(r: R): R => {
    for (const j of r.scheduled) jobs.set(j.id, { job: j, state: "pending" });
    for (const id of r.cancelled) {
      const e = jobs.get(id);
      if (e?.state === "pending") e.state = "canceled";
    }
    return r;
  };
  const mutate = (name: string, args: unknown = {}) => track(engine.runMutation(name, args));
  const pending = () => [...jobs.values()].filter((e) => e.state === "pending").map((e) => e.job);
  /** Runs the due jobs (and the ones they schedule that are due), returning what each returned. */
  const runDue = () => {
    const out: unknown[] = [];
    for (let e = pending().filter((j) => j.runAt <= now).sort((a, b) => a.runAt - b.runAt)[0]; e; e = pending().filter((j) => j.runAt <= now).sort((a, b) => a.runAt - b.runAt)[0]) {
      jobs.get(e.id)!.state = "inProgress";
      out.push(mutate(e.fn, e.args).value);
      jobs.get(e.id)!.state = "success";
    }
    return out;
  };
  return {
    engine,
    driver,
    mutate,
    pending,
    runDue,
    now: () => now,
    advance: (ms: number) => (now += ms),
    count: (t: string) => driver.exec(`SELECT COUNT(*) AS n FROM "${t}"`).rows[0]!.n,
  };
}

const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as EmberError;
  }
  throw new Error("expected an error");
};

describe("rateLimit component", () => {
  test("limits per key inside the caller's mutation", () => {
    const { engine, advance } = setup();
    const send = (user: string) => engine.runMutation("messages:send", { user }).value as any;
    expect([send("a"), send("a"), send("a")]).toEqual([{ ok: true }, { ok: true }, { ok: false, retryAfter: 10 * SECOND }]);
    expect(send("b")).toEqual({ ok: true }); // another key, its own bucket
    advance(10 * SECOND);
    expect(send("a")).toEqual({ ok: true });
  });

  test("transactional: when the app mutation fails, the tokens are given back", () => {
    const { engine, count } = setup();
    for (let i = 0; i < 5; i++) expect(() => engine.runMutation("messages:send", { user: "a", fail: true })).toThrow("send failed");
    expect(count("rateLimit$rateLimits")).toBe(0);
    expect(engine.runQuery("messages:left", { user: "a" }).value).toBe(2);
    expect(engine.runMutation("messages:send", { user: "a" }).value).toEqual({ ok: true });
  });

  test("group commit: items of one batch see each other's consumption", () => {
    const { engine } = setup();
    const out = engine.runMutationBatch(Array.from({ length: 4 }, () => ({ name: "messages:send", args: { user: "z" }, ctx: { identity: null } })));
    expect(out.map((o) => o.ok && (o.value as any).ok)).toEqual([true, true, false, false]);
  });

  test("throws: RateLimited with the retry time, nothing written", () => {
    const { engine } = setup();
    engine.runMutation("messages:sendOrThrow", { user: "t" });
    engine.runMutation("messages:sendOrThrow", { user: "t" });
    const e = err(() => engine.runMutation("messages:sendOrThrow", { user: "t" }));
    expect(e.code).toBe("RateLimited");
    expect(e.data).toEqual({ name: "send", retryAfter: 10 * SECOND });
  });

  test("RateLimited is an app error (defineErrors): isError/is narrow it, the wire says kind app and status 429", () => {
    const { engine } = setup();
    engine.runMutation("messages:sendOrThrow", { user: "w" });
    engine.runMutation("messages:sendOrThrow", { user: "w" });
    const e: unknown = err(() => engine.runMutation("messages:sendOrThrow", { user: "w" }));
    expect(isAppError(e)).toBe(true);
    expect(rateLimitErrors.RateLimited.is(e)).toBe(true);
    if (rateLimitErrors.RateLimited.is(e)) expect(e.data.retryAfter).toBe(10 * SECOND); // typed payload
    expect(errorInfo(e)).toEqual({ code: "RateLimited", kind: "app", status: 429, message: "Rate limit send exceeded; retry in 10000 ms", data: { name: "send", retryAfter: 10 * SECOND } });
    // assertAllowed (for results from check / an action) throws the same error.
    const a = err(() => assertAllowed("send", { ok: false, retryAfter: 5 }));
    expect(rateLimitErrors.RateLimited.is(a)).toBe(true);
    expect(a.data).toEqual({ name: "send", retryAfter: 5 });
  });

  test("a global limit (no key) is shared by every caller of the shard", () => {
    const { engine } = setup();
    const r = Array.from({ length: 4 }, () => (engine.runMutation("messages:global").value as any).ok);
    expect(r).toEqual([true, true, true, false]);
  });

  test("check / getValue are reactive reads of the component table; reset refills", () => {
    const { engine } = setup();
    engine.runMutation("messages:send", { user: "r" });
    const q = engine.runQuery("messages:canSend", { user: "r" });
    expect(q.value).toEqual({ ok: true });
    expect(q.readSet.some((e) => e.table === "rateLimit$rateLimits")).toBe(true);
    const w = engine.runMutation("messages:send", { user: "r" });
    expect(engine.matches(q.readSet, w.changes)).toBe(true);
    expect(engine.runQuery("messages:canSend", { user: "r" }).value).toEqual({ ok: false, retryAfter: 10 * SECOND });
    expect(engine.runMutation("messages:reset", { user: "r" }).value).toBe(true);
    expect(engine.runQuery("messages:left", { user: "r" }).value).toBe(2);
  });

  test("check rejects an invalid count with ValidationError, like limit", () => {
    const { engine } = setup();
    for (const n of [-5, 3]) expect(err(() => engine.runQuery("messages:canSendN", { n })).code).toBe("ValidationError");
    expect(engine.runQuery("messages:canSendN", { n: 2 }).value).toEqual({ ok: true });
  });

  test("a call's config is checked once in the component and still refused with ValidationError when invalid", () => {
    const { engine, count } = setup();
    const bad = [
      { kind: "token bucket", rate: 0, period: MINUTE },
      { kind: "token bucket", rate: 1, period: -1 },
      { kind: "fixed window", rate: 1, period: MINUTE, capacity: 0 },
      { kind: "token bucket", rate: 1, period: MINUTE, maxReserved: -1 },
    ];
    for (const config of bad) {
      expect(err(() => engine.runMutation("messages:rawLimit", { config })).code).toBe("ValidationError");
      expect(err(() => engine.runQuery("messages:rawCheck", { config })).code).toBe("ValidationError");
      expect(err(() => engine.runQuery("messages:rawValue", { config })).code).toBe("ValidationError");
    }
    expect(count("rateLimit$rateLimits")).toBe(0);
    const good = { kind: "token bucket", rate: 1, period: MINUTE };
    expect(engine.runMutation("messages:rawLimit", { config: good }).value).toEqual({ ok: true });
    expect(engine.runQuery("messages:rawCheck", { config: good }).value).toEqual({ ok: false, retryAfter: MINUTE });
  });

  test("the unchecked variants stay internal to the component", async () => {
    const pkg = await import("../src/index.ts");
    expect("consumeChecked" in pkg).toBe(false);
    expect("checkChecked" in pkg).toBe(false);
    expect(typeof pkg.consume).toBe("function");
    expect(typeof pkg.check).toBe("function");
    // The explicit re-export list keeps every other value of algorithms.ts (what `export *` gave): one added there
    // fails here until it is re-exported (or named `*Checked`, internal).
    const algorithms = await import("../src/algorithms.ts");
    expect(Object.keys(algorithms).filter((k) => !k.endsWith("Checked") && !(k in pkg))).toEqual([]);
  });

  test("install-time named limits; installs are isolated", () => {
    const { engine, count } = setup();
    expect((engine.runMutation("messages:daily").value as any).ok).toBe(true);
    expect((engine.runMutation("messages:daily").value as any).ok).toBe(true);
    expect((engine.runMutation("messages:daily").value as any).ok).toBe(false);
    expect(count("configured$rateLimits")).toBe(1);
    expect(count("rateLimit$rateLimits")).toBe(0);
    expect(err(() => engine.runMutation("messages:unknown")).code).toBe("ValidationError");
  });

  test("install config is validated", () => {
    expect(() => defineApp().use(rateLimit, { name: "bad", config: { limits: { x: { kind: "leaky", rate: 1, period: 1 } as any } } })).toThrow(/invalid config/);
  });

  test("a Cloudflare binding in the install config is declared for deploy", () => {
    const withBinding = defineApp().use(rateLimit, { config: { binding: { name: "RL_EDGE", limit: 100, period: 60 } } });
    const m = composeApp({ schema, app: withBinding }).schema.manifest;
    expect(m.components!.rateLimit!.bindings).toEqual([{ type: "ratelimit", name: "RL_EDGE", limit: 100, period: 60 }]);
  });

  test("several Cloudflare bindings (bindings: { NAME: { limit, period } }) are all declared, with binding", () => {
    const config: RateLimitInstallConfig = {
      binding: { name: "RL_EDGE", limit: 100, period: 60 },
      bindings: { RL_LOGIN: { limit: 5, period: 60 }, RL_API: { limit: 50, period: 10 } },
    };
    const m = composeApp({ schema, app: defineApp().use(rateLimit, { config }) }).schema.manifest;
    expect(m.components!.rateLimit!.bindings).toEqual([
      { type: "ratelimit", name: "RL_EDGE", limit: 100, period: 60 },
      { type: "ratelimit", name: "RL_LOGIN", limit: 5, period: 60 },
      { type: "ratelimit", name: "RL_API", limit: 50, period: 10 },
    ]);
    const twice: RateLimitInstallConfig = { binding: { name: "RL", limit: 1, period: 10 }, bindings: { RL: { limit: 2, period: 60 } } };
    expect(() => composeApp({ schema, app: defineApp().use(rateLimit, { config: twice }) })).toThrow(/declared twice/);
    expect(() => composeApp({ schema, app: defineApp().use(rateLimit, { config: { bindings: { "not-ok": { limit: 1, period: 10 } } } }) })).toThrow(/JS identifier/);
    // A wrong period is refused by the config validator.
    expect(() => defineApp().use(rateLimit, { config: { bindings: { RL: { limit: 1, period: 30 as 60 } } } })).toThrow(/invalid config/);
  });

  test("helper in actions: async, through the action's ctx", async () => {
    const calls: unknown[] = [];
    const ctx = {
      runAction: async () => null,
      runQuery: async () => null,
      runMutation: async (ref: unknown, args: unknown) => {
        calls.push(args);
        return { ok: true };
      },
    };
    await expect(limiter.limit(ctx, "send", { key: "x", count: 2 })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ name: "send", config: { kind: "token bucket", rate: 6, period: MINUTE, capacity: 2 }, key: "x", count: 2 }]);
    void actionGeneric;
  });
});

describe("rateLimit GC (expired buckets)", () => {
  // `send`: 6/min, capacity 2 → a bucket emptied at t is full again at t + 20 s.
  const keys = (n: number, prefix = "u") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  test("each row records when it is full again; one GC job per shard deletes the expired ones and stops when empty", () => {
    const { mutate, pending, runDue, advance, count, driver } = setup();
    for (const k of keys(5)) mutate("messages:send", { user: k });
    expect(count("rateLimit$rateLimits")).toBe(5);
    // One job for five new keys (scheduled once, at least an interval away).
    const gcJobs = pending().filter((j) => j.fn === "@rateLimit/lib:gc");
    expect(gcJobs).toHaveLength(1);
    expect(count("rateLimit$gc")).toBe(1);
    const rows = driver.exec(`SELECT expiresAt, ts, value FROM "rateLimit$rateLimits"`).rows as Array<{ expiresAt: number; ts: number; value: number }>;
    for (const r of rows) expect(r.expiresAt).toBe(r.ts + 10 * SECOND); // one token missing at 6/min
    advance(HOUR);
    expect(runDue()).toEqual([5]);
    expect(count("rateLimit$rateLimits")).toBe(0);
    expect(count("rateLimit$gc")).toBe(0);
    expect(pending()).toEqual([]);
  });

  test("a bucket that is not full yet is kept, and the next job waits for it", () => {
    const { mutate, pending, runDue, advance, count, now } = setup(defineApp().use(rateLimit, { config: { gc: { intervalMs: 1000 } } }));
    const t0 = now();
    mutate("messages:send", { user: "old" }); // full again at t0 + 10 s; the GC job is due then
    advance(5 * SECOND);
    mutate("messages:send", { user: "new" }); // full again at t0 + 15 s
    advance(6 * SECOND); // t0 + 11 s
    expect(runDue()).toEqual([1]);
    expect(count("rateLimit$rateLimits")).toBe(1);
    const next = pending().filter((j) => j.fn === "@rateLimit/lib:gc");
    expect(next).toHaveLength(1);
    expect(next[0]!.runAt).toBe(t0 + 15 * SECOND); // when "new" is full again
    advance(4 * SECOND);
    expect(runDue()).toEqual([1]);
    expect(count("rateLimit$rateLimits")).toBe(0);
    expect(pending()).toEqual([]);
  });

  test("deleting an expired bucket gives no extra tokens; ttlMs keeps it longer", () => {
    const { engine, mutate, runDue, advance, count } = setup(defineApp().use(rateLimit, { config: { gc: { ttlMs: 10 * MINUTE, intervalMs: 1000 } } }));
    const send = (user: string) => mutate("messages:send", { user }).value as { ok: boolean };
    expect([send("a"), send("a"), send("a")].map((r) => r.ok)).toEqual([true, true, false]);
    advance(20 * SECOND); // full again
    runDue();
    expect(count("rateLimit$rateLimits")).toBe(1); // within ttl
    advance(10 * MINUTE);
    runDue();
    expect(count("rateLimit$rateLimits")).toBe(0);
    // Same as never limited: the full capacity, no more.
    expect(engine.runQuery("messages:left", { user: "a" }).value).toBe(2);
    expect([send("a"), send("a"), send("a")].map((r) => r.ok)).toEqual([true, true, false]);
  });

  test("deletes in batches: a full batch continues right away", () => {
    const { mutate, runDue, advance, count, pending } = setup(defineApp().use(rateLimit, { config: { gc: { batchSize: 4, intervalMs: 1000 } } }));
    for (const k of keys(10)) mutate("messages:send", { user: k });
    advance(MINUTE);
    expect(runDue()).toEqual([4, 4, 2]);
    expect(count("rateLimit$rateLimits")).toBe(0);
    expect(pending()).toEqual([]);
  });

  test("a stream of new keys keeps one pending GC job; a refused call or a patch schedules nothing", () => {
    const { mutate, pending } = setup();
    for (const k of keys(20)) mutate("messages:send", { user: k });
    for (let i = 0; i < 3; i++) mutate("messages:send", { user: "u0" });
    expect(pending().filter((j) => j.fn === "@rateLimit/lib:gc")).toHaveLength(1);
  });

  test("gc: false writes no GC job; rows written before the GC (no expiresAt) are skipped, and tracked on their next write", () => {
    const off = setup(defineApp().use(rateLimit, { config: { gc: false } }));
    for (const k of keys(3)) off.mutate("messages:send", { user: k });
    expect(off.pending()).toEqual([]);
    expect(off.count("rateLimit$gc")).toBe(0);

    const { mutate, driver, runDue, advance, count, pending } = setup(defineApp().use(rateLimit, { config: { gc: { intervalMs: 1000 } } }));
    mutate("messages:send", { user: "legacy" });
    runDue();
    // A row from before the GC: no expiresAt, and its index key starts with the undefined tag (0x01) instead of the
    // 9-byte number (tag + 8 bytes), as a backfill of the new index would write it.
    driver.exec(`UPDATE "rateLimit$rateLimits" SET expiresAt = NULL, "_k_by_expires" = CAST(X'01' || substr("_k_by_expires", 10) AS BLOB)`);
    advance(HOUR);
    mutate("messages:send", { user: "fresh" });
    advance(HOUR);
    expect(runDue()).toEqual([1]); // "fresh"; the legacy row stays
    expect(count("rateLimit$rateLimits")).toBe(1);
    mutate("messages:send", { user: "legacy" }); // rewritten: gets expiresAt and a GC job
    expect(pending().filter((j) => j.fn === "@rateLimit/lib:gc")).toHaveLength(1);
    advance(HOUR);
    expect(runDue()).toEqual([1]);
    expect(count("rateLimit$rateLimits")).toBe(0);
  });

  test("a new row expiring before the pending job moves the job up (never past the row's expiry)", () => {
    const { mutate, pending, now } = setup(); // intervalMs: 1 h
    const t0 = now();
    const gcJobs = () => pending().filter((j) => j.fn === "@rateLimit/lib:gc");
    mutate("@rateLimit/lib:limit", { name: "slow", key: "a", config: { kind: "token bucket", rate: 1, period: 2 * HOUR } });
    expect(gcJobs().map((j) => j.runAt)).toEqual([t0 + 2 * HOUR]);
    // Full again in 10 s: collectable at the interval (1 h), an hour before the pending job.
    mutate("@rateLimit/lib:limit", { name: "fast", key: "a", config: { kind: "token bucket", rate: 1, period: 10 * SECOND } });
    expect(gcJobs().map((j) => j.runAt)).toEqual([t0 + HOUR]);
    // A later expiry leaves the earlier job alone.
    mutate("@rateLimit/lib:limit", { name: "slow", key: "b", config: { kind: "token bucket", rate: 1, period: 2 * HOUR } });
    expect(gcJobs().map((j) => j.runAt)).toEqual([t0 + HOUR]);
  });

  test("a slower named limit after a redeploy: the GC keeps the bucket still in debt under it", () => {
    const fast = { kind: "token bucket" as const, rate: 1, period: MINUTE, capacity: 1 };
    const before = setup(defineApp().use(rateLimit, { config: { limits: { slow: fast }, gc: { intervalMs: 1000 } } }));
    expect(before.mutate("@rateLimit/lib:limit", { name: "slow", key: "k" }).value).toEqual({ ok: true }); // empty until +1 min
    before.advance(HOUR); // the GC has not run yet
    const after = setup(defineApp().use(rateLimit, { config: { limits: { slow: { ...fast, period: 24 * HOUR } }, gc: { intervalMs: 1000 } } }), before);
    expect(after.mutate("@rateLimit/lib:gc").value).toBe(0); // in debt under the new config: kept
    expect(after.count("rateLimit$rateLimits")).toBe(1);
    expect(after.mutate("@rateLimit/lib:limit", { name: "slow", key: "k" }).value).toMatchObject({ ok: false });
    const next = after.pending().filter((j) => j.fn === "@rateLimit/lib:gc");
    expect(next.map((j) => j.runAt)).toEqual([before.now() - HOUR + 24 * HOUR]); // when it is full under the new one
    after.advance(24 * HOUR);
    expect(after.runDue()).toEqual([1]);
    expect(after.count("rateLimit$rateLimits")).toBe(0);
  });

  test("turning the GC back on collects the rows written while it was off, from the next write of any key", () => {
    const off = setup(defineApp().use(rateLimit, { config: { gc: false } }));
    for (const k of keys(3)) off.mutate("messages:send", { user: k });
    expect(off.pending()).toEqual([]);
    const on = setup(defineApp().use(rateLimit, { config: { gc: { intervalMs: 1000 } } }), off);
    on.mutate("messages:send", { user: "u0" }); // a patch of a tracked row
    expect(on.pending().filter((j) => j.fn === "@rateLimit/lib:gc")).toHaveLength(1);
    on.advance(HOUR);
    expect(on.runDue()).toEqual([3]);
    expect(on.count("rateLimit$rateLimits")).toBe(0);
  });
});

describe("edgeLimit (Cloudflare Rate Limiting binding)", () => {
  test("wraps env.<binding>.limit and reports a missing binding", async () => {
    let n = 0;
    const env = { RL_EDGE: { limit: async ({ key }: { key: string }) => ({ success: key === "ok" && ++n <= 1 }) } };
    expect(await edgeLimit({ env }, "RL_EDGE", "ok")).toEqual({ ok: true });
    expect(await edgeLimit({ env }, "RL_EDGE", "ok")).toEqual({ ok: false });
    await expect(edgeLimit({ env: {} }, "RL_EDGE", "k")).rejects.toThrow(/no Rate Limiting binding/);
  });
});

// Type-level: the typed component API fits the helper; wrong limit names are errors.
export function typeChecks(api: RateLimitComponentApi, ctx: any) {
  const l = new RateLimiter(api, { a: { kind: "token bucket", rate: 1, period: 1 } });
  // @ts-expect-error unknown limit name
  l.limit(ctx, "b");
  // @ts-expect-error wrong kind
  new RateLimiter(api, { a: { kind: "leaky", rate: 1, period: 1 } });
}
