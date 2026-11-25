// PR 4B-3b: `ctx.fail` is built once per function definition and rebuilt when its error list (factories or codes) changes.
import { describe, expect, it } from "vitest";
import { defineErrors } from "../src/index.ts";
import type { AnyErrorFactory } from "../src/errors.ts";
import { failApi } from "../src/functions.ts";

describe("failApi memo", () => {
  it("one frozen object per definition; a changed list (pushed, replaced, or a code changed) rebuilds it", () => {
    const { A, B } = defineErrors({ A: { message: "a" }, B: { message: "b" } });
    const def: { errors: AnyErrorFactory[] } = { errors: [A] };
    const first = failApi(def);
    expect(failApi(def)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => (A as { code: string }).code = "Z").toThrow();
    def.errors.push(B);
    const second = failApi(def);
    expect(Object.keys(second)).toEqual(["A", "B"]);
    def.errors[1] = A;
    expect(Object.keys(failApi(def))).toEqual(["A"]);
    // A hand-made factory whose code changes in place: the thrower follows the code.
    const hand = Object.assign((d?: unknown) => new Error(String(d)), { code: "H" }) as unknown as AnyErrorFactory;
    const other = { errors: [hand] };
    expect(Object.keys(failApi(other))).toEqual(["H"]);
    (hand as { code: string }).code = "K";
    expect(Object.keys(failApi(other))).toEqual(["K"]);
  });
});
