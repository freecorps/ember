// Table layout in SQLite and the document <-> row codec.
//
//   "_rowid"          INTEGER PRIMARY KEY  explicit, so VACUUM never renumbers it (FTS5 external content keys on it)
//   "_id"             TEXT NOT NULL UNIQUE `<prefix>_<ULID>`
//   "_creationTime"   REAL NOT NULL        ms
//   "<field>"         TEXT/REAL/INTEGER/BLOB, one per top-level scalar field (see @freecorps/ember-values columnSpecFor)
//   "_json"           TEXT NOT NULL        every other field, plus values a column cannot hold (NaN, -0, ...)
//   "_k_<index>"      BLOB                 encoded key [fields..., _creationTime, _id] per db index (and by_creation_time)

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
    column: (field) => byField.get(field),
    expr(path, rowRef) {
      const p = rowRef ? `${rowRef}.` : "";
      if (path === "_id" || path === "_creationTime" || byField.has(path)) return `${p}${q(path)}`;
      return `json_extract(${p}"_json", ${lit("$." + path.split(".").map((s) => `"${s}"`).join("."))})`;
    },
  };
}

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
  for (const c of layout.columns) {
    const x = doc[c.field];
    const sv = toSqlValue(c.spec.cls, x);
    if (sv === ESCAPE) {
      json[c.field] = x;
      out[c.field] = null;
    } else out[c.field] = sv;
  }
  for (const [k, x] of Object.entries(doc)) {
    if (x === undefined || k === "_id" || k === "_creationTime" || layout.column(k)) continue;
    json[k] = x;
  }
  out._json = stringifyValue(json);
  return out;
}

/** SQL row -> document, fields in schema order. */
export function decodeRow(layout: Layout, row: SqlRow): Doc {
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
  for (const [k, x] of Object.entries(json)) if (!(k in doc) && !layout.column(k)) doc[k] = x;
  return doc as Doc;
}
