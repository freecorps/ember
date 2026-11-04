// The minimal synchronous SQL adapter the engine runs on (docs/design/contracts.md). The runtime implements it
// over Durable Object `ctx.storage.sql`; tests use node:sqlite (`@ember/server/testing`).

import type { SqlValue } from "@ember/values";

export type { SqlValue };
export type SqlRow = Record<string, SqlValue>;
export type SqlResult = { rows: SqlRow[]; rowsRead: number; rowsWritten: number };

export interface SqlDriver {
  /** Runs one statement. */
  exec(sql: string, ...params: SqlValue[]): SqlResult;
  /** Synchronous. Nested = savepoint. Throws if `fn` returns a Promise (and rolls back). */
  transaction<T>(fn: () => T): T;
}

/** Quotes an SQL identifier. */
export const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
/** Quotes an SQL string literal. */
export const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
