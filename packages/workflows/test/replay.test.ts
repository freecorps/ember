import { describe, expect, test } from "vitest";
import { replay, StepFailed, type JournalEntry, type WorkflowStep } from "../src/replay.ts";

const flow = async (step: WorkflowStep, args: { n: number }) => {
  const a = await step.runQuery<number>("math:double", { n: args.n });
  const b = await step.runMutation<number>("math:save", { v: a }, { name: "save" });
  await step.sleep(1000);
  const ev = await step.waitForEvent<{ x: number }>("go", { timeoutMs: 5000 });
  const c = await step.runAction<number>("math:remote", { v: b + ev.x }, { retry: { maxAttempts: 3 } });
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
    const ref = { [Symbol.for("ember.functionName")]: "dir/mod:fn" };
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
});
