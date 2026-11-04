// node:sqlite-backed SqlDriver for tests (Node >= 22.5). Not imported by the main entry: values/server stay free
// of Node-only APIs.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlDriver, SqlResult, SqlRow, SqlValue } from "./driver.ts";

export type NodeSqliteDriver = SqlDriver & {
  db: DatabaseSync;
  close(): void;
  /** Number of statements executed (for tests). */
  statements: number;
};

export function createNodeSqliteDriver(path = ":memory:"): NodeSqliteDriver {
  const db = new DatabaseSync(path);
  const cache = new Map<string, StatementSync>();
  let depth = 0;
  let sp = 0;
  const driver: NodeSqliteDriver = {
    db,
    statements: 0,
    close: () => db.close(),
    exec(sql: string, ...params: SqlValue[]): SqlResult {
      driver.statements++;
      let stmt = cache.get(sql);
      if (!stmt) {
        stmt = db.prepare(sql);
        if (cache.size > 500) cache.clear();
        cache.set(sql, stmt);
      }
      if (stmt.columns().length > 0) {
        const rows = stmt.all(...(params as Array<null | number | string | Uint8Array>)) as SqlRow[];
        const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql);
        return { rows, rowsRead: isWrite ? 0 : rows.length, rowsWritten: isWrite ? rows.length : 0 };
      }
      const r = stmt.run(...(params as Array<null | number | string | Uint8Array>));
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
  return driver;
}
