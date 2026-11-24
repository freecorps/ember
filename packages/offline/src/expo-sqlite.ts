// expo-sqlite (React Native / Expo) offline storage: the SQLite backend over expo-sqlite's synchronous API.
// `expo-sqlite` is an optional peer dependency, loaded lazily with a literal `require` (Metro treats it as
// optional); pass `openDatabaseSync` to inject it explicitly. FTS5 ships enabled in expo-sqlite (config plugin
// `enableFTS`, default true), so `withSearchIndex` runs locally with `unicode61 remove_diacritics 2`.
//
//   import { expoSqliteStorage } from "@freecorps/ember-offline/expo-sqlite";
//   createEmberClient({ url, storage: expoSqliteStorage({ schema, queries: { messages } }) })

import type { SqlDriver, SqlResult, SqlRow, SqlValue } from "@freecorps/ember-server";
import { SqliteBackend } from "./sqlite.ts";
import { createOfflineStorage, type OfflineOptions, type OfflineStore } from "./store.ts";

declare const require: (id: string) => any;

/** The part of expo-sqlite's `SQLiteStatement` this adapter uses (`prepareSync`). */
export interface ExpoSqliteStatement {
  executeSync(params: SqlValue[]): { getAllSync(): unknown[]; changes: number; resetSync?(): void };
  finalizeSync(): void;
}

/** The part of expo-sqlite's `SQLiteDatabase` this adapter uses (synchronous calls). */
export interface ExpoSqliteDatabase {
  getAllSync(source: string, params: SqlValue[]): unknown[];
  runSync(source: string, params: SqlValue[]): { changes: number };
  execSync(source: string): void;
  /** Prepared statements (expo-sqlite ≥ 14): cached per SQL text, so each one is compiled once per database. */
  prepareSync?(source: string): ExpoSqliteStatement;
  closeSync?(): void;
}

export type OpenDatabaseSync = (name: string) => ExpoSqliteDatabase;

const RETURNS_ROWS = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i;
const WRITES = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;
/** Prepared statements kept per database (all finalized past it). */
const MAX_STATEMENTS = 300;

/**
 * `SqlDriver` over an expo-sqlite database (savepoints for nested transactions, like the server's drivers). With
 * `prepareSync`, statements are prepared once per SQL text and reused (the replica writer and reader run the same
 * few statements over and over); `PRAGMA` and transaction control go through the plain calls.
 */
export function expoSqliteDriver(db: ExpoSqliteDatabase): SqlDriver & { close(): void } {
  let sp = 0;
  const cache = new Map<string, ExpoSqliteStatement>();
  const finalizeAll = () => {
    for (const s of cache.values()) {
      try {
        s.finalizeSync();
      } catch {
        /* closing anyway */
      }
    }
    cache.clear();
  };
  const prepared = (sql: string): ExpoSqliteStatement | null => {
    if (!db.prepareSync || /^\s*PRAGMA\b/i.test(sql)) return null;
    let s = cache.get(sql);
    if (!s) {
      if (cache.size >= MAX_STATEMENTS) finalizeAll();
      s = db.prepareSync(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    exec(sql: string, ...params: SqlValue[]): SqlResult {
      const returns = RETURNS_ROWS.test(sql);
      const write = WRITES.test(sql);
      const stmt = prepared(sql);
      if (stmt) {
        const r = stmt.executeSync(params);
        try {
          if (returns) {
            const rows = r.getAllSync() as SqlRow[];
            return { rows, rowsRead: write ? 0 : rows.length, rowsWritten: write ? rows.length : 0 };
          }
          return { rows: [], rowsRead: 0, rowsWritten: Number(r?.changes ?? 0) };
        } finally {
          r.resetSync?.();
        }
      }
      if (returns) {
        const rows = db.getAllSync(sql, params) as SqlRow[];
        return { rows, rowsRead: write ? 0 : rows.length, rowsWritten: write ? rows.length : 0 };
      }
      const r = db.runSync(sql, params);
      return { rows: [], rowsRead: 0, rowsWritten: Number(r?.changes ?? 0) };
    },
    transaction<T>(fn: () => T): T {
      const name = `ember_sp_${sp++}`;
      db.execSync(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        if (out && typeof (out as { then?: unknown }).then === "function") {
          Promise.resolve(out).catch(() => {});
          throw new Error("transaction(fn): fn must be synchronous");
        }
        db.execSync(`RELEASE ${name}`);
        return out;
      } catch (e) {
        db.execSync(`ROLLBACK TO ${name}`);
        db.execSync(`RELEASE ${name}`);
        throw e;
      }
    },
    close: () => {
      finalizeAll();
      db.closeSync?.();
    },
  };
}

export function loadExpoSqlite(): OpenDatabaseSync | null {
  try {
    const m = require("expo-sqlite");
    const open = m?.openDatabaseSync ?? m?.default?.openDatabaseSync;
    return typeof open === "function" ? open : null;
  } catch {
    return null;
  }
}

export interface ExpoSqliteStorageOptions extends OfflineOptions {
  /** Database name prefix (files `<name>.db`, `<name>-<hash>.db`). Default `"ember"`. */
  name?: string;
  /** expo-sqlite's `openDatabaseSync` (default: required lazily). */
  openDatabaseSync?: OpenDatabaseSync;
  /** Shard databases kept open at once (least recently used closed first). Default 8. */
  maxOpenShards?: number;
}

/**
 * Offline storage on expo-sqlite: the server's DDL, SQL compiler and FTS5 search, on the device.
 *
 * Journal: WAL everywhere (reads do not wait for the replica's writes). The shard databases (the replica, a cache the
 * server can always resend) also use `synchronous = NORMAL`: in WAL mode no fsync per commit, still safe against an
 * app crash; a power loss may lose the last commits, which the server sends again. The main database (the pending
 * mutation queue, the client id) keeps the default `FULL`: an offline edit is not lost to a power cut.
 */
export function expoSqliteStorage(options: ExpoSqliteStorageOptions): OfflineStore {
  const open = options.openDatabaseSync ?? loadExpoSqlite();
  if (!open) throw new Error("expoSqliteStorage: install expo-sqlite or pass openDatabaseSync");
  const main = options.name ?? "ember";
  const db = (name: string) => {
    const d = open(`${name}.db`);
    const pragma = (sql: string) => {
      try {
        d.execSync(sql);
      } catch {
        /* not supported: keep the default */
      }
    };
    // WAL keeps reads fast while the replica is written; foreign keys are unused.
    pragma("PRAGMA journal_mode = WAL");
    if (name !== main) pragma("PRAGMA synchronous = NORMAL");
    return expoSqliteDriver(d);
  };
  return createOfflineStorage(new SqliteBackend(options.schema, db, main, options), options);
}
