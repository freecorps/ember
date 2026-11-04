import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  compareBytes,
  compareStrings,
  compareValues,
  decodeKey,
  encodeKey,
  inKeyRange,
  keySuccessor,
  prefixEnd,
  rangeFor,
} from "../src/index.ts";

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

// Strings over the whole UTF-16 unit range: lone surrogates, pairs, NUL, ASCII, BMP.
const unit = fc.oneof(
  fc.integer({ min: 0, max: 0x7f }),
  fc.integer({ min: 0, max: 0xffff }),
  fc.integer({ min: 0xd800, max: 0xdfff }),
  fc.constant(0),
);
const anyString = fc.oneof(
  fc.array(unit, { maxLength: 8 }).map((us) => String.fromCharCode(...us)),
  fc.string({ unit: "binary", maxLength: 6 }),
  fc.constantFrom("", "a", "ab", "a\u0000", "\u0000", "é", "\u{1F600}", "￿", ""),
);
const anyNumber = fc.oneof(
  fc.double(),
  fc.constantFrom(0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, 1, -1),
  fc.integer().map((n) => n / 7),
);
const anyInt64 = fc.oneof(
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
  fc.constantFrom(-(2n ** 63n), 2n ** 63n - 1n, 0n, -1n, 1n),
);
const anyBytes = fc.oneof(
  fc.uint8Array({ maxLength: 6 }),
  fc.constantFrom(Uint8Array.of(), Uint8Array.of(0), Uint8Array.of(0, 0), Uint8Array.of(0xff), Uint8Array.of(0, 0xff)),
);
const { value: anyValue } = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant(null),
    anyInt64,
    anyNumber,
    fc.boolean(),
    anyString,
    anyBytes,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(fc.oneof(anyString, fc.constantFrom("a", "b", "c")), tie("value"), { maxKeys: 3 }),
  ),
}));
const topValue = fc.oneof(fc.constant(undefined), anyValue);
const tuple = fc.array(topValue, { maxLength: 4 });

/** Independent reference order for strings: arrays of code points (lone surrogates as themselves). */
function codePoints(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    out.push(c);
    if (c > 0xffff) i++;
  }
  return out;
}
function cmpCodePoints(a: string, b: string): number {
  const x = codePoints(a);
  const y = codePoints(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return sign(x[i]! - y[i]!);
  return sign(x.length - y.length);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) return compareBytes(a, b) === 0;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).filter((k) => (a as any)[k] !== undefined).sort();
    const kb = Object.keys(b).filter((k) => (b as any)[k] !== undefined).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValue((a as any)[k], (b as any)[k]));
  }
  return a === b;
}

const runs = { numRuns: 2000 };

describe("encodeKey: memcmp order == logical order", () => {
  test("any two tuples", () => {
    fc.assert(
      fc.property(tuple, tuple, (a, b) => {
        expect(sign(compareBytes(encodeKey(a), encodeKey(b)))).toBe(sign(compareValues(a, b)));
      }),
      runs,
    );
  });

  test("round trip", () => {
    fc.assert(
      fc.property(tuple, (t) => {
        expect(sameValue(decodeKey(encodeKey(t)), t)).toBe(true);
      }),
      runs,
    );
  });

  test("numbers follow IEEE total order (-0 < +0, NaN last)", () => {
    fc.assert(
      fc.property(anyNumber, anyNumber, (a, b) => {
        const c = sign(compareBytes(encodeKey([a]), encodeKey([b])));
        if (Number.isNaN(a) || Number.isNaN(b)) {
          expect(c).toBe(Number.isNaN(a) && Number.isNaN(b) ? 0 : Number.isNaN(a) ? 1 : -1);
        } else if (a === b) {
          expect(c).toBe(Object.is(a, b) ? 0 : Object.is(a, -0) ? -1 : 1);
        } else expect(c).toBe(a < b ? -1 : 1);
      }),
      runs,
    );
    const ordered = [-Infinity, -Number.MAX_VALUE, -1, -Number.MIN_VALUE, -0, 0, Number.MIN_VALUE, 1, Number.MAX_VALUE, Infinity, NaN];
    const keys = ordered.map((x) => encodeKey([x]));
    for (let i = 1; i < keys.length; i++) expect(compareBytes(keys[i - 1]!, keys[i]!)).toBeLessThan(0);
    // Every NaN payload is the same key.
    const weird = new Float64Array(new BigUint64Array([0xfff0000000000001n]).buffer)[0]!;
    expect(Number.isNaN(weird)).toBe(true);
    expect(compareBytes(encodeKey([weird]), encodeKey([NaN]))).toBe(0);
  });

  test("int64 numeric order over the full range", () => {
    fc.assert(
      fc.property(anyInt64, anyInt64, (a, b) => {
        expect(sign(compareBytes(encodeKey([a]), encodeKey([b])))).toBe(a < b ? -1 : a > b ? 1 : 0);
      }),
      runs,
    );
  });

  test("strings: code point order, incl. surrogates and NUL", () => {
    fc.assert(
      fc.property(anyString, anyString, (a, b) => {
        expect(sign(compareBytes(encodeKey([a]), encodeKey([b])))).toBe(cmpCodePoints(a, b));
        expect(sign(compareStrings(a, b))).toBe(cmpCodePoints(a, b));
      }),
      runs,
    );
    // UTF-16 order would put U+FFFF after U+1F600; code point order does not.
    expect(compareBytes(encodeKey(["￿"]), encodeKey(["\u{1F600}"]))).toBeLessThan(0);
    expect(compareBytes(encodeKey(["a"]), encodeKey(["a\u0000"]))).toBeLessThan(0);
    expect(compareBytes(encodeKey(["a\u0000"]), encodeKey(["a\u0001"]))).toBeLessThan(0);
  });

  test("type order: undefined < null < int64 < number < boolean < string < bytes < array < object", () => {
    const ordered = [undefined, null, 5n, -1, false, true, "", new Uint8Array(), [], {}];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareBytes(encodeKey([ordered[i - 1]]), encodeKey([ordered[i]]))).toBeLessThan(0);
      expect(compareValues(ordered[i - 1], ordered[i])).toBeLessThan(0);
    }
  });

  test("nested arrays and objects", () => {
    const ordered: unknown[] = [[], [null], [1n], [1], [1, 2], [1, [0]], [2], ["a"], [[]], {}, { a: 1 }, { a: 1, b: 1 }, { a: 2 }, { b: 0 }];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareBytes(encodeKey([ordered[i - 1]]), encodeKey([ordered[i]]))).toBeLessThan(0);
    }
    // Object key order is irrelevant.
    expect(encodeKey([{ a: 1, b: 2 }])).toEqual(encodeKey([{ b: 2, a: 1 }]));
  });

  test("rejects unsupported values", () => {
    expect(() => encodeKey([[undefined]])).toThrow();
    expect(() => encodeKey([new Date()])).toThrow();
    expect(() => encodeKey([2n ** 63n])).toThrow();
  });
});

describe("ranges", () => {
  test("prefix range contains exactly the extensions of the prefix", () => {
    fc.assert(
      fc.property(tuple, tuple, tuple, (p, rest, other) => {
        const pk = encodeKey(p);
        expect(inKeyRange(encodeKey([...p, ...rest]), pk, prefixEnd(pk))).toBe(true);
        const extendsP = other.length >= p.length && p.every((x, i) => compareValues(x, other[i]) === 0);
        expect(inKeyRange(encodeKey(other), pk, prefixEnd(pk))).toBe(extendsP);
      }),
      runs,
    );
  });

  test("keySuccessor is the next key", () => {
    fc.assert(
      fc.property(tuple, tuple, (a, b) => {
        const ka = encodeKey(a);
        const kb = encodeKey(b);
        const c = compareBytes(kb, ka);
        expect(compareBytes(kb, keySuccessor(ka)) < 0).toBe(c <= 0);
      }),
      runs,
    );
  });

  test("rangeFor(eq, gt/gte, lt/lte) agrees with logical comparisons on the bounded field", () => {
    const op = fc.constantFrom("gt", "gte", "lt", "lte", "none");
    fc.assert(
      fc.property(
        fc.array(anyValue, { maxLength: 2 }),
        topValue,
        tuple,
        op,
        anyValue,
        op,
        anyValue,
        (eq, x, tail, lop, lval, uop, uval) => {
          const lower = lop === "gt" || lop === "gte" ? { op: lop, value: lval } : undefined;
          const upper = uop === "lt" || uop === "lte" ? { op: uop, value: uval } : undefined;
          const { lo, hi } = rangeFor(eq, lower, upper);
          const key = encodeKey([...eq, x, ...tail]);
          let want = true;
          if (lower) want &&= lower.op === "gt" ? compareValues(x, lower.value) > 0 : compareValues(x, lower.value) >= 0;
          if (upper) want &&= upper.op === "lt" ? compareValues(x, upper.value) < 0 : compareValues(x, upper.value) <= 0;
          expect(inKeyRange(key, lo, hi)).toBe(want);
        },
      ),
      runs,
    );
  });
});
