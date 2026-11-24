// Diffs between two values one side already shares by identity: what a client hands its storage over a message
// boundary (remote.ts). The client keeps the identity of every row that did not change (`applyRowDiff`,
// `reuseUnchanged`), so comparing references finds the k changed rows of an n-row value in O(n) pointer checks and
// O(k) encodings — instead of the O(n) structured clone of the whole value per patch. The result is the protocol's
// own `RowDiff` / `ValueDiff`, applied on the other side with `applyAnyDiff`.

import { isPlainObject, rowDiff, type RowDiff, type ValueDiff } from "@freecorps/ember-values";

const idOf = (x: unknown): string | undefined => (isPlainObject(x) && typeof x._id === "string" ? x._id : undefined);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A row diff from `prev` to `next` (doc arrays with distinct ids), where a row present in both as the very same object
 * is unchanged. Null: not doc arrays, or no smaller than the value.
 */
export function identityRowDiff(prev: unknown, next: unknown): RowDiff | null {
  if (!Array.isArray(prev) || !Array.isArray(next)) return null;
  const before = new Map<string, unknown>();
  for (const d of prev) {
    const id = idOf(d);
    if (id === undefined || before.has(id)) return null;
    before.set(id, d);
  }
  // A row both sides hold by reference becomes the same tiny stub in both arrays: `rowDiff` encodes it in a few
  // bytes and never upserts it unless it moved (then the real row goes back in below).
  const stubs = new Map<string, { _id: string }>();
  const real = new Map<string, Record<string, unknown>>();
  const next2: unknown[] = new Array(next.length);
  for (let i = 0; i < next.length; i++) {
    const d = next[i];
    const id = idOf(d);
    if (id === undefined || real.has(id)) return null;
    real.set(id, d as Record<string, unknown>);
    if (before.get(id) === d) {
      const stub = { _id: id };
      stubs.set(id, stub);
      next2[i] = stub;
    } else next2[i] = d;
  }
  const prev2 = prev.map((d) => stubs.get((d as { _id: string })._id) ?? d);
  const diff = rowDiff(prev2, next2);
  if (!diff) return null;
  return { ...diff, upsert: diff.upsert.map((d) => real.get(d._id as string)!) };
}

/** A value diff (objects holding doc arrays, e.g. `{page}`), comparing parts by identity. Null when not objects. */
export function identityValueDiff(prev: unknown, next: unknown, depth = 0): ValueDiff | null {
  if (!isPlainObject(prev) || !isPlainObject(next)) return null;
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  // `applyValueDiff` skips undefined fields of its base; a `__proto__` field would need a defined property here.
  for (const k of prevKeys) if (prev[k] === undefined || k === "__proto__") return null;
  for (const k of nextKeys) if (next[k] === undefined || k === "__proto__") return null;
  const diff: ValueDiff = {};
  const s: Record<string, unknown> = {};
  const r: Record<string, RowDiff> = {};
  const o: Record<string, ValueDiff> = {};
  const d: string[] = [];
  let ns = 0;
  let nr = 0;
  let no = 0;
  for (const k of nextKeys) {
    const n = next[k];
    if (hasOwn(prev, k)) {
      const p = prev[k];
      if (p === n) continue;
      const rd = identityRowDiff(p, n);
      if (rd) {
        r[k] = rd;
        nr++;
        continue;
      }
      if (depth < 4) {
        const od = identityValueDiff(p, n, depth + 1);
        if (od) {
          o[k] = od;
          no++;
          continue;
        }
      }
    }
    s[k] = n;
    ns++;
  }
  for (const k of prevKeys) if (!hasOwn(next, k)) d.push(k);
  if (ns) diff.s = s;
  if (nr) diff.r = r;
  if (no) diff.o = o;
  if (d.length) diff.d = d;
  // Applying keeps the base's field order and appends new fields: `k` only when that is not the new order.
  const expected = prevKeys.filter((k) => hasOwn(next, k));
  for (const k of nextKeys) if (!hasOwn(prev, k)) expected.push(k);
  if (expected.some((k, i) => nextKeys[i] !== k)) diff.k = nextKeys;
  return diff;
}

/** `identityRowDiff` for a doc array, else `identityValueDiff`; null: send the whole value. */
export function identityDiff(prev: unknown, next: unknown): RowDiff | ValueDiff | null {
  return identityRowDiff(prev, next) ?? identityValueDiff(prev, next);
}
