// `ember/import.config.ts` (PLAN §22 L4): how `ember import convex` routes a snapshot into shards. Only the CLI
// evaluates it (Node); it is never bundled into the Worker.

/** A document as read from the snapshot (values already converted to Ember values by the table's schema). */
export type ImportDoc = Record<string, unknown> & { _id: string; _creationTime: number };

export interface ImportConfig<Table extends string = string> {
  /**
   * The shard of a document (`"org:<id>"`, `"global:main"`, ...), or null to skip it (counted in the report). Tables
   * listed in `via` are not routed here. `_storage` entries no document references are routed with table
   * `"_storage"` (null: not imported).
   */
  route: (table: Table | "_storage", doc: ImportDoc) => string | null | undefined;
  /**
   * Child tables without the tenant field: `{ childTable: "parentIdField" }`. A child goes to the shard of the parent
   * document its field points at (its table is the field's `v.id(...)` table); parents are imported first. A child
   * whose parent was skipped or is missing is skipped too.
   */
  via?: Partial<Record<Table, string>>;
  /** Snapshot tables not imported at all. */
  skip?: Array<Table | (string & {})>;
  /**
   * Last change before a document is validated and routed: returns the document to import (keep `_id` and
   * `_creationTime`), or null to skip it. Runs on every run, so `ember import verify` sees the same documents.
   */
  transform?: (table: Table, doc: ImportDoc) => ImportDoc | null | undefined;
}

const IMPORT_CONFIG = Symbol.for("ember.importConfig");

/** `export default defineImport({ route, via?, skip?, transform? })` in `ember/import.config.ts`. */
export function defineImport<Table extends string = string>(config: ImportConfig<Table>): ImportConfig<Table> {
  if (typeof config?.route !== "function") throw new Error("defineImport: route(table, doc) is required");
  return Object.assign(config, { [IMPORT_CONFIG]: true });
}

export const isImportConfig = (x: unknown): x is ImportConfig =>
  !!x && typeof x === "object" && (x as Record<symbol, unknown>)[IMPORT_CONFIG] === true;
