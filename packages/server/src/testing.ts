// node:sqlite-backed SqlDriver for tests (Node >= 22.5). Not imported by the main entry: values/server stay free
// of Node-only APIs.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlDriver, SqlRawResult, SqlResult, SqlRow, SqlValue } from "./driver.ts";

export type NodeSqliteDriver = SqlDriver & {
  db: DatabaseSync;
  close(): void;
  /** Number of statements executed (for tests). */
  statements: number;
};

/**
 * node:sqlite on Node 22 binds a view over a zero-length ArrayBuffer as NULL (Node 24: an empty BLOB, as DO SQLite):
 * such a parameter is bound as `new Uint8Array(0)`, which every version binds as an empty BLOB.
 */
const EMPTY_BLOB_AS_NULL = (db: DatabaseSync): boolean => (db.prepare("SELECT typeof(?) AS t").get(new Uint8Array(new ArrayBuffer(0))) as { t: string }).t !== "blob";
type Bind = null | number | string | Uint8Array;
const bindable = (params: SqlValue[]): Bind[] => {
  let out: Bind[] | undefined;
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p instanceof Uint8Array && p.byteLength === 0) (out ??= params.slice() as Bind[])[i] = new Uint8Array(0);
  }
  return out ?? (params as Bind[]);
};

export function createNodeSqliteDriver(path = ":memory:"): NodeSqliteDriver {
  const db = new DatabaseSync(path);
  const fixEmpty = EMPTY_BLOB_AS_NULL(db);
  // Node 22 reads TEXT back up to its first NUL (the value is stored whole): the engine is told (`truncatesTextAtNul`).
  const truncatesTextAtNul = (db.prepare("SELECT ? AS s").get("a\u0000b") as { s: string }).s !== "a\u0000b";
  const cache = new Map<string, StatementSync>();
  const rawCache = new Map<string, StatementSync>();
  let depth = 0;
  let sp = 0;
  const driver: NodeSqliteDriver = {
    db,
    statements: 0,
    truncatesTextAtNul,
    close: () => db.close(),
    exec(sql: string, ...params: SqlValue[]): SqlResult {
      driver.statements++;
      let stmt = cache.get(sql);
      if (!stmt) {
        stmt = db.prepare(sql);
        if (cache.size > 500) cache.clear();
        cache.set(sql, stmt);
      }
      const args = fixEmpty ? bindable(params) : (params as Bind[]);
      if (stmt.columns().length > 0) {
        const rows = stmt.all(...args) as SqlRow[];
        const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql);
        return { rows, rowsRead: isWrite ? 0 : rows.length, rowsWritten: isWrite ? rows.length : 0 };
      }
      const r = stmt.run(...args);
      return { rows: [], rowsRead: 0, rowsWritten: Number(r.changes) };
    },
    transaction<T>(fn: () => T): T {
      const name = `ember_sp_${sp++}`;
      db.exec(`SAVEPOINT ${name}`);
      depth++;
      try {
        const out = fn();
        if (out && typeof (out as { then?: unknown }).then === "function") {
          Promise.resolve(out).catch(() => {});
          throw new Error("transaction(fn): fn must be synchronous (it returned a Promise)");
        }
        db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
  // Rows as arrays (`setReturnArrays`, Node >= 22.16), or the objects' values in column order on older Nodes. Not
  // enumerable: a test wrapping the driver (`{ ...driver, exec }`) sees every statement through its own `exec`; one
  // that replaces `driver.exec` too (array rows are then built from what its `exec` returns).
  const ownExec = driver.exec;
  Object.defineProperty(driver, "execRaw", {
    enumerable: false,
    configurable: true,
    writable: true,
    value(sql: string, ...params: SqlValue[]): SqlRawResult {
      if (driver.exec !== ownExec) {
        const r = driver.exec(sql, ...params);
        return { rows: r.rows.map((o) => Object.values(o)), rowsRead: r.rowsRead, rowsWritten: r.rowsWritten };
      }
      let stmt = rawCache.get(sql);
      if (!stmt) {
        stmt = db.prepare(sql);
        if (typeof stmt.setReturnArrays === "function") stmt.setReturnArrays(true);
        if (rawCache.size > 500) rawCache.clear();
        rawCache.set(sql, stmt);
      }
      if (stmt.columns().length === 0) {
        const r = driver.exec(sql, ...params);
        return { rows: [], rowsRead: r.rowsRead, rowsWritten: r.rowsWritten };
      }
      driver.statements++;
      const args = fixEmpty ? bindable(params) : (params as Bind[]);
      const all = stmt.all(...args) as unknown[];
      const rows = all.map((r) => (Array.isArray(r) ? (r as SqlValue[]) : Object.values(r as SqlRow)));
      const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql);
      return { rows, rowsRead: isWrite ? 0 : rows.length, rowsWritten: isWrite ? rows.length : 0 };
    },
  });
  return driver;
}
