// Types of `step.run*`: args and result come from the reference (checked by `tsc -b`; the test body is trivial).
import { makeFunctionReference, unsafeRef } from "@freecorps/ember-values";
import { expectTypeOf, test } from "vitest";
import type { WorkflowStep } from "../src/index.ts";

const double = makeFunctionReference<"query", { n: number }, number>("m:double");
const save = makeFunctionReference<"mutation", { v: string }, { id: string }>("m:save");
const ping = makeFunctionReference<"action", {}, "pong">("m:ping");

test("step.runQuery / runMutation / runAction are typed by the reference", () => {
  const typed = async (step: WorkflowStep) => {
    expectTypeOf(step.runQuery(double, { n: 1 })).toEqualTypeOf<Promise<number>>();
    expectTypeOf(step.runMutation(save, { v: "x" }, { name: "save" })).toEqualTypeOf<Promise<{ id: string }>>();
    expectTypeOf(step.runAction(ping)).toEqualTypeOf<Promise<"pong">>();
    expectTypeOf(step.runAction(ping, {}, { retry: { maxAttempts: 3 } })).toEqualTypeOf<Promise<"pong">>();
    const [a, b] = await Promise.all([step.runQuery(double, { n: 2 }), step.runAction(ping)]);
    expectTypeOf(a).toEqualTypeOf<number>();
    expectTypeOf(b).toEqualTypeOf<"pong">();
    // An untyped reference or a name: args are a record, the result unknown.
    expectTypeOf(step.runQuery(unsafeRef<"query">("m:other"), { anything: 1 })).toEqualTypeOf<Promise<unknown>>();
    expectTypeOf(step.runMutation("m:other")).toEqualTypeOf<Promise<unknown>>();
    // @ts-expect-error required args
    void step.runQuery(double);
    // @ts-expect-error wrong arg type
    void step.runQuery(double, { n: "1" });
    // @ts-expect-error a mutation is not a query step
    void step.runQuery(save, { v: "x" });
  };
  expectTypeOf(typed).toBeFunction();
});
