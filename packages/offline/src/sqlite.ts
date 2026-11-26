// SQLite backend over the server's `SqlDriver` (synchronous): expo-sqlite in apps (expo-sqlite.ts), node:sqlite in
// tests. Each shard's replica is its own database with the server's DDL (typed columns, encoded key columns,
// FTS5 `unicode61 remove_diacritics 2`), written with the server's row codec and read with the server's SQL —
// `withSearchIndex` runs on FTS5 locally. A main database holds metadata, the pending queue and the shard list.
//
//   <name>              _ember_local_meta, _ember_local_pending, _ember_local_shards
//   <name>-<sha(shard)> schema tables + _ember_local_queries + _ember_local_log (records, their row-diff log and
//                       their rows commit atomically)
//
// Shard databases open on demand and at most `maxOpenShards` stay open (least recently used closed first): each
// connection has its own page cache and statements, so an app with many shards does not keep them all. Only drivers
// that can be closed are evicted (a driver without `close` is kept). Readers and commits go through `shard()` on
// every call and run synchronously, so no database is closed while one of them uses it. The first
// open of a shard in a session migrates it (`prepareLocalDatabase`); a reopen after eviction does not.
//
// Cold start: `open()` reads only the main database (metadata, the pending queue, the shard list: what the client's
// `hello` waits for); a shard's records are read when the store first needs that shard (`openShard`). A shard left
// with nothing (no records, rows, log or pending mutation) after a commit that removed some has its database deleted
// (`remove`, when the factory can delete; the file of `opfs-sahpool` goes back to the pool). New databases use
// `auto_vacuum = INCREMENTAL`, with an `incremental_vacuum` every `VACUUM_EVERY` commits that freed pages. A database
// created before keeps the mode it has (SQLite changes it only with a `VACUUM`): see contracts.md "Offline".

import { decodeJson, encodeJson, type PendingMutationRecord } from "@freecorps/ember-client";
import {
  jsSearch,
  prepareLocalDatabase,
  sha256Hex,
  sqlLocalReader,
  sqlReplicaWriter,
  type LocalSchema,
  type SqlDriver,
} from "@freecorps/ember-server";
import type { BackendReader, Commit, OfflineBackend, PendingOp, QueryLogEntry, QueryRecord } from "./backend.ts";
import { createOfflineStorage, type OfflineOptions, type OfflineStore } from "./store.ts";

export type OpenSqlite = (name: string) => SqlDriver & { close?(): void };
/** Deletes a database by name (closed first by the backend). Synchronous: the name may be opened again right after. */
export type RemoveSqlite = (name: string) => void;

export interface SqliteStorageOptions extends OfflineOptions {
  /** Database name prefix. Default `"ember"`. */
  name?: string;
  /** Opens (creating if needed) a database by name. */
  open: OpenSqlite;
  /** Shard databases kept open at once (least recently used closed first). Default 8. */
  maxOpenShards?: number;
  /** Deletes a database by name: a shard left empty has its database removed. Without it, empty databases stay. */
  remove?: RemoveSqlite;
}

/** Commits that freed pages before an `incremental_vacuum` (of at most `VACUUM_PAGES` pages). */
export const VACUUM_EVERY = 32;
const VACUUM_PAGES = 256;

const MAIN_DDL = [
  `CREATE TABLE IF NOT EXISTS "_ember_local_meta" ("k" TEXT PRIMARY KEY, "v" TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS "_ember_local_pending" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, "mid" TEXT NOT NULL UNIQUE, "record" TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS "_ember_local_shards" ("shard" TEXT PRIMARY KEY, "db" TEXT NOT NULL) STRICT`,
];
const QUERIES_DDL = [
  `CREATE TABLE IF NOT EXISTS "_ember_local_queries" ("key" TEXT PRIMARY KEY, "record" TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS "_ember_local_log" ("key" TEXT NOT NULL, "seq" INTEGER NOT NULL, "entry" TEXT NOT NULL, PRIMARY KEY ("key", "seq")) STRICT`,
];

type ShardDb = { driver: SqlDriver & { close?(): void }; writer: ReturnType<typeof sqlReplicaWriter>; reader: BackendReader };

export class SqliteBackend implements OfflineBackend {
  private main: (SqlDriver & { close?(): void }) | null = null;
  /** Open shard databases, least recently used first. */
  private readonly shards = new Map<string, ShardDb>();
  private readonly known = new Map<string, string>();
  /** Shards migrated in this session (a reopen after eviction skips it). */
  private readonly prepared = new Set<string>();
  private readonly maxOpen: number;
  private readonly removeDb: RemoveSqlite | undefined;
  /** Database name → commits that freed pages since its last `incremental_vacuum`. */
  private readonly freed = new Map<string, number>();

  constructor(
    private readonly schema: LocalSchema,
    private readonly openDb: OpenSqlite,
    private readonly name = "ember",
    options: { maxOpenShards?: number; remove?: RemoveSqlite } = {},
  ) {
    this.maxOpen = Math.max(1, options.maxOpenShards ?? 8);
    this.removeDb = options.remove;
  }

  private get db() {
    if (!this.main) throw new Error("SqliteBackend: not open");
    return this.main;
  }

  /** The main database only: the shards' records are read on first use (`openShard`). */
  async open() {
    const main = (this.main = this.openDb(this.name));
    incrementalVacuum(main);
    for (const s of MAIN_DDL) main.exec(s);
    const meta: Record<string, string> = {};
    for (const r of main.exec(`SELECT "k", "v" FROM "_ember_local_meta"`).rows) meta[String(r.k)] = String(r.v);
    for (const r of main.exec(`SELECT "shard", "db" FROM "_ember_local_shards"`).rows) this.known.set(String(r.shard), String(r.db));
    return { meta, queries: [], log: [], lazy: [...this.known.keys()] };
  }

  /** A shard's records and log, opening (and migrating) its database. */
  openShard(shard: string): { queries: QueryRecord[]; log: QueryLogEntry[] } {
    const queries: QueryRecord[] = [];
    const log: QueryLogEntry[] = [];
    if (!this.known.has(shard)) return { queries, log };
    const s = this.shard(shard);
    for (const q of s.driver.exec(`SELECT "record" FROM "_ember_local_queries"`).rows) queries.push(decodeJson(String(q.record)) as QueryRecord);
    for (const e of s.driver.exec(`SELECT "entry" FROM "_ember_local_log" ORDER BY "key", "seq"`).rows) log.push(decodeJson(String(e.entry)) as QueryLogEntry);
    return { queries, log };
  }

  /** A shard's database, opened (and migrated, once per session) on demand, registered in the main database. */
  private shard(shard: string): ShardDb {
    let s = this.shards.get(shard);
    if (s) {
      // Most recently used goes last.
      this.shards.delete(shard);
      this.shards.set(shard, s);
      return s;
    }
    let dbName = this.known.get(shard);
    if (!dbName) {
      dbName = `${this.name}-${sha256Hex(shard).slice(0, 24)}`;
      this.db.exec(`INSERT OR IGNORE INTO "_ember_local_shards" ("shard", "db") VALUES (?, ?)`, shard, dbName);
      this.known.set(shard, dbName);
    }
    // Room first: the new connection never makes one more than `maxOpenShards` open, even for a moment.
    this.evict(this.maxOpen - 1);
    const driver = this.openDb(dbName);
    try {
      if (!this.prepared.has(shard)) {
        incrementalVacuum(driver);
        prepareLocalDatabase(driver, this.schema);
        for (const ddl of QUERIES_DDL) driver.exec(ddl);
        this.prepared.add(shard);
      }
      s = { driver, writer: sqlReplicaWriter(driver, this.schema), reader: sqlLocalReader(driver, this.schema) };
    } catch (e) {
      driver.close?.();
      throw e;
    }
    this.shards.set(shard, s);
    return s;
  }

  /**
   * Closes the least recently used shard databases until at most `limit` stay open. A driver without `close` (the
   * factory may hand out one shared connection) is kept and reused, never dropped unclosed — reopening it would leak
   * a connection on every switch; one whose `close` throws stays open (and in use) too.
   */
  private evict(limit: number): void {
    let over = this.shards.size - limit;
    for (const [k, open] of [...this.shards]) {
      if (over <= 0) break;
      if (!open.driver.close) continue;
      try {
        open.driver.close();
      } catch {
        continue;
      }
      this.shards.delete(k);
      over--;
    }
  }

  setMeta(key: string, value: string | null) {
    if (value === null) this.db.exec(`DELETE FROM "_ember_local_meta" WHERE "k" = ?`, key);
    else this.db.exec(`INSERT INTO "_ember_local_meta" ("k", "v") VALUES (?, ?) ON CONFLICT ("k") DO UPDATE SET "v" = excluded."v"`, key, value);
  }

  loadPending(): PendingMutationRecord[] {
    return this.db.exec(`SELECT "record" FROM "_ember_local_pending" ORDER BY "seq"`).rows.map((r) => decodeJson(String(r.record)) as PendingMutationRecord);
  }
  putPending(r: PendingMutationRecord) {
    this.db.exec(
      `INSERT INTO "_ember_local_pending" ("mid", "record") VALUES (?, ?) ON CONFLICT ("mid") DO UPDATE SET "record" = excluded."record"`,
      r.mid,
      encodeJson(r),
    );
  }
  removePending(mid: string) {
    this.db.exec(`DELETE FROM "_ember_local_pending" WHERE "mid" = ?`, mid);
    this.vacuumSoon(this.name, this.db);
  }
  batchPending(ops: ReadonlyArray<PendingOp>) {
    this.db.transaction(() => {
      for (const op of ops) {
        if (op.record) this.putPending(op.record);
        else this.db.exec(`DELETE FROM "_ember_local_pending" WHERE "mid" = ?`, op.mid);
      }
    });
    if (ops.some((o) => !o.record)) this.vacuumSoon(this.name, this.db);
  }

  /** One more commit that freed pages in `name`: every `VACUUM_EVERY` of them, a bounded `incremental_vacuum`. */
  private vacuumSoon(name: string, driver: SqlDriver): void {
    const n = (this.freed.get(name) ?? 0) + 1;
    if (n < VACUUM_EVERY) {
      this.freed.set(name, n);
      return;
    }
    this.freed.set(name, 0);
    try {
      // A no-op where auto_vacuum is not incremental (a database created before it).
      driver.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
    } catch {
      /* not supported here: the file keeps its free pages */
    }
  }

  /**
   * After a commit that removed something: a shard left with nothing (no records, log, rows, nor a pending mutation
   * for it) has its database closed, unregistered and deleted (with `remove`; a driver that cannot be closed stays).
   * Returns whether it went.
   */
  private removeIfEmpty(shard: string, s: ShardDb): boolean {
    const d = s.driver;
    const close = d.close?.bind(d);
    if (!this.removeDb || !close) return false;
    const hasRow = (sql: string) => d.exec(sql).rows.length > 0;
    if (hasRow(`SELECT 1 FROM "_ember_local_queries" LIMIT 1`) || hasRow(`SELECT 1 FROM "_ember_local_log" LIMIT 1`)) return false;
    for (const t of Object.keys(this.schema.manifest.tables)) if (hasRow(`SELECT 1 FROM "${t.replace(/"/g, '""')}" LIMIT 1`)) return false;
    for (const r of this.db.exec(`SELECT "record" FROM "_ember_local_pending"`).rows) {
      try {
        if ((decodeJson(String(r.record)) as { shard?: unknown }).shard === shard) return false;
      } catch {
        return false;
      }
    }
    const dbName = this.known.get(shard);
    if (!dbName) return false;
    try {
      close();
    } catch {
      return false;
    }
    this.shards.delete(shard);
    this.prepared.delete(shard);
    this.known.delete(shard);
    this.freed.delete(dbName);
    this.db.exec(`DELETE FROM "_ember_local_shards" WHERE "shard" = ?`, shard);
    try {
      this.removeDb(dbName);
    } catch {
      // Left on disk: empty, and opened again under the same name if the shard comes back.
    }
    return true;
  }

  commit(shard: string, c: Commit) {
    const s = this.shard(shard);
    s.driver.transaction(() => {
      for (const r of c.put ?? []) {
        s.driver.exec(
          `INSERT INTO "_ember_local_queries" ("key", "record") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "record" = excluded."record"`,
          r.key,
          encodeJson(r),
        );
        s.driver.exec(`DELETE FROM "_ember_local_log" WHERE "key" = ?`, r.key);
      }
      for (const k of c.drop ?? []) {
        s.driver.exec(`DELETE FROM "_ember_local_queries" WHERE "key" = ?`, k);
        s.driver.exec(`DELETE FROM "_ember_local_log" WHERE "key" = ?`, k);
      }
      for (const e of c.append ?? []) {
        s.driver.exec(`INSERT OR REPLACE INTO "_ember_local_log" ("key", "seq", "entry") VALUES (?, ?, ?)`, e.key, e.seq, encodeJson(e));
      }
      for (const { table, id } of c.delete ?? []) s.writer.delete(table, id);
      for (const { table, doc } of c.upsert ?? []) s.writer.upsert(table, doc);
    });
    if (c.drop?.length || c.delete?.length) {
      if (!c.put?.length && !c.upsert?.length && this.removeIfEmpty(shard, s)) return;
      this.vacuumSoon(this.known.get(shard) ?? shard, s.driver);
    }
  }

  reader(shard: string): BackendReader {
    // A shard never written has no replica: read as empty without creating a database for it.
    if (!this.known.has(shard)) {
      return { scan: () => [], get: () => null, pluginQuery: (_t, _k, spec, arg) => jsSearch([], spec, arg as (q: unknown) => unknown) };
    }
    // Through `shard()` on every call: a database closed by the LRU meanwhile is opened again.
    return {
      scan: (...a) => this.shard(shard).reader.scan(...a),
      get: (...a) => this.shard(shard).reader.get(...a),
      pluginQuery: (...a) => this.shard(shard).reader.pluginQuery!(...a),
    };
  }

  close() {
    for (const s of this.shards.values()) s.driver.close?.();
    this.shards.clear();
    this.prepared.clear();
    this.main?.close?.();
    this.main = null;
  }
}

/**
 * `auto_vacuum = INCREMENTAL` for a database without tables yet (a new one): freed pages can then be returned to the
 * file system a few at a time (`incremental_vacuum`). On an existing database it changes nothing (only `VACUUM` does).
 */
function incrementalVacuum(driver: SqlDriver): void {
  try {
    driver.exec(`PRAGMA auto_vacuum = INCREMENTAL`);
  } catch {
    /* not supported by this driver: the default */
  }
}

/** Offline storage on SQLite through any synchronous driver factory (`SqlDriver`). */
export function sqliteStorage(options: SqliteStorageOptions): OfflineStore {
  return createOfflineStorage(new SqliteBackend(options.schema, options.open, options.name, options), options);
}
