// Value diffs (protocol feature "vdiff", contracts.md): row diffs for arrays of documents inside objects. For a query
// result that is a plain object holding arrays of documents (`paginate()`'s `{page, isDone, continueCursor}`, or any
// `{ title, items: [...] }`, at any depth through objects), the server may send, instead of the whole new value:
//
//   { s?: {field: value}, d?: [field], r?: {field: RowDiff}, o?: {field: ValueDiff}, k?: [field] }
//
//   apply(old, diff) = a copy of `old` (a new object; its unchanged fields keep their identity) where
//     - the fields in `d` are deleted;
//     - each `s` field is set to the value given (a new field goes last);
//     - each `r` field (an array of documents in `old`) gets the row diff (`applyRowDiff`: unchanged rows keep theirs);
//     - each `o` field (an object in `old`) gets the nested value diff;
//     - with `k` (every field of the new value, in order), the fields are put in that order.
//
// Encoded once per run: `encodeParts` splits the wire JSON along the fields (and the documents of each array of
// documents), so the value's JSON and every diff from or to it are built from the same strings (`valueDiffJson`).

import { decodeJson, encodeJson } from "./json.ts";
import { applyRowDiff, isDocArray, rowDiffJson, type RowDiff } from "./rowdiff.ts";

export type ValueDiff = {
  s?: Record<string, unknown>;
  d?: string[];
  r?: Record<string, RowDiff>;
  o?: Record<string, ValueDiff>;
  k?: string[];
};

/** The wire JSON of a value (`json` is exactly `encodeJson(value)`), split where a diff can use the parts. */
export interface EncodedValue {
  json: string;
  /** An array of documents: the JSON of each one. */
  docs: string[] | null;
  /** A plain object holding an array of documents (directly or through objects): each defined field, encoded. */
  fields: Map<string, EncodedValue> | null;
}

/** Objects deeper than this are encoded whole (a diff replaces them). */
const MAX_DEPTH = 4;

function plainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x) || x instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(x);
  return (proto === Object.prototype || proto === null) && !("toJSON" in x);
}

const leaf = (json: string): EncodedValue => ({ json, docs: null, fields: null });

/**
 * `{json, docs, fields}` of a value: one pass, every document encoded once. An object gets `fields` only when one of
 * them (at any depth through objects) is an array of documents; otherwise it is encoded whole.
 */
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

/**
 * `encodeJson` of the value diff from `prev` to `next` (both plain objects whose encodings have `fields`), built from
 * their encodings; null when there is none or it is not smaller than `next`'s JSON.
 */
export function valueDiffJson(prev: unknown, prevEnc: EncodedValue, next: unknown, nextEnc: EncodedValue): string | null {
  if (!prevEnc.fields || !nextEnc.fields) return null;
  const json = objectDiffJson(prev as Record<string, unknown>, prevEnc.fields, next as Record<string, unknown>, nextEnc.fields);
  return json !== null && json.length < nextEnc.json.length ? json : null;
}

function objectDiffJson(prev: Record<string, unknown>, pf: Map<string, EncodedValue>, next: Record<string, unknown>, nf: Map<string, EncodedValue>): string | null {
  const s: string[] = [];
  const r: string[] = [];
  const o: string[] = [];
  const d: string[] = [];
  for (const [k, n] of nf) {
    const p = pf.get(k);
    if (p && p.json === n.json) continue;
    const key = JSON.stringify(k);
    if (p?.docs && n.docs) {
      const j = rowDiffJson(prev[k] as Array<Record<string, unknown>>, p.docs, next[k] as Array<Record<string, unknown>>, n.docs, n.json);
      if (j !== null) {
        r.push(`${key}:${j}`);
        continue;
      }
    } else if (p?.fields && n.fields) {
      const j = objectDiffJson(prev[k] as Record<string, unknown>, p.fields, next[k] as Record<string, unknown>, n.fields);
      if (j !== null && j.length < n.json.length) {
        o.push(`${key}:${j}`);
        continue;
      }
    }
    s.push(`${key}:${n.json}`);
  }
  for (const k of pf.keys()) if (!nf.has(k)) d.push(k);
  // Field order: applying keeps the old order and appends new fields; `k` gives the order when that is not it.
  const expected = [...pf.keys()].filter((k) => nf.has(k));
  for (const k of nf.keys()) if (!pf.has(k)) expected.push(k);
  let order = "";
  let i = 0;
  for (const k of nf.keys()) {
    if (expected[i++] !== k) {
      order = `"k":${JSON.stringify([...nf.keys()])}`;
      break;
    }
  }
  const parts: string[] = [];
  if (s.length) parts.push(`"s":{${s.join(",")}}`);
  if (d.length) parts.push(`"d":${JSON.stringify(d)}`);
  if (r.length) parts.push(`"r":{${r.join(",")}}`);
  if (o.length) parts.push(`"o":{${o.join(",")}}`);
  if (order) parts.push(order);
  return parts.length ? `{${parts.join(",")}}` : null;
}

/** The value diff from `prev` to `next` as an object (`valueDiffJson`, decoded), or null. */
export function valueDiff(prev: unknown, next: unknown): ValueDiff | null {
  const json = valueDiffJson(prev, encodeParts(prev), next, encodeParts(next));
  return json === null ? null : (decodeJson(json) as ValueDiff);
}

function setField(o: Record<string, unknown>, k: string, v: unknown): void {
  // A "__proto__" field is data, never the object's prototype.
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

/**
 * Applies a value diff to the receiver's copy of the value: a new object, where every field the diff does not touch
 * keeps its identity (and so do the unchanged documents of a diffed array). Throws when the diff does not fit `prev`
 * (the receiver's base is not the sender's): resynchronize with a full value.
 */
export function applyValueDiff(prev: unknown, diff: ValueDiff): Record<string, unknown> {
  if (!plainObject(prev)) throw new Error("vdiff: the base value is not an object");
  if (typeof diff !== "object" || diff === null) throw new Error("vdiff: malformed diff");
  const del = new Set(diff.d ?? []);
  for (const k of del) if (!Object.prototype.hasOwnProperty.call(prev, k)) throw new Error(`vdiff: deleted field ${k} is not in the base value`);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(prev)) if (!del.has(k) && prev[k] !== undefined) setField(out, k, prev[k]);
  if (diff.s) for (const k of Object.keys(diff.s)) setField(out, k, diff.s[k]);
  if (diff.r) {
    for (const k of Object.keys(diff.r)) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) throw new Error(`vdiff: diffed field ${k} is not in the base value`);
      setField(out, k, applyRowDiff(out[k], diff.r[k]!));
    }
  }
  if (diff.o) {
    for (const k of Object.keys(diff.o)) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) throw new Error(`vdiff: diffed field ${k} is not in the base value`);
      setField(out, k, applyValueDiff(out[k], diff.o[k]!));
    }
  }
  if (!diff.k) return out;
  const keys = Object.keys(out);
  if (diff.k.length !== keys.length || diff.k.some((k) => !Object.prototype.hasOwnProperty.call(out, k))) throw new Error("vdiff: field order does not match the value");
  const ordered: Record<string, unknown> = {};
  for (const k of diff.k) setField(ordered, k, out[k]);
  return ordered;
}

/** A row diff (`{remove, upsert}`) or a value diff: what a stored log entry or a patch carries. */
export function applyAnyDiff(prev: unknown, diff: RowDiff | ValueDiff): unknown {
  return "remove" in diff && "upsert" in diff ? applyRowDiff(prev, diff as RowDiff) : applyValueDiff(prev, diff as ValueDiff);
}

/**
 * `next`, with every part equal to the same part of `prev` replaced by `prev`'s (documents matched by `_id` in arrays
 * of documents, other arrays by index): a value that arrived whole keeps the identity of what did not change, so a
 * React tree re-renders only the rows that did. `next` must be freshly decoded (it is updated in place).
 */
export function reuseUnchanged<T>(prev: unknown, next: T): T {
  return share(prev, next, 0) as T;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const idOf = (x: unknown): string | undefined => {
  const id = typeof x === "object" && x !== null ? (x as { _id?: unknown })._id : undefined;
  return typeof id === "string" ? id : undefined;
};

/**
 * Every part is compared before it is shared, so matching rows by `_id` needs no validation (a duplicate id only
 * shares less). Decoded values are plain objects and arrays: no allocation per object (no `Object.keys`).
 */
function share(prev: unknown, next: unknown, depth: number): unknown {
  if (prev === next) return prev;
  if (typeof next !== "object" || next === null) return Object.is(prev, next) ? prev : next;
  if (typeof prev !== "object" || prev === null || depth > 64) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    const n = next.length;
    let same = n === prev.length;
    let byId: Map<string, unknown> | null = null;
    if (n && prev.length && idOf(next[0]) !== undefined) {
      // Rows: matched by `_id`, so a row that moved keeps its identity too.
      byId = new Map();
      for (const d of prev) {
        const id = idOf(d);
        if (id !== undefined) byId.set(id, d);
      }
    }
    for (let i = 0; i < n; i++) {
      const x = next[i];
      const id = byId ? idOf(x) : undefined;
      const before = byId ? (id === undefined ? undefined : byId.get(id)) : prev[i];
      const v = before === undefined ? x : share(before, x, depth + 1);
      if (v !== x) next[i] = v;
      if (same && v !== prev[i]) same = false;
    }
    return same ? prev : next;
  }
  if (next instanceof Uint8Array) return prev instanceof Uint8Array && sameBytes(prev, next) ? prev : next;
  if (Array.isArray(prev) || prev instanceof Uint8Array) return next;
  const p = prev as Record<string, unknown>;
  const o = next as Record<string, unknown>;
  let same = true;
  let count = 0;
  for (const k in o) {
    count++;
    const nv = o[k];
    // `p["__proto__"]` would be the prototype when `p` has no such field.
    const pv = k === "__proto__" && !Object.prototype.hasOwnProperty.call(p, k) ? undefined : p[k];
    const v = pv === undefined ? nv : share(pv, nv, depth + 1);
    if (v !== nv) setField(o, k, v);
    if (same && v !== pv) same = false;
  }
  if (same) {
    let before = 0;
    for (const _ in p) before++;
    if (before !== count) same = false;
  }
  return same ? prev : next;
}
