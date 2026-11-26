// The workpool component end to end on the real engine (node:sqlite), with a scheduler that runs action jobs
// concurrently (test/harness.ts): the cap is measured by a probe inside the work action.
import {
  anyComponents,
  defineApp,
  defineSchema,
  defineTable,
  internalActionGeneric,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  unsafeRef,
  v,
} from "@freecorps/ember-server";
import { beforeEach, describe, expect, test } from "vitest";
import { Workpool, vOnCompleteArgs, workpool, type EnqueueOptions, type OnCompleteArgs, type WorkpoolOptions } from "../src/index.ts";
import type { FunctionReference } from "@freecorps/ember-server";
import { gates, harness, T0 } from "./harness.ts";

const app = defineApp()
  .use(workpool, { name: "aiPool", config: { reclaimIntervalMs: 1000 } })
  .use(workpool, { name: "emailPool" });

const schema = defineSchema({
  tables: {
    saved: defineTable({ label: v.string() }),
    done: defineTable({ workId: v.string(), context: v.any(), result: v.any() }),
    seen: defineTable({ label: v.string(), stats: v.any() }),
  },
});

const gate = gates();
const probe = { inFlight: 0, max: 0, started: [] as string[], fails: new Map<string, number>(), hang: new Set<string>() };
beforeEach(async () => {
  // Calls a previous test left waiting finish before the probe is reset.
  gate.releaseAll();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  Object.assign(probe, { inFlight: 0, max: 0, started: [], fails: new Map(), hang: new Set() });
});

const work = {
  /** Waits on the gate; fails `fails.get(label)` times first. */
  call: internalActionGeneric({
    args: { label: v.string() },
    handler: async (_ctx: unknown, { label }: { label: string }) => {
      probe.inFlight++;
      probe.max = Math.max(probe.max, probe.inFlight);
      probe.started.push(label);
      // A Worker that dies mid-call: never returns, never reports.
      if (probe.hang.has(label)) return new Promise<never>(() => {});
      try {
        await gate.wait();
        const left = probe.fails.get(label) ?? 0;
        if (left > 0) {
          probe.fails.set(label, left - 1);
          throw new Error(`upstream 503 (${label})`);
        }
        return `done:${label}`;
      } finally {
        probe.inFlight--;
      }
    },
  }),
  write: internalMutationGeneric({
    args: { label: v.string(), fail: v.optional(v.boolean()) },
    handler: (ctx: any, a: { label: string; fail?: boolean }) => {
      ctx.db.insert("saved", { label: a.label });
      if (a.fail) throw new Error(`write ${a.label} failed`);
      return a.label.length;
    },
  }),
  done: internalMutationGeneric({
    args: vOnCompleteArgs,
    handler: (ctx: any, a: { workId: string; context: any; result: unknown }) => {
      ctx.db.insert("done", { workId: a.workId, context: a.context, result: a.result });
      if (a.context?.throw) throw new Error("onComplete exploded");
    },
  }),
  /** onComplete that records what `stats` shows from inside the callback and, with `again`, enqueues one more item. */
  observe: internalMutationGeneric({
    args: vOnCompleteArgs,
    handler: (ctx: any, a: { workId: string; context: any; result: unknown }) => {
      const pool = poolOf();
      ctx.db.insert("seen", { label: a.context.label, stats: pool.stats(ctx) });
      if (a.context.again) {
        const label = `${a.context.label}+`;
        pool.enqueueMutation(ctx, unsafeRef<"mutation">("work:write"), { label }, { onComplete: observeRef, context: { label } });
      }
    },
  }),
};
const observeRef = unsafeRef("work:observe") as FunctionReference<"mutation", "internal", OnCompleteArgs>;

type EnqueueReq = { pool?: string; kind?: "action" | "mutation"; labels: string[]; poolOptions?: WorkpoolOptions; item?: EnqueueOptions & { fail?: boolean }; batch?: boolean; thenFail?: boolean;
  /** Batch only: `"label"` keys each item by its label (`<prefix>:<label>`), `"const"` gives every item the same key, `"fixed"` passes a string. */
  batchKey?: { mode: "label" | "const" | "fixed"; prefix: string } };
const poolOf = (name = "aiPool", o: WorkpoolOptions = {}) => new Workpool(anyComponents[name], o);

const api = {
  enqueue: mutationGeneric({
    args: { req: v.any() },
    handler: (ctx: any, a: { req: unknown }) => {
      const req = a.req as EnqueueReq;
      const pool = poolOf(req.pool, req.poolOptions);
      const { fail, ...item } = req.item ?? {};
      const opts = (label: string): EnqueueOptions => ({ onComplete: unsafeRef("work:done") as FunctionReference<"mutation", "internal", OnCompleteArgs>, context: { label }, ...item });
      let ids: string[];
      if (req.kind === "mutation") ids = req.labels.map((label) => pool.enqueueMutation(ctx, unsafeRef<"mutation">("work:write"), { label, ...(fail ? { fail } : {}) }, opts(label)));
      else if (req.batch) {
        const { key: _key, ...base } = opts("batch");
        const bk = req.batchKey;
        const key = !bk ? undefined : bk.mode === "label" ? (a: Record<string, unknown>) => `${bk.prefix}:${String(a.label)}` : bk.mode === "const" ? () => bk.prefix : (bk.prefix as never);
        ids = pool.enqueueActionBatch(ctx, unsafeRef<"action">("work:call"), req.labels.map((label) => ({ label })), key ? { ...base, key } : base);
      }
      else ids = req.labels.map((label) => pool.enqueueAction(ctx, unsafeRef<"action">("work:call"), { label }, opts(label)));
      if (req.thenFail) throw new Error("caller failed after enqueueing");
      return ids;
    },
  }),
  status: queryGeneric({ args: { id: v.string(), pool: v.optional(v.string()) }, handler: (ctx: any, a: { id: string; pool?: string }) => poolOf(a.pool).status(ctx, a.id) }),
  stats: queryGeneric({ args: { pool: v.optional(v.string()) }, handler: (ctx: any, a: { pool?: string }) => poolOf(a.pool).stats(ctx) }),
  cancel: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: { id: string }) => poolOf().cancel(ctx, a.id) }),
  cancelAll: mutationGeneric({ args: {}, handler: (ctx: any) => poolOf().cancelAll(ctx) }),
  done: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("done").collect().map((d: any) => ({ workId: d.workId, context: d.context, result: d.result })) }),
  enqueueMixed: mutationGeneric({
    args: { items: v.any(), maxParallelism: v.number() },
    handler: (ctx: any, a: { items: unknown; maxParallelism: number }) =>
      ctx.runMutation(anyComponents.aiPool.lib.enqueue, {
        maxParallelism: a.maxParallelism,
        items: (a.items as Array<[string, number]>).map(([label, priority]) => ({ kind: "action", fn: "&work:call", args: { label }, priority })),
      }),
  }),
  /** Mutation items without onComplete. */
  enqueueBare: mutationGeneric({
    args: { labels: v.array(v.string()), poolOptions: v.any() },
    handler: (ctx: any, a: { labels: string[]; poolOptions: unknown }) =>
      a.labels.map((label) => poolOf("aiPool", a.poolOptions as WorkpoolOptions).enqueueMutation(ctx, unsafeRef<"mutation">("work:write"), { label })),
  }),
  /** Mutation items whose onComplete is `work:observe`. */
  enqueueObserved: mutationGeneric({
    args: { labels: v.array(v.string()), again: v.optional(v.boolean()), maxParallelism: v.optional(v.number()) },
    handler: (ctx: any, a: { labels: string[]; again?: boolean; maxParallelism?: number }) =>
      a.labels.map((label) =>
        poolOf("aiPool", a.maxParallelism ? { maxParallelism: a.maxParallelism } : {}).enqueueMutation(ctx, unsafeRef<"mutation">("work:write"), { label }, { onComplete: observeRef, context: { label, again: a.again } }),
      ),
  }),
  seen: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("seen").collect().map((d: any) => ({ label: d.label, stats: d.stats })) }),
  pinned: mutationGeneric({ args: {}, handler: (ctx: any) => poolOf("aiPool", { shard: "global:main" }).enqueueAction(ctx, unsafeRef<"action">("work:call"), { label: "x" }) }),
};

function setup(installed: typeof app = app) {
  const h = harness({ schema, functions: { work, api }, app: installed });
  const enqueue = (req: EnqueueReq) => h.mutate("api:enqueue", { req }) as string[];
  const status = (id: string, pool?: string) => h.query("api:status", pool ? { id, pool } : { id }) as any;
  const stats = (pool?: string) => h.query("api:stats", pool ? { pool } : {}) as any;
  const done = () => h.query("api:done") as Array<{ workId: string; context: any; result: any }>;
  /** Releases in-flight calls one wave at a time until nothing is due or running (the clock does not move). */
  const drain = async () => {
    for (let i = 0; i < 200; i++) {
      await h.runDue();
      if (!gate.waiting) {
        await h.idle();
        await h.runDue();
        if (!gate.waiting) return;
      }
      gate.releaseAll();
      await h.idle();
    }
    throw new Error("drain: did not settle");
  };
  return { h, enqueue, status, stats, done, drain };
}

describe("workpool: parallelism and order", () => {
  test("a burst of 20 never has more than maxParallelism running, starts FIFO, and calls onComplete once each", async () => {
    const { h, enqueue, stats, done, drain } = setup();
    const labels = Array.from({ length: 20 }, (_, i) => `job-${String(i).padStart(2, "0")}`);
    const ids = enqueue({ labels, poolOptions: { maxParallelism: 3 } });
    expect(stats()).toMatchObject({ pending: 17, running: 3, maxParallelism: 3 });
    await h.runDue();
    expect(probe.inFlight).toBe(3);
    await drain();
    expect(probe.max).toBe(3);
    expect(probe.started).toEqual(labels);
    const finished = done();
    expect(finished).toHaveLength(20);
    expect(new Set(finished.map((d) => d.workId))).toEqual(new Set(ids));
    for (const d of finished) expect(d.result).toEqual({ kind: "success", returnValue: `done:${d.context.label}` });
    expect(stats()).toMatchObject({ pending: 0, running: 0, finished: { success: 20, failed: 0, canceled: 0 }, totals: { enqueued: 20, succeeded: 20 } });
  });

  test("a batch enqueue keeps its order; status reports the queue position", async () => {
    const { h, enqueue, status, drain } = setup();
    const ids = enqueue({ labels: ["a", "b", "c", "d"], batch: true, poolOptions: { maxParallelism: 1 } });
    expect(status(ids[0]!)).toEqual({ state: "running", attempt: 1 });
    expect(ids.slice(1).map((id) => status(id))).toEqual([0, 1, 2].map((position) => ({ state: "pending", position })));
    await drain();
    expect(probe.started).toEqual(["a", "b", "c", "d"]);
    expect(status(ids[3]!)).toEqual({ state: "finished", result: { kind: "success", returnValue: "done:d" } });
    expect(h.query("api:status", { id: "not-an-id" })).toBeNull();
  });

  test("higher priority runs first, FIFO within a priority", async () => {
    const { enqueue, status, drain } = setup();
    enqueue({ labels: ["first"], poolOptions: { maxParallelism: 1 } });
    enqueue({ labels: ["low-1", "low-2"] });
    const [urgent] = enqueue({ labels: ["urgent"], item: { priority: 5 } });
    expect(status(urgent!)).toEqual({ state: "pending", position: 0 });
    await drain();
    expect(probe.started).toEqual(["first", "urgent", "low-1", "low-2"]);
  });

  test("without helper settings the install config applies (read at use time)", async () => {
    const { h, enqueue, stats } = setup(defineApp().use(workpool, { name: "aiPool", config: { maxParallelism: 2 } }).use(workpool, { name: "emailPool" }));
    enqueue({ labels: ["a", "b", "c"] });
    await h.runDue();
    expect(probe.inFlight).toBe(2);
    expect(stats()).toMatchObject({ running: 2, pending: 1, maxParallelism: 2 });
    expect(stats("emailPool").maxParallelism).toBe(10);
  });

  test("two installs are two pools: separate caps, queues and counts", async () => {
    const { h, enqueue, stats, drain } = setup();
    enqueue({ pool: "aiPool", labels: ["a1", "a2", "a3"], poolOptions: { maxParallelism: 1 } });
    enqueue({ pool: "emailPool", labels: ["e1", "e2", "e3"], poolOptions: { maxParallelism: 2 } });
    await h.runDue();
    expect(probe.inFlight).toBe(3);
    expect(stats("aiPool")).toMatchObject({ running: 1, pending: 2, maxParallelism: 1 });
    expect(stats("emailPool")).toMatchObject({ running: 2, pending: 1, maxParallelism: 2 });
    await drain();
    expect(stats("aiPool").totals.succeeded).toBe(3);
    expect(stats("emailPool").totals.succeeded).toBe(3);
    expect(h.sql(`SELECT COUNT(*) AS n FROM "aiPool$work"`)[0]!.n).toBe(3);
    expect(h.sql(`SELECT COUNT(*) AS n FROM "emailPool$work"`)[0]!.n).toBe(3);
  });

  test("enqueueing is atomic with the caller: a mutation that fails afterwards leaves no item and no job", () => {
    const { h, stats } = setup();
    expect(() => h.mutate("api:enqueue", { req: { labels: ["x", "y"], thenFail: true } })).toThrow("caller failed");
    expect(h.sql(`SELECT COUNT(*) AS n FROM "aiPool$work"`)[0]!.n).toBe(0);
    expect(h.pendingJobs()).toEqual([]);
    expect(stats()).toMatchObject({ pending: 0, running: 0, totals: { enqueued: 0 } });
  });

  test("an idempotency key returns the existing item instead of enqueueing again", async () => {
    const { enqueue, stats, drain } = setup();
    const [a] = enqueue({ labels: ["k"], item: { key: "doc-1" } });
    const [b] = enqueue({ labels: ["k"], item: { key: "doc-1" } });
    expect(b).toBe(a);
    await drain();
    const [c] = enqueue({ labels: ["k"], item: { key: "doc-1" } });
    expect(c).toBe(a); // still retained: no second run
    expect(stats().totals.enqueued).toBe(1);
    expect(probe.started).toEqual(["k"]);
  });
});

describe("workpool: results, retries, failures", () => {
  test("actions retry with exponential backoff and jitter, keeping their slot; the last failure is final", async () => {
    const { h, enqueue, status, done, stats, drain } = setup();
    probe.fails.set("flaky", 1).set("doomed", 99);
    const retry = { maxAttempts: 3, initialBackoffMs: 1000, base: 2 };
    const poolOptions = { maxParallelism: 1, retry };
    const [flaky] = enqueue({ labels: ["flaky"], poolOptions });
    const [doomed] = enqueue({ labels: ["doomed"], poolOptions });
    const [after] = enqueue({ labels: ["after"], poolOptions });
    await drain();
    const s1 = status(flaky!);
    expect(s1).toMatchObject({ state: "running", attempt: 2, lastError: "upstream 503 (flaky)" });
    expect(s1.retryAt - T0).toBeGreaterThanOrEqual(750);
    expect(s1.retryAt - T0).toBeLessThanOrEqual(1250); // Math.round of the ±25% jitter can land on the bound
    expect(status(doomed!)).toMatchObject({ state: "pending", position: 0 }); // the slot is held during the backoff
    h.advance(1250);
    await drain();
    expect(status(flaky!)).toEqual({ state: "finished", result: { kind: "success", returnValue: "done:flaky" } });
    // doomed: attempt 1 now, then backoffs of ~1 s and ~2 s.
    let at = h.now();
    for (const base of [1000, 2000]) {
      const s = status(doomed!);
      expect(s.retryAt - at).toBeGreaterThanOrEqual(0.75 * base);
      expect(s.retryAt - at).toBeLessThanOrEqual(1.25 * base);
      at = s.retryAt;
      h.advance(s.retryAt - h.now());
      await drain();
    }
    expect(status(doomed!)).toEqual({ state: "finished", result: { kind: "failed", error: "upstream 503 (doomed)" } });
    expect(probe.started.filter((l) => l === "doomed")).toHaveLength(3);
    expect(status(after!)).toMatchObject({ state: "finished", result: { kind: "success" } });
    expect(done().map((d) => [d.context.label, d.result.kind])).toEqual([["flaky", "success"], ["doomed", "failed"], ["after", "success"]]);
    expect(stats().totals).toMatchObject({ retries: 3, failed: 1, succeeded: 2 });
  });

  test("without a retry policy an action fails at once; retry: false on an item overrides the pool", async () => {
    const { enqueue, status, drain } = setup();
    probe.fails.set("a", 1).set("b", 1);
    const [a] = enqueue({ labels: ["a"] });
    const [b] = enqueue({ labels: ["b"], poolOptions: { retry: true }, item: { retry: false } });
    await drain();
    expect(status(a!)).toEqual({ state: "finished", result: { kind: "failed", error: "upstream 503 (a)" } });
    expect(status(b!)).toEqual({ state: "finished", result: { kind: "failed", error: "upstream 503 (b)" } });
  });

  test("mutation items run exactly once with their onComplete; a failing one is undone and not retried by default", async () => {
    const { h, enqueue, status, done, drain } = setup();
    const ok = enqueue({ kind: "mutation", labels: ["m1", "m22"], poolOptions: { maxParallelism: 1, retry: true } });
    const [bad] = enqueue({ kind: "mutation", labels: ["boom"], item: { fail: true } });
    await drain();
    expect(h.sql(`SELECT label FROM saved ORDER BY label`)).toEqual([{ label: "m1" }, { label: "m22" }]);
    expect(ok.map((id) => status(id).result)).toEqual([{ kind: "success", returnValue: 2 }, { kind: "success", returnValue: 3 }]);
    expect(status(bad!)).toEqual({ state: "finished", result: { kind: "failed", error: "write boom failed" } });
    expect(done()).toHaveLength(3);
  });

  test("a failing onComplete is undone and recorded; the item still finishes and frees its slot", async () => {
    const { h, enqueue, status, done, drain } = setup();
    const [a] = enqueue({ labels: ["a"], poolOptions: { maxParallelism: 1 }, item: { context: { throw: true } } });
    const [b] = enqueue({ labels: ["b"] });
    await drain();
    expect(status(a!)).toMatchObject({ state: "finished", result: { kind: "success" } });
    expect(h.sql(`SELECT onCompleteError FROM "aiPool$work" WHERE onCompleteError IS NOT NULL`)).toHaveLength(1);
    expect(status(b!)).toMatchObject({ state: "finished" });
    expect(done().map((d) => d.context.label ?? "a")).toEqual(["b"]);
  });

  test("finished items are kept for retentionMs, then deleted by the tick", async () => {
    const { h, enqueue, status, drain } = setup();
    const [a] = enqueue({ labels: ["a"], poolOptions: { retentionMs: 5000 } });
    await drain();
    expect(status(a!)).toMatchObject({ state: "finished" });
    // Kept at least retentionMs; deleted on the next GC boundary (a window of at most the retention itself).
    h.advance(5001);
    await drain();
    h.advance(5000);
    await drain();
    expect(status(a!)).toBeNull();
    expect(h.pendingJobs()).toEqual([]); // no tick left: the pool is idle

    const [b] = enqueue({ labels: ["b"], poolOptions: { retentionMs: 0 } });
    await drain();
    expect(status(b!)).toBeNull(); // deleted right after onComplete
  });
});

describe("workpool: cancel", () => {
  test("cancel: a queued item now, an in-flight action when it returns (keeping its slot), a waiting retry at once", async () => {
    const { h, enqueue, status, done, drain } = setup();
    probe.fails.set("retrying", 9);
    const [running, queued, other] = enqueue({ labels: ["running", "queued", "other"], poolOptions: { maxParallelism: 1 } });
    await h.runDue();
    expect(h.mutate("api:cancel", { id: queued! })).toBe(true);
    expect(status(queued!)).toEqual({ state: "finished", result: { kind: "canceled" } });
    expect(h.mutate("api:cancel", { id: running! })).toBe(true);
    expect(status(running!)).toEqual({ state: "running", attempt: 1, cancelRequested: true });
    expect(status(other!)).toEqual({ state: "pending", position: 0 });
    gate.releaseAll();
    await h.idle();
    expect(status(running!)).toEqual({ state: "finished", result: { kind: "canceled" } });
    await drain();
    expect(probe.started).toEqual(["running", "other"]);
    expect(h.mutate("api:cancel", { id: other! })).toBe(false); // already finished

    const [retrying] = enqueue({ labels: ["retrying"], poolOptions: { retry: { maxAttempts: 5, initialBackoffMs: 60_000, base: 2 } } });
    await drain();
    expect(status(retrying!)).toMatchObject({ state: "running", attempt: 2 });
    expect(h.mutate("api:cancel", { id: retrying! })).toBe(true);
    expect(status(retrying!)).toEqual({ state: "finished", result: { kind: "canceled" } });
    expect(h.pendingJobs().filter((j) => j.fn.endsWith("lib:run"))).toEqual([]);
    expect(done().filter((d) => d.result.kind === "canceled").map((d) => d.context.label)).toEqual(["queued", "running", "retrying"]);
  });

  test("cancelAll cancels everything enqueued so far, not what comes after", async () => {
    const { h, enqueue, stats, drain } = setup();
    enqueue({ labels: ["r1", "r2", "p1", "p2", "p3"], poolOptions: { maxParallelism: 2 } });
    await h.runDue();
    expect(h.mutate("api:cancelAll")).toBe(5);
    const [later] = enqueue({ labels: ["later"] });
    await drain();
    expect(probe.started).toEqual(["r1", "r2", "later"]);
    expect(stats().totals).toMatchObject({ canceled: 5, succeeded: 1 });
    expect(h.query("api:status", { id: later! })).toMatchObject({ state: "finished", result: { kind: "success" } });
  });
});

describe("workpool: crashes", () => {
  test("a run whose lease ran out runs again (at least once); onComplete is called once, the late report is ignored", async () => {
    const { h, enqueue, status, done, drain } = setup();
    const [id] = enqueue({ labels: ["paid"] });
    await h.runDue();
    const job = [...h.history.values()].find((e) => e.job.fn.endsWith("lib:run"))!.job;
    h.redeliver(job.id); // the scheduler's lease ran out: the same job again
    await h.runDue();
    expect(probe.started).toEqual(["paid", "paid"]);
    gate.releaseOne(); // one of them reports
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(status(id!)).toMatchObject({ state: "finished" });
    gate.releaseAll(); // the other reports late: fenced out
    await drain();
    expect(status(id!)).toEqual({ state: "finished", result: { kind: "success", returnValue: "done:paid" } });
    expect(done()).toHaveLength(1);
  });

  test("a running item whose job failed or vanished is reclaimed by the tick: the slot is freed, the attempt retried", async () => {
    const { h, enqueue, status, stats, drain } = setup();
    probe.hang.add("a");
    const [a, b] = enqueue({ labels: ["a", "b"], poolOptions: { maxParallelism: 1, retry: { maxAttempts: 2, initialBackoffMs: 0, base: 2 } } });
    await h.runDue();
    const runOf = () => [...h.history.values()].filter((e) => e.job.fn.endsWith("lib:run") && e.state.kind === "inProgress").map((e) => e.job.id);
    const [first] = runOf();
    // The run died and the scheduler gave up on its job: nothing will ever report.
    h.abandon(first!);
    h.setJob(first!, { kind: "failed", error: "action_failed: worker crashed" });
    h.advance(1000); // reclaimIntervalMs of the aiPool install
    await h.runDue();
    expect(stats().totals.reclaimed).toBe(1);
    expect(status(a!)).toMatchObject({ state: "running", attempt: 2, lastError: expect.stringContaining("lost: its job failed") });
    // Attempt 2's job vanishes entirely (e.g. deleted): reclaimed after an interval, and out of attempts.
    const [second] = runOf();
    h.abandon(second!);
    h.setJob(second!, null);
    h.advance(1000);
    await drain();
    expect(status(a!)).toEqual({ state: "finished", result: { kind: "failed", error: "lost: its job is gone" } });
    expect(status(b!)).toMatchObject({ state: "finished", result: { kind: "success" } });
    expect(stats().totals.reclaimed).toBe(2);
  });

  test("an idle pool keeps its reclaim tick once, then the one tick waits for the GC window of its oldest result", async () => {
    const { h, enqueue, drain } = setup();
    const ticks = () => h.pendingJobs().filter((j) => String(j.fn).endsWith("lib:tick"));
    enqueue({ labels: ["a"], pool: "emailPool" });
    // While it runs: the reclaim tick, one interval (5 min by default) out.
    expect(ticks().map((j) => j.runAt - h.now())).toEqual([5 * 60_000]);
    const reclaim = ticks()[0]!.id;
    await drain();
    // Done and idle: the finish does not move the tick (no cancel + reschedule per burst); the reclaim tick runs once.
    const finishedAt = h.now();
    expect(ticks().map((j) => j.id)).toEqual([reclaim]);
    h.advance(5 * 60_000);
    await drain();
    // Then no tick before the result expires (1 day), on a 15-minute boundary.
    const [t] = ticks();
    expect(ticks()).toHaveLength(1);
    expect(t!.runAt).toBeGreaterThan(finishedAt + 24 * 60 * 60_000);
    expect(t!.runAt % (15 * 60_000)).toBe(0);
    expect(t!.runAt - (finishedAt + 24 * 60 * 60_000)).toBeLessThanOrEqual(15 * 60_000);
  });

  test("a retention shorter than the reclaim interval, with items still running: the result's GC tick comes first", async () => {
    const { h, enqueue, status } = setup();
    const ticks = () => h.pendingJobs().filter((j) => String(j.fn).endsWith("lib:tick"));
    probe.hang.add("slow"); // keeps the pool busy (running) past the GC
    const [quick] = enqueue({ pool: "emailPool", labels: ["quick", "slow"], poolOptions: { retentionMs: 60_000 } });
    await h.runDue();
    expect(ticks().map((j) => j.runAt - h.now())).toEqual([5 * 60_000]); // the reclaim tick
    gate.releaseAll(); // quick reports, slow never does
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(status(quick!, "emailPool")).toMatchObject({ state: "finished" });
    const [t] = ticks();
    expect(ticks()).toHaveLength(1);
    expect(t!.runAt).toBeGreaterThan(h.now() + 60_000);
    expect(t!.runAt).toBeLessThanOrEqual(h.now() + 2 * 60_000); // the next 1-minute boundary past the retention
    h.advance(t!.runAt - h.now());
    await h.runDue();
    expect(status(quick!, "emailPool")).toBeNull();
    // slow still runs: the reclaim tick is back, one interval out.
    expect(ticks().map((j) => j.runAt - h.now())).toEqual([5 * 60_000]);
  });

  test("an idle pool whose GC tick failed gets a new one from the next finish (a stale tickAt is not trusted)", async () => {
    const { h, enqueue, drain } = setup();
    const ticks = () => h.pendingJobs().filter((j) => String(j.fn).endsWith("lib:tick"));
    enqueue({ labels: ["a"], pool: "emailPool", poolOptions: { retentionMs: 60_000 } });
    await drain();
    const [t] = ticks();
    // The tick's turn came and it failed (rolled back): tickAt still names it, the job is gone.
    h.advance(t!.runAt - h.now());
    h.abandon(t!.id);
    h.setJob(t!.id, { kind: "failed", error: "boom" });
    expect(ticks()).toEqual([]);
    enqueue({ labels: ["b"], pool: "emailPool" });
    await drain();
    expect(ticks()).toHaveLength(1);
    expect(ticks()[0]!.id).not.toBe(t!.id);
  });

  test("an idle pool whose overdue GC tick has no job row left gets a new one from the next finish", async () => {
    const { h, enqueue, drain } = setup();
    const ticks = () => h.pendingJobs().filter((j) => String(j.fn).endsWith("lib:tick"));
    enqueue({ labels: ["a"], pool: "emailPool", poolOptions: { retentionMs: 60_000 } });
    await drain();
    const [t] = ticks();
    // The tick ended and maintenance removed its row before the pool cleared `tickJob`.
    h.advance(t!.runAt - h.now());
    h.abandon(t!.id);
    h.setJob(t!.id, null);
    expect(ticks()).toEqual([]);
    enqueue({ labels: ["b"], pool: "emailPool" });
    await drain();
    expect(ticks()).toHaveLength(1);
    expect(ticks()[0]!.id).not.toBe(t!.id);
  });

  test("an enqueue that shortens the retention re-times an idle pool's GC tick (a keyed item already finished)", async () => {
    const { h, enqueue, status, drain } = setup();
    const ticks = () => h.pendingJobs().filter((j) => String(j.fn).endsWith("lib:tick"));
    const [a] = enqueue({ labels: ["a"], pool: "emailPool", item: { key: "k" } });
    await drain();
    h.advance(5 * 60_000); // the reclaim tick armed while it ran moves itself to the GC
    await drain();
    expect(ticks()[0]!.runAt - h.now()).toBeGreaterThan(23 * 60 * 60_000); // default retention: about a day out
    // Same key again (no new item, nothing starts) with a 30 s retention: the result now expires in 30 s.
    expect(enqueue({ labels: ["a"], pool: "emailPool", item: { key: "k" }, poolOptions: { retentionMs: 30_000 } })).toEqual([a]);
    expect(ticks()).toHaveLength(1);
    expect(ticks()[0]!.runAt - h.now()).toBeLessThanOrEqual(60_000);
    h.advance(ticks()[0]!.runAt - h.now());
    await drain();
    expect(status(a!, "emailPool")).toBeNull();
    expect(ticks()).toEqual([]);
  });

  test("results finishing over a window are collected by one tick, not one wake each", async () => {
    const { h, enqueue, status, drain } = setup();
    const ids: string[] = [];
    const runs = () => [...h.history.values()].filter((e) => String(e.job.fn).endsWith("lib:tick") && e.state.kind !== "pending" && e.state.kind !== "canceled").length;
    // Ten results a minute apart (inside one 15-minute window, from a boundary).
    h.advance(15 * 60_000 - (h.now() % (15 * 60_000)) + 1000);
    for (let i = 0; i < 10; i++) {
      ids.push(...enqueue({ labels: [`r${i}`], pool: "emailPool" }));
      await drain();
      h.advance(60_000);
    }
    const before = runs();
    h.advance(24 * 60 * 60_000 + 15 * 60_000);
    await drain();
    expect(ids.map((id) => status(id, "emailPool"))).toEqual(ids.map(() => null));
    expect(runs() - before).toBe(1);
  });

  test("the tick runs only while there is work: no job is left behind in an idle pool", async () => {
    const { h, enqueue, drain } = setup();
    enqueue({ labels: ["a"], poolOptions: { retentionMs: 0 } });
    await drain();
    h.advance(2000);
    await drain();
    expect(h.pendingJobs()).toEqual([]);
  });
});

describe("workpool: helper", () => {
  test("a pool pinned to a shard refuses a mutation ctx (enqueue from an action instead)", () => {
    const { h } = setup();
    expect(() => h.mutate("api:pinned")).toThrow(/pinned to global:main: call it from an action/);
  });

  test("bad settings are refused", () => {
    const { h } = setup();
    expect(() => h.mutate("api:enqueue", { req: { labels: ["x"], poolOptions: { maxParallelism: 0 } } })).toThrow(/maxParallelism must be an integer/);
    expect(() => h.mutate("api:enqueue", { req: { labels: ["x"], poolOptions: { retry: { maxAttempts: 0, initialBackoffMs: 1, base: 2 } } } })).toThrow(/maxAttempts/);
    expect(() => h.engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.runMutation("@aiPool/lib:enqueue", { items: [{ kind: "action", fn: "work:call" }] }) }) as any)).toThrow(/function handle/);
    expect(() => h.engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.runMutation("@aiPool/lib:complete", { id: "x", attempt: 1, outcome: {} }) }) as any)).toThrow(/not found/);
  });
});

describe("workpool: writes per enqueue (PR 2D)", () => {
  const poolWrites = (h: ReturnType<typeof setup>["h"]) => h.sql(`SELECT COUNT(*) AS n FROM "aiPool$pool"`)[0]!.n;

  test("an idle pool inserts the item as running with its job, in one write; the pool row is written once", async () => {
    const { h, enqueue, status, stats, done, drain } = setup();
    enqueue({ labels: ["warm"], poolOptions: { maxParallelism: 2 } }); // creates the pool row and stores the settings
    await drain();
    h.resetCounters();
    const [a] = enqueue({ labels: ["a"], poolOptions: { maxParallelism: 2 } });
    // node:sqlite usage, before PR 2D → after: rowsWritten 8 → 3 (insert pending + patch running + 4 pool patches →
    // one insert + one pool patch), rowsRead 7 → 1.
    expect(h.counters.rowsWritten).toBeLessThanOrEqual(3);
    expect(h.counters.rowsRead).toBeLessThanOrEqual(1);
    // The reclaim tick armed for "warm" is still there (an idle finish leaves it): no tick is scheduled again.
    expect(h.counters.scheduled).toEqual({ "@aiPool/lib:run": 1 });
    expect(status(a!)).toEqual({ state: "running", attempt: 1 });
    expect(poolWrites(h)).toBe(1);
    const row = h.sql(`SELECT status, attempts, job IS NOT NULL AS hasJob, startedAt FROM "aiPool$work" WHERE status = 'running'`);
    expect(row).toEqual([{ status: "running", attempts: 1, hasJob: 1, startedAt: T0 }]);
    await drain();
    expect(status(a!)).toEqual({ state: "finished", result: { kind: "success", returnValue: "done:a" } });
    expect(done().map((d) => d.context.label)).toEqual(["warm", "a"]);
    expect(stats().totals).toMatchObject({ enqueued: 2, succeeded: 2 });
  });

  test("the same settings sent again are not rewritten", () => {
    const { h, enqueue } = setup();
    enqueue({ labels: ["a"], poolOptions: { maxParallelism: 1, retentionMs: 60_000, reclaimIntervalMs: 2000 } });
    enqueue({ labels: ["b"], poolOptions: { maxParallelism: 1, retentionMs: 60_000, reclaimIntervalMs: 2000 } }); // queued: pool busy
    h.resetCounters();
    enqueue({ labels: ["c"], poolOptions: { maxParallelism: 1, retentionMs: 60_000, reclaimIntervalMs: 2000 } });
    // before PR 2D → after: rowsWritten 4 → 3 (settings + nextSeq + totals patches → one patch, settings unchanged).
    expect(h.counters.rowsWritten).toBeLessThanOrEqual(3);
  });

  test("a batch into an empty queue starts the items that fit in the pump's order (priority, then FIFO)", async () => {
    const { h, enqueue, status, drain } = setup();
    // One call, three items: low, high, mid; one slot.
    const ids = h.mutate("api:enqueueMixed", { items: [["low", 0], ["high", 5], ["mid", 1]], maxParallelism: 1 }) as string[];
    expect(status(ids[1]!)).toEqual({ state: "running", attempt: 1 });
    expect(status(ids[2]!)).toEqual({ state: "pending", position: 0 });
    expect(status(ids[0]!)).toEqual({ state: "pending", position: 1 });
    await drain();
    expect(probe.started).toEqual(["high", "mid", "low"]);
    void enqueue;
  });

  test("direct-start jobs of one batch are scheduled in the pump's order, ids still in input order", async () => {
    const { h, status, drain } = setup();
    // Two slots, both items start at once: the high-priority job is scheduled (and runs) first, as the pump would.
    const ids = h.mutate("api:enqueueMixed", { items: [["mid", 1], ["high", 5], ["low", 0]], maxParallelism: 2 }) as string[];
    expect(status(ids[0]!)).toEqual({ state: "running", attempt: 1 });
    expect(status(ids[1]!)).toEqual({ state: "running", attempt: 1 });
    expect(status(ids[2]!)).toEqual({ state: "pending", position: 0 });
    const runs = h.pendingJobs().filter((j) => j.fn === "@aiPool/lib:run").map((j) => (j.args as { seq: number }).seq);
    expect(runs).toEqual([1, 0]); // high (seq 1), then mid (seq 0)
    await h.runDue();
    expect(probe.started.slice(0, 2)).toEqual(["high", "mid"]);
    await drain();
    expect(probe.started).toEqual(["high", "mid", "low"]);
  });

  test("a batch larger than the free slots: the first ones start, the rest wait in order", async () => {
    const { h, enqueue, stats, drain } = setup();
    enqueue({ labels: ["a", "b", "c", "d", "e"], batch: true, poolOptions: { maxParallelism: 3 } });
    expect(stats()).toMatchObject({ running: 3, pending: 2 });
    await h.runDue();
    expect(probe.started).toEqual(["a", "b", "c"]);
    await drain();
    expect(probe.started).toEqual(["a", "b", "c", "d", "e"]);
    expect(probe.max).toBe(3);
  });

  test("with items already queued, a new one waits behind them (no direct start)", async () => {
    const { h, enqueue, status, drain } = setup();
    enqueue({ labels: ["a", "b"], poolOptions: { maxParallelism: 1 } });
    const [c] = enqueue({ labels: ["c"], poolOptions: { maxParallelism: 2 } }); // a slot opens: the queued b goes first
    expect(status(c!)).toEqual({ state: "pending", position: 0 });
    await h.runDue();
    expect(probe.started).toEqual(["a", "b"]);
    await drain();
    expect(probe.started).toEqual(["a", "b", "c"]);
  });

  test("a direct start's job (named by rank and seq) survives plain-JSON args, duplicates and redelivery", async () => {
    for (const priority of [undefined, 5]) {
      const { h, enqueue, status, done, drain } = setup();
      const [a] = enqueue({ labels: ["a"], ...(priority !== undefined ? { item: { priority } } : {}) });
      const job = h.pendingJobs().find((j) => j.fn === "@aiPool/lib:run")!;
      expect(job.args).toMatchObject({ seq: 0, attempt: 1 });
      h.jsonArgs(job.id);
      await drain();
      expect(status(a!)).toEqual({ state: "finished", result: { kind: "success", returnValue: "done:a" } });
      h.redeliver(job.id); // a late redelivery of the finished attempt
      await drain();
      expect(probe.started.filter((l) => l === "a")).toHaveLength(1);
      expect(done().filter((d) => d.context.label === "a")).toHaveLength(1);
      Object.assign(probe, { started: [] });
    }
  });

  test("a direct-start mutation item runs exactly once; its retry uses the item id", async () => {
    const { h, enqueue, status, drain } = setup();
    const [m] = enqueue({ kind: "mutation", labels: ["m1"], item: { fail: true, retry: { maxAttempts: 2, initialBackoffMs: 10, base: 1 } } });
    const first = h.pendingJobs().find((j) => j.fn === "@aiPool/lib:runMutation")!;
    expect(first.args).toMatchObject({ seq: 0, attempt: 1 });
    await drain();
    const retry = h.pendingJobs().find((j) => j.fn === "@aiPool/lib:runMutation")!;
    expect(retry.args).toEqual({ id: m, attempt: 2 });
    h.advance(20);
    await drain();
    expect(status(m!)).toEqual({ state: "finished", result: { kind: "failed", error: "write m1 failed" } });
    expect(h.sql(`SELECT lastError FROM "aiPool$work"`)).toEqual([{ lastError: "write m1 failed" }]);
  });

  test("a batch key is per item: (args, index) => string dedupes each item, not the whole batch", async () => {
    const { enqueue, stats, drain, done } = setup();
    const first = enqueue({ labels: ["x", "y"], batch: true, batchKey: { mode: "label", prefix: "doc" } });
    expect(new Set(first).size).toBe(2);
    // Again with one known and one new label: the known one returns its id, the new one is a new item.
    const again = enqueue({ labels: ["x", "z"], batch: true, batchKey: { mode: "label", prefix: "doc" } });
    expect(again[0]).toBe(first[0]);
    expect(again[1]).not.toBe(first[1]);
    expect(stats()).toMatchObject({ totals: { enqueued: 3 } });
    await drain();
    expect(probe.started.sort()).toEqual(["x", "y", "z"]);
    expect(done()).toHaveLength(3);
  });

  test("a key function that returns the same key for every item still makes one item (the dedup is the component's)", async () => {
    const { h, enqueue, stats, drain } = setup();
    const ids = enqueue({ labels: ["x", "y"], batch: true, batchKey: { mode: "const", prefix: "same" } });
    expect(ids[0]).toBe(ids[1]);
    expect(stats()).toMatchObject({ running: 1, pending: 0, totals: { enqueued: 1 } });
    await drain();
    expect(h.sql(`SELECT COUNT(*) AS n FROM "aiPool$work"`)[0]!.n).toBe(1);
  });

  test("a fixed string key in a batch throws (it would make the batch one item) and enqueues nothing", () => {
    const { h, enqueue } = setup();
    expect(() => enqueue({ labels: ["x", "y"], batch: true, batchKey: { mode: "fixed", prefix: "same" } })).toThrow(/key must be \(args, index\) => string/);
    expect(h.sql(`SELECT COUNT(*) AS n FROM "aiPool$work"`)[0]!.n).toBe(0);
  });

  test("a running item from an older version (job args { id, attempt }) still completes", async () => {
    const { h, enqueue, status, drain } = setup();
    enqueue({ labels: ["first"], poolOptions: { maxParallelism: 1 } });
    const [b] = enqueue({ labels: ["b"] }); // queued: started later by the pump, whose job names the id
    await drain();
    const jobs = [...h.history.values()].filter((e) => e.job.fn === "@aiPool/lib:run").map((e) => e.job.args);
    expect(jobs[1]).toEqual({ id: b, attempt: 1 });
    expect(status(b!)).toMatchObject({ state: "finished" });
  });
});

describe("workpool: writes per finish (PR 4A-5a)", () => {
  test("retention 0 without onComplete: the finished item is deleted unpatched, the pool row written once", async () => {
    const { h, status, stats } = setup();
    const [id] = h.mutate("api:enqueueBare", { labels: ["a"], poolOptions: { retentionMs: 0 } }) as string[];
    h.resetCounters();
    await h.runDue();
    expect(status(id!)).toBeNull();
    expect(h.query("api:status", { id: id! })).toBeNull();
    expect(stats().totals).toMatchObject({ enqueued: 1, succeeded: 1 });
    // The job's mutation: the work's insert, the item's delete and one pool patch (totals); before: + the item's
    // patch to finished. The reclaim tick that ran too finds nothing and leaves (no tick left).
    // node:sqlite usage, before → after: rowsWritten 8 → 4.
    expect(h.counters.rowsWritten).toBeLessThanOrEqual(4);
    expect(h.sql(`SELECT COUNT(*) AS n FROM "aiPool$work"`)[0]!.n).toBe(0);
    h.advance(1000);
    await h.runDue();
    expect(h.pendingJobs()).toEqual([]);
  });

  test("cancelAll over a queue without onComplete writes the pool row once (not once per canceled item)", async () => {
    const { h, stats } = setup();
    h.mutate("api:enqueueBare", { labels: Array.from({ length: 50 }, (_, i) => `i${i}`), poolOptions: { maxParallelism: 1 } });
    h.resetCounters();
    expect(h.mutate("api:cancelAll")).toBe(50);
    // 50 items canceled (the running mutation item's job had not started): 3 rows each (the patch and the by_status
    // aggregate's move), and one pool patch; with a pool patch per item it would be 200.
    expect(h.counters.rowsWritten).toBeLessThanOrEqual(151);
    expect(stats().totals).toMatchObject({ canceled: 50 });
  });

  test("cancelAll with onComplete writes the totals before each callback (it may read stats)", async () => {
    const { h, enqueue, stats } = setup();
    enqueue({ labels: Array.from({ length: 50 }, (_, i) => `i${i}`), poolOptions: { maxParallelism: 1 } });
    await h.runDue();
    h.resetCounters();
    expect(h.mutate("api:cancelAll")).toBe(50);
    // 49 queued items canceled (patch + onComplete's insert + a pool patch with the totals each, as before PR 4A-5a).
    expect(h.counters.rowsWritten).toBeLessThanOrEqual(247);
    expect(stats().totals).toMatchObject({ canceled: 49 }); // the running one finishes as canceled when it returns
  });

  test("an onComplete that reads stats sees its own outcome in the totals; a nested enqueue keeps its totals", async () => {
    const { h, stats, drain } = setup();
    h.mutate("api:enqueueObserved", { labels: ["a", "b"], again: true });
    await drain();
    const seen = h.query("api:seen") as Array<{ label: string; stats: any }>;
    const at = (label: string) => seen.find((s) => s.label === label)!.stats;
    // Each callback runs after its own finish: the finished count and the total agree, and the nested enqueue of an
    // earlier callback is counted.
    expect(at("a")).toMatchObject({ finished: { success: 1 }, totals: { enqueued: 2, succeeded: 1 } });
    expect(at("b").finished.success).toBe(at("b").totals.succeeded);
    expect(at("a+").finished.success).toBe(at("a+").totals.succeeded);
    expect(at("b+")).toMatchObject({ finished: { success: 4 }, totals: { enqueued: 4, succeeded: 4 } });
    expect(stats()).toMatchObject({ pending: 0, running: 0, totals: { enqueued: 4, succeeded: 4 } });
  });

  test("cancelAll: each onComplete sees the cancels so far in the totals", async () => {
    const { h, stats } = setup();
    h.mutate("api:enqueueObserved", { labels: ["r", "q1", "q2", "q3"], maxParallelism: 1 });
    expect(h.mutate("api:cancelAll")).toBe(4);
    const seen = h.query("api:seen") as Array<{ label: string; stats: any }>;
    for (const s of seen) expect(s.stats.totals.canceled).toBe(s.stats.finished.canceled);
    expect(seen.map((s) => s.stats.totals.canceled)).toEqual([1, 2, 3, 4]);
    expect(stats().totals).toMatchObject({ enqueued: 4, canceled: 4 });
  });

  test("a finish that idles the pool does not move its tick (no cancel + schedule per burst)", async () => {
    const { h, enqueue, drain } = setup();
    enqueue({ labels: ["a"], pool: "emailPool" });
    await drain();
    h.resetCounters();
    // A second burst inside the reclaim interval: its start finds the tick in place.
    enqueue({ labels: ["b"], pool: "emailPool" });
    await drain();
    expect(h.counters.scheduled).toEqual({ "@emailPool/lib:run": 1 });
    expect(h.pendingJobs().filter((j) => String(j.fn).endsWith("lib:tick"))).toHaveLength(1);
  });
});
