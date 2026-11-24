// Table layout in SQLite and the document <-> row codec.
//
//   "_rowid"          INTEGER PRIMARY KEY  explicit, so VACUUM never renumbers it (FTS5 external content keys on it);
//                                          compact storage (server): `_creationTime` in microseconds (ddl.ts)
//   "_id"             TEXT NOT NULL UNIQUE `<prefix>_<ULID>` (compact storage: not indexed, the id carries the rowid)
//   "_creationTime"   REAL NOT NULL        ms
//   "<field>"         TEXT/REAL/INTEGER/BLOB, one per top-level scalar field (see @freecorps/ember-values columnSpecFor)
//   "_json"           TEXT NOT NULL        every other field, plus values a column cannot hold (NaN, -0, ...)
//   "_k_<index>"      BLOB                 encoded key [fields..., _creationTime, _id] per db index (and by_creation_time,
//                                          except in compact format 3: storage.ts)
//   "_legacy"         INTEGER              compact tables converted from classic ones: 1 on rows written before

import {
  columnSpecFor,
  ESCAPE,
  fromSqlValue,
  isPlainObject,
  parseValue,
  stringifyValue,
  toSqlValue,
  type ObjectShape,
} from "@freecorps/ember-values";
import { lit, q, type SqlRow, type SqlValue } from "./driver.ts";
import type { Column, Doc, TableLayout } from "./types.ts";

/** Above this many scalar fields, the rest live in `_json` (SQLite allows 2000 columns; DO SQLite 100). */
export const MAX_USER_COLUMNS = 64;

export const SYSTEM_COLUMNS = ["_rowid", "_id", "_creationTime", "_json"] as const;
export const keyColumn = (index: string): string => `_k_${index}`;

export interface Layout extends TableLayout {
  document: ObjectShape;
  fieldOrder: string[];
  /**
   * The columns `decodeRow` reads (`_id`, `_creationTime`, `_json`, the typed columns): what a read that hands out
   * documents selects, without `_rowid` and the `_k_*` index BLOBs.
   */
  dataColumns: readonly string[];
  /** Typed columns holding `v.bytes()` values (BLOB): the only row values a decoded document shares with its row. */
  bytesColumns: readonly string[];
}

export function layoutOf(table: string, document: ObjectShape): Layout {
  const columns: Column[] = [];
  for (const [field, f] of Object.entries(document.fields)) {
    if (columns.length >= MAX_USER_COLUMNS) break;
    const spec = columnSpecFor(f);
    if (spec) columns.push({ field, spec });
  }
  const byField = new Map(columns.map((c) => [c.field, c]));
  return {
    table,
    document,
    columns,
    fieldOrder: Object.keys(document.fields),
    dataColumns: dataColumnsOf(columns),
    bytesColumns: columns.filter((c) => c.spec.cls === "bytes").map((c) => c.field),
    column: (field) => byField.get(field),
    expr(path, rowRef) {
      const p = rowRef ? `${rowRef}.` : "";
      if (path === "_id" || path === "_creationTime" || byField.has(path)) return `${p}${q(path)}`;
      return `json_extract(${p}"_json", ${lit("$." + path.split(".").map((s) => `"${s}"`).join("."))})`;
    },
  };
}

/** The columns `decodeRow` reads, given a layout's typed columns (`Layout.dataColumns`). */
export const dataColumnsOf = (columns: readonly Column[]): string[] => ["_id", "_creationTime", "_json", ...columns.map((c) => c.field)];

/** A (dotted) path of a document; undefined when absent or when it walks through a non-object. */
export function fieldOf(doc: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return doc[path];
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Document (without system fields) -> column values and `_json`. */
export function encodeFields(layout: Layout, doc: Record<string, unknown>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  const json: Record<string, unknown> = {};
  let inJson = false;
  for (const c of layout.columns) {
    const x = doc[c.field];
    const sv = toSqlValue(c.spec.cls, x);
    if (sv === ESCAPE) {
      json[c.field] = x;
      inJson = true;
      out[c.field] = null;
    } else out[c.field] = sv;
  }
  for (const k in doc) {
    const x = doc[k];
    if (x === undefined || k === "_id" || k === "_creationTime" || layout.column(k)) continue;
    json[k] = x;
    inJson = true;
  }
  // Every field in a column (the common case): no serialization of an empty object.
  out._json = inJson ? stringifyValue(json) : "{}";
  return out;
}

/**
 * Per layout: each schema field (in order) with its column, if it has one (no `layout.column` lookup per row). null
 * when a field is named like an Object.prototype member: the general path below reads those through `json`'s
 * prototype, and the fast path must not differ.
 */
type DecodePlan = ReadonlyArray<{ field: string; column: Column | undefined }> | null;
const decodePlans = new WeakMap<Layout, DecodePlan>();
const decodePlan = (layout: Layout): DecodePlan => {
  let plan = decodePlans.get(layout);
  if (plan === undefined) {
    plan = layout.fieldOrder.some((f) => f in Object.prototype) ? null : layout.fieldOrder.map((field) => ({ field, column: layout.column(field) }));
    decodePlans.set(layout, plan);
  }
  return plan;
};

/** SQL row -> document, fields in schema order. */
export function decodeRow(layout: Layout, row: SqlRow): Doc {
  const plan = row._json === "{}" ? decodePlan(layout) : null;
  if (plan) {
    // Every field is in its column (the common case): no JSON, nothing kept outside the schema.
    const doc: Record<string, unknown> = { _id: String(row._id), _creationTime: Number(row._creationTime) };
    for (const { field, column: c } of plan) {
      if (!c) continue;
      const x = fromSqlValue(c.spec.cls, row[field]);
      if (x !== undefined) doc[field] = x;
      else if (c.spec.nullable) doc[field] = null;
    }
    return doc as Doc;
  }
  const json = typeof row._json === "string" && row._json !== "{}" ? (parseValue(row._json) as Record<string, unknown>) : {};
  const doc: Record<string, unknown> = { _id: String(row._id), _creationTime: Number(row._creationTime) };
  for (const field of layout.fieldOrder) {
    const c = layout.column(field);
    if (c) {
      if (field in json) doc[field] = json[field];
      else {
        const x = fromSqlValue(c.spec.cls, row[field]);
        if (x !== undefined) doc[field] = x;
        else if (c.spec.nullable) doc[field] = null;
      }
    } else if (json[field] !== undefined) doc[field] = json[field];
  }
  // Fields no longer in the schema (kept data) come last.
  for (const k in json) if (!(k in doc) && !layout.column(k)) doc[k] = json[k];
  return doc as Doc;
}
