import { describe, expect, test } from "vitest";
import { applyAnyDiff, applyValueDiff, decodeJson, encodeJson, encodeParts, reuseUnchanged, rowDiff, valueDiff, valueDiffJson } from "../src/index.ts";

const doc = (i: number, extra: Record<string, unknown> = {}) => ({ _id: `msg_${String(i).padStart(26, "0")}`, _creationTime: 1e12 + i, body: `message number ${i} with some text`, likes: i % 7, ...extra });

function prng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const page = (from: number, n: number) => ({ page: Array.from({ length: n }, (_, i) => doc(from - i)), isDone: false, continueCursor: `c${from - n + 1}` });

/** What the receiver gets: the diff's wire JSON, decoded, applied to its copy. */
const roundTrip = (prev: unknown, next: unknown): { out: unknown; bytes: number } | null => {
  const json = valueDiffJson(prev, encodeParts(prev), next, encodeParts(next));
  return json === null ? null : { out: applyValueDiff(prev, decodeJson(json) as never), bytes: json.length };
};

describe("valuediff", () => {
  test("encodeParts: the same text as encodeJson, split along objects that hold arrays of documents", () => {
    const values: unknown[] = [
      page(10, 5),
      { title: "t", items: [doc(1), doc(2)], meta: { count: 2, rows: [doc(3)], when: 5n } },
      { a: 1, b: [1, 2], c: { d: "x" } },
      { u: undefined, page: [doc(1, { n: 5n, b: new Uint8Array([1, 2]), f: NaN })], "__proto__": { x: 1 } },
      [doc(1), doc(2)],
      [],
      null,
      "s",
      { deep: { deeper: { deepest: { far: { rows: [doc(1)] } } } } },
    ];
    for (const v of values) {
      const e = encodeParts(v);
      expect(e.json).toBe(encodeJson(v));
    }
    expect(encodeParts(page(10, 5)).fields?.get("page")?.docs).toHaveLength(5);
    expect(encodeParts({ a: 1, b: [1, 2], c: { d: "x" } }).fields).toBeNull();
    expect(encodeParts([doc(1)]).fields).toBeNull();
  });

  test("a new row on top of a page: the row diff of `page` and the changed cursor, nothing else", () => {
    const prev = page(100, 50);
    const next = page(101, 50);
    const json = valueDiffJson(prev, encodeParts(prev), next, encodeParts(next))!;
    const d = JSON.parse(json);
    expect(Object.keys(d).sort()).toEqual(["r", "s"]);
    expect(d.s).toEqual({ continueCursor: "c52" });
    expect(d.r.page.upsert).toEqual([doc(101)]);
    expect(json.length * 20).toBeLessThan(encodeJson(next).length);
    const out = applyValueDiff(prev, d) as typeof prev;
    expect(out).toEqual(next);
    // Unchanged rows keep their identity.
    expect(out.page[1]).toBe(prev.page[0]);
  });

  test("fields added, deleted, reordered; nested objects; several arrays", () => {
    const prev = { a: 1, rows: [doc(1), doc(2)], nested: { other: [doc(3)], k: "x" }, gone: true };
    const next = { rows: [doc(1), doc(2, { likes: 9 })], a: 2, nested: { other: [doc(3), doc(4)], k: "x" }, added: [1] };
    const r = roundTrip(prev, next)!;
    expect(r.out).toEqual(next);
    expect(encodeJson(r.out)).toBe(encodeJson(next));
    expect((r.out as typeof next).rows[0]).toBe(prev.rows[0]);
    expect((r.out as typeof next).nested.other[0]).toBe(prev.nested.other[0]);
  });

  test("a diff that does not fit the base throws; non-objects give no diff", () => {
    const prev = page(10, 5);
    const d = valueDiff(prev, page(11, 5))!;
    expect(() => applyValueDiff([], d)).toThrow(/not an object/);
    expect(() => applyValueDiff({ page: [doc(99)], isDone: false, continueCursor: "x" }, d)).toThrow(/not in the base/);
    expect(() => applyValueDiff({}, { d: ["x"] })).toThrow(/not in the base/);
    expect(valueDiff([doc(1)], [doc(2)])).toBeNull();
    expect(valueDiff({ a: 1 }, { a: 2 })).toBeNull();
  });

  test("applyAnyDiff takes row diffs and value diffs", () => {
    const rows = [doc(1), doc(2)];
    expect(applyAnyDiff(rows, rowDiff(rows, [doc(1), doc(2), doc(3)])!)).toEqual([doc(1), doc(2), doc(3)]);
    expect(applyAnyDiff(page(10, 5), valueDiff(page(10, 5), page(12, 5))!)).toEqual(page(12, 5));
  });

  test("fuzz: apply(prev, diff) == next (same JSON text), never larger than the value, unchanged parts keep identity", () => {
    const rnd = prng(11);
    let n = 1000;
    const rows = (k: number) => Array.from({ length: k }, () => doc(n++));
    const mutateRows = (xs: Array<Record<string, unknown>>) => {
      let next = xs.map((d) => (rnd() < 0.1 ? { ...d, likes: Math.floor(rnd() * 100) } : d));
      next = next.filter(() => rnd() > 0.08);
      for (let k = Math.floor(rnd() * 3); k > 0; k--) next.splice(Math.floor(rnd() * (next.length + 1)), 0, doc(n++, rnd() < 0.2 ? { big: 7n } : {}));
      if (rnd() < 0.1) next.reverse();
      return next;
    };
    let prev: Record<string, unknown> = { page: rows(20), isDone: false, continueCursor: "c0", meta: { total: 20, recent: rows(3) } };
    for (let step = 0; step < 600; step++) {
      const next: Record<string, unknown> = {};
      const keys = Object.keys(prev);
      if (rnd() < 0.05) keys.reverse();
      for (const k of keys) {
        const v = prev[k];
        if (rnd() < 0.03 && k !== "page") continue; // deleted
        if (Array.isArray(v)) next[k] = rnd() < 0.5 ? mutateRows(v as Array<Record<string, unknown>>) : v;
        else if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          next[k] = rnd() < 0.5 ? { ...o, total: Math.floor(rnd() * 50), recent: mutateRows((o.recent as Array<Record<string, unknown>>) ?? []) } : o;
        } else next[k] = rnd() < 0.3 ? `c${step}` : v;
      }
      if (rnd() < 0.05) next.extra = rnd() < 0.5 ? rows(2) : { x: step };
      if (rnd() < 0.05) next.isDone = rnd() < 0.5 ? undefined : true;
      const r = roundTrip(prev, next);
      if (r) {
        expect(encodeJson(r.out)).toBe(encodeJson(next));
        expect(r.bytes).toBeLessThan(encodeJson(next).length);
        const out = r.out as Record<string, unknown>;
        for (const k of Object.keys(next)) if (encodeJson(prev[k]) === encodeJson(next[k]) && k in prev) expect(out[k]).toBe(prev[k]);
      }
      expect(encodeParts(next).json).toBe(encodeJson(next));
      prev = next;
    }
  });

  test("reuseUnchanged: a value that came whole keeps the identity of every part that did not change", () => {
    const prev = { ...page(100, 50), meta: { a: [1, 2], b: new Uint8Array([1]) } };
    const next = decodeJson(encodeJson({ ...page(101, 50), meta: { a: [1, 2], b: new Uint8Array([1]) } })) as typeof prev;
    const out = reuseUnchanged(prev, next);
    expect(out).toEqual(page(101, 50) && { ...page(101, 50), meta: { a: [1, 2], b: new Uint8Array([1]) } });
    expect(out.page[1]).toBe(prev.page[0]);
    expect(out.page[0]).not.toBe(prev.page[0]);
    expect(out.meta).toBe(prev.meta);
    const same = decodeJson(encodeJson(prev)) as typeof prev;
    expect(reuseUnchanged(prev, same)).toBe(prev);
    expect(reuseUnchanged([1, 2], [1, 3])).toEqual([1, 3]);
    expect(reuseUnchanged({ a: NaN }, { a: NaN })).toEqual({ a: NaN });
  });

  test("bandwidth: a 500-row page, one new row on top", () => {
    const prev = page(1000, 500);
    const next = page(1001, 500);
    const full = encodeJson(next).length;
    const diff = valueDiffJson(prev, encodeParts(prev), next, encodeParts(next))!.length;
    console.log(`vdiff bandwidth: ${full} -> ${diff} bytes (${(full / diff).toFixed(0)}x)`);
    expect(diff).toBeLessThan(300);
  });
});
