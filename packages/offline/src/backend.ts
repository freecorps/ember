// The storage seam under the generic offline store (store.ts). A backend persists four things — metadata, the
// pending mutation queue, query records, and replicated rows per shard — and serves synchronous reads of one
// shard's rows to `runLocalQuery`. Backends: memory (memory.ts), SQLite (sqlite.ts, expo-sqlite.ts), IndexedDB
// (indexeddb.ts).

import type { PendingMutationRecord } from "@freecorps/ember-client";
import type { Doc, LocalReader } from "@freecorps/ember-server";

/** The last server value of one subscribed query, and the replicated rows it owns. */
export interface QueryRecord {
  /** `${shard}\u0000${fn}\u0000${argsJson}` */
  key: string;
  shard: string;
  fn: string;
  args: Record<string, unknown>;
  argsJson: string;
  value: unknown;
  version: number;
  /** ms; refreshed on every server value (retention / eviction). */
  updatedAt: number;
  /** `_id`s of the complete documents in `value` (rows owned by this record). */
  ids: string[];
}

/** One atomic write to a shard: query records and the rows they own. */
export interface Commit {
  put?: QueryRecord[];
  /** Record keys to remove. */
  drop?: string[];
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

export interface OfflineBackend {
  /** Open / migrate (a schema change the planner refuses resets the replica; pending survives). */
  open(): Promise<{ meta: Record<string, string>; queries: QueryRecord[] }>;
  setMeta(key: string, value: string | null): Promise<void> | void;
  loadPending(): Promise<PendingMutationRecord[]> | PendingMutationRecord[];
  putPending(record: PendingMutationRecord): Promise<void> | void;
  removePending(mid: string): Promise<void> | void;
  commit(shard: string, c: Commit): Promise<void> | void;
  reader(shard: string): BackendReader;
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
