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
const app = defineApp().use(workflows, { config: { maxSteps: 20 } });
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

function harness() {
  let now = T0;
  const composed = composeApp({ schema, functions: { steps, flows, api, rogue: { driver: rogue } }, app });
  const driver = createNodeSqliteDriver();
  const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver, now: () => now });
  engine.migrate();
  const fns = new Map(Object.entries(composed.functions));
  let jobs: Job[] = [];
  const commit = (r: { scheduled: Job[]; cancelled: string[] }) => {
    jobs.push(...r.scheduled);
    jobs = jobs.filter((j) => !r.cancelled.includes(j.id));
  };
  const mutate = (name: string, args: unknown) => {
    const r = engine.runMutation(name, args);
    commit(r);
    return r.value;
  };
  const ctxFor = (name: string): any => {
    const path = splitFunctionName(name).path;
    const res = (ref: unknown) => checkAccess(fns as any, resolveReference(path, ref as any)) && resolveReference(path, ref as any).name;
    return {
      runQuery: async (ref: unknown, a?: unknown) => engine.runQuery(res(ref) as string, a ?? {}).value,
      runMutation: async (ref: unknown, a?: unknown) => mutate(res(ref) as string, a ?? {}),
      runAction: async (ref: unknown, a?: unknown) => runAction(res(ref) as string, a ?? {}),
      env: {},
      now,
    };
  };
  const runAction = async (name: string, args: unknown) => (fns.get(name) as any).handler(ctxFor(name), args);
  /** Runs due jobs (in run_at order) until none is due. Failing action jobs are retried (like the queue). */
  const tick = async (limit?: number) => {
    for (let i = 0; i < (limit ?? 200); i++) {
      const due = jobs.filter((j) => j.runAt <= now).sort((a, b) => a.runAt - b.runAt)[0];
      if (!due) return;
      jobs = jobs.filter((j) => j !== due);
      if (due.kind === "mutation") mutate(due.fn, due.args);
      else await runAction(due.fn, due.args);
    }
    if (limit === undefined) throw new Error("tick: too many jobs");
  };
  const sql = (s: string) => driver.exec(s).rows;
  return {
    engine,
    jobs: () => jobs,
    pushJob: (j: Job) => jobs.push(j),
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

    test("the app cannot reach the component's internal loop functions", () => {
    const h = harness();
    expect(() =>
      h.engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.runMutation("@workflows/lib:advance", { id: "x", index: 0, outcome: {} }) }) as any),
    ).toThrow(/not found/);
  });
});
