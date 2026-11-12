import { describe, expect, it } from "vitest";
import { fromJSONValue, parseValue, stringifyValue, toJSONValue } from "../src/json.ts";

/** The two-pass definitions the fast paths must match byte for byte. */
const refStringify = (x: unknown) => JSON.stringify(toJSONValue(x));
const refParse = (s: string) => fromJSONValue(JSON.parse(s));

const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
const nullProto = Object.assign(Object.create(null), { a: 1, b: [true, null] });

const corpus: unknown[] = [
  null, true, false, 0, 1, -1, 1.5, 2 ** 53, -(2 ** 60), "", "x", "$int64", 'quote "$x"', "ünïcödé 🔥", "\u0000\u001f",
  [], [1, "a", null, [2, [3]]], sparse, [undefined, 1], { a: undefined, b: 1 },
  { n: 1, sentAt: 2, body: "x".repeat(64) }, { nested: { deep: { deeper: [1, { z: "y" }] } } }, { 10: "a", 2: "b", z: 1, a: 2 },
  nullProto, { _id: "it_01", _creationTime: 1.5, flags: { read: false } },
  // tagged values: the slow path
  10n, -0, NaN, Infinity, -Infinity, new Uint8Array([1, 2, 255]), { a: 1n }, [1, -0], { b: { c: new Uint8Array([]) } },
  [{ x: NaN }], { list: [1, 2, { big: 2n ** 70n }] },
  // not plain: JSON.stringify would differ from toJSONValue
  new Date(0), { d: new Date(0) }, { toJSON: () => 1 } as unknown, new Map([[1, 2]]), new (class K { a = 1 })(),
];

describe("stringifyValue (one pass when nothing needs a tag)", () => {
  it("matches JSON.stringify(toJSONValue(x)) on every value", () => {
    for (const x of corpus) {
      let ref: string | Error;
      try {
        ref = refStringify(x);
      } catch (e) {
        ref = e as Error;
      }
      if (ref instanceof Error) expect(() => stringifyValue(x)).toThrow();
      else expect(stringifyValue(x)).toBe(ref);
    }
    expect(stringifyValue(undefined)).toBe("null");
  });

  it("still rejects what toJSONValue rejects", () => {
    expect(() => stringifyValue({ f: () => 1 })).toThrow(/Cannot convert function/);
    expect(() => stringifyValue([Symbol("s")])).toThrow(/Cannot convert symbol/);
  });

  it("keeps key order (integer keys first, then insertion)", () => {
    expect(stringifyValue({ b: 1, 2: 1, a: 1, 1: 1 })).toBe('{"1":1,"2":1,"b":1,"a":1}');
  });
});

describe("parseValue (JSON.parse alone when the text holds no tag)", () => {
  it("matches fromJSONValue(JSON.parse(s)) on every encoded value", () => {
    for (const x of corpus) {
      let s: string;
      try {
        s = refStringify(x);
      } catch {
        continue;
      }
      expect(parseValue(s)).toEqual(refParse(s));
    }
  });

  it("decodes tags, including a key spelled with a \\u escape", () => {
    expect(parseValue('{"a":{"$int64":"5"}}')).toEqual({ a: 5n });
    expect(parseValue('{"\\u0024int64":"7"}')).toBe(7n);
    expect(Object.is(parseValue('{"$float":"-0"}'), -0)).toBe(true);
    expect(parseValue('{"b":{"$bytes":"AQI="}}')).toEqual({ b: new Uint8Array([1, 2]) });
  });

  it("treats a __proto__ key as data on both paths", () => {
    for (const s of ['{"__proto__":{"x":1}}', '{"__proto__":{"x":1},"n":{"$int64":"1"}}']) {
      const v = parseValue(s) as Record<string, unknown>;
      expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(v, "__proto__")).toBe(true);
      expect((v as { x?: number }).x).toBeUndefined();
    }
  });
});
