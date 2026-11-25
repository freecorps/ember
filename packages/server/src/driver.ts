// The minimal synchronous SQL adapter the engine runs on (docs/design/contracts.md). The runtime implements it
// over Durable Object `ctx.storage.sql`; tests use node:sqlite (`@freecorps/ember-server/testing`).

import type { SqlValue } from "@freecorps/ember-values";

export type { SqlValue };
export type SqlRow = Record<string, SqlValue>;
export type SqlResult = { rows: SqlRow[]; rowsRead: number; rowsWritten: number };

export interface SqlDriver {
  /** Runs one statement. */
  exec(sql: string, ...params: SqlValue[]): SqlResult;
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
