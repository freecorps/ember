// The only SQL surface the engine uses: what Durable Object `ctx.storage.sql` offers (exec + rows, and a
// synchronous transaction). bun:sqlite stands in for it here.

import { Database } from "bun:sqlite";

export interface Sql {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  run(sql: string, ...params: unknown[]): void;
  /** Lazy row cursor (DO: the `sql.exec` cursor), so a scan can stop early. */
  iterate<T = Record<string, unknown>>(sql: string, ...params: unknown[]): IterableIterator<T>;
  /** Synchronous transaction (DO: `ctx.storage.transactionSync`). Nested calls use savepoints. */
  transaction<R>(fn: () => R): R;
}

export function openSqlite(path = ":memory:"): Sql & { raw: Database } {
  // safeIntegers: int64 columns come back as bigint, so v.int64() round-trips exactly.
  const db = new Database(path, { safeIntegers: true });
  let depth = 0;
  return {
    raw: db,
    all: (sql, ...params) => db.query(sql).all(...(params as any[])) as any[],
    run: (sql, ...params) => void db.query(sql).run(...(params as any[])),
    // Uncached statement per scan: a cached one abandoned mid-iteration (take(n) breaks early) would be reused
    // while still stepping. A real engine would pool these.
    *iterate(sql, ...params) {
      const stmt = db.prepare(sql);
      try {
        yield* stmt.iterate(...(params as any[])) as any;
      } finally {
        stmt.finalize();
      }
    },
    transaction(fn) {
      const name = `sp${depth++}`;
      db.run(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        db.run(`RELEASE ${name}`);
        return out;
      } catch (e) {
        db.run(`ROLLBACK TO ${name}`);
        db.run(`RELEASE ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

export const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
