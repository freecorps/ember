// Type-level checks of the helper (`tsc -b` compiles this file; the test body only keeps Vitest happy).
import { unsafeRef, type FunctionReference, type Visibility } from "@freecorps/ember-server";
import { describe, expect, test } from "vitest";
import { Workpool, workpool, type OnCompleteArgs, type SyncWriteCtx, type WorkResult, type WorkpoolComponentApi } from "../src/index.ts";

type Action<Args, Ret> = FunctionReference<"action", "internal", Args, Ret>;
type Mutation<Args, Ret> = FunctionReference<"mutation", Visibility, Args, Ret>;
declare const component: WorkpoolComponentApi;
declare const ctx: SyncWriteCtx;
declare const summarize: Action<{ docId: string }, { words: number }>;
declare const write: Mutation<{ label: string }, number>;
/** onComplete typed with vOnCompleteArgs: `returnValue` is unknown, so it takes any work. */
declare const anyDone: Mutation<OnCompleteArgs, null>;
/** onComplete that expects `{ words: number }`. */
declare const wordsDone: Mutation<{ workId: string; context: { docId: string }; result: WorkResult<{ words: number }> }, null>;
/** onComplete that expects a string result. */
declare const stringDone: Mutation<{ workId: string; context: unknown; result: WorkResult<string> }, null>;
declare const choose: boolean;

export function typeChecks(): void {
  const pool = new Workpool(component);
  pool.enqueueAction(ctx, summarize, { docId: "d" }, { onComplete: anyDone });
  pool.enqueueAction(ctx, summarize, { docId: "d" }, { onComplete: wordsDone, context: { docId: "d" } });
  // @ts-expect-error the work returns { words: number }, the onComplete takes a string
  pool.enqueueAction(ctx, summarize, { docId: "d" }, { onComplete: stringDone });
  // @ts-expect-error the mutation returns a number, the onComplete takes { words: number }
  pool.enqueueMutation(ctx, write, { label: "x" }, { onComplete: wordsDone });
  // A batch key is per item: a function of the item's args (typed) and index.
  pool.enqueueActionBatch(ctx, summarize, [{ docId: "a" }, { docId: "b" }], { key: (a, i) => `${a.docId}:${i}`, onComplete: wordsDone });
  // @ts-expect-error a fixed key would make the whole batch one item
  pool.enqueueActionBatch(ctx, summarize, [{ docId: "a" }], { key: "same" });
  // @ts-expect-error the batch's onComplete is checked against the work's result too
  pool.enqueueMutationBatch(ctx, write, [{ label: "x" }], { onComplete: stringDone });
  // A union of references (`cond ? a : b`): every member must accept the result.
  pool.enqueueAction(ctx, summarize, { docId: "d" }, { onComplete: choose ? wordsDone : anyDone, context: { docId: "d" } });
  // @ts-expect-error one member (stringDone) does not take { words: number }
  pool.enqueueAction(ctx, summarize, { docId: "d" }, { onComplete: choose ? wordsDone : stringDone });
  // A hand-written reference (unknown return) works with any onComplete.
  pool.enqueueAction(ctx, unsafeRef<"action">("work:call"), { label: "x" }, { onComplete: stringDone });
}

describe("workpool types", () => {
  test("the type checks above compile (tsc -b)", () => {
    expect(typeof typeChecks).toBe("function");
    expect(workpool.name).toBe("workpool");
  });
});
