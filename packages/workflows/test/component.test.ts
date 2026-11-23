// The workflows component end to end on the real engine (node:sqlite), with a small job runner standing in for
// the runtime's scheduler: mutation jobs run in the engine, action jobs run their handler with an ActionCtx that
// resolves references like the runtime does (scope-relative, handles, child public functions).
import {
  anyComponents,
  checkAccess,
  composeApp,
  createEngine,
  defineApp,
  defineSchema,
  defineTable,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
  resolveReference,
  splitFunctionName,
  v,
  type Job,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, test } from "vitest";
import { WorkflowManager, workflows, type WorkflowStep } from "../src/index.ts";

const T0 = 1_700_000_000_000;
const appWith = (maxSteps: number) => defineApp().use(workflows, { config: { maxSteps } });
const app = appWith(20);
const workflow = new WorkflowManager(anyComponents.workflows);

const schema = defineSchema({ tables: { saved: defineTable({ v: v.number() }), finished: defineTable({ outcome: v.any(), context: v.any() }) } });

const probe = { flaky: 0, remoteCalls: 0 };

const steps = {
  double: internalQueryGeneric({ args: { n: v.number() }, handler: (_ctx: any, { n }: { n: number }) => n * 2 }),
  save: internalMutationGeneric({ args: { v: v.number() }, handler: (ctx: any, a: { v: number }) => ctx.db.insert("saved", { v: a.v }) }),
  boom: internalMutationGeneric({
    args: {},
    handler: (ctx: any) => {
      ctx.db.insert("saved", { v: -1 });
      throw new Error("boom");
    },
  }),
  remote: internalActionGeneric({
    args: { v: v.number() },
    handler: async (_ctx: any, { v: x }: { v: number }) => {
      probe.remoteCalls++;
      if (probe.flaky > 0) {
        probe.flaky--;
        throw new Error("upstream 503");
      }
      return x + 100;
    },
  }),
  finished: internalMutationGeneric({ args: { workflowId: v.string(), outcome: v.any(), context: v.any() }, handler: (ctx: any, a: any) => ctx.db.insert("finished", { outcome: a.outcome, context: a.context }) }),
};

const flows = {
  main: workflow.define({
    args: { n: v.number() },
    handler: async (step: WorkflowStep, { n }) => {
      const d = await step.runQuery<number>("steps:double", { n });
      await step.runMutation("steps:save", { v: d });
      await step.sleep(60_000);
      const ev = await step.waitForEvent<{ add: number }>("go", { timeoutMs: 3_600_000 });
      return step.runAction<number>("steps:remote", { v: d + ev.add }, { retry: { maxAttempts: 3, initialBackoffMs: 10 } });
    },
  }),
  catchy: workflow.define({
    handler: async (step: WorkflowStep) => {
      try {
        await step.runMutation("steps:boom");
      } catch (e) {
        return `caught: ${(e as Error).message}`;
      }
    },
  }),
  remoteOnly: workflow.define({ handler: async (step: WorkflowStep) => step.runAction("steps:remote", { v: 1 }, { retry: { maxAttempts: 2, initialBackoffMs: 10 } }) }),
  waitOnly: workflow.define({ handler: async (step: WorkflowStep) => step.waitForEvent("ping", { timeoutMs: 1000 }) }),
  forever: workflow.define({
    handler: async (step: WorkflowStep) => {
      for (;;) await step.runQuery("steps:double", { n: 1 });
    },
  }),
  /** `n` synchronous steps (query + mutation alternating), then the sum. */
  chain: workflow.define({
    args: { n: v.number() },
    handler: async (step: WorkflowStep, { n }) => {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        if (i % 2) await step.runMutation("steps:save", { v: i });
        else sum += await step.runQuery<number>("steps:double", { n: i });
      }
      return sum;
    },
  }),
  /** Two synchronous steps, a sleep, two more. */
  mixed: workflow.define({
    handler: async (step: WorkflowStep) => {
      await step.runMutation("steps:save", { v: 1 });
      const d = await step.runQuery<number>("steps:double", { n: 2 });
      await step.sleep(1000);
      await step.runMutation("steps:save", { v: d });
      return step.runQuery<number>("steps:double", { n: d });
    },
  }),
};

/** Not made by workflow.define: returns whatever outcome the workflow args say (a misused driver handle). */
const rogue = internalActionGeneric({ args: { workflowId: v.string(), args: v.any(), journal: v.any() }, handler: async (_ctx: any, a: any) => a.args.outcome });

const api = {
  start: mutationGeneric({
    args: { flow: v.string(), args: v.optional(v.any()), fail: v.optional(v.boolean()) },
    handler: (ctx: any, a: { flow: string; args?: unknown; fail?: boolean }) => {
      const id = workflow.start(ctx, a.flow.includes(":") ? a.flow : `flows:${a.flow}`, a.args ?? {}, { onComplete: "steps:finished", context: { flow: a.flow } });
      if (a.fail) throw new Error("caller failed");
      return id;
    },
  }),
  event: mutationGeneric({ args: { id: v.string(), event: v.string(), payload: v.optional(v.any()) }, handler: (ctx: any, a: any) => workflow.sendEvent(ctx, a.id, a.event, a.payload) }),
  cancel: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => workflow.cancel(ctx, a.id) }),
  cleanup: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => workflow.cleanup(ctx, a.id) }),
  status: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => workflow.status(ctx, a.id) }),
  finished: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("finished").collect().map((d: any) => ({ outcome: d.outcome, context: d.context })) }),
};

type Counters = { rowsRead: number; rowsWritten: number; scheduled: Record<string, number>; calls: Record<string, number> };

/**
 * Usage measured on the node:sqlite driver (rows returned / changed), before PR 2D → after:
 * `chain` n = 2: rowsWritten 11 → 7, rowsRead 16 → 7; n = 40: rowsRead 985 → 95, rowsWritten 182 → 102, drive jobs
 * 40 → 2 after the first. Rows read are still O(n²) in steps (each drive job reloads the whole journal), but the
 * journal is reloaded once per LOCAL_STEPS steps instead of once per step.
 */
const BUDGET = { chain2Written: 7, chain2Read: 7, chain40Read: 95, chain40Written: 102 };

function harness(opts: { app?: ReturnType<typeof appWith>; failMutation?: (name: string, n: number) => "before" | "after" | undefined } = {}) {
  let now = T0;
  const composed = composeApp({ schema, functions: { steps, flows, api, rogue: { driver: rogue } }, app: opts.app ?? app });
  const driver = createNodeSqliteDriver();
  const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver, now: () => now });
  engine.migrate();
  const fns = new Map(Object.entries(composed.functions));
  let jobs: Job[] = [];
  const counters: Counters = { rowsRead: 0, rowsWritten: 0, scheduled: {}, calls: {} };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const commit = (r: { scheduled: Job[]; cancelled: string[] }) => {
    jobs.push(...r.scheduled);
    for (const j of r.scheduled) bump(counters.scheduled, j.fn);
    jobs = jobs.filter((j) => !r.cancelled.includes(j.id));
  };
  const injected = (e: unknown) => e instanceof Error && e.message.startsWith("injected failure ");
  const mutate = (name: string, args: unknown) => {
    const n = bump(counters.calls, name);
    const fail = opts.failMutation?.(name, n);
    if (fail === "before") throw new Error(`injected failure before ${name}`);
    const r = engine.runMutation(name, args);
    counters.rowsRead += r.usage?.rowsRead ?? 0;
    counters.rowsWritten += r.usage?.rowsWritten ?? 0;
    commit(r);
    if (fail === "after") throw new Error(`injected failure after ${name}`);
    return r.value;
  };
  const query = (name: string, args: unknown) => {
    bump(counters.calls, name);
    const r = engine.runQuery(name, args);
    counters.rowsRead += r.usage?.rowsRead ?? 0;
    return r.value;
  };
  const ctxFor = (name: string): any => {
    const path = splitFunctionName(name).path;
    const res = (ref: unknown) => checkAccess(fns as any, resolveReference(path, ref as any)) && resolveReference(path, ref as any).name;
    return {
      runQuery: async (ref: unknown, a?: unknown) => query(res(ref) as string, a ?? {}),
      runMutation: async (ref: unknown, a?: unknown) => mutate(res(ref) as string, a ?? {}),
      runAction: async (ref: unknown, a?: unknown) => runAction(res(ref) as string, a ?? {}),
      env: {},
      now,
    };
  };
  const runAction = async (name: string, args: unknown) => (fns.get(name) as any).handler(ctxFor(name), args);
  /**
   * Runs due jobs (in run_at order) until none is due. An action job that fails on an injected failure is retried
   * (like the queue), up to 5 times; any other error fails the test at once.
   */
  const tick = async (limit?: number) => {
    for (let i = 0; i < (limit ?? 200); i++) {
      const due = jobs.filter((j) => j.runAt <= now).sort((a, b) => a.runAt - b.runAt)[0];
      if (!due) return;
      jobs = jobs.filter((j) => j !== due);
      if (due.kind === "mutation") mutate(due.fn, due.args);
      else {
        for (let attempt = 1; ; attempt++) {
          try {
            await runAction(due.fn, due.args);
            break;
          } catch (e) {
            if (!injected(e) || attempt >= 5) throw e;
          }
        }
      }
    }
    if (limit === undefined) throw new Error("tick: too many jobs");
  };
  const sql = (s: string) => driver.exec(s).rows;
  return {
    engine,
    counters,
    resetCounters: () => Object.assign(counters, { rowsRead: 0, rowsWritten: 0, scheduled: {}, calls: {} }),
    jobs: () => jobs,
    pushJob: (j: Job) => jobs.push(j),
    /** Runs an action job's handler now, outside `tick` (to overlap two deliveries of one job). */
    runJob: (j: Job) => runAction(j.fn, j.args),
    mutate,
    tick,
    advance: (ms: number) => (now += ms),
    status: (id: string) => mutate("api:status", { id }) as any,
    finished: () => engine.runQuery("api:finished").value as Array<{ outcome: unknown; context: unknown }>,
    sql,
  };
}

describe("workflows component", () => {
  test("runs query, mutation, sleep, event and action steps; onComplete in the finishing transaction", async () => {
    probe.flaky = 0;
    const h = harness();
    const id = h.mutate("api:start", { flow: "main", args: { n: 5 } }) as string;
    expect(h.status(id)).toMatchObject({ status: "running", stepCount: 0 });
    await h.tick();
    expect(h.sql(`SELECT v FROM saved`)).toEqual([{ v: 10 }]);
    expect(h.status(id)).toMatchObject({ status: "running", stepCount: 3, current: { kind: "sleep", runAt: T0 + 60_000 } });
    h.advance(60_000);
    await h.tick();
    expect(h.status(id).current).toMatchObject({ kind: "event", name: "event:go" });
    expect(h.mutate("api:event", { id, event: "go", payload: { add: 1 } })).toBe(true);
    await h.tick();
    expect(h.status(id)).toMatchObject({ status: "completed", result: 111, stepCount: 5 });
    expect(h.finished()).toEqual([{ outcome: { kind: "success", result: 111 }, context: { flow: "main" } }]);
    expect(h.jobs()).toEqual([]);
  });

  test("starting is atomic with the caller: a failing caller leaves no workflow and no job", () => {
    const h = harness();
    expect(() => h.mutate("api:start", { flow: "main", args: { n: 1 }, fail: true })).toThrow("caller failed");
    expect(h.sql(`SELECT COUNT(*) AS n FROM "workflows$workflows"`)[0]!.n).toBe(0);
    expect(h.jobs()).toEqual([]);
  });

  test("a mutation step commits exactly once even when drive jobs are duplicated", async () => {
    const h = harness();
    const id = h.mutate("api:start", { flow: "main", args: { n: 2 } }) as string;
    // Duplicate every drive job (the queue delivers actions at least once).
    for (let i = 0; i < 4; i++) {
      for (const j of h.jobs().filter((j) => j.fn.endsWith("lib:drive"))) h.pushJob({ ...j, id: `${j.id}-dup${i}` });
      await h.tick(1);
    }
    await h.tick();
    expect(h.sql(`SELECT v FROM saved`)).toEqual([{ v: 4 }]);
    expect(h.status(id)).toMatchObject({ stepCount: 3, current: { kind: "sleep" } });
  });

  test("a failing mutation step is undone and rejects in the handler", async () => {
    const h = harness();
    const id = h.mutate("api:start", { flow: "catchy" }) as string;
    await h.tick();
    expect(h.status(id)).toMatchObject({ status: "completed", result: "caught: boom" });
    expect(h.sql(`SELECT COUNT(*) AS n FROM saved`)[0]!.n).toBe(0);
  });

  test("action steps retry with backoff; exhausted retries fail the workflow", async () => {
    const h = harness();
    probe.flaky = 1;
    const ok = h.mutate("api:start", { flow: "remoteOnly" }) as string;
    await h.tick();
    expect(h.status(ok).current).toMatchObject({ kind: "action", attempts: 1 });
    h.advance(10);
    await h.tick();
    expect(h.status(ok)).toMatchObject({ status: "completed", result: 101 });

    probe.flaky = 5;
    const bad = h.mutate("api:start", { flow: "remoteOnly" }) as string;
    await h.tick();
    h.advance(10);
    await h.tick();
    expect(h.status(bad)).toMatchObject({ status: "failed", error: "upstream 503" });
    expect(h.finished().at(-1)!.outcome).toEqual({ kind: "failed", error: "upstream 503" });
    probe.flaky = 0;
  });

  test("events sent before the wait are buffered; a wait times out", async () => {
    const h = harness();
    const early = h.mutate("api:start", { flow: "waitOnly" }) as string;
    expect(h.mutate("api:event", { id: early, event: "ping", payload: 42 })).toBe(true);
    await h.tick();
    expect(h.status(early)).toMatchObject({ status: "completed", result: 42 });

    const late = h.mutate("api:start", { flow: "waitOnly" }) as string;
    await h.tick();
    h.advance(1000);
    await h.tick();
    expect(h.status(late)).toMatchObject({ status: "failed", error: "timed out waiting for event ping" });
    expect(h.mutate("api:event", { id: late, event: "ping" })).toBe(false);
  });

  test("cancel stops a sleeping workflow, removes its pending job and calls onComplete", async () => {
    const h = harness();
    const id = h.mutate("api:start", { flow: "main", args: { n: 1 } }) as string;
    await h.tick();
    expect(h.jobs().map((j) => j.fn)).toEqual(["@workflows/lib:wake"]);
    expect(h.mutate("api:cancel", { id })).toBe(true);
    expect(h.jobs()).toEqual([]);
    expect(h.status(id)).toMatchObject({ status: "canceled" });
    expect(h.mutate("api:cancel", { id })).toBe(false);
    expect(h.finished()[0]!.outcome).toEqual({ kind: "canceled" });
    expect(h.mutate("api:cleanup", { id })).toBe(true);
    expect(h.status(id)).toBeNull();
    expect(h.sql(`SELECT COUNT(*) AS n FROM "workflows$steps"`)[0]!.n).toBe(0);
  });

  test("maxSteps (install config) stops runaway loops", async () => {
    const h = harness();
    const id = h.mutate("api:start", { flow: "forever" }) as string;
    await h.tick();
    expect(h.status(id)).toMatchObject({ status: "failed", error: "workflow exceeded 20 steps", stepCount: 20 });
  });

  test("a driver outcome that is not a step for the current index fails the workflow instead of stalling it", async () => {
    const step = { kind: "query", name: "q", fn: "&steps:double", args: { n: 1 } };
    for (const [outcome, why] of [
      [{ type: "step", index: 5, step }, /InvalidOutcome: .*"index":5.*step 0/],
      [{ type: "bogus" }, /InvalidOutcome: .*bogus/],
      [{ type: "step", index: 0, step: { kind: "teleport", name: "t" } }, /InvalidOutcome: .*teleport/],
      [null, /invalid outcome: null/],
      [{ type: "waiting" }, /InvalidOutcome: .*"waiting" for step 0 but no step is pending/],
    ] as const) {
      const h = harness();
      const id = h.mutate("api:start", { flow: "rogue:driver", args: { outcome } }) as string;
      await h.tick();
      const st = h.status(id);
      expect(st.status).toBe("failed");
      expect(st.error).toMatch(why);
      expect(st.stepCount).toBe(0);
      expect(h.finished()).toEqual([{ outcome: { kind: "failed", error: st.error }, context: { flow: "rogue:driver" } }]);
      expect(h.jobs()).toEqual([]);
    }
  });

  test("synchronous steps run inline in one drive job (LOCAL_STEPS per job), one journal read per job", async () => {
    const h = harness({ app: appWith(100) });
    const id = h.mutate("api:start", { flow: "chain", args: { n: 40 } }) as string;
    h.resetCounters();
    await h.tick();
    expect(h.counters.rowsRead).toBeLessThanOrEqual(BUDGET.chain40Read);
    expect(h.counters.rowsWritten).toBeLessThanOrEqual(BUDGET.chain40Written);
    // sum of double(i) for even i < 40
    expect(h.status(id)).toMatchObject({ status: "completed", result: 760, stepCount: 40 });
    expect(h.sql(`SELECT COUNT(*) AS n FROM saved`)[0]!.n).toBe(20);
    // 40 steps + done = 41 advances: 16 + 16 + 9 → 3 drive runs (the start's job + 2; was 1 + 40) and 3 journal loads (was 41)
    expect(h.counters.scheduled["@workflows/lib:drive"]).toBe(2);
    expect(h.counters.calls["@workflows/lib:load"]).toBe(3);
    expect(h.counters.calls["@workflows/lib:advance"]).toBe(41);
    expect(h.jobs()).toEqual([]);
  });

  test("one insert per synchronous step and one patch of the workflow (no write-then-patch)", async () => {
    const h = harness({ app: appWith(100) });
    h.mutate("api:start", { flow: "chain", args: { n: 2 } });
    h.resetCounters();
    await h.tick();
    // advance ×3 (query step, mutation step, done) + the app's own insert in steps:save
    const rows = h.sql(`SELECT kind, status, attempts FROM "workflows$steps" ORDER BY "index"`);
    expect(rows).toEqual([
      { kind: "query", status: "done", attempts: 1 },
      { kind: "mutation", status: "done", attempts: 1 },
    ]);
    expect(h.counters.rowsWritten).toBeLessThanOrEqual(BUDGET.chain2Written);
    expect(h.counters.rowsRead).toBeLessThanOrEqual(BUDGET.chain2Read);
    expect(h.counters.scheduled["@workflows/lib:drive"]).toBeUndefined();
  });

  test("a sleep in the middle hands over to a job; the steps after it run inline again", async () => {
    const h = harness();
    const id = h.mutate("api:start", { flow: "mixed" }) as string;
    await h.tick();
    expect(h.status(id)).toMatchObject({ status: "running", stepCount: 3, current: { kind: "sleep" } });
    expect(h.counters.scheduled["@workflows/lib:drive"]).toBe(1);
    h.advance(1000);
    await h.tick();
    expect(h.status(id)).toMatchObject({ status: "completed", result: 8, stepCount: 5 });
    expect(h.counters.scheduled["@workflows/lib:drive"]).toBe(2);
    expect(h.sql(`SELECT v FROM saved ORDER BY v`)).toEqual([{ v: 1 }, { v: 4 }]);
  });

  test("a drive run that dies after an inline advance committed is resumed by the job's retry (exactly once)", async () => {
    for (const when of ["after", "before"] as const) {
      // The 3rd advance (step 2 of the inline run) fails once, after or before its commit.
      const h = harness({ app: appWith(100), failMutation: (name, n) => (name === "@workflows/lib:advance" && n === 3 ? when : undefined) });
      const id = h.mutate("api:start", { flow: "chain", args: { n: 6 } }) as string;
      await h.tick();
      expect(h.status(id)).toMatchObject({ status: "completed", result: 12, stepCount: 6 });
      // steps:save ran for i = 1, 3, 5: once each
      expect(h.sql(`SELECT v FROM saved ORDER BY v`)).toEqual([{ v: 1 }, { v: 3 }, { v: 5 }]);
      expect(h.counters.scheduled["@workflows/lib:drive"]).toBe(1);
      expect(h.jobs()).toEqual([]);
    }
  });

  test("duplicate and stale drive jobs stay no-ops around inline runs", async () => {
    const h = harness({ app: appWith(100) });
    const id = h.mutate("api:start", { flow: "chain", args: { n: 20 } }) as string;
    const first = h.jobs()[0]!;
    // Two deliveries of the first drive job: both replay, the fence on the step index lets one advance each step.
    h.pushJob({ ...first, id: `${first.id}-dup` });
    await h.tick();
    expect(h.status(id)).toMatchObject({ status: "completed", stepCount: 20 });
    expect(h.sql(`SELECT COUNT(*) AS n FROM saved`)[0]!.n).toBe(10);
    // A late duplicate of a drive job of a finished run does nothing.
    const before = { ...h.counters.calls };
    h.pushJob({ ...first, id: `${first.id}-late` });
    h.pushJob({ ...first, id: `${first.id}-late16`, args: { id, index: 16 } });
    await h.tick();
    expect(h.counters.calls["@workflows/lib:advance"]).toBe(before["@workflows/lib:advance"]);
    expect(h.sql(`SELECT COUNT(*) AS n FROM saved`)[0]!.n).toBe(10);
  });

  test("a duplicate delivery that arrives while the first run is still inline races on the fence: each step once", async () => {
    for (const at of [2, 5, 15]) {
      let dup: Promise<unknown> | undefined;
      let first: Job | undefined;
      // Right before the first run's advance number `at` + 1, a second delivery of the same drive job starts: it
      // sees `driving` = its index and resumes from the step count, overlapping the first run.
      const h = harness({
        app: appWith(100),
        failMutation: (name, n) => {
          if (name === "@workflows/lib:advance" && n === at + 1 && first) dup = h.runJob({ ...first, id: `${first.id}-dup` });
          return undefined;
        },
      });
      const id = h.mutate("api:start", { flow: "chain", args: { n: 20 } }) as string;
      first = h.jobs()[0]!;
      await h.tick();
      await dup;
      await h.tick();
      expect(dup).toBeDefined();
      expect(h.status(id)).toMatchObject({ status: "completed", result: 180, stepCount: 20 });
      // steps:save ran for each odd i < 20 exactly once; one journal row per step
      expect(h.sql(`SELECT v FROM saved ORDER BY v`)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19].map((v) => ({ v })));
      expect(h.sql(`SELECT COUNT(*) AS n FROM "workflows$steps"`)[0]!.n).toBe(20);
      // the duplicate did resume (it loaded the journal and reached the fence) and lost at least one advance
      expect(h.counters.calls["@workflows/lib:load"]).toBe(3); // 16 + 5 advances: 2 runs, + the duplicate
      expect(h.counters.calls["@workflows/lib:advance"]).toBeGreaterThan(21);
      expect(h.jobs()).toEqual([]);
    }
  });

  test("a stale drive job of a run that handed over to a job (driving cleared) does not run the driver", async () => {
    const h = harness();
    const id = h.mutate("api:start", { flow: "mixed" }) as string;
    const first = h.jobs()[0]!;
    await h.tick();
    expect(h.status(id).current).toMatchObject({ kind: "sleep" });
    const advances = h.counters.calls["@workflows/lib:advance"];
    h.pushJob({ ...first, id: `${first.id}-retry` }); // e.g. a retry of the first run after it had finished
    await h.tick();
    expect(h.counters.calls["@workflows/lib:advance"]).toBe(advances);
    h.advance(1000);
    await h.tick();
    expect(h.status(id)).toMatchObject({ status: "completed", result: 8 });
  });

  test("events: a buffered event settles inline; a waiting one settles in one write and drives on", async () => {
    const h = harness();
    const early = h.mutate("api:start", { flow: "waitOnly" }) as string;
    h.mutate("api:event", { id: early, event: "ping", payload: 1 });
    await h.tick();
    expect(h.status(early)).toMatchObject({ status: "completed", result: 1 });
    expect(h.counters.scheduled["@workflows/lib:drive"]).toBe(1);

    const late = h.mutate("api:start", { flow: "waitOnly" }) as string;
    await h.tick();
    expect(h.jobs().map((j) => j.fn)).toEqual(["@workflows/lib:wake"]);
    expect(h.mutate("api:event", { id: late, event: "ping", payload: 2 })).toBe(true);
    expect(h.jobs().map((j) => j.fn)).toEqual(["@workflows/lib:drive"]); // the timeout is cancelled
    await h.tick();
    expect(h.status(late)).toMatchObject({ status: "completed", result: 2 });
    // cancel after the end, with the stale job id left on the row: false, no throw
    expect(h.mutate("api:cancel", { id: late })).toBe(false);
  });

  test("cancel with a stale pendingJob (the action that already ran) cancels the next job only", async () => {
    probe.flaky = 0;
    const h = harness();
    const id = h.mutate("api:start", { flow: "main", args: { n: 1 } }) as string;
    await h.tick();
    h.advance(60_000);
    await h.tick(); // wake → drive → waiting on the event (timeout job)
    expect(h.jobs().map((j) => j.fn)).toEqual(["@workflows/lib:wake"]);
    expect(h.mutate("api:cancel", { id })).toBe(true);
    expect(h.jobs()).toEqual([]);
    expect(h.status(id)).toMatchObject({ status: "canceled" });
  });

  test("cleanup deletes the workflow at once and a long journal in batches of CLEANUP_BATCH", async () => {
    const h = harness({ app: appWith(1000) });
    const id = h.mutate("api:start", { flow: "chain", args: { n: 450 } }) as string;
    await h.tick(400);
    expect(h.status(id)).toMatchObject({ status: "completed", stepCount: 450 });
    h.resetCounters();
    expect(h.mutate("api:cleanup", { id })).toBe(true);
    expect(h.status(id)).toBeNull();
    expect(h.sql(`SELECT COUNT(*) AS n FROM "workflows$steps"`)[0]!.n).toBe(250);
    expect(h.jobs().map((j) => j.fn)).toEqual(["@workflows/lib:cleanupRest"]);
    await h.tick();
    expect(h.sql(`SELECT COUNT(*) AS n FROM "workflows$steps"`)[0]!.n).toBe(0);
    expect(h.counters.scheduled["@workflows/lib:cleanupRest"]).toBe(2); // 200 + 200 + 50
    expect(h.counters.calls["@workflows/lib:cleanupRest"]).toBe(2);
    expect(h.jobs()).toEqual([]);
    expect(h.mutate("api:cleanup", { id })).toBe(false);
  });

  test("cleanup of a journal of exactly CLEANUP_BATCH rows schedules no follow-up job", async () => {
    const h = harness({ app: appWith(1000) });
    const id = h.mutate("api:start", { flow: "chain", args: { n: 200 } }) as string;
    await h.tick(400);
    expect(h.status(id)).toMatchObject({ status: "completed", stepCount: 200 });
    expect(h.mutate("api:cleanup", { id })).toBe(true);
    expect(h.sql(`SELECT COUNT(*) AS n FROM "workflows$steps"`)[0]!.n).toBe(0);
    expect(h.jobs()).toEqual([]);
  });

  test("cleanup with a short journal deletes everything in one transaction, events included", async () => {
    const h = harness();
    const id = h.mutate("api:start", { flow: "main", args: { n: 1 } }) as string;
    await h.tick();
    h.mutate("api:event", { id, event: "other", payload: 1 }); // buffered, never consumed
    h.mutate("api:cancel", { id });
    expect(h.mutate("api:cleanup", { id })).toBe(true);
    expect(h.sql(`SELECT COUNT(*) AS n FROM "workflows$events"`)[0]!.n).toBe(0);
    expect(h.sql(`SELECT COUNT(*) AS n FROM "workflows$steps"`)[0]!.n).toBe(0);
    expect(h.jobs()).toEqual([]);
  });

    test("the app cannot reach the component's internal loop functions", () => {
    const h = harness();
    expect(() =>
      h.engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.runMutation("@workflows/lib:advance", { id: "x", index: 0, outcome: {} }) }) as any),
    ).toThrow(/not found/);
  });
});
