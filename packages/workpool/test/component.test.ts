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
};

type EnqueueReq = { pool?: string; kind?: "action" | "mutation"; labels: string[]; poolOptions?: WorkpoolOptions; item?: EnqueueOptions & { fail?: boolean }; batch?: boolean; thenFail?: boolean };
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
      else if (req.batch) ids = pool.enqueueActionBatch(ctx, unsafeRef<"action">("work:call"), req.labels.map((label) => ({ label })), opts("batch"));
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

  test("an idle pool has no reclaim tick: the one tick waits for the GC window of its oldest result", async () => {
    const { h, enqueue, drain } = setup();
    const ticks = () => h.pendingJobs().filter((j) => String(j.fn).endsWith("lib:tick"));
    enqueue({ labels: ["a"], pool: "emailPool" });
    // While it runs: the reclaim tick, one interval (5 min by default) out.
    expect(ticks().map((j) => j.runAt - h.now())).toEqual([5 * 60_000]);
    await drain();
    // Done and idle: no tick before the result expires (1 day), on a 15-minute boundary.
    const finishedAt = h.now();
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
