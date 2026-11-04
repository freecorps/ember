// Runtime types shared by the engine, DDL, index-kind plugins and reactivity.

import type { ColumnSpec, JSONValue } from "@ember/values";

export type Doc = Record<string, unknown> & { _id: string; _creationTime: number };

/** One row a committed mutation touched (null = absent before / after). */
export type RowChange = { table: string; id: string; before: Doc | null; after: Doc | null };

/** `.filter()` expression tree: plain data, so it can live in a read set and be evaluated against changed rows. */
export type FilterExpr =
  | { field: string }
  | { literal: unknown }
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "and" | "or" | "not"; args: FilterExpr[] };

/**
 * What one read covered (contracts.md). For `kind: "db"` the half-open key range `[lo, hi)` over the index's
 * encoded key column, narrowed to what was actually scanned; `filter` (optional) lets matching skip rows that
 * fail it both before and after. Other kinds (search, user plugins) match through their plugin's
 * `matchesChange`, using `data`.
 */
export type ReadSetEntry = {
  table: string;
  index: string;
  lo: Uint8Array;
  hi: Uint8Array;
  kind: string;
  filter?: FilterExpr;
  data?: unknown;
};
export type ReadSet = ReadSetEntry[];

/** An index as stored in the manifest. `fields` are the indexed paths (without the implicit tiebreakers). */
export type IndexSpec = { kind: string; name: string; fields: string[]; config?: JSONValue };

/** A schema object owned by a table (index, virtual table, trigger); diffed against sqlite_master by SQL text. */
export type OwnedObject = { type: "index" | "table" | "trigger"; name: string; sql: string };

export type Column = { field: string; spec: ColumnSpec };

/** How a table is laid out in SQLite; given to plugins so they can address fields. */
export interface TableLayout {
  table: string;
  /** Typed scalar columns (one per top-level scalar field). */
  columns: Column[];
  column(field: string): Column | undefined;
  /** SQL expression reading a (possibly dotted) field path from a row (`rowRef` = table alias / `new` / `old`). */
  expr(path: string, rowRef?: string): string;
}

/** Verified caller identity (kept small: it lives in a 16 KB socket attachment). */
export type Identity = {
  subject: string;
  issuer?: string;
  /** Expiry, seconds since epoch (JWT `exp`). */
  exp?: number;
  claims?: Record<string, unknown>;
};
export type AuthCtx = { identity: Identity | null };

/**
 * A job scheduled by a mutation (`ctx.scheduler.runAfter/runAt`). The engine returns them with the mutation
 * result; the runtime persists them in its `_jobs` table inside the same transaction and drives the alarm.
 * `id` is the value `runAfter`/`runAt` returned to the handler.
 */
export type Job = { id: string; fn: string; args: unknown; runAt: number; kind: "mutation" | "action" };
