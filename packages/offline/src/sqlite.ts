// SQLite backend over the server's `SqlDriver` (synchronous): expo-sqlite in apps (expo-sqlite.ts), node:sqlite in
// tests. Each shard's replica is its own database with the server's DDL (typed columns, encoded key columns,
// FTS5 `unicode61 remove_diacritics 2`), written with the server's row codec and read with the server's SQL —
// `withSearchIndex` runs on FTS5 locally. A main database holds metadata, the pending queue and the shard list.
//
//   <name>              _ember_local_meta, _ember_local_pending, _ember_local_shards
//   <name>-<sha(shard)> schema tables + _ember_local_queries + _ember_local_log (records, their row-diff log and
//                       their rows commit atomically)

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
import type { BackendReader, Commit, OfflineBackend, QueryLogEntry, QueryRecord } from "./backend.ts";
import { createOfflineStorage, type OfflineOptions, type OfflineStore } from "./store.ts";

export type OpenSqlite = (name: string) => SqlDriver & { close?(): void };

export interface SqliteStorageOptions extends OfflineOptions {
  /** Database name prefix. Default `"ember"`. */
  name?: string;
  /** Opens (creating if needed) a database by name. */
  open: OpenSqlite;
}

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
  private readonly shards = new Map<string, ShardDb>();
  private readonly known = new Map<string, string>();

  constructor(
    private readonly schema: LocalSchema,
    private readonly openDb: OpenSqlite,
    private readonly name = "ember",
  ) {}

  private get db() {
    if (!this.main) throw new Error("SqliteBackend: not open");
    return this.main;
  }

  async open() {
    const main = (this.main = this.openDb(this.name));
    for (const s of MAIN_DDL) main.exec(s);
    const meta: Record<string, string> = {};
    for (const r of main.exec(`SELECT "k", "v" FROM "_ember_local_meta"`).rows) meta[String(r.k)] = String(r.v);
    const queries: QueryRecord[] = [];
    const log: QueryLogEntry[] = [];
    for (const r of main.exec(`SELECT "shard", "db" FROM "_ember_local_shards"`).rows) {
      this.known.set(String(r.shard), String(r.db));
      const s = this.shard(String(r.shard));
      for (const q of s.driver.exec(`SELECT "record" FROM "_ember_local_queries"`).rows) queries.push(decodeJson(String(q.record)) as QueryRecord);
      for (const e of s.driver.exec(`SELECT "entry" FROM "_ember_local_log" ORDER BY "key", "seq"`).rows) log.push(decodeJson(String(e.entry)) as QueryLogEntry);
    }
    return { meta, queries, log };
  }

  /** Opens (and migrates) a shard's database, registering it in the main database. */
  private shard(shard: string): ShardDb {
    let s = this.shards.get(shard);
    if (s) return s;
    let dbName = this.known.get(shard);
    if (!dbName) {
      dbName = `${this.name}-${sha256Hex(shard).slice(0, 24)}`;
      this.db.exec(`INSERT OR IGNORE INTO "_ember_local_shards" ("shard", "db") VALUES (?, ?)`, shard, dbName);
      this.known.set(shard, dbName);
    }
    const driver = this.openDb(dbName);
    prepareLocalDatabase(driver, this.schema);
    for (const ddl of QUERIES_DDL) driver.exec(ddl);
    s = { driver, writer: sqlReplicaWriter(driver, this.schema), reader: sqlLocalReader(driver, this.schema) };
    this.shards.set(shard, s);
    return s;
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
  }

  reader(shard: string): BackendReader {
    // A shard never written has no replica: read as empty without creating a database for it.
    if (!this.known.has(shard)) {
      return { scan: () => [], get: () => null, pluginQuery: (_t, _k, spec, arg) => jsSearch([], spec, arg as (q: unknown) => unknown) };
    }
    return this.shard(shard).reader;
  }

  close() {
    for (const s of this.shards.values()) s.driver.close?.();
    this.shards.clear();
    this.main?.close?.();
    this.main = null;
  }
}

/** Offline storage on SQLite through any synchronous driver factory (`SqlDriver`). */
export function sqliteStorage(options: SqliteStorageOptions): OfflineStore {
  return createOfflineStorage(new SqliteBackend(options.schema, options.open, options.name), options);
}
