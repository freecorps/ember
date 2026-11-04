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

/** The part of expo-sqlite's `SQLiteDatabase` this adapter uses (synchronous calls). */
export interface ExpoSqliteDatabase {
  getAllSync(source: string, params: SqlValue[]): unknown[];
  runSync(source: string, params: SqlValue[]): { changes: number };
  execSync(source: string): void;
  closeSync?(): void;
}

export type OpenDatabaseSync = (name: string) => ExpoSqliteDatabase;

const RETURNS_ROWS = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i;

/** `SqlDriver` over an expo-sqlite database (savepoints for nested transactions, like the server's drivers). */
export function expoSqliteDriver(db: ExpoSqliteDatabase): SqlDriver & { close(): void } {
  let sp = 0;
  return {
    exec(sql: string, ...params: SqlValue[]): SqlResult {
      if (RETURNS_ROWS.test(sql)) {
        const rows = db.getAllSync(sql, params) as SqlRow[];
        const write = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql);
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
    close: () => db.closeSync?.(),
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
}

/** Offline storage on expo-sqlite: the server's DDL, SQL compiler and FTS5 search, on the device. */
export function expoSqliteStorage(options: ExpoSqliteStorageOptions): OfflineStore {
  const open = options.openDatabaseSync ?? loadExpoSqlite();
  if (!open) throw new Error("expoSqliteStorage: install expo-sqlite or pass openDatabaseSync");
  const db = (name: string) => {
    const d = open(`${name}.db`);
    // WAL keeps reads fast while the replica is written; foreign keys are unused.
    try {
      d.execSync("PRAGMA journal_mode = WAL");
    } catch {
      /* not supported: keep the default */
    }
    return expoSqliteDriver(d);
  };
  return createOfflineStorage(new SqliteBackend(options.schema, db, options.name ?? "ember"), options);
}
