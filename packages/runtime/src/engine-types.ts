/**
 * Placeholder for the `@ember/server` engine contract (docs/design/contracts.md).
 *
 * The runtime codes only against these types. When `@ember/server` ships
 * `createEngine`, these declarations are replaced by type re-exports from it.
 * Anything here that contracts.md leaves unspecified (AuthCtx, Job, batch
 * item/result shapes, MigrationReport) is the runtime's proposal and is listed
 * as a requested contract precision.
 */

export type SqlValue = null | number | string | Uint8Array;

export interface SqlExecResult {
  rows: Record<string, SqlValue>[];
  rowsRead: number;
  rowsWritten: number;
}

export interface SqlDriver {
  exec(sql: string, ...params: SqlValue[]): SqlExecResult;
  /** Synchronous. Nested = savepoint. Throws if fn returns a Promise. */
  transaction<T>(fn: () => T): T;
}

/** Verified caller identity. Kept small: it lives in a 16 KB socket attachment. */
export interface Identity {
  subject: string;
  issuer?: string;
  /** Expiry, seconds since epoch (JWT `exp`). */
  exp?: number;
  claims?: Record<string, unknown>;
}

export interface AuthCtx {
  identity: Identity | null;
}

export type Doc = Record<string, unknown>;

export type ReadSet = Array<{
  table: string;
  index: string;
  lo: Uint8Array;
  /** exclusive */
  hi: Uint8Array;
  kind: string;
}>;

export interface RowChange {
  table: string;
  id: string;
  before: Doc | null;
  after: Doc | null;
}

/** A job scheduled by a mutation (`ctx.scheduler.runAfter/runAt`). */
export interface Job {
  fn: string;
  args: unknown;
  /** ms since epoch */
  runAt: number;
  kind: "mutation" | "action";
}

export interface MutationBatchItem {
  name: string;
  args: unknown;
  ctx: AuthCtx;
}

export interface EngineError {
  code: string;
  message: string;
}

export type MutationResult =
  | { ok: true; value: unknown; changes: RowChange[]; scheduled: Job[] }
  | { ok: false; error: EngineError };

export interface MigrationReport {
  /** true when DDL was applied (first boot or schema change). */
  changed: boolean;
  [k: string]: unknown;
}

export interface QueryResult {
  value: unknown;
  readSet: ReadSet;
}

export interface Engine {
  migrate(): MigrationReport;
  runQuery(name: string, args: unknown, ctx: AuthCtx): QueryResult;
  runMutation(name: string, args: unknown, ctx: AuthCtx): { value: unknown; changes: RowChange[]; scheduled: Job[] };
  /** Group commit: one transaction, one savepoint per item. Never throws for a single item failure. */
  runMutationBatch(items: MutationBatchItem[]): MutationResult[];
  matches(readSet: ReadSet, changes: RowChange[]): boolean;
}

/** What the runtime needs from `defineSchema(...)`. */
export interface SchemaLike {
  manifest: { version: string; shards?: Record<string, unknown> | string[] };
}

export interface CreateEngineOptions {
  schema: SchemaLike;
  functions: unknown;
  driver: SqlDriver;
  now?: () => number;
  random?: () => number;
}

export type CreateEngine = (opts: CreateEngineOptions) => Engine;
