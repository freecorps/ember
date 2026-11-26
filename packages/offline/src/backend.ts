// The storage seam under the generic offline store (store.ts). A backend persists five things — metadata, the
// pending mutation queue, query records, their diff logs, and replicated rows per shard — and serves synchronous
// reads of one shard's rows to `runLocalQuery`. Backends: memory (memory.ts), SQLite (sqlite.ts, expo-sqlite.ts,
// sqlite-wasm.ts / opfs), IndexedDB (indexeddb.ts), TinyBase (tinybase.ts).

import type { LocalIdentity, PendingMutationRecord } from "@freecorps/ember-client";
import type { Doc, LocalReader } from "@freecorps/ember-server";
import { encodeJson, type RowDiff, type ValueDiff } from "@freecorps/ember-values";

/** The last server value of one subscribed query, and the replicated rows it owns. */
export interface QueryRecord {
  /** `${shard}\u0000${fn}\u0000${argsJson}` */
  key: string;
  shard: string;
  fn: string;
  args: Record<string, unknown>;
  argsJson: string;
  /**
   * The value (the base of the log when entries follow). With `refs`, the replicated documents in it are stored
   * as row references `{ _id, $row: 1 }` and read back from the replicated rows.
   */
  value: unknown;
  version: number;
  /** The shard epoch of `version` (absent in records written before it, or when the client did not know it). */
  epoch?: string;
  /** The identity tag the shard gave the value (`resume.ik`). */
  ik?: string;
  /**
   * Whose value it is (`ownerKey`: `"anon"` signed out; `"?"` when the client could not tell, never shown). A cached
   * value is only shown, and resumed, under its owner. Absent in records written before it (shown as before, never
   * resumed).
   */
  owner?: string;
  /** ms; refreshed on every server value (retention / eviction). */
  updatedAt: number;
  /** `_id`s of the complete documents in `value` (rows owned by this record). */
  ids: string[];
  /** `value` holds row references (format 2). Absent in records written before it. */
  refs?: true;
  /** Encoded size of `value` (bounds the log: entries never outgrow the base). */
  size?: number;
  /**
   * `valueFingerprint` of the full value (not of the stored skeleton). Absent in records written before it: unknown,
   * so the next value is written whatever it is.
   */
  fp?: string;
}

/**
 * One appended change of a record: the row (or value) diff from the previous stored value (references stay references), the
 * new version, and the owned ids that came and went. Replayed over `QueryRecord.value` on open, in `seq` order;
 * a `put` of the record (compaction) removes its entries.
 */
export interface QueryLogEntry {
  key: string;
  seq: number;
  /** A row diff (a doc array) or a value diff (an object holding doc arrays, e.g. `{page}`). */
  diff: RowDiff | ValueDiff;
  version: number;
  epoch?: string;
  ik?: string;
  owner?: string;
  updatedAt: number;
  add: string[];
  remove: string[];
  /**
   * `encodeJson(diff).length`, stored so opening does not encode every entry again to bound the log. Absent in
   * entries written before it (computed on open, as before).
   */
  bytes?: number;
  /** `valueFingerprint` of the full value after this entry (absent in entries written before it: unknown). */
  fp?: string;
}

/** One atomic write to a shard: query records, their log, and the rows they own. */
export interface Commit {
  /** Records written whole (their log entries are removed). */
  put?: QueryRecord[];
  /** Record keys to remove (with their log). */
  drop?: string[];
  append?: QueryLogEntry[];
  upsert?: Array<{ table: string; doc: Doc }>;
  delete?: Array<{ table: string; id: string }>;
}

/**
 * Reads of one shard. Async stores serve what they have fetched and record the rest as misses (throwing
 * `NeedData` so the query stops early); the store then calls `fetch()` and runs the query again.
 */
export interface BackendReader extends LocalReader {
  readonly misses?: number;
  fetch?(): Promise<void>;
}

/** Rows a backend saw change outside `commit` (another writer of a shared store): tables per shard. */
export type ExternalChange = { shard: string; tables: string[] };

export interface OfflineBackend {
  /**
   * Open / migrate (a schema change the planner refuses resets the replica; pending survives). `lazy`: shards whose
   * records were left out (read with `openShard` when the store first needs one of them), so opening — what the
   * client's `hello` waits for — does not read every shard.
   */
  open(): Promise<{ meta: Record<string, string>; queries: QueryRecord[]; log?: QueryLogEntry[]; lazy?: string[] }>;
  /** With `lazy` from `open()`: the records and log of one of those shards. */
  openShard?(shard: string): Promise<{ queries: QueryRecord[]; log?: QueryLogEntry[] }> | { queries: QueryRecord[]; log?: QueryLogEntry[] };
  setMeta(key: string, value: string | null): Promise<void> | void;
  loadPending(): Promise<PendingMutationRecord[]> | PendingMutationRecord[];
  putPending(record: PendingMutationRecord): Promise<void> | void;
  removePending(mid: string): Promise<void> | void;
  /**
   * Optional: the writes of one batch of the pending queue (`record`: put; none: remove), one per mid, in order, in
   * one transaction — all of them or none. Without it the store calls `putPending`/`removePending` one by one.
   */
  batchPending?(ops: ReadonlyArray<PendingOp>): Promise<void> | void;
  commit(shard: string, c: Commit): Promise<void> | void;
  reader(shard: string): BackendReader;
  /** Optional: report row changes made by someone else (e.g. the app writing to a shared TinyBase store). */
  onExternalChange?(listener: (c: ExternalChange) => void): () => void;
  close(): Promise<void> | void;
}

/** One write of the pending queue (`OfflineBackend.batchPending`): a put with `record`, a remove without. */
export type PendingOp = { mid: string; record?: PendingMutationRecord };

/** Thrown by async readers on a miss (see `BackendReader`). */
export class NeedData extends Error {
  constructor() {
    super("offline store: data not loaded yet");
    this.name = "NeedData";
  }
}

export const recordKey = (shard: string, fn: string, argsJson: string): string => `${shard}\u0000${fn}\u0000${argsJson}`;

/** The owner of a value whose identity the client could not tell: matches no request. */
export const UNKNOWN_OWNER = "?";

/** Who a stored value belongs to (the client's key for it: `"anon"` signed out). */
export const ownerKey = (id: LocalIdentity | null): string => (id ? `u\u0000${id.issuer ?? ""}\u0000${id.subject}` : "anon");

/** The owner `OfflineStore.applyPatch` records for an update (undefined: none, as an older client wrote it). */
export const updateOwner = (u: { identity?: LocalIdentity | null; ownerUnknown?: true }): string | undefined =>
  u.ownerUnknown ? UNKNOWN_OWNER : u.identity !== undefined ? ownerKey(u.identity) : undefined;

/**
 * A cheap fingerprint of a query value: a 53-bit structural hash (cyrb53's mixing over 32-bit words), memoized per
 * object (`WeakMap`), so a value that reuses the objects of an earlier one (the client keeps every unchanged row by
 * identity) is hashed in O(changed rows). Values are immutable: an object is never changed after it was handed over.
 * It follows the wire encoding (`encodeJson`): equal encodings hash alike (object keys in order, `undefined` fields
 * left out, `-0`, `NaN`, bigint and bytes apart from numbers and strings). Two values with the same fingerprint are
 * the same value but for a collision (about 2^-53); where that would skip a write (`OfflineStore.applyPatch`), the
 * values are compared in full first (`sameValue`). Prefixed `s`: never equal to the encoding-hash fingerprints older
 * versions stored (`<length>.<hash>`), which then just do not match once.
 */
export function valueFingerprint(value: unknown): string {
  return `s${hashValue(value).toString(36)}`;
}

/** `valueFingerprint` of an already encoded value (the format older versions stored; kept for callers of it). */
export function fingerprintOfJson(json: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const n = json.length;
  let i = 0;
  // Two UTF-16 units per step (one 32-bit word): half the multiplications of cyrb53's per-unit loop.
  for (; i + 1 < n; i += 2) {
    const c = json.charCodeAt(i) | (json.charCodeAt(i + 1) << 16);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  if (i < n) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${n.toString(36)}.${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** Whether `value` has fingerprint `fp`, in either format (a record or notice of an older version: `<length>.<hash>`). */
export function hasFingerprint(value: unknown, fp: string): boolean {
  // By the dot, not the `s` prefix: an older one starts with its length in base 36, which can be `s` too (28).
  return fp.includes(".") ? fingerprintOfJson(encodeJson(value)) === fp : valueFingerprint(value) === fp;
}

/** Hash of each object (array, plain object, bytes) already seen: its value never changes. */
const hashes = new WeakMap<object, number>();
/** Field names repeat across rows: their hashes, computed once. */
const keyHashes = new Map<string, number>();
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const TWO32 = 4294967296;

/** cyrb53's finalization of two lanes into a 53-bit number. */
function finish(h1: number, h2: number): number {
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return TWO32 * (2097151 & h2) + (h1 >>> 0);
}

function hashString(s: string, tag: number): number {
  let h1 = 0xdeadbeef ^ tag;
  let h2 = 0x41c6ce57 ^ Math.imul(tag, 0x9e3779b1);
  const n = s.length;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    const c = s.charCodeAt(i) | (s.charCodeAt(i + 1) << 16);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  if (i < n) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ n, 2654435761);
  h2 = Math.imul(h2 ^ n, 1597334677);
  return finish(h1, h2);
}

/** The structural hash under `valueFingerprint` (a non-negative integer below 2^53). */
export function hashValue(x: unknown): number {
  switch (typeof x) {
    case "string":
      return hashString(x, 1);
    case "number": {
      // Object.is semantics, as the encoding: -0 is not 0, every NaN is one value.
      if (x !== x) return 0x2f1a3;
      // The two words read right after the write, before anything else could use the shared buffer.
      f64[0] = x;
      const lo = u32[0]!;
      const hi = u32[1]!;
      return finish(Math.imul(0x51ed27 ^ lo, 2654435761), Math.imul(0x2b3d ^ hi, 1597334677));
    }
    case "boolean":
      return x ? 0x3a11 : 0x3a12;
    case "bigint":
      return hashString(x.toString(), 4);
    case "undefined":
      return 0x3a13;
    case "object": {
      if (x === null) return 0x3a14;
      const known = hashes.get(x);
      if (known !== undefined) return known;
      let h1: number;
      let h2: number;
      if (x instanceof Uint8Array) {
        h1 = 0x6a09e667;
        h2 = 0xbb67ae85;
        for (let i = 0; i < x.length; i++) {
          h1 = Math.imul(h1 ^ x[i]!, 2654435761);
          h2 = Math.imul(h2 ^ x[i]!, 1597334677);
        }
        h1 = Math.imul(h1 ^ x.length, 2654435761);
        h2 = Math.imul(h2 ^ x.length, 1597334677);
      } else if (Array.isArray(x)) {
        h1 = 0x3c6ef372;
        h2 = 0xa54ff53a;
        for (let i = 0; i < x.length; i++) {
          // `undefined` in an array encodes as null.
          const c = x[i] === undefined ? 0x3a14 : hashValue(x[i]);
          h1 = Math.imul(h1 ^ (c >>> 0), 2654435761);
          h2 = Math.imul(h2 ^ ((c / TWO32) | 0), 1597334677);
        }
        h1 = Math.imul(h1 ^ x.length, 2654435761);
      } else {
        h1 = 0x510e527f;
        h2 = 0x9b05688c;
        const o = x as Record<string, unknown>;
        let n = 0;
        for (const k of Object.keys(o)) {
          const v = o[k];
          // Left out of the encoding.
          if (v === undefined) continue;
          let kh = keyHashes.get(k);
          if (kh === undefined) {
            if (keyHashes.size >= 4096) keyHashes.clear();
            keyHashes.set(k, (kh = hashString(k, 2)));
          }
          const c = hashValue(v);
          h1 = Math.imul(h1 ^ (kh >>> 0), 2654435761);
          h2 = Math.imul(h2 ^ ((kh / TWO32) | 0), 1597334677);
          h1 = Math.imul(h1 ^ (c >>> 0), 2654435761);
          h2 = Math.imul(h2 ^ ((c / TWO32) | 0), 1597334677);
          n++;
        }
        h1 = Math.imul(h1 ^ n, 2654435761);
      }
      const h = finish(h1, h2);
      hashes.set(x, h);
      return h;
    }
    default:
      return 0x3a15;
  }
}

/**
 * Whether two values encode alike (`encodeJson`), compared in full: the check behind a fingerprint that matches. Shared
 * objects compare by identity first. Conservative where the encoding is lenient (`undefined` against `null` in an
 * array): "different" only costs a write.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return typeof a !== "number" || Object.is(a, b);
  if (typeof a !== typeof b) return false;
  if (typeof a === "number") return Object.is(a, b);
  if (typeof a !== "object" || a === null || b === null) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const arr = Array.isArray(a);
  if (arr !== Array.isArray(b)) return false;
  if (arr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!sameValue(x[i], y[i])) return false;
    return true;
  }
  // Own enumerable keys with a value, in order (the encoding's order).
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  let kx = Object.keys(x);
  let ky = Object.keys(y);
  if (kx.length !== ky.length || kx.some((k) => x[k] === undefined) || ky.some((k) => y[k] === undefined)) {
    kx = kx.filter((k) => x[k] !== undefined);
    ky = ky.filter((k) => y[k] !== undefined);
    if (kx.length !== ky.length) return false;
  }
  for (let i = 0; i < kx.length; i++) {
    const k = kx[i]!;
    if (ky[i] !== k || !sameValue(x[k], y[k])) return false;
  }
  return true;
}

/**
 * What a store just made durable (`OfflineStore.onSaved`): records written, as `[key, version, epoch, owner, fp,
 * freshUntil]`, and records dropped. The leader tab broadcasts it, so the other tabs skip handing it a value it
 * already stored. `fp` is the stored value's `valueFingerprint`; `freshUntil` (ms) is when the store stops skipping
 * that value again (it rewrites it then, so the record does not expire). Both are absent in notices of an older
 * leader: an equal version is then always handed over.
 */
export interface SavedNotice {
  put: Array<[key: string, version: number, epoch: string | null, owner: string | null, fp?: string | null, freshUntil?: number | null]>;
  drop: string[];
}
