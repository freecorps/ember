// Diffs between two values one side already shares by identity: what a client hands its storage over a message
// boundary (remote.ts). The client keeps the identity of every row that did not change (`applyRowDiff`,
// `reuseUnchanged`), so comparing references finds the k changed rows of an n-row value in O(n) pointer checks and
// O(k) encodings — instead of the O(n) structured clone of the whole value per patch. The result is the protocol's
// own `RowDiff` / `ValueDiff`, applied on the other side with `applyAnyDiff`.

import { encodeJson, isPlainObject, type RowDiff, type ValueDiff } from "@freecorps/ember-values";

const idOf = (x: unknown): string | undefined => (isPlainObject(x) && typeof x._id === "string" ? x._id : undefined);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Positions (in `xs`) of a longest strictly increasing subsequence: the survivors that keep their order. */
function increasingRun(xs: readonly number[]): Uint8Array {
  const n = xs.length;
  const tails = new Int32Array(n);
  const prev = new Int32Array(n).fill(-1);
  let len = 0;
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (xs[tails[mid]!]! < xs[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
    if (lo === len) len++;
  }
  const out = new Uint8Array(n);
  for (let k = len ? tails[len - 1]! : -1; k >= 0; k = prev[k]!) out[k] = 1;
  return out;
}

/**
 * A row diff from `prev` to `next` (doc arrays with distinct ids), where a row present in both as the very same object
 * is unchanged. Null: not doc arrays, or no smaller than the value.
 *
 * Built here rather than with `rowDiff` (values): that one encodes every surviving row to compare it and measures its
 * diff against the encoded `next`, which is the O(n) work identity avoids. The diff is the same protocol `RowDiff`
 * (contracts.md, "rowdiff"): moved rows as removed + inserted at their index (fewest moves), or `order` when smaller.
 */
export function identityRowDiff(prev: unknown, next: unknown): RowDiff | null {
  if (!Array.isArray(prev) || !Array.isArray(next)) return null;
  const before = new Map<string, number>();
  for (let i = 0; i < prev.length; i++) {
    const id = idOf(prev[i]);
    if (id === undefined || before.has(id)) return null;
    before.set(id, i);
  }
  const ids: string[] = new Array(next.length);
  const seen = new Set<string>();
  for (let j = 0; j < next.length; j++) {
    const id = idOf(next[j]);
    if (id === undefined || seen.has(id)) return null;
    seen.add(id);
    ids[j] = id;
  }
  const remove: string[] = [];
  for (const d of prev) if (!seen.has((d as { _id: string })._id)) remove.push((d as { _id: string })._id);

  // Sizes are measured with every row both sides hold by reference as a tiny stub `{_id}`, and the real rows only
  // encoded when needed: `extra(j)` is what row j of `next` adds over its stub (memoized). A row held by reference is
  // unchanged; another surviving row is unchanged when its encoding is the same.
  const extraOf = new Map<number, number>();
  const extra = (j: number): number => {
    let e = extraOf.get(j);
    if (e === undefined) extraOf.set(j, (e = encodeJson(next[j]).length - encodeJson({ _id: ids[j] }).length));
    return e;
  };
  const oldOf: number[] = new Array(next.length);
  const same = new Uint8Array(next.length); // 1: unchanged (by reference)
  const unchanged = new Uint8Array(next.length); // 1: unchanged (by reference, or the same encoding)
  const survivorOld: number[] = [];
  for (let j = 0; j < next.length; j++) {
    const i = before.get(ids[j]!);
    oldOf[j] = i ?? -1;
    if (i === undefined) continue;
    survivorOld.push(i);
    if (prev[i] === next[j]) same[j] = unchanged[j] = 1;
    else if (encodeJson(prev[i]) === encodeJson(next[j])) unchanged[j] = 1;
  }
  const keep = increasingRun(survivorOld);

  // With moves: the survivors outside the increasing run are removed and inserted at their index.
  const upsert: number[] = [];
  const at: number[] = [];
  const moved: string[] = [];
  let k = 0;
  let stayCount = 0;
  for (let j = 0; j < next.length; j++) {
    if (oldOf[j]! >= 0) {
      if (keep[k++]) {
        stayCount++;
        if (!unchanged[j]) upsert.push(j);
        continue;
      }
      moved.push(ids[j]!);
    }
    upsert.push(j);
    at.push(j);
  }
  const appendedOnly = at.every((j, n) => j === stayCount + n);
  // Rows the diff carries as stubs while measuring (held by reference), and the real rows otherwise.
  const stubbed = (js: number[]) => js.map((j) => (same[j] ? { _id: ids[j] } : (next[j] as Record<string, unknown>)));
  const withAt: RowDiff = { remove: moved.length ? [...remove, ...moved] : remove, upsert: stubbed(upsert) };
  if (!appendedOnly) withAt.at = at;
  let size = encodeJson(withAt).length;
  for (const j of upsert) if (same[j]) size += extra(j);
  let best = withAt;
  let rows = upsert;
  if (moved.length) {
    // Alternative: no moves, the full order instead (carries only the changed rows).
    const changed: number[] = [];
    for (let j = 0; j < next.length; j++) if (!unchanged[j]) changed.push(j);
    const plain: RowDiff = { remove, upsert: stubbed(changed), order: ids };
    const plainSize = encodeJson(plain).length;
    if (plainSize < size) {
      best = plain;
      size = plainSize;
      rows = changed;
    }
  }
  // Smaller than the value? `size` is the real diff's. The value: its stubbed encoding plus what every stub adds; only
  // as many of those rows are encoded as it takes (usually none: the stubbed value alone is already bigger).
  const stubbedValue: unknown[] = new Array(next.length);
  for (let j = 0; j < next.length; j++) stubbedValue[j] = same[j] ? { _id: ids[j] } : next[j];
  let margin = size - encodeJson(stubbedValue).length;
  if (margin >= 0) {
    for (let j = 0; j < next.length && margin >= 0; j++) if (same[j]) margin -= extra(j);
    if (margin >= 0) return null;
  }
  return { ...best, upsert: rows.map((j) => next[j] as Record<string, unknown>) };
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
