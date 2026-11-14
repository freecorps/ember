// Per-row patch diffs (protocol v1.1 feature "rowdiff", contracts.md). For a query result that is an array of
// documents with distinct string `_id`s, the server may send `{remove, upsert, at?, order?}` instead of the whole
// new array:
//
//   apply(old, diff):
//     1. drop the docs whose `_id` is in `remove`;
//     2. a doc in `upsert` whose `_id` is still there replaces it in place; the others are "inserted" docs;
//     3. inserted docs go to the end, in order; or, with `at` (one final index per inserted doc, ascending), each
//        is spliced in at its index;
//     4. with `order` (every `_id` of the new value, in order), the result is rearranged to it.
//
// A doc that moves is sent as removed + inserted (`at`), choosing the fewest moves (longest increasing run of the
// survivors); `order` is used instead when it is smaller. The sender falls back to the full value whenever the
// diff is not smaller.

import { encodeJson } from "./json.ts";

export type RowDiff = { remove: string[]; upsert: Array<Record<string, unknown>>; at?: number[]; order?: string[] };

type Row = Record<string, unknown> & { _id: string };

/** `x` is an array of plain objects with distinct string `_id`s. */
export function isDocArray(x: unknown): x is Row[] {
  if (!Array.isArray(x)) return false;
  const seen = new Set<string>();
  for (const d of x) {
    if (typeof d !== "object" || d === null || Array.isArray(d) || d instanceof Uint8Array) return false;
    const id = (d as Row)._id;
    if (typeof id !== "string" || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** Positions (in `xs`) of a longest strictly increasing subsequence. */
function lis(xs: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(xs.length).fill(-1);
  for (let i = 0; i < xs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (xs[tails[mid]!]! < xs[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) out.add(k);
  return out;
}

/**
 * The diff from `prev` to `next`, or null when either is not a doc array or the diff is not smaller than the
 * full value (sizes and docs compared in the wire encoding, `encodeJson`). Pass `nextJson` when already known.
 */
export function rowDiff(prev: unknown, next: unknown, nextJson?: string): RowDiff | null {
  if (!isDocArray(prev) || !isDocArray(next)) return null;
  const oldIndex = new Map<string, number>();
  prev.forEach((d, i) => oldIndex.set(d._id, i));
  const oldJson = (i: number) => encodeJson(prev[i]);
  const nextIds = new Set(next.map((d) => d._id));
  const remove = prev.filter((d) => !nextIds.has(d._id)).map((d) => d._id);

  // Survivors that keep their relative order stay; the others move (removed + inserted at their index).
  const survivorPos: number[] = [];
  const survivorOld: number[] = [];
  next.forEach((d, j) => {
    const i = oldIndex.get(d._id);
    if (i !== undefined) {
      survivorPos.push(j);
      survivorOld.push(i);
    }
  });
  const keep = lis(survivorOld);
  const stays = new Set<number>(); // positions in `next`
  survivorPos.forEach((j, k) => keep.has(k) && stays.add(j));

  const upsert: Row[] = [];
  const at: number[] = [];
  const moved: string[] = [];
  next.forEach((d, j) => {
    const i = oldIndex.get(d._id);
    if (i !== undefined && stays.has(j)) {
      if (oldJson(i) !== encodeJson(d)) upsert.push(d);
      return;
    }
    if (i !== undefined) moved.push(d._id);
    upsert.push(d);
    at.push(j);
  });
  const stayCount = stays.size;
  const appendedOnly = at.every((j, k) => j === stayCount + k);
  const withAt: RowDiff = { remove: [...remove, ...moved], upsert };
  if (!appendedOnly) withAt.at = at;

  let best = withAt;
  if (moved.length) {
    // Alternative: no moves, the full order instead.
    const plain: RowDiff = { remove, upsert: next.filter((d) => {
      const i = oldIndex.get(d._id);
      return i === undefined || oldJson(i) !== encodeJson(d);
    }), order: next.map((d) => d._id) };
    if (encodeJson(plain).length < encodeJson(withAt).length) best = plain;
  }
  const full = nextJson ?? encodeJson(next);
  return encodeJson(best).length < full.length ? best : null;
}

/**
 * The wire JSON of a value (`json` is exactly `encodeJson(value)`) and, when it is an array of documents, the JSON of
 * each document (`docs`): encoded once, they serve the whole value and every row diff from or to it (`rowDiffJson`).
 */
export function encodeWithDocs(value: unknown): { json: string; docs: string[] | null } {
  if (!isDocArray(value)) return { json: encodeJson(value), docs: null };
  const docs = new Array<string>(value.length);
  for (let i = 0; i < value.length; i++) docs[i] = encodeJson(value[i]);
  // An array's JSON is its elements' JSON joined: the same text `encodeJson(value)` writes.
  return { json: `[${docs.join(",")}]`, docs };
}

/**
 * `encodeJson(rowDiff(prev, next))` (null when `rowDiff` is null), from the documents' JSON that `encodeWithDocs` gave
 * for both values: no document is encoded again, and the diff's JSON is built from them.
 */
export function rowDiffJson(
  prev: ReadonlyArray<Record<string, unknown>>,
  prevDocs: readonly string[],
  next: ReadonlyArray<Record<string, unknown>>,
  nextDocs: readonly string[],
  nextJson: string,
): string | null {
  const oldIndex = new Map<string, number>();
  for (let i = 0; i < prev.length; i++) oldIndex.set(prev[i]!._id as string, i);
  const nextIds = new Set<string>();
  for (const d of next) nextIds.add(d._id as string);
  const remove: string[] = [];
  for (const d of prev) if (!nextIds.has(d._id as string)) remove.push(d._id as string);

  const survivorPos: number[] = [];
  const survivorOld: number[] = [];
  for (let j = 0; j < next.length; j++) {
    const i = oldIndex.get(next[j]!._id as string);
    if (i !== undefined) {
      survivorPos.push(j);
      survivorOld.push(i);
    }
  }
  const keep = lis(survivorOld);
  const stays = new Set<number>();
  survivorPos.forEach((j, k) => keep.has(k) && stays.add(j));

  const upsert: string[] = [];
  const at: number[] = [];
  const moved: string[] = [];
  for (let j = 0; j < next.length; j++) {
    const i = oldIndex.get(next[j]!._id as string);
    if (i !== undefined && stays.has(j)) {
      if (prevDocs[i] !== nextDocs[j]) upsert.push(nextDocs[j]!);
      continue;
    }
    if (i !== undefined) moved.push(next[j]!._id as string);
    upsert.push(nextDocs[j]!);
    at.push(j);
  }
  const stayCount = stays.size;
  const appendedOnly = at.every((j, k) => j === stayCount + k);
  const ids = (xs: string[]) => JSON.stringify(xs);
  let best = `{"remove":${ids(moved.length ? [...remove, ...moved] : remove)},"upsert":[${upsert.join(",")}]${appendedOnly ? "" : `,"at":${JSON.stringify(at)}`}}`;
  if (moved.length) {
    // Alternative: no moves, the full order instead.
    const changed: string[] = [];
    for (let j = 0; j < next.length; j++) {
      const i = oldIndex.get(next[j]!._id as string);
      if (i === undefined || prevDocs[i] !== nextDocs[j]) changed.push(nextDocs[j]!);
    }
    const plain = `{"remove":${ids(remove)},"upsert":[${changed.join(",")}],"order":${ids(next.map((d) => d._id as string))}}`;
    if (plain.length < best.length) best = plain;
  }
  return best.length < nextJson.length ? best : null;
}

/**
 * Applies a diff to the receiver's copy. Unchanged docs keep their identity (cheap re-renders). Throws when the
 * diff does not fit `prev` (the receiver's base is not the sender's): resynchronize with a full value.
 */
export function applyRowDiff(prev: unknown, diff: RowDiff): Array<Record<string, unknown>> {
  if (!isDocArray(prev)) throw new Error("rowdiff: the base value is not an array of documents");
  if (!Array.isArray(diff.remove) || !Array.isArray(diff.upsert)) throw new Error("rowdiff: malformed diff");
  const removed = new Set(diff.remove);
  const ids = new Set(prev.map((d) => d._id));
  for (const id of removed) if (!ids.has(id)) throw new Error(`rowdiff: removed ${id} is not in the base value`);
  const out: Row[] = prev.filter((d) => !removed.has(d._id));
  const at = new Map(out.map((d, i) => [d._id, i]));
  const inserted: Row[] = [];
  for (const u of diff.upsert) {
    const id = (u as Row)._id;
    if (typeof id !== "string") throw new Error("rowdiff: upserted document without _id");
    const i = at.get(id);
    if (i !== undefined) out[i] = u as Row;
    else inserted.push(u as Row);
  }
  if (diff.at) {
    if (diff.at.length !== inserted.length) throw new Error("rowdiff: at does not match the inserted documents");
    let last = -1;
    inserted.forEach((d, k) => {
      const j = diff.at![k]!;
      if (!Number.isInteger(j) || j <= last || j > out.length) throw new Error("rowdiff: bad insert position");
      last = j;
      out.splice(j, 0, d);
    });
  } else out.push(...inserted);
  if (!diff.order) return out;
  if (diff.order.length !== out.length || new Set(diff.order).size !== out.length) throw new Error("rowdiff: order does not match the documents");
  const byId = new Map(out.map((d) => [d._id, d]));
  return diff.order.map((id) => {
    const d = byId.get(id);
    if (!d) throw new Error(`rowdiff: order lists unknown ${id}`);
    return d;
  });
}
