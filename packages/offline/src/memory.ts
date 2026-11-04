// In-memory backend: the replica lives as long as the backend object. Useful for tests, SSR and as the reference
// semantics of the other backends (same keys: `docKey` over the index fields, compared bytewise).

import type { PendingMutationRecord } from "@freecorps/ember-client";
import { compareBytes, inKeyRange } from "@freecorps/ember-values";
import { docKey, indexFields, jsSearch, type Doc, type LocalSchema } from "@freecorps/ember-server";
import type { BackendReader, Commit, OfflineBackend, QueryRecord } from "./backend.ts";
import { createOfflineStorage, type OfflineOptions, type OfflineStore } from "./store.ts";

type Row = { key: Uint8Array; doc: Doc };

export class MemoryBackend implements OfflineBackend {
  readonly meta = new Map<string, string>();
  readonly pending = new Map<string, PendingMutationRecord>();
  readonly queries = new Map<string, QueryRecord>();
  /** shard → table → id → doc */
  readonly rows = new Map<string, Map<string, Map<string, Doc>>>();
  /** Sorted rows per `shard\0table\0index`, rebuilt after writes. */
  private sorted = new Map<string, Row[]>();
  schema: LocalSchema | null = null;

  constructor(schema?: LocalSchema) {
    this.schema = schema ?? null;
  }

  /** Schema version the rows were written with: another one resets the replica (pending stays). */
  private version: string | null = null;

  async open() {
    const v = this.schema?.manifest.version ?? null;
    if (this.version !== null && this.version !== v) {
      this.rows.clear();
      this.queries.clear();
      this.sorted.clear();
    }
    this.version = v;
    return { meta: Object.fromEntries(this.meta), queries: [...this.queries.values()] };
  }
  setMeta(key: string, value: string | null) {
    if (value === null) this.meta.delete(key);
    else this.meta.set(key, value);
  }
  loadPending() {
    return [...this.pending.values()];
  }
  putPending(r: PendingMutationRecord) {
    this.pending.set(r.mid, r);
  }
  removePending(mid: string) {
    this.pending.delete(mid);
  }

  private table(shard: string, table: string) {
    let s = this.rows.get(shard);
    if (!s) this.rows.set(shard, (s = new Map()));
    let t = s.get(table);
    if (!t) s.set(table, (t = new Map()));
    return t;
  }

  commit(shard: string, c: Commit) {
    for (const r of c.put ?? []) this.queries.set(r.key, r);
    for (const k of c.drop ?? []) this.queries.delete(k);
    for (const { table, doc } of c.upsert ?? []) this.table(shard, table).set(doc._id, doc);
    for (const { table, id } of c.delete ?? []) this.table(shard, table).delete(id);
    if (c.upsert?.length || c.delete?.length) this.sorted.clear();
  }

  reader(shard: string): BackendReader {
    const schema = this.schema;
    if (!schema) throw new Error("MemoryBackend: no schema");
    const sortedRows = (table: string, index: string): Row[] => {
      const k = `${shard}\u0000${table}\u0000${index}`;
      let rows = this.sorted.get(k);
      if (!rows) {
        const fields = indexFields(schema.manifest.tables[table]!, index)!;
        rows = [...this.table(shard, table).values()].map((doc) => ({ key: docKey(doc, fields), doc })).sort((a, b) => compareBytes(a.key, b.key));
        this.sorted.set(k, rows);
      }
      return rows;
    };
    return {
      scan: (table, index, lo, hi, asc, limit) => {
        const inRange = sortedRows(table, index).filter((r) => inKeyRange(r.key, lo, hi));
        return (asc ? inRange : inRange.reverse()).slice(0, limit);
      },
      get: (table, id) => this.table(shard, table).get(id) ?? null,
      pluginQuery: (table, kind, spec, arg) => {
        if (kind.kind !== "search") throw new Error(`index kind ${kind.kind} is not supported offline`);
        return jsSearch([...this.table(shard, table).values()], spec, arg as (q: unknown) => unknown);
      },
    };
  }

  close() {}
}

/**
 * Offline storage in memory: local queries and cached results without persistence (or, with a shared `backend`,
 * surviving a client re-creation in the same process).
 */
export function memoryStorage(options: OfflineOptions & { backend?: MemoryBackend }): OfflineStore {
  const backend = options.backend ?? new MemoryBackend(options.schema);
  backend.schema = options.schema;
  return createOfflineStorage(backend, options);
}
