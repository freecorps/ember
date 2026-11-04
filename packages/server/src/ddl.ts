// Schema -> SQLite DDL. Every object a table owns is named `<table>__<index>[__<suffix>]` so the migration planner
// can diff it against sqlite_master by its exact SQL text; plugin index kinds get create/drop/change migrations
// without extra code.

import { encodeKey } from "@freecorps/ember-values";
import { AGGREGATE_INDEX, aggregateOfTable, groupFields } from "./aggregate.ts";
import { q } from "./driver.ts";
import { OUTBOX_DDL } from "./external.ts";
import type { IndexKind } from "./indexKinds.ts";
import { fieldOf, keyColumn, layoutOf, type Layout } from "./layout.ts";
import type { SchemaManifest, TableManifest } from "./schema.ts";
import type { Doc, IndexSpec, OwnedObject } from "./types.ts";

// `_jobs` belongs to the runtime: the engine returns scheduled jobs and the runtime persists them.
export const SYSTEM_TABLES = new Set(["_ember_meta", "_ember_indexes"]);

export const SYSTEM_DDL = [
  `CREATE TABLE IF NOT EXISTS "_ember_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS "_ember_indexes" ("tbl" TEXT NOT NULL, "name" TEXT NOT NULL, "kind" TEXT NOT NULL, "cursor" INTEGER NOT NULL, "until" INTEGER NOT NULL, PRIMARY KEY ("tbl", "name")) STRICT`,
  // External indexes (Vectorize, AI Search): writes waiting for delivery (external.ts).
  ...OUTBOX_DDL,
];

/** The built-in index every table has (key = [_creationTime, _id]). */
export const CREATION_INDEX: IndexSpec = { kind: "db", name: "by_creation_time", fields: [] };

/** db-kind indexes of a table, including by_creation_time. */
export const dbIndexesOf = (t: TableManifest): IndexSpec[] => [CREATION_INDEX, ...t.indexes.filter((i) => i.kind === "db")];

/** Full key fields of an index, tiebreakers included; undefined for unknown / non-db indexes. */
export function indexFields(t: TableManifest, index: string): string[] | undefined {
  if (index === "by_id") return ["_id"];
  if (index === "by_creation_time") return ["_creationTime", "_id"];
  const spec = t.indexes.find((i) => i.name === index && i.kind === "db");
  return spec ? [...spec.fields, "_creationTime", "_id"] : undefined;
}

/**
 * Key fields of a read-set entry's index: a table index, or `by_group` of an aggregate pseudo-table
 * ("<table>__<aggregate>"). undefined = unknown (matchers then treat the entry as table-wide).
 */
export function readSetFields(m: SchemaManifest, table: string, index: string): string[] | undefined {
  const t = m.tables[table];
  if (t) return indexFields(t, index);
  const agg = index === AGGREGATE_INDEX ? aggregateOfTable(m, table) : undefined;
  return agg && groupFields(agg.spec);
}

/** The encoded index key of a document. */
export const docKey = (doc: Doc, fields: readonly string[]): Uint8Array => encodeKey(fields.map((f) => fieldOf(doc, f)));

export function createTableSql(table: string, layout: Layout, t: TableManifest): string {
  const cols = [
    `"_rowid" INTEGER PRIMARY KEY`,
    `"_id" TEXT NOT NULL UNIQUE`,
    `"_creationTime" REAL NOT NULL`,
    ...layout.columns.map((c) => `${q(c.field)} ${c.spec.sqlType}`),
    `"_json" TEXT NOT NULL DEFAULT '{}'`,
    ...dbIndexesOf(t).map((i) => `${q(keyColumn(i.name))} BLOB`),
  ];
  return `CREATE TABLE ${q(table)} (${cols.join(", ")}) STRICT`;
}

export type OwnedByIndex = { index: IndexSpec; objects: OwnedObject[] };

/** Every object backing the table's indexes, grouped by index. */
export function ownedObjects(table: string, t: TableManifest, kinds: ReadonlyMap<string, IndexKind>, layout = layoutOf(table, t.document)): OwnedByIndex[] {
  const out: OwnedByIndex[] = [];
  for (const spec of [CREATION_INDEX, ...t.indexes]) {
    if (spec.kind === "db") {
      const name = `${table}__${spec.name}`;
      out.push({ index: spec, objects: [{ type: "index", name, sql: `CREATE INDEX ${q(name)} ON ${q(table)} (${q(keyColumn(spec.name))})` }] });
    } else {
      const kind = kinds.get(spec.kind);
      if (!kind) throw new Error(`Unknown index kind ${spec.kind} (table ${table}, index ${spec.name})`);
      const objects = kind.ddl(layout, spec);
      for (const o of objects) {
        if (o.name !== `${table}__${spec.name}` && !o.name.startsWith(`${table}__${spec.name}__`)) {
          throw new Error(`Index kind ${spec.kind}: object ${o.name} must be named ${table}__${spec.name}[__suffix]`);
        }
      }
      out.push({ index: spec, objects });
    }
  }
  return out;
}

/** DDL for a brand-new table (all indexes ready, nothing to backfill). */
export function createTableDdl(table: string, t: TableManifest, kinds: ReadonlyMap<string, IndexKind>): string[] {
  const layout = layoutOf(table, t.document);
  return [createTableSql(table, layout, t), ...ownedObjects(table, t, kinds, layout).flatMap((o) => o.objects.map((x) => x.sql))];
}

/** Full DDL for an empty database. */
export function compileSchema(m: SchemaManifest, kinds: ReadonlyMap<string, IndexKind>): string[] {
  return [...SYSTEM_DDL, ...Object.entries(m.tables).flatMap(([name, t]) => createTableDdl(name, t, kinds))];
}
