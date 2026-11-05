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
  mutationGeneric,
  queryGeneric,
  v,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, test } from "vitest";
import { edgeLimit, MINUTE, rateLimit, RateLimiter, SECOND, type RateLimitComponentApi } from "../src/index.ts";

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
  },
};

function setup() {
  let now = 1_700_000_000_000;
  const composed = composeApp({ schema, functions: fns, app });
  const driver = createNodeSqliteDriver();
  const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver, now: () => now });
  engine.migrate();
  return {
    engine,
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
