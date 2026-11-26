// The minimal synchronous SQL adapter the engine runs on (docs/design/contracts.md). The runtime implements it
// over Durable Object `ctx.storage.sql`; tests use node:sqlite (`@freecorps/ember-server/testing`).

import type { SqlValue } from "@freecorps/ember-values";

export type { SqlValue };
export type SqlRow = Record<string, SqlValue>;
export type SqlResult = { rows: SqlRow[]; rowsRead: number; rowsWritten: number };
/** `SqlDriver.execRaw`: each row as an array of its values, in the statement's column order. */
export type SqlRawResult = { rows: SqlValue[][]; rowsRead: number; rowsWritten: number };

export interface SqlDriver {
  /** Runs one statement. */
  exec(sql: string, ...params: SqlValue[]): SqlResult;
  /**
   * Optional: `exec` with each row as an array (column order), no object per row. The engine reads its hot paths (a
   * query's scans and `db.get`) through it when the driver has it, and through `exec` otherwise: the same statements,
   * values, rows read and written (BLOBs as Uint8Array, as `exec`).
   */
  execRaw?(sql: string, ...params: SqlValue[]): SqlRawResult;
  /** Synchronous. Nested = savepoint. Throws if `fn` returns a Promise (and rolls back). */
  transaction<T>(fn: () => T): T;
  /**
   * True when a TEXT value is read back cut at its first NUL though stored whole (node:sqlite on Node 22). The engine
   * then decides whether a write changes an index key from the stored key, not from the document read. DO SQLite: no.
   */
  readonly truncatesTextAtNul?: boolean;
}

/** Quotes an SQL identifier. */
export const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
/** Quotes an SQL string literal. */
export const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
