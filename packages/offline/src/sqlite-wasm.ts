// SQLite compiled to WebAssembly (`@sqlite.org/sqlite-wasm`, the SQLite project's official build: FTS5 included)
// as a `SqlDriver`, so the SQLite backend runs on it unchanged: the server's DDL, row codec, SQL compiler and FTS5
// search. Any oo1 database works — in-memory, `kvvfs`, or OPFS through the `opfs-sahpool` VFS (see opfs.ts, which
// runs it in a dedicated Worker). In Node the same build runs over an in-memory file system (tests).
//
//   import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
//   const sqlite3 = await sqlite3InitModule();
//   sqliteWasmStorage({ schema, queries, open: (name) => new sqlite3.oo1.DB(`/${name}.db`, "c") })

import type { SqlDriver, SqlResult, SqlRow, SqlValue } from "@freecorps/ember-server";
import { SqliteBackend } from "./sqlite.ts";
import { createOfflineStorage, type OfflineOptions, type OfflineStore } from "./store.ts";

/** The part of an oo1 prepared statement this driver uses. */
export interface WasmSqliteStatement {
  readonly columnCount: number;
  bind(values: SqlValue[]): unknown;
  step(): boolean;
  get(target: Record<string, unknown>): Record<string, unknown>;
  reset(clearBindings?: boolean): unknown;
  finalize(): unknown;
}

/** The part of an oo1 `DB` (`sqlite3.oo1.DB`, `OpfsSAHPoolDb`, ...) this driver uses. */
export interface WasmSqliteDatabase {
  prepare(sql: string): WasmSqliteStatement;
  exec(sql: string): unknown;
  changes(): number;
  close(): unknown;
}

const WRITES = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;

/** `SqlDriver` over an oo1 database: cached prepared statements, savepoints for nested transactions. */
export function wasmSqliteDriver(db: WasmSqliteDatabase): SqlDriver & { close(): void } {
  const cache = new Map<string, WasmSqliteStatement>();
  let sp = 0;
  const finalizeAll = () => {
    for (const s of cache.values()) s.finalize();
    cache.clear();
  };
  return {
    exec(sql: string, ...params: SqlValue[]): SqlResult {
      let stmt = cache.get(sql);
      if (!stmt) {
        if (cache.size > 500) finalizeAll();
        stmt = db.prepare(sql);
        cache.set(sql, stmt);
      }
      try {
        if (params.length) stmt.bind(params);
        const rows: SqlRow[] = [];
        if (stmt.columnCount > 0) while (stmt.step()) rows.push(stmt.get({}) as SqlRow);
        else stmt.step();
        const write = WRITES.test(sql);
        return {
          rows,
          rowsRead: write ? 0 : rows.length,
          rowsWritten: write ? (rows.length || db.changes()) : 0,
        };
      } finally {
        stmt.reset(true);
      }
    },
    transaction<T>(fn: () => T): T {
      const name = `ember_sp_${sp++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        if (out && typeof (out as { then?: unknown }).then === "function") {
          Promise.resolve(out).catch(() => {});
          throw new Error("transaction(fn): fn must be synchronous");
        }
        db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      }
    },
    close: () => {
      finalizeAll();
      db.close();
    },
  };
}

export interface SqliteWasmStorageOptions extends OfflineOptions {
  /** Database name prefix. Default `"ember"`. */
  name?: string;
  /** Opens (creating if needed) a database by name, e.g. `(n) => new poolUtil.OpfsSAHPoolDb(`/${n}.db`)`. */
  open: (name: string) => WasmSqliteDatabase;
}

/** Offline storage on SQLite-Wasm (same DDL, SQL and FTS5 as `sqliteStorage`). Runs where the database lives. */
export function sqliteWasmStorage(options: SqliteWasmStorageOptions): OfflineStore {
  return createOfflineStorage(new SqliteBackend(options.schema, (n) => wasmSqliteDriver(options.open(n)), options.name ?? "ember"), options);
}
