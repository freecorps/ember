// TinyBase offline storage: the replica lives in the app's own TinyBase `Store`, one TinyBase table per Ember table
// (row id = `_id`, cells = the document's fields), so components already bound to TinyBase (`useTable`, `useRow`,
// queries, metrics) render replicated rows directly and stay reactive. Ember's own state sits in `_ember_*` tables
// (query records, their row-diff log, the pending queue) and `_ember_*` values (metadata).
//
// Why a backend over the Store, not a TinyBase persister: a persister copies a whole Store to and from some storage;
// it neither puts Ember's rows where the app reads them nor answers ranged reads by the server's encoded index keys.
// As a backend, local queries run with the same compiler as elsewhere (index ranges by encoded key, `jsSearch`),
// rows are written with ownership and atomically (`store.transaction`), and persistence stays the app's choice:
// any TinyBase persister on the same Store (IndexedDB, OPFS, expo-sqlite, a file...) — pass it as `persister` to have
// it loaded on open and saved after every write, or run its auto-load/auto-save yourself.
//
// Cells are JSON values: strings, numbers and booleans as they are; objects, arrays and null as JSON; values JSON
// cannot carry (bigint, bytes, NaN/±Infinity/-0) in Ember's tagged form (`{"$int64": "…"}`, `{"$bytes": "…"}`).
// Rows of other shards than the first one carry a `_shard` cell. Writes the app makes to these tables are seen
// (local queries re-run) but are overwritten by the next server value: the server stays the source of truth.
//
//   import { createStore } from "tinybase";
//   import { tinybaseStorage } from "@freecorps/ember-offline/tinybase";
//   const store = createStore();
//   new EmberClient({ url, storage: tinybaseStorage({ store, schema, queries: { messages } }) });

import { decodeJson, encodeJson, type PendingMutationRecord } from "@freecorps/ember-client";
import { compareBytes } from "@freecorps/ember-values";
import { docKey, indexFields, jsSearch, type Doc, type LocalSchema } from "@freecorps/ember-server";
import type { BackendReader, Commit, ExternalChange, OfflineBackend, QueryLogEntry, QueryRecord } from "./backend.ts";
import { scanSorted } from "./sorted.ts";
import { createOfflineStorage, type OfflineOptions, type OfflineStore } from "./store.ts";

type Cell = string | number | boolean | null | Record<string, unknown> | unknown[];
type Row = Record<string, Cell>;

/** The part of a TinyBase `Store` (v5+) used here. */
export interface TinyStore {
  getRow(tableId: string, rowId: string): Row;
  hasRow(tableId: string, rowId: string): boolean;
  getTable(tableId: string): Record<string, Row>;
  setRow(tableId: string, rowId: string, row: Row): unknown;
  delRow(tableId: string, rowId: string): unknown;
  delTable(tableId: string): unknown;
  getValue(valueId: string): unknown;
  setValue(valueId: string, value: string | number | boolean): unknown;
  delValue(valueId: string): unknown;
  getValueIds(): string[];
  transaction<T>(actions: () => T): T;
  addRowListener(
    tableId: string | null,
    rowId: string | null,
    listener: (store: unknown, tableId: string, rowId: string, getCellChange?: (t: string, r: string, c: string) => [boolean, unknown, unknown]) => void,
  ): string;
  delListener(listenerId: string): unknown;
}

/** The writes of one `writeSaved` (each records what it overwrites). */
interface Tx {
  setRow(table: string, id: string, row: Row): void;
  delRow(table: string, id: string): void;
  delTable(table: string): void;
  setValue(id: string, value: string | number | boolean): void;
  delValue(id: string): void;
}

/** A TinyBase persister (or anything with load/save). */
export interface TinyPersister {
  load(): Promise<unknown>;
  save(): Promise<unknown>;
}

export interface TinybaseStorageOptions extends OfflineOptions {
  /** The app's TinyBase store. */
  store: TinyStore;
  /** Loaded on open, saved after every write (omit if the app runs its own auto-load / auto-save). */
  persister?: TinyPersister;
}

const QUERIES = "_ember_queries";
const LOG = "_ember_log";
const PENDING = "_ember_pending";
const META = "_ember_meta:";
const SCHEMA = "_ember_schema";
const SHARDS = "_ember_shards";
const SHARD_CELL = "_shard";

const toRow = (doc: Doc, shard: string | null): Row => {
  const row = JSON.parse(encodeJson(doc)) as Row;
  if (shard !== null) row[SHARD_CELL] = shard;
  return row;
};
const toDoc = (row: Row): Doc => {
  const { [SHARD_CELL]: _s, ...rest } = row;
  return decodeJson(JSON.stringify(rest)) as Doc;
};

export class TinybaseBackend implements OfflineBackend {
  /** Shards in first-seen order; the first one's rows carry no `_shard` cell. */
  private shards: string[] = [];
  /**
   * `table` → id → doc, decoded once. Our own commits update it in place; another writer's change of the table (or a
   * rolled-back save) drops it.
   */
  private docs = new Map<string, Map<string, { shard: string; doc: Doc }>>();
  /** `table\0index\0shard` → rows sorted by key; `table\0shard` → that shard's docs (search). Dropped per table. */
  private sorted = new Map<string, Array<{ key: Uint8Array; doc: Doc }>>();
  private byShard = new Map<string, Doc[]>();
  /** Query key → its log row ids (no scan of the whole log per record). */
  private logIds: Map<string, Set<string>> | null = null;
  /** Highest `seq` in the pending table (null: not read yet). */
  private pendingSeq: number | null = null;
  private writing = false;
  private listener: string | null = null;
  private readonly external = new Set<(c: ExternalChange) => void>();
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly schema: LocalSchema,
    private readonly store: TinyStore,
    private readonly persister?: TinyPersister,
  ) {}

  private get tables(): string[] {
    return Object.keys(this.schema.manifest.tables);
  }

  async open() {
    this.dropCaches();
    await this.persister?.load();
    const s = this.store;
    if (s.getValue(SCHEMA) !== this.schema.manifest.version) {
      // A new schema: the replica is a cache, the server resends it (the pending queue and metadata stay).
      await this.writeSaved((tx) => {
        for (const t of this.tables) tx.delTable(t);
        tx.delTable(QUERIES);
        tx.delTable(LOG);
        tx.delValue(SHARDS);
        tx.setValue(SCHEMA, this.schema.manifest.version);
      });
    }
    const raw = s.getValue(SHARDS);
    this.shards = typeof raw === "string" && raw ? (JSON.parse(raw) as string[]) : [];
    const meta: Record<string, string> = {};
    for (const id of s.getValueIds()) {
      const v = s.getValue(id);
      if (id.startsWith(META) && typeof v === "string") meta[id.slice(META.length)] = v;
    }
    const queries = Object.values(s.getTable(QUERIES)).map((r) => decodeJson(String(r.record)) as QueryRecord);
    const log = Object.values(s.getTable(LOG)).map((r) => decodeJson(String(r.entry)) as QueryLogEntry);
    this.dropCaches();
    this.listener = s.addRowListener(null, null, (_s, table, rowId, change) => this.changed(table, rowId, change));
    return { meta, queries, log };
  }

  /** The log's row ids by query key, built once from the table. */
  private logIndex(): Map<string, Set<string>> {
    if (this.logIds) return this.logIds;
    const m = new Map<string, Set<string>>();
    for (const id of Object.keys(this.store.getTable(LOG))) {
      const key = id.slice(0, id.lastIndexOf("\u0000"));
      let set = m.get(key);
      if (!set) m.set(key, (set = new Set()));
      set.add(id);
    }
    return (this.logIds = m);
  }

  /** Forgets every derived cache (after a rollback, which rewrites rows behind our back). */
  private dropCaches(): void {
    this.docs.clear();
    this.sorted.clear();
    this.byShard.clear();
    this.logIds = null;
    this.pendingSeq = null;
  }

  /** `table`'s sorted and per-shard caches go; the decoded docs stay (updated in place by our commits). */
  private dropSorted(table: string): void {
    for (const k of this.sorted.keys()) if (k.startsWith(`${table}\u0000`)) this.sorted.delete(k);
    for (const k of this.byShard.keys()) if (k.startsWith(`${table}\u0000`)) this.byShard.delete(k);
  }

  /** Our writes run with `writing` set: the listener only reports other writers' changes. */
  private write(f: () => void): void {
    this.writing = true;
    try {
      this.store.transaction(f);
    } finally {
      this.writing = false;
    }
  }

  /**
   * A write that is only done once the persister saved it. Every row and value it changes is recorded first; if
   * the save fails, they are put back (and the shard list with them), so the Store never holds a write the
   * offline store was told failed (it rolls its own memory back and the next server value retries).
   */
  private async writeSaved(f: (tx: Tx) => void): Promise<void> {
    const s = this.store;
    const rows = new Map<string, { table: string; id: string; row: Row | null }>();
    const values = new Map<string, unknown>();
    const shards = this.shards;
    const keepRow = (table: string, id: string) => {
      const k = `${table}\u0000${id}`;
      if (!rows.has(k)) rows.set(k, { table, id, row: s.hasRow(table, id) ? s.getRow(table, id) : null });
    };
    const keepValue = (id: string) => {
      if (!values.has(id)) values.set(id, s.getValue(id));
    };
    const tx: Tx = {
      setRow: (table, id, row) => (keepRow(table, id), s.setRow(table, id, row)),
      delRow: (table, id) => (keepRow(table, id), s.delRow(table, id)),
      delTable: (table) => {
        for (const id of Object.keys(s.getTable(table))) keepRow(table, id);
        s.delTable(table);
      },
      setValue: (id, v) => (keepValue(id), s.setValue(id, v)),
      delValue: (id) => (keepValue(id), s.delValue(id)),
    };
    this.write(() => f(tx));
    try {
      await this.save();
    } catch (e) {
      this.dropCaches();
      this.write(() => {
        for (const { table, id, row } of rows.values()) {
          if (row) s.setRow(table, id, row);
          else s.delRow(table, id);
        }
        for (const [id, v] of values) {
          if (v === undefined) s.delValue(id);
          else s.setValue(id, v as string | number | boolean);
        }
      });
      this.shards = shards;
      throw e;
    }
  }

  private save(): Promise<void> {
    if (!this.persister) return Promise.resolve();
    const p = this.persister;
    const next = this.saving.then(() => p.save());
    this.saving = next.catch(() => undefined);
    return next.then(() => undefined);
  }

  private changed(table: string, rowId: string, change?: (t: string, r: string, c: string) => [boolean, unknown, unknown]): void {
    // Our own writes keep the caches current themselves (commit); a listener call per row would drop them per row.
    if (this.writing) return;
    if (table === LOG) this.logIds = null;
    if (table === PENDING) this.pendingSeq = null;
    if (!(table in this.schema.manifest.tables)) return;
    this.docs.delete(table);
    this.dropSorted(table);
    if (!this.external.size) return;
    const row = this.store.hasRow(table, rowId) ? this.store.getRow(table, rowId) : null;
    const before = change?.(table, rowId, SHARD_CELL)?.[1];
    const shards = new Set<string>();
    for (const s of [row?.[SHARD_CELL], before]) shards.add(typeof s === "string" ? s : (this.shards[0] ?? ""));
    for (const shard of shards) for (const l of this.external) l({ shard, tables: [table] });
  }

  onExternalChange(listener: (c: ExternalChange) => void): () => void {
    this.external.add(listener);
    return () => this.external.delete(listener);
  }

  private shardCell(tx: Tx, shard: string): string | null {
    let i = this.shards.indexOf(shard);
    if (i < 0) {
      // A new array: a failed save puts the previous one back.
      this.shards = [...this.shards, shard];
      tx.setValue(SHARDS, JSON.stringify(this.shards));
      i = this.shards.length - 1;
    }
    return i === 0 ? null : shard;
  }

  async setMeta(key: string, value: string | null) {
    await this.writeSaved((tx) => (value === null ? tx.delValue(META + key) : tx.setValue(META + key, value)));
  }

  loadPending(): PendingMutationRecord[] {
    return Object.values(this.store.getTable(PENDING))
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .map((r) => decodeJson(String(r.record)) as PendingMutationRecord);
  }
  async putPending(r: PendingMutationRecord) {
    await this.writeSaved((tx) => {
      const cur = this.store.hasRow(PENDING, r.mid) ? this.store.getRow(PENDING, r.mid) : null;
      if (this.pendingSeq === null) {
        let max = 0;
        for (const x of Object.values(this.store.getTable(PENDING))) max = Math.max(max, Number(x.seq) || 0);
        this.pendingSeq = max;
      }
      const seq = cur ? Number(cur.seq) : ++this.pendingSeq;
      tx.setRow(PENDING, r.mid, { seq, record: encodeJson(r) });
    });
  }
  async removePending(mid: string) {
    await this.writeSaved((tx) => tx.delRow(PENDING, mid));
  }

  async commit(shard: string, c: Commit) {
    const logs = this.logIndex();
    const clearLog = (tx: Tx, key: string) => {
      for (const id of logs.get(key) ?? []) tx.delRow(LOG, id);
      logs.delete(key);
    };
    const tables = new Set<string>();
    await this.writeSaved((tx) => {
      const cell = this.shardCell(tx, shard);
      for (const r of c.put ?? []) {
        tx.setRow(QUERIES, r.key, { record: encodeJson(r) });
        clearLog(tx, r.key);
      }
      for (const k of c.drop ?? []) {
        tx.delRow(QUERIES, k);
        clearLog(tx, k);
      }
      for (const e of c.append ?? []) {
        const id = `${e.key}\u0000${String(e.seq).padStart(10, "0")}`;
        tx.setRow(LOG, id, { entry: encodeJson(e) });
        let set = logs.get(e.key);
        if (!set) logs.set(e.key, (set = new Set()));
        set.add(id);
      }
      for (const { table, id } of c.delete ?? []) {
        tx.delRow(table, id);
        tables.add(table);
      }
      for (const { table, doc } of c.upsert ?? []) {
        tx.setRow(table, doc._id, toRow(doc, cell));
        tables.add(table);
      }
    });
    // Saved: the decoded rows move with the write (no re-decode of the table), the sorted views are rebuilt on use.
    for (const { table, id } of c.delete ?? []) this.docs.get(table)?.delete(id);
    for (const { table, doc } of c.upsert ?? []) this.docs.get(table)?.set(doc._id, { shard, doc });
    for (const t of tables) this.dropSorted(t);
  }

  /** `table`'s rows (all shards), decoded once per change of the table. */
  private rowsOf(table: string): Map<string, { shard: string; doc: Doc }> {
    let m = this.docs.get(table);
    if (!m) {
      m = new Map();
      const first = this.shards[0] ?? "";
      for (const [id, row] of Object.entries(this.store.getTable(table))) {
        const shard = typeof row[SHARD_CELL] === "string" ? (row[SHARD_CELL] as string) : first;
        try {
          m.set(id, { shard, doc: toDoc(row) });
        } catch {
          /* a row the app wrote in another shape: not a replicated document */
        }
      }
      this.docs.set(table, m);
    }
    return m;
  }

  reader(shard: string): BackendReader {
    const docsOf = (table: string) => {
      const k = `${table}\u0000${shard}`;
      let docs = this.byShard.get(k);
      if (!docs) {
        docs = [];
        for (const r of this.rowsOf(table).values()) if (r.shard === shard) docs.push(r.doc);
        this.byShard.set(k, docs);
      }
      return docs;
    };
    const sortedRows = (table: string, index: string) => {
      const k = `${table}\u0000${index}\u0000${shard}`;
      let rows = this.sorted.get(k);
      if (!rows) {
        const fields = indexFields(this.schema.manifest.tables[table]!, index)!;
        rows = docsOf(table)
          .map((doc) => ({ key: docKey(doc, fields), doc }))
          .sort((a, b) => compareBytes(a.key, b.key));
        this.sorted.set(k, rows);
      }
      return rows;
    };
    return {
      scan: (table, index, lo, hi, asc, limit) => scanSorted(sortedRows(table, index), lo, hi, asc, limit),
      get: (table, id) => {
        const r = this.rowsOf(table).get(id);
        return r && r.shard === shard ? r.doc : null;
      },
      pluginQuery: (table, kind, spec, arg) => {
        if (kind.kind !== "search") throw new Error(`index kind ${kind.kind} is not supported in TinyBase`);
        return jsSearch(docsOf(table), spec, arg as (q: unknown) => unknown);
      },
    };
  }

  async close() {
    if (this.listener !== null) this.store.delListener(this.listener);
    this.listener = null;
    await this.saving;
  }
}

/** Offline storage in a TinyBase store (reactive in the app's TinyBase bindings). */
export function tinybaseStorage(options: TinybaseStorageOptions): OfflineStore {
  return createOfflineStorage(new TinybaseBackend(options.schema, options.store, options.persister), options);
}
