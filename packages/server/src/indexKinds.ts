// Index-kind plugin API (PLAN D7, §6). `.index()` is built into the core; every other kind (`.searchIndex()`,
// `.vectorIndex()`, user kinds) is an IndexKind registered *per schema* through `defineSchema({ indexKinds })`.
// Builder methods are typed through interface augmentation of `IndexKindMethods` (schema side) and
// `IndexKindQueryMethods` (query side).

import type { ObjectShape } from "@ember/values";
import type { SqlRow, SqlValue } from "./driver.ts";
import { lit, q } from "./driver.ts";
import type { Doc, IndexSpec, OwnedObject, ReadSetEntry, RowChange, TableLayout } from "./types.ts";

export interface IndexQueryEnv {
  layout: TableLayout;
  spec: IndexSpec;
  /** Runs SQL counted against the transaction's read limits. */
  exec(sql: string, ...params: SqlValue[]): SqlRow[];
  /** SQL row of the table -> document. */
  decode(row: SqlRow): Doc;
}

export interface MatchHelpers {
  /** A (dotted) field of a document; undefined when absent. */
  field(doc: Doc, path: string): unknown;
}

export interface IndexKind<Config = any, QueryArg = any> {
  /** Stored in IndexSpec.kind and ReadSetEntry.kind, e.g. "search". Not "db". */
  kind: string;
  /** The TableDefinition builder method name, e.g. "searchIndex". Must end in "Index". */
  method: string;
  /** The query method name, e.g. "withSearchIndex". */
  queryMethod?: string;
  /** Validates the config at defineSchema time; returns the stored spec (JSON). */
  parse(name: string, config: Config, document: ObjectShape, layout: TableLayout): IndexSpec;
  /** SQL objects backing the index. Names must start with `${table}__${spec.name}`. */
  ddl(layout: TableLayout, spec: IndexSpec): OwnedObject[];
  /**
   * One statement that fills the index for rows with `_rowid > ?1 AND _rowid <= ?2` (chunked staged backfill).
   * Omit when the objects need no backfill.
   */
  backfill?(layout: TableLayout, spec: IndexSpec): string;
  /** Runs a query through the index. `data` lands in the read set entry. */
  query?(env: IndexQueryEnv, arg: QueryArg): { docs: Doc[]; data?: unknown };
  /** Reactivity: whether `change` may alter a result recorded as `entry`. Default: any change to the table. */
  matchesChange?(entry: ReadSetEntry, change: RowChange, helpers: MatchHelpers): boolean;
}

export function defineIndexKind<Config, QueryArg = unknown>(kind: IndexKind<Config, QueryArg>): IndexKind<Config, QueryArg> {
  if (kind.kind === "db") throw new Error(`Index kind "db" is reserved`);
  if (!/^[a-z][A-Za-z0-9]*Index$/.test(kind.method)) throw new Error(`Index kind method ${kind.method} must match /^[a-z][A-Za-z0-9]*Index$/`);
  return kind;
}

/**
 * SQL condition (for triggers) that is true when the row `rowRef` is covered by index `index` of `table`: i.e.
 * the index is not mid-backfill for that row. Rows in the not-yet-backfilled window `(cursor, until]` are skipped
 * by triggers and picked up by the backfill later, so an external-content FTS index never sees a delete for a
 * row it never indexed.
 */
export function indexedGuard(table: string, index: string, rowRef: string): string {
  return `NOT EXISTS (SELECT 1 FROM "_ember_indexes" WHERE "tbl" = ${lit(table)} AND "name" = ${lit(index)} AND ${rowRef}."_rowid" > "cursor" AND ${rowRef}."_rowid" <= "until")`;
}

export { lit, q };
