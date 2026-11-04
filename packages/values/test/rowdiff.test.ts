import { describe, expect, test } from "vitest";
import { applyRowDiff, encodeJson, rowDiff } from "../src/index.ts";

const doc = (i: number, extra: Record<string, unknown> = {}) => ({ _id: `msg_${String(i).padStart(26, "0")}`, _creationTime: 1e12 + i, body: `message number ${i} with some text`, likes: i % 7, ...extra });

function prng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe("rowdiff", () => {
  test("non doc arrays and duplicates fall back (null)", () => {
    expect(rowDiff(1, 2)).toBeNull();
    expect(rowDiff([1], [2])).toBeNull();
    expect(rowDiff([doc(1)], { page: [doc(1)] })).toBeNull();
    expect(rowDiff([doc(1), doc(1)], [doc(1)])).toBeNull();
  });

  test("in-place update, append, remove: no order; prepend: order", () => {
    const base = Array.from({ length: 50 }, (_, i) => doc(i));
    const upd = base.map((d, i) => (i === 10 ? { ...d, likes: 99 } : d));
    expect(rowDiff(base, upd)).toEqual({ remove: [], upsert: [upd[10]] });
    const app = [...base, doc(50)];
    expect(rowDiff(base, app)).toEqual({ remove: [], upsert: [doc(50)] });
    const rem = base.filter((_, i) => i !== 3);
    expect(rowDiff(base, rem)).toEqual({ remove: [base[3]!._id], upsert: [] });
    const pre = [doc(-1), ...base.slice(0, 49)];
    const d = rowDiff(base, pre)!;
    expect(d).toEqual({ remove: [base[49]!._id], upsert: [doc(-1)], at: [0] });
    expect(applyRowDiff(base, d)).toEqual(pre);
  });

  test("a moved doc is removed + inserted at its index (fewest moves); a shuffle sends the order", () => {
    const base = Array.from({ length: 50 }, (_, i) => doc(i));
    const moved = [...base];
    const [x] = moved.splice(40, 1);
    moved.splice(2, 0, { ...x!, likes: 1000 });
    const d = rowDiff(base, moved)!;
    expect(d).toEqual({ remove: [x!._id], upsert: [{ ...x!, likes: 1000 }], at: [2] });
    expect(applyRowDiff(base, d)).toEqual(moved);
    const rev = [...base].reverse();
    const r = rowDiff(base, rev)!;
    expect(r.order).toHaveLength(50);
    expect(r.upsert).toEqual([]);
    expect(applyRowDiff(base, r)).toEqual(rev);
  });

  test("unchanged docs keep their identity", () => {
    const base = Array.from({ length: 20 }, (_, i) => doc(i));
    const next = base.map((d, i) => (i === 5 ? { ...d, likes: 1000 } : { ...d }));
    const out = applyRowDiff(base, rowDiff(base, next)!);
    expect(out).toEqual(next);
    expect(out[4]).toBe(base[4]);
    expect(out[5]).not.toBe(base[5]);
  });

  test("a diff that does not fit the base throws", () => {
    const base = Array.from({ length: 20 }, (_, i) => doc(i));
    const d = rowDiff(base, base.slice(1))!;
    expect(() => applyRowDiff(base.slice(1), d)).toThrow(/not in the base/);
    expect(() => applyRowDiff({}, d)).toThrow(/not an array/);
    expect(() => applyRowDiff(base, { remove: [], upsert: [], order: [base[0]!._id] })).toThrow(/order/);
  });

  test("fuzz: apply(prev, diff(prev, next)) == next, and the diff is never larger than the value", () => {
    const rnd = prng(3);
    let prev = Array.from({ length: 30 }, (_, i) => doc(i));
    let n = 100;
    for (let step = 0; step < 500; step++) {
      let next = prev.map((d) => (rnd() < 0.05 ? { ...d, likes: Math.floor(rnd() * 100) } : d));
      next = next.filter(() => rnd() > 0.04);
      for (let k = Math.floor(rnd() * 3); k > 0; k--) next.splice(Math.floor(rnd() * (next.length + 1)), 0, doc(n++));
      if (rnd() < 0.1) next.sort(() => rnd() - 0.5);
      if (rnd() < 0.2 && next.length > 2) next.splice(Math.floor(rnd() * next.length), 0, ...next.splice(Math.floor(rnd() * next.length), 1));
      if (rnd() < 0.05) next = next.map((d) => ({ ...d, tag: "x" }));
      const d = rowDiff(prev, next);
      if (d) {
        expect(applyRowDiff(prev, JSON.parse(encodeJson(d)))).toEqual(next);
        expect(encodeJson(d).length).toBeLessThan(encodeJson(next).length);
      }
      prev = next;
    }
  });

  test("bandwidth: 500-row list, one change", () => {
    const base = Array.from({ length: 500 }, (_, i) => doc(i));
    const full = encodeJson(base.map((d, i) => (i === 250 ? { ...d, likes: 42 } : d))).length;
    const cases = {
      update: base.map((d, i) => (i === 250 ? { ...d, likes: 42 } : d)),
      append: [...base, doc(500)],
      remove: base.filter((_, i) => i !== 250),
      prepend: [doc(-1), ...base.slice(0, 499)],
    };
    const sizes: Record<string, { full: number; diff: number; ratio: string }> = {};
    for (const [k, next] of Object.entries(cases)) {
      const d = rowDiff(base, next)!;
      const fullK = encodeJson(next).length;
      sizes[k] = { full: fullK, diff: encodeJson(d).length, ratio: (fullK / encodeJson(d).length).toFixed(1) + "x" };
    }
    console.log("rowdiff bandwidth (bytes of JSON):", JSON.stringify(sizes));
    expect(full).toBeGreaterThan(40_000);
    expect(sizes.update!.diff).toBeLessThan(200);
    expect(sizes.append!.diff).toBeLessThan(200);
    expect(sizes.remove!.diff).toBeLessThan(100);
    expect(sizes.prepend!.diff).toBeLessThan(250);
  });
});
