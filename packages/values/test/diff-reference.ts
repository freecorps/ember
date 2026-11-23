// rowDiffJson and encodeParts before PR 2A (verbatim), the references the optimized ones must match exactly.

import { encodeJson } from "../src/json.ts";
import { isDocArray } from "../src/rowdiff.ts";
import type { EncodedValue } from "../src/valuediff.ts";

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

const MAX_DEPTH = 4;
function plainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x) || x instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(x);
  return (proto === Object.prototype || proto === null) && !("toJSON" in x);
}
const leaf = (json: string): EncodedValue => ({ json, docs: null, fields: null });
export function encodeParts(value: unknown): EncodedValue {
  return encodeAt(value, 0);
}
function encodeAt(value: unknown, depth: number): EncodedValue {
  if (Array.isArray(value)) {
    if (!isDocArray(value)) return leaf(encodeJson(value));
    const docs = new Array<string>(value.length);
    for (let i = 0; i < value.length; i++) docs[i] = encodeJson(value[i]);
    // An array's JSON is its elements' JSON joined: the same text `encodeJson(value)` writes.
    return { json: `[${docs.join(",")}]`, docs, fields: null };
  }
  if (depth >= MAX_DEPTH || !plainObject(value)) return leaf(encodeJson(value));
  const fields = new Map<string, EncodedValue>();
  const parts: string[] = [];
  let split = false;
  for (const k in value) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
    const item = value[k];
    // As JSON.stringify: an undefined field is left out.
    if (item === undefined) continue;
    const e = encodeAt(item, depth + 1);
    if (e.docs || e.fields) split = true;
    fields.set(k, e);
    parts.push(`${JSON.stringify(k)}:${e.json}`);
  }
  // The object's JSON is its fields' JSON joined, in the same order JSON.stringify walks them.
  const json = `{${parts.join(",")}}`;
  return split ? { json, docs: null, fields } : leaf(json);
}
