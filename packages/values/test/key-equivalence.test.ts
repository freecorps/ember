// The optimized key encoding (scratch buffer, direct writes, TextDecoder) against the one it replaced
// (key-reference.ts, verbatim): byte-identical encodings and identical decodings, over hand-picked edge cases and
// seeded random values.

import { describe, expect, it } from "vitest";
import { decodeKey, encodeKey, encodeValue, keySuccessor, pointRange, rangeFor } from "../src/key.ts";
import { acquire, release, scratchCapacity } from "../src/scratch.ts";
import * as ref from "./key-reference.ts";

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

const UNITS = [0, 1, 0x1f, 0x41, 0x7f, 0x80, 0xff, 0x7ff, 0x800, 0xfeff, 0xfffd, 0xffff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000];

function randomString(r: () => number): string {
  const n = Math.floor(r() * 12);
  let s = "";
  for (let i = 0; i < n; i++) {
    const p = r();
    if (p < 0.4) s += String.fromCharCode(0x20 + Math.floor(r() * 95));
    else if (p < 0.55) s += String.fromCharCode(UNITS[Math.floor(r() * UNITS.length)]!);
    else if (p < 0.7) s += String.fromCodePoint(0x10000 + Math.floor(r() * 0xfffff)); // pairs, emoji included
    else if (p < 0.8) s += String.fromCharCode(0xd800 + Math.floor(r() * 0x800)); // unpaired surrogates
    else if (p < 0.9) s += "\u0000";
    else s += String.fromCharCode(Math.floor(r() * 0x10000));
  }
  return s;
}

const NUMBERS = [0, -0, 1, -1, 0.1, -0.1, NaN, -NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 2 ** 53, -(2 ** 53), 1e-300];
const BIGINTS = [0n, 1n, -1n, 2n ** 63n - 1n, -(2n ** 63n), 255n, 256n, -256n, 2n ** 32n, -(2n ** 32n) - 1n];

function randomValue(r: () => number, depth: number): unknown {
  const p = r();
  if (p < 0.08) return null;
  if (p < 0.16) return r() < 0.5;
  if (p < 0.3) return NUMBERS[Math.floor(r() * NUMBERS.length)]! * (r() < 0.5 ? 1 : r() * 1000);
  if (p < 0.4) return r() < 0.5 ? BIGINTS[Math.floor(r() * BIGINTS.length)]! : BigInt(Math.floor((r() - 0.5) * 2 ** 52));
  if (p < 0.6) return randomString(r);
  if (p < 0.7) return Uint8Array.from({ length: Math.floor(r() * 10) }, () => (r() < 0.3 ? 0 : r() < 0.5 ? 0xff : Math.floor(r() * 256)));
  if (depth > 3) return randomString(r);
  if (p < 0.85) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(r() * 4); i > 0; i--) o[randomString(r)] = r() < 0.1 ? undefined : randomValue(r, depth + 1);
  return o;
}

const same = (values: unknown[]) => {
  const want = ref.encodeKey(values);
  const got = encodeKey(values);
  expect(Buffer.from(got).toString("hex")).toBe(Buffer.from(want).toString("hex"));
  expect(decodeKey(got)).toEqual(ref.decodeKey(want));
};

describe("key encoding: identical to the reference", () => {
  it("edge cases", () => {
    const cases: unknown[][] = [
      [],
      [undefined],
      [""],
      ["\u0000"],
      ["a\u0000b\u0000\u0000"],
      ["\ud800"],
      ["\udc00"],
      ["\ud800𐀀"],
      ["x\udbff"],
      ["\udfff\ud800"],
      ["😀👍🏽 ação 漢字"],
      ["﻿BOM first"],
      ["\u0080߿ࠀ￿"],
      ["x".repeat(100)],
      ["é".repeat(100)],
      ["a".repeat(70_000)],
      [NaN],
      [-NaN],
      [0],
      [-0],
      [Infinity, -Infinity],
      [Number.MIN_VALUE, -Number.MIN_VALUE],
      [2n ** 63n - 1n, -(2n ** 63n), 0n, -1n, 1n],
      [new Uint8Array(0), Uint8Array.of(0), Uint8Array.of(0, 0, 0xff), Uint8Array.of(1, 2, 0), new Uint8Array(40_000)],
      [[], [[]], [null, [true, false]], { a: 1, b: undefined, "": "e" }],
      [{ "\ud800": 1, "😀": 2, "￿": 3, a: { z: [1n, Uint8Array.of(0)] } }],
      ["chan", 42.5, "msg_01J9Z3ABCDEFGHJKMNPQRSTVWX", 1700000000000.123, "msg_x"],
    ];
    for (const c of cases) same(c);
  });

  it("seeded random tuples", () => {
    const r = prng(2024);
    for (let i = 0; i < 4000; i++) same(Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, 0)));
  });

  it("every single code unit", () => {
    for (let c = 0; c < 0x10000; c += 1) {
      const s = String.fromCharCode(c);
      expect(encodeKey([s])).toEqual(ref.encodeKey([s]));
    }
  });

  it("encodeValue, rangeFor and pointRange", () => {
    const r = prng(7);
    for (let i = 0; i < 1500; i++) {
      const eq = Array.from({ length: Math.floor(r() * 3) }, () => randomValue(r, 2));
      const lower = r() < 0.6 ? { op: r() < 0.5 ? ("gt" as const) : ("gte" as const), value: randomValue(r, 2) } : undefined;
      const upper = r() < 0.6 ? { op: r() < 0.5 ? ("lt" as const) : ("lte" as const), value: randomValue(r, 2) } : undefined;
      expect(rangeFor(eq, lower, upper)).toEqual(ref.rangeFor(eq, lower, upper));
      const x = randomValue(r, 1);
      expect(encodeValue(x)).toEqual(ref.encodeValue(x));
      const p = pointRange(eq);
      expect(Uint8Array.from(p.lo)).toEqual(ref.encodeKey(eq));
      expect(p.hi).toEqual(keySuccessor(ref.encodeKey(eq)));
    }
    // A top-level undefined bound is legal, as before.
    expect(rangeFor([], { op: "gt", value: undefined })).toEqual(ref.rangeFor([], { op: "gt", value: undefined }));
  });

  it("errors are the same", () => {
    for (const bad of [[2n ** 63n], [-(2n ** 63n) - 1n], [[undefined]], [{ a: [undefined] }], [new Date(0)], [() => 1], [Symbol("x")], [new Uint16Array(2)]]) {
      expect(() => encodeKey(bad)).toThrow((() => {
        try {
          ref.encodeKey(bad);
        } catch (e) {
          return (e as Error).message;
        }
        return "no error";
      })());
    }
  });

  it("decoding malformed and truncated keys behaves the same", () => {
    const r = prng(99);
    const outcome = (f: () => unknown) => {
      try {
        return { ok: f() };
      } catch (e) {
        return { err: (e as Error).message };
      }
    };
    for (let i = 0; i < 3000; i++) {
      const k = encodeKey([randomValue(r, 1), randomValue(r, 1)]);
      const cut = k.subarray(0, Math.floor(r() * k.length));
      expect(outcome(() => decodeKey(cut))).toEqual(outcome(() => ref.decodeKey(cut)));
      const noisy = Uint8Array.from(k);
      if (noisy.length) noisy[Math.floor(r() * noisy.length)] = Math.floor(r() * 256);
      expect(outcome(() => decodeKey(noisy))).toEqual(outcome(() => ref.decodeKey(noisy)));
    }
    // Hand-made WTF-8 / invalid UTF-8 string bodies (the slow decoder's leniency is kept).
    for (const body of [[0xed, 0xa0, 0x80], [0xc0, 0x80], [0xe0, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff], [0x80], [0xef, 0xbb, 0xbf, 0x41], [0xe2, 0x82]]) {
      const k = Uint8Array.from([0x07, ...body, 0x00]);
      expect(outcome(() => decodeKey(k))).toEqual(outcome(() => ref.decodeKey(k)));
    }
  });

  it("decoded bytes are copies, never views of the key", () => {
    const k = encodeKey([Uint8Array.of(1, 2, 3)]);
    const [b] = decodeKey(k) as [Uint8Array];
    b[0] = 9;
    expect(decodeKey(k)).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(b.buffer).not.toBe(k.buffer);
  });

  it("a key in a Node Buffer: decoded bytes are plain copies (as the reference's), not Buffer views of it", () => {
    for (const bytes of [Uint8Array.of(1, 2, 3), Uint8Array.of(1, 0, 3)]) {
      const pool = Buffer.alloc(64, 7);
      const k = encodeKey(["s", bytes]);
      k.forEach((x, i) => (pool[8 + i] = x));
      const key = pool.subarray(8, 8 + k.length);
      const [s, b] = decodeKey(key) as [string, Uint8Array];
      const [, want] = ref.decodeKey(key) as [string, Uint8Array];
      expect(s).toBe("s");
      expect(b).toEqual(want);
      expect(Object.getPrototypeOf(b)).toBe(Uint8Array.prototype);
      expect(Buffer.isBuffer(b)).toBe(false);
      key.fill(0xee);
      expect(b).toEqual(bytes);
    }
  });

  it("bytes of a Uint8Array subclass: zeros are found from the bytes, not from an overridden indexOf", () => {
    class Lying extends Uint8Array {
      override indexOf(): number {
        return -1;
      }
    }
    for (const x of [Lying.of(0, 7), Lying.of(1, 2), Lying.of(7, 0, 0)]) {
      const plain = Uint8Array.from(x);
      expect(encodeKey([x, 1])).toEqual(ref.encodeKey([plain, 1]));
      expect(decodeKey(encodeKey([x, 1]))).toEqual([plain, 1]);
    }
  });

  it("returned keys never share the scratch buffer", () => {
    const a = encodeKey(["first"]);
    const b = encodeKey(["second"]);
    expect(decodeKey(a)).toEqual(["first"]);
    expect(a.buffer).not.toBe(b.buffer);
    const { lo, hi } = rangeFor(["p"], { op: "gte", value: 1 }, { op: "lte", value: 2 });
    encodeKey(["overwrite the scratch"]);
    expect(lo).toEqual(ref.rangeFor(["p"], { op: "gte", value: 1 }).lo);
    expect(hi).toEqual(ref.rangeFor(["p"], undefined, { op: "lte", value: 2 }).hi);
  });

  it("a re-entrant encode (a getter calling encodeKey) gets its own buffer", () => {
    let inner: Uint8Array | undefined;
    const tricky = {
      get a() {
        inner = encodeKey(["inner", 1]);
        return "outer";
      },
    };
    expect(encodeKey([tricky, 2])).toEqual(ref.encodeKey([{ a: "outer" }, 2]));
    expect(inner).toEqual(ref.encodeKey(["inner", 1]));
  });

  it("an encode that throws leaves the scratch usable", () => {
    expect(() => encodeKey(["x".repeat(50), 2n ** 64n])).toThrow("int64 out of range");
    expect(encodeKey(["ok"])).toEqual(ref.encodeKey(["ok"]));
  });

  it("caps the scratch buffer's memory", () => {
    encodeKey(["small"]);
    const base = scratchCapacity();
    expect(base).toBeLessThanOrEqual(16 * 1024);
    encodeKey(["y".repeat(200_000)]);
    // Grew for the big key, dropped after it.
    expect(scratchCapacity()).toBeLessThanOrEqual(16 * 1024);
    // Up to the cap it is kept (no reallocation per call).
    encodeKey(["z".repeat(3000)]);
    const kept = scratchCapacity();
    expect(kept).toBeGreaterThan(9000);
    encodeKey(["a"]);
    expect(scratchCapacity()).toBe(kept);
    // A long ASCII key that fits under the cap is measured, not reserved at 3 bytes per unit (32 KiB, then dropped).
    for (const s of ["q".repeat(6000), "q".repeat(16_000), "é".repeat(4000)]) {
      encodeKey([s]);
      expect(scratchCapacity()).toBeGreaterThanOrEqual(Math.min(16 * 1024, 2 * s.length));
      expect(encodeKey([s])).toEqual(ref.encodeKey([s]));
    }
    // Taken while in use.
    const w = acquire();
    expect(scratchCapacity()).toBe(0);
    release(w);
  });
});
