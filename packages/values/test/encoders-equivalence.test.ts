// PR 2A's faster encoders against what they replaced: the same bytes, the same values.

import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, encodeJson, encodeJsonStable, fromJSONValue, parseValue } from "../src/json.ts";
import { encodeWithDocs, rowDiffJson } from "../src/rowdiff.ts";
import { valueSize } from "../src/sql.ts";
import { encodeParts, valueDiffJson } from "../src/valuediff.ts";
import * as ref from "./diff-reference.ts";

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The old `bytesToBase64` (string concatenation), verbatim. */
function refBase64(bytes: Uint8Array, url = false): string {
  const A = url ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += A[n >> 18]! + A[(n >> 12) & 63]! + A[(n >> 6) & 63]! + A[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += A[n >> 18]! + A[(n >> 12) & 63]! + (url ? "" : "==");
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += A[n >> 18]! + A[(n >> 12) & 63]! + A[(n >> 6) & 63]! + (url ? "" : "=");
  }
  return out;
}

/** The old `valueSize` (Object.entries), verbatim but for the string branch it shares. */
function refValueSize(x: unknown): number {
  if (typeof x === "object" && x !== null && !(x instanceof Uint8Array) && !Array.isArray(x)) {
    let n = 2;
    for (const [k, item] of Object.entries(x)) if (item !== undefined) n += valueSize(k) - 2 + 1 + refValueSize(item);
    return n;
  }
  if (Array.isArray(x)) {
    let n = 2;
    for (const item of x) n += refValueSize(item);
    return n;
  }
  return valueSize(x);
}

const doc = (i: number, extra: Record<string, unknown> = {}) => ({ _id: `d${i}`, _creationTime: i, body: `text ${i}`, ...extra });

function randomValue(r: () => number, depth: number): unknown {
  const p = r();
  if (p < 0.1) return null;
  if (p < 0.2) return r() * 100;
  if (p < 0.25) return [NaN, -0, Infinity, 5n, new Uint8Array([1, 2, 0])][Math.floor(r() * 5)];
  if (p < 0.4) return ["a", "\u0000", "\u0001x", "\ud800", '"$int64"', "$bytes", "\\u0024", "😀"][Math.floor(r() * 8)];
  if (depth > 4) return true;
  if (p < 0.55) return Array.from({ length: Math.floor(r() * 4) }, (_, i) => (r() < 0.5 ? doc(i, { v: randomValue(r, depth + 1) }) : randomValue(r, depth + 1)));
  if (p < 0.6) return [];
  const o: Record<string, unknown> = {};
  const keys = ["a", "b", "page", "items", "__proto__", "1", "$x", "toJSONx", "u"];
  for (let i = Math.floor(r() * 4); i > 0; i--) {
    const k = keys[Math.floor(r() * keys.length)]!;
    const val = r() < 0.1 ? undefined : randomValue(r, depth + 1);
    Object.defineProperty(o, k, { value: val, enumerable: true, writable: true, configurable: true });
  }
  return o;
}

describe("encoders: identical to the ones they replaced", () => {
  it("bytesToBase64 (both alphabets, every length up to 64, large inputs) and its inverse", () => {
    const r = prng(3);
    for (let n = 0; n < 64; n++) {
      const b = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      for (const url of [false, true]) {
        expect(bytesToBase64(b, url)).toBe(refBase64(b, url));
        expect(base64ToBytes(bytesToBase64(b, url))).toEqual(b);
      }
    }
    for (const n of [0x2000 * 3 / 4, 6144, 6145, 100_000, 300_001]) {
      const b = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      expect(bytesToBase64(b)).toBe(refBase64(b));
      expect(bytesToBase64(b, true)).toBe(refBase64(b, true));
    }
  });

  it("parseValue: same values as fromJSONValue(JSON.parse(s)), \\u escapes and tag-like keys included", () => {
    const texts = [
      '{"a":"\\u0001","b":{"$int64":"5"}}',
      '{"a":"\\u0001","b":1}',
      '{"$\\u0069nt64":"9"}',
      '{"a":{"$i\\u006et64":"9"}}',
      '{"\\u0024bytes":"AQI="}',
      '{"\\u0024float":"-0"}',
      '{"$float":"NaN","x":1}',
      '{"$int64":5}',
      '{"$int64":{"$int64":"1"}}',
      '{"s":"$int64","t":"\\ud800"}',
      '[{"$bytes":""},{"$float":"Infinity"},[{"$int64":"-3"}]]',
      '{"__proto__":{"$int64":"1"},"k":[1,{"$float":"-Infinity"}]}',
      '{"__proto__":{"a":1}}',
      '{"2":{"$int64":"2"},"1":"x","b":{"c":{"d":{"$bytes":"AA=="}}}}',
      '"\\u0024int64"',
      '{"a":"\\"$int64\\""}',
    ];
    for (const s of texts) {
      const got = parseValue(s);
      const want = fromJSONValue(JSON.parse(s));
      expect(got).toEqual(want);
      expect(encodeJson(got)).toBe(encodeJson(want));
      if (got && typeof got === "object") {
        expect(Object.getPrototypeOf(got)).toBe(Object.getPrototypeOf(want));
        expect(Object.keys(got)).toEqual(Object.keys(want as object));
      }
    }
    // Literal tag values, independent of `untag` (which both sides share).
    expect(Object.is(parseValue('{"$float":"-0"}'), -0)).toBe(true);
    expect(Object.is(parseValue('{"\\u0024float":"-0"}'), -0)).toBe(true);
    expect(parseValue('{"$float":"NaN"}')).toBeNaN();
    expect(parseValue('[{"$float":"Infinity"},{"$float":"-Infinity"}]')).toEqual([Infinity, -Infinity]);
    expect(parseValue('{"$int64":"-9223372036854775808"}')).toBe(-(2n ** 63n));
    expect(parseValue('{"a":{"$int64":"5"}}')).toEqual({ a: 5n });
    expect(parseValue('{"$bytes":"AQI="}')).toEqual(Uint8Array.of(1, 2));
    expect(parseValue('{"$bytes":""}')).toEqual(new Uint8Array(0));
    const r = prng(11);
    for (let i = 0; i < 3000; i++) {
      const s = encodeJson(randomValue(r, 0));
      const got = parseValue(s);
      expect(encodeJson(got)).toBe(encodeJson(fromJSONValue(JSON.parse(s))));
      expect(got).toEqual(fromJSONValue(JSON.parse(s)));
    }
  });

  it("encodeParts: the same parts (json, docs, fields) as before", () => {
    const r = prng(5);
    const same = (x: unknown) => expect(encodeParts(x)).toEqual(ref.encodeParts(x));
    same({ page: [doc(1)], isDone: false });
    same({ a: { b: { c: { d: { e: [doc(1)] } } } } });
    same({ a: { b: { c: [doc(1)] } } });
    same({ a: [], b: 1 });
    same({ a: [{ _id: 1 }], b: [{ _id: "x" }, { _id: "x" }] });
    same({ a: [{ _id: "x" }, 3] });
    // Only the first element decides "maybe" (a non-document first element is never a document array).
    same({ a: [3, { _id: "x" }], b: [null, doc(2)], c: { d: ["s", doc(3)] } });
    same({ toJSON: 1, page: [doc(1)] });
    same({ x: { toJSON: 1, rows: [doc(1)] } });
    for (let i = 0; i < 4000; i++) same(randomValue(r, 0));
  });

  it("rowDiffJson: the same diff text as before (moves, inserts, removals, order)", () => {
    const r = prng(17);
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(r() * 12);
      const prev = Array.from({ length: n }, (_, j) => doc(j, { v: Math.floor(r() * 3) }));
      let next = prev.filter(() => r() < 0.8).map((d) => (r() < 0.2 ? { ...d, v: 9 } : d));
      for (let k = Math.floor(r() * 4); k > 0; k--) next.splice(Math.floor(r() * (next.length + 1)), 0, doc(100 + i * 10 + k));
      if (r() < 0.4) next = next.sort(() => r() - 0.5);
      else if (r() < 0.3) next = next.filter((d) => !String(d._id).startsWith("d10"));
      const pe = encodeWithDocs(prev);
      const ne = encodeWithDocs(next);
      expect(rowDiffJson(prev, pe.docs!, next, ne.docs!, ne.json)).toBe(ref.rowDiffJson(prev, pe.docs!, next, ne.docs!, ne.json));
    }
  });

  it("encodeJsonStable: the same text as before (tags, index-like keys, __proto__, holes, class instances)", () => {
    const same = (x: unknown) => expect(encodeJsonStable(x)).toBe(ref.encodeJsonStable(x));
    same(undefined);
    same(null);
    same({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 5n } });
    same({ "10": 1, "2": 2, b: 3, "01": 4, "1a": 5, "-1": 6, "4294967294": 7, "4294967295": 8, "9007199254740993": 9, a: 0 });
    same(Object.defineProperty({ z: 1 }, "__proto__", { value: { y: 2, x: 1 }, enumerable: true }));
    // eslint-disable-next-line no-sparse-arrays
    same([1, , undefined, NaN, -0, Infinity, -Infinity, new Uint8Array([255, 0])]);
    same({ a: undefined, b: [undefined], c: new Date(0), d: new Map([[1, 2]]), e: Int8Array.of(1, -1) });
    class P {
      y = 1;
      x = 2;
    }
    same({ p: new P() });
    same({ $int64: "5", $bytes: 1 });
    same(Object.defineProperty({ "1": 1, a: 2 }, "__proto__", { value: { "0": 3 }, enumerable: true }));
    // Getters with side effects, a fresh input for each encoder: same reads at the same moments as before.
    const fresh = (make: () => unknown) => expect(encodeJsonStable(make())).toBe(ref.encodeJsonStable(make()));
    fresh(() => {
      const a: unknown[] = [];
      a.push({
        get v() {
          a.push(2);
          return 1;
        },
      });
      return a;
    });
    fresh(() => {
      const a: unknown[] = [
        {
          get v() {
            a.length = 1;
            return 1;
          },
        },
        5,
        6,
      ];
      return a;
    });
    fresh(() => {
      const child = { n: 1 };
      return {
        a: child,
        get b() {
          child.n = 2;
          return 0;
        },
      };
    });
    fresh(() => {
      const o: Record<string, unknown> = {
        get a() {
          delete o.c;
          o.d = 1;
          return 0;
        },
        b: 1,
        c: 2,
      };
      return o;
    });
    // Holes and inherited items: `map` (the old walk) reads an index the prototype chain has (`HasProperty`) and
    // JSON.stringify writes a hole as null: `[7,null,1]` with `Array.prototype[0] = 7`, as before.
    const holes = () => {
      const a: unknown[] = [];
      a.length = 3;
      a[2] = 1;
      return a;
    };
    same(holes());
    same({ a: holes(), b: [1, 2].filter(() => false) });
    const deleted = [1, 2, 3];
    delete deleted[1];
    same(deleted);
    const chain = Object.create(Array.prototype) as Record<number, unknown>;
    chain[1] = { b: 1, a: 2 };
    const inherits = holes();
    Object.setPrototypeOf(inherits, chain);
    same(inherits);
    expect(encodeJsonStable(inherits)).toBe('[null,{"a":2,"b":1},1]');
    const ap = Array.prototype as unknown as Record<number, unknown>;
    ap[0] = 7;
    try {
      same(holes());
      same([]);
      expect(encodeJsonStable(holes())).toBe("[7,null,1]");
      expect(ref.encodeJsonStable(holes())).toBe("[7,null,1]");
    } finally {
      delete ap[0];
    }
    // A Proxy whose `get` answers for an index it does not have (`has` says no): a hole, `[null]`, as `map` saw it.
    const ghost = () => new Proxy(new Array(1), { get: (t, k, r) => (k === "0" ? 7 : Reflect.get(t, k, r)) });
    same(ghost());
    same({ a: ghost() });
    expect(encodeJsonStable(ghost())).toBe("[null]");
    expect(() => encodeJsonStable({ a: () => 1 })).toThrow(/Cannot convert function to JSON/);
    expect(() => ref.encodeJsonStable({ a: () => 1 })).toThrow(/Cannot convert function to JSON/);
    const r = prng(29);
    for (let i = 0; i < 4000; i++) same(randomValue(r, 0));
  });

  it("valueDiffJson: the same diff text as before (fields added, deleted, reordered, diffed)", () => {
    const r = prng(31);
    const keys = ["page", "items", "a", "b", "c", "isDone"];
    const docsOf = (n: number) => Array.from({ length: n }, (_, j) => doc(j, { v: Math.floor(r() * 3) }));
    const make = (): Record<string, unknown> => {
      const o: Record<string, unknown> = {};
      for (const k of keys) {
        if (r() < 0.3) continue;
        const p = r();
        o[k] = p < 0.4 ? docsOf(Math.floor(r() * 6)) : p < 0.6 ? { rows: docsOf(Math.floor(r() * 4)), n: Math.floor(r() * 2) } : Math.floor(r() * 3);
      }
      return o;
    };
    const shuffle = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(() => r() - 0.5));
    for (let i = 0; i < 3000; i++) {
      const prev = make();
      let next: Record<string, unknown>;
      const p = r();
      if (p < 0.4) {
        // Same fields in the same order, some changed.
        next = Object.fromEntries(Object.entries(prev).map(([k, x]) => [k, r() < 0.3 ? (Array.isArray(x) ? [...x].filter(() => r() < 0.8) : make()[k] ?? x) : x]));
      } else if (p < 0.7) next = make();
      else next = shuffle({ ...prev, ...(r() < 0.5 ? { extra: 1 } : {}) });
      const pe = encodeParts(prev);
      const ne = encodeParts(next);
      expect(valueDiffJson(prev, pe, next, ne)).toBe(ref.valueDiffJson(prev, pe, next, ne));
    }
  });

  it("valueSize: the same sizes as before", () => {
    const r = prng(23);
    for (let i = 0; i < 2000; i++) {
      const x = randomValue(r, 0);
      expect(valueSize(x)).toBe(refValueSize(x));
    }
  });
});
