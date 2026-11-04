// IndexedDB offline storage (browsers). One object store per table holds the replicated documents of every shard,
// keyed `[shard, _id]`; each db index (and `by_creation_time`) is an IndexedDB index on `[shard, _k_<index>]`,
// where `_k_<index>` is the server's encoded key (`encodeKey([fields..., _creationTime, _id])`) as an ArrayBuffer.
// IndexedDB compares binary keys bytewise, like SQLite compares the BLOB key column, so every index range the
// query compiler computes is one `IDBKeyRange.bound([shard, lo], [shard, hi], false, true)`.
//
// Queries are synchronous and IndexedDB is not: the reader serves scans it has already fetched and records the
// others as misses; the store fetches them (one transaction) and re-runs the query until nothing is missing.
// Search has no FTS here: `withSearchIndex` loads the table's rows of that shard and runs `jsSearch` (same
// tokenizer and matching, BM25 over the replica).
//
//   import { indexedDbStorage } from "@freecorps/ember-offline/indexeddb";
//   new EmberClient({ url, storage: indexedDbStorage({ name: "my-app", schema, queries: { messages } }) })

import type { PendingMutationRecord } from "@freecorps/ember-client";
import { dbIndexesOf, docKey, indexFields, jsSearch, type Doc, type LocalSchema } from "@freecorps/ember-server";
import { bytesToBase64 } from "@freecorps/ember-values";
import { NeedData, type BackendReader, type Commit, type OfflineBackend, type QueryRecord } from "./backend.ts";
import { createOfflineStorage, type OfflineOptions, type OfflineStore } from "./store.ts";

export interface IndexedDbStorageOptions extends OfflineOptions {
  /** Database name. Default `"ember"`. */
  name?: string;
  /** Default: `globalThis.indexedDB` (inject `fake-indexeddb` in tests). */
  indexedDB?: IDBFactory;
  /** Default: `globalThis.IDBKeyRange`. */
  IDBKeyRange?: typeof IDBKeyRange;
}

const META = "meta";
const PENDING = "pending";
const QUERIES = "queries";
const tableStore = (table: string) => `t:${table}`;
const keyProp = (index: string) => `_k_${index}`;
const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

type StoredRow = { s: string; id: string; doc: Doc } & Record<string, unknown>;

export class IndexedDbBackend implements OfflineBackend {
  private db: IDBDatabase | null = null;
  private readonly factory: IDBFactory;
  private readonly Range: typeof IDBKeyRange;

  constructor(
    private readonly schema: LocalSchema,
    private readonly name = "ember",
    factory?: IDBFactory,
    Range?: typeof IDBKeyRange,
  ) {
    const g = globalThis as { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange };
    const f = factory ?? g.indexedDB;
    const r = Range ?? g.IDBKeyRange;
    if (!f || !r) throw new Error("indexedDbStorage: IndexedDB is not available here");
    this.factory = f;
    this.Range = r;
  }

  private get conn(): IDBDatabase {
    if (!this.db) throw new Error("IndexedDbBackend: not open");
    return this.db;
  }

  /** Opens; a different schema version recreates the table stores (the replica is a cache; pending survives). */
  private openDb(version?: number, reset = false): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const r = version === undefined ? this.factory.open(this.name) : this.factory.open(this.name, version);
      r.onupgradeneeded = (ev) => {
        const db = r.result;
        const tx = r.transaction!;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING, { autoIncrement: true }).createIndex("mid", "mid", { unique: true });
        if (!db.objectStoreNames.contains(QUERIES)) db.createObjectStore(QUERIES, { keyPath: "key" });
        if (ev.oldVersion === 0 || reset) {
          for (const n of Array.from(db.objectStoreNames)) if (n.startsWith("t:")) db.deleteObjectStore(n);
          tx.objectStore(QUERIES).clear();
          for (const [table, t] of Object.entries(this.schema.manifest.tables)) {
            const s = db.createObjectStore(tableStore(table), { keyPath: ["s", "id"] });
            for (const i of dbIndexesOf(t)) s.createIndex(i.name, ["s", keyProp(i.name)]);
          }
          tx.objectStore(META).put(this.schema.manifest.version, "schema");
        }
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error(`indexedDbStorage: database ${this.name} is open elsewhere with an older version`));
    });
  }

  async open() {
    let db = await this.openDb();
    const stored = await req(db.transaction(META).objectStore(META).get("schema"));
    if (stored !== this.schema.manifest.version) {
      const v = db.version + 1;
      db.close();
      db = await this.openDb(v, true);
    }
    this.db = db;
    const tx = db.transaction([META, QUERIES]);
    const metaStore = tx.objectStore(META);
    const [keys, values, queries] = await Promise.all([
      req(metaStore.getAllKeys()),
      req(metaStore.getAll()),
      req(tx.objectStore(QUERIES).getAll() as IDBRequest<QueryRecord[]>),
    ]);
    const meta: Record<string, string> = {};
    keys.forEach((k, i) => {
      if (typeof k === "string" && k !== "schema" && typeof values[i] === "string") meta[k] = values[i];
    });
    return { meta, queries };
  }

  async setMeta(key: string, value: string | null) {
    const tx = this.conn.transaction(META, "readwrite");
    if (value === null) tx.objectStore(META).delete(key);
    else tx.objectStore(META).put(value, key);
    await done(tx);
  }

  async loadPending(): Promise<PendingMutationRecord[]> {
    return (await req(this.conn.transaction(PENDING).objectStore(PENDING).getAll())) as PendingMutationRecord[];
  }

  // Follow-up requests are issued from the request callbacks (not after an await) so the transaction stays active.
  async putPending(r: PendingMutationRecord) {
    const tx = this.conn.transaction(PENDING, "readwrite");
    const s = tx.objectStore(PENDING);
    const g = s.index("mid").getKey(r.mid);
    g.onsuccess = () => void (g.result === undefined ? s.add(r) : s.put(r, g.result));
    await done(tx);
  }

  async removePending(mid: string) {
    const tx = this.conn.transaction(PENDING, "readwrite");
    const s = tx.objectStore(PENDING);
    const g = s.index("mid").getKey(mid);
    g.onsuccess = () => void (g.result !== undefined && s.delete(g.result));
    await done(tx);
  }

  private row(shard: string, table: string, doc: Doc): StoredRow {
    const t = this.schema.manifest.tables[table]!;
    const row: StoredRow = { s: shard, id: doc._id, doc };
    for (const i of dbIndexesOf(t)) row[keyProp(i.name)] = buf(docKey(doc, indexFields(t, i.name)!));
    return row;
  }

  async commit(shard: string, c: Commit) {
    const tables = new Set([...(c.upsert ?? []), ...(c.delete ?? [])].map((x) => tableStore(x.table)));
    const tx = this.conn.transaction([QUERIES, ...tables], "readwrite");
    const q = tx.objectStore(QUERIES);
    for (const r of c.put ?? []) q.put(r);
    for (const k of c.drop ?? []) q.delete(k);
    for (const { table, id } of c.delete ?? []) tx.objectStore(tableStore(table)).delete([shard, id]);
    for (const { table, doc } of c.upsert ?? []) tx.objectStore(tableStore(table)).put(this.row(shard, table, doc));
    await done(tx);
  }

  reader(shard: string): BackendReader {
    type Need = { k: string; run(tx: IDBTransaction): Promise<unknown>; store: string };
    const cache = new Map<string, unknown>();
    let needs: Need[] = [];
    const lookup = <T>(k: string, store: string, run: (tx: IDBTransaction) => Promise<T>): T => {
      if (cache.has(k)) return cache.get(k) as T;
      if (!needs.some((n) => n.k === k)) needs.push({ k, store, run });
      throw new NeedData();
    };
    const hex = (u: Uint8Array) => bytesToBase64(u, true);
    const scanAll = (table: string): Doc[] =>
      lookup(`all\u0000${table}`, tableStore(table), async (tx) => {
        const rows = (await req(tx.objectStore(tableStore(table)).getAll(this.Range.bound([shard], [shard, []])))) as StoredRow[];
        return rows.map((r) => r.doc);
      });
    const reader: BackendReader = {
      get misses() {
        return needs.length;
      },
      scan: (table, index, lo, hi, asc, limit) =>
        lookup(`s\u0000${table}\u0000${index}\u0000${hex(lo)}\u0000${hex(hi)}\u0000${asc}\u0000${limit}`, tableStore(table), (tx) => {
          const range = this.Range.bound([shard, buf(lo)], [shard, buf(hi)], false, true);
          const idx = tx.objectStore(tableStore(table)).index(index);
          const key = keyProp(index);
          const map = (rows: StoredRow[]) => rows.map((r) => ({ key: new Uint8Array(r[key] as ArrayBuffer), doc: r.doc }));
          if (asc) return req(idx.getAll(range, limit)).then((rows) => map(rows as StoredRow[]));
          return new Promise((resolve, reject) => {
            const out: StoredRow[] = [];
            const c = idx.openCursor(range, "prev");
            c.onerror = () => reject(c.error);
            c.onsuccess = () => {
              const cur = c.result;
              if (!cur || out.length >= limit) return resolve(map(out));
              out.push(cur.value as StoredRow);
              cur.continue();
            };
          });
        }),
      get: (table, id) =>
        lookup(`g\u0000${table}\u0000${id}`, tableStore(table), async (tx) => {
          const r = (await req(tx.objectStore(tableStore(table)).get([shard, id]))) as StoredRow | undefined;
          return r?.doc ?? null;
        }),
      pluginQuery: (table, kind, spec, arg) => {
        if (kind.kind !== "search") throw new Error(`index kind ${kind.kind} is not supported in IndexedDB`);
        return jsSearch(scanAll(table), spec, arg as (q: unknown) => unknown);
      },
      fetch: async () => {
        const batch = needs;
        needs = [];
        if (!batch.length) return;
        const tx = this.conn.transaction([...new Set(batch.map((n) => n.store))]);
        const results = await Promise.all(batch.map((n) => n.run(tx)));
        batch.forEach((n, i) => cache.set(n.k, results[i]));
      },
    };
    return reader;
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

/** Offline storage in IndexedDB (browsers). */
export function indexedDbStorage(options: IndexedDbStorageOptions): OfflineStore {
  return createOfflineStorage(new IndexedDbBackend(options.schema, options.name, options.indexedDB, options.IDBKeyRange), options);
}
