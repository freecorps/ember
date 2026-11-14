// The storage seam under the generic offline store (store.ts). A backend persists five things — metadata, the
// pending mutation queue, query records, their diff logs, and replicated rows per shard — and serves synchronous
// reads of one shard's rows to `runLocalQuery`. Backends: memory (memory.ts), SQLite (sqlite.ts, expo-sqlite.ts,
// sqlite-wasm.ts / opfs), IndexedDB (indexeddb.ts), TinyBase (tinybase.ts).

import type { PendingMutationRecord } from "@freecorps/ember-client";
import type { Doc, LocalReader } from "@freecorps/ember-server";
import type { RowDiff, ValueDiff } from "@freecorps/ember-values";

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
   * Whose value it is (`ownerKey`: `"anon"` signed out). A cached value is only shown, and resumed, under its owner.
   * Absent in records written before it (shown as before, never resumed).
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
  /** Open / migrate (a schema change the planner refuses resets the replica; pending survives). */
  open(): Promise<{ meta: Record<string, string>; queries: QueryRecord[]; log?: QueryLogEntry[] }>;
  setMeta(key: string, value: string | null): Promise<void> | void;
  loadPending(): Promise<PendingMutationRecord[]> | PendingMutationRecord[];
  putPending(record: PendingMutationRecord): Promise<void> | void;
  removePending(mid: string): Promise<void> | void;
  commit(shard: string, c: Commit): Promise<void> | void;
  reader(shard: string): BackendReader;
  /** Optional: report row changes made by someone else (e.g. the app writing to a shared TinyBase store). */
  onExternalChange?(listener: (c: ExternalChange) => void): () => void;
  close(): Promise<void> | void;
}

/** Thrown by async readers on a miss (see `BackendReader`). */
export class NeedData extends Error {
  constructor() {
    super("offline store: data not loaded yet");
    this.name = "NeedData";
  }
}

export const recordKey = (shard: string, fn: string, argsJson: string): string => `${shard}\u0000${fn}\u0000${argsJson}`;
