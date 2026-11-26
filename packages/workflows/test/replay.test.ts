import { describe, expect, test } from "vitest";
import { makeFunctionReference } from "@freecorps/ember-values";
import { replay, StepFailed, type JournalEntry, type WorkflowStep } from "../src/replay.ts";

const math = {
  double: makeFunctionReference<"query", { n: number }, number>("math:double"),
  save: makeFunctionReference<"mutation", { v: number }, number>("math:save"),
  remote: makeFunctionReference<"action", { v: number }, number>("math:remote"),
};

const flow = async (step: WorkflowStep, args: { n: number }) => {
  const a = await step.runQuery(math.double, { n: args.n });
  const b = await step.runMutation(math.save, { v: a }, { name: "save" });
  await step.sleep(1000);
  const ev = await step.waitForEvent<{ x: number }>("go", { timeoutMs: 5000 });
  const c = await step.runAction(math.remote, { v: b + ev.x }, { retry: { maxAttempts: 3 } });
  return c * 10;
};

const done = (index: number, kind: JournalEntry["kind"], name: string, result: unknown): JournalEntry => ({ index, kind, name, status: "done", result });
const run = (journal: JournalEntry[], handler: any = flow) => replay(handler, { workflowId: "wf_1", args: { n: 2 }, journal });

describe("replay", () => {
  test("an empty journal asks for the first step", async () => {
    expect(await run([])).toEqual({ type: "step", index: 0, step: { kind: "query", name: "math:double", fn: "&math:double", args: { n: 2 } } });
  });

  test("journaled steps resolve with their results; the next one is requested", async () => {
    const j = [done(0, "query", "math:double", 4), done(1, "mutation", "save", 4)];
    expect(await run(j)).toEqual({ type: "step", index: 2, step: { kind: "sleep", name: "sleep", ms: 1000 } });
    j.push(done(2, "sleep", "sleep", null));
    expect(await run(j)).toEqual({ type: "step", index: 3, step: { kind: "event", name: "event:go", event: "go", timeoutMs: 5000 } });
    j.push(done(3, "event", "event:go", { x: 1 }));
    expect(await run(j)).toEqual({
      type: "step",
      index: 4,
      step: { kind: "action", name: "math:remote", fn: "&math:remote", args: { v: 5 }, retry: { maxAttempts: 3 } },
    });
    j.push(done(4, "action", "math:remote", 7));
    expect(await run(j)).toEqual({ type: "done", result: 70 });
  });

  test("a failed step rejects in the handler (catchable); uncaught it fails the workflow", async () => {
    const failed: JournalEntry = { index: 0, kind: "action", name: "x:y", status: "failed", error: "boom" };
    const catching = async (step: WorkflowStep) => {
      try {
        await step.runAction("x:y");
      } catch (e) {
        return `caught ${(e as StepFailed).message} (${(e as StepFailed).step})`;
      }
    };
    expect(await run([failed], catching)).toEqual({ type: "done", result: "caught boom (x:y)" });
    expect(await run([failed], async (step: WorkflowStep) => step.runAction("x:y"))).toEqual({ type: "failed", error: "boom" });
  });

  test("a journal that does not match the code is a NonDeterminism failure, even if caught", async () => {
    const j = [done(0, "mutation", "other:thing", 1)];
    const out = await run(j);
    expect(out).toMatchObject({ type: "failed" });
    expect((out as any).error).toMatch(/^NonDeterminism: step 0/);
    const swallow = async (step: WorkflowStep) => {
      try {
        await step.runQuery("math:double");
      } catch {}
      return "ok";
    };
    expect((await run(j, swallow)).type).toBe("failed");
  });

  test("a journal ending in a pending step (stale duplicate run) is 'waiting'", async () => {
    expect(await run([{ index: 0, kind: "query", name: "math:double", status: "pending" }])).toEqual({ type: "waiting" });
  });

  test("references: api objects and names become handles; handler errors fail the workflow", async () => {
    const ref = makeFunctionReference<"mutation">("dir/mod:fn");
    expect(await run([], async (step: WorkflowStep) => step.runMutation(ref))).toMatchObject({ step: { fn: "&dir/mod:fn", name: "dir/mod:fn" } });
    expect(await run([], async () => {
      throw new Error("bad input");
    })).toEqual({ type: "failed", error: "bad input" });
    expect(await run([], async () => undefined)).toEqual({ type: "done" });
  });

  test("a step not awaited still wins over the handler finishing (it must run first)", async () => {
    const fireAndForget = async (step: WorkflowStep) => {
      void step.runMutation("a:b");
      return 1;
    };
    expect(await run([], fireAndForget)).toMatchObject({ type: "step", index: 0 });
    expect(await run([done(0, "mutation", "a:b", null)], fireAndForget)).toEqual({ type: "done", result: 1 });
  });

  test("steps started together are one batch, by call order; the handler goes on once all settled", async () => {
    const par = async (step: WorkflowStep) => {
      const [a, b] = await Promise.all([step.runAction(math.remote, { v: 1 }), step.runAction(math.remote, { v: 2 }, { name: "second" })]);
      return step.runMutation(math.save, { v: a + b });
    };
    const req = (v: number, name = "math:remote") => ({ kind: "action", name, fn: "&math:remote", args: { v } });
    expect(await run([], par)).toEqual({ type: "steps", index: 0, steps: [req(1), req(2, "second")] });
    // One settled, the other still running: wait (never ask for the next step while a sibling runs).
    expect(await run([done(0, "action", "math:remote", 10), { index: 1, kind: "action", name: "second", status: "pending" }], par)).toEqual({ type: "waiting" });
    expect(await run([{ index: 0, kind: "action", name: "math:remote", status: "pending" }, done(1, "action", "second", 20)], par)).toEqual({ type: "waiting" });
    const both = [done(0, "action", "math:remote", 10), done(1, "action", "second", 20)];
    expect(await run(both, par)).toEqual({ type: "step", index: 2, step: { kind: "mutation", name: "math:save", fn: "&math:save", args: { v: 30 } } });
    expect(await run([...both, done(2, "mutation", "math:save", 30)], par)).toEqual({ type: "done", result: 30 });
  });

  test("branches that continue after their own steps: each round is one batch, the same on every replay", async () => {
    const branch = async (step: WorkflowStep, n: number) => step.runQuery(math.double, { n: (await step.runQuery(math.double, { n })) + 1 });
    const par = async (step: WorkflowStep) => Promise.all([branch(step, 1), branch(step, 5)]);
    const q = (n: number) => ({ kind: "query", name: "math:double", fn: "&math:double", args: { n } });
    expect(await run([], par)).toEqual({ type: "steps", index: 0, steps: [q(1), q(5)] });
    const j = [done(0, "query", "math:double", 2), done(1, "query", "math:double", 10)];
    for (let i = 0; i < 3; i++) expect(await run(j, par)).toEqual({ type: "steps", index: 2, steps: [q(3), q(11)] });
    j.push(done(2, "query", "math:double", 6), done(3, "query", "math:double", 22));
    expect(await run(j, par)).toEqual({ type: "done", result: [6, 22] });
  });

  test("a parallel step that failed rejects in Promise.all (caught), after the batch settled", async () => {
    const par = async (step: WorkflowStep) => {
      try {
        await Promise.all([step.runAction(math.remote, { v: 1 }), step.sleep(10)]);
      } catch (e) {
        return `caught ${(e as Error).message}`;
      }
    };
    const failed: JournalEntry = { index: 0, kind: "action", name: "math:remote", status: "failed", error: "boom" };
    expect(await run([failed, { index: 1, kind: "sleep", name: "sleep", status: "pending" }], par)).toEqual({ type: "waiting" });
    expect(await run([failed, done(1, "sleep", "sleep", null)], par)).toEqual({ type: "done", result: "caught boom" });
  });

  test("a batch whose journal no longer matches the code is a NonDeterminism failure", async () => {
    const par = async (step: WorkflowStep) => Promise.all([step.runQuery(math.double, { n: 1 }), step.runAction(math.remote, { v: 1 })]);
    const out = await run([done(0, "query", "math:double", 2), done(1, "query", "math:double", 2)], par);
    expect(out).toMatchObject({ type: "failed" });
    expect((out as { error: string }).error).toMatch(/^NonDeterminism: step 1/);
  });
});
