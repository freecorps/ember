// Compiled validators (map #12): `validate` decides with a predicate compiled once per Shape and builds the issue with
// the interpreter only on failure. The fuzz checks the predicate never disagrees with the interpreter.
import { describe, expect, test } from "vitest";
import { v, validate, type Shape } from "../src/index.ts";
import { validateInterpreted } from "../src/validate.ts";

function prng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function randomShape(r: () => number, depth = 0): Shape {
  const leaves: Array<() => Shape> = [
    () => v.string().shape,
    () => v.string().min(2).max(4).shape,
    () => v.string().email().shape,
    () => v.string().regex(/^a+$/).shape,
    () => v.number().shape,
    () => v.number().int().min(0).max(10).shape,
    () => v.int64().shape,
    () => v.boolean().shape,
    () => v.null().shape,
    () => v.bytes().shape,
    () => v.any().shape,
    () => v.id("users").shape,
    () => v.literal("x").shape,
    () => v.literal(3).shape,
  ];
  if (depth > 2 || r() < 0.4) return leaves[Math.floor(r() * leaves.length)]!();
  const k = r();
  if (k < 0.3) {
    const fields: Record<string, { shape: Shape; optional: boolean }> = {};
    for (let i = 0; i < 1 + Math.floor(r() * 3); i++) fields[`f${i}`] = { shape: randomShape(r, depth + 1), optional: r() < 0.3 };
    return { kind: "object", fields };
  }
  if (k < 0.55) return { kind: "array", item: randomShape(r, depth + 1), ...(r() < 0.3 ? { checks: { minItems: 1, maxItems: 2 } } : {}) };
  if (k < 0.75) return { kind: "record", value: randomShape(r, depth + 1) };
  return { kind: "union", members: [randomShape(r, depth + 1), randomShape(r, depth + 1)] };
}

function randomValue(r: () => number, depth = 0): unknown {
  const leaves = [
    () => "a",
    () => "aaa",
    () => "ab",
    () => "x",
    () => "a@b.co",
    () => "users_1",
    () => "😀😀",
    () => 3,
    () => 2.5,
    () => -1,
    () => 11,
    () => NaN,
    () => 5n,
    () => 2n ** 64n,
    () => true,
    () => null,
    () => undefined,
    () => new Uint8Array([1]),
    () => new Date(0),
  ];
  if (depth > 3 || r() < 0.5) return leaves[Math.floor(r() * leaves.length)]!();
  if (r() < 0.5) return Array.from({ length: Math.floor(r() * 3) }, () => randomValue(r, depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = 0; i < Math.floor(r() * 4); i++) o[r() < 0.15 ? "$bad" : r() < 0.2 ? "extra" : `f${Math.floor(r() * 3)}`] = randomValue(r, depth + 1);
  return o;
}

describe("compiled validators", () => {
  test("agree with the interpreter on random shapes and values (ok, path and message)", () => {
    const r = prng(1);
    const tableOfId = (id: string) => (id.startsWith("users_") ? "users" : undefined);
    let failures = 0;
    for (let i = 0; i < 4000; i++) {
      const shape = randomShape(r);
      for (let j = 0; j < 8; j++) {
        const value = randomValue(r);
        for (const opts of [{}, { tableOfId }]) {
          const want = validateInterpreted(shape, value, opts);
          expect(validate(shape, value, opts)).toEqual(want);
          if (!want.ok) failures++;
        }
      }
    }
    // Both outcomes were exercised.
    expect(failures).toBeGreaterThan(1000);
    expect(failures).toBeLessThan(4000 * 8 * 2 - 1000);
  });

  test("a document shape: valid values allocate no issue; the issue of an invalid one is the interpreter's", () => {
    const doc = v.object({ _id: v.id("users"), name: v.string().min(1), tags: v.array(v.string()), n: v.optional(v.number().int()) }).shape;
    expect(validate(doc, { _id: "users_1", name: "a", tags: ["x"] })).toEqual({ ok: true });
    const bad = { _id: "users_1", name: "a", tags: ["x", 2] };
    expect(validate(doc, bad)).toEqual(validateInterpreted(doc, bad));
    expect(validate(doc, bad)).toMatchObject({ ok: false, path: "tags[1]" });
  });
});
