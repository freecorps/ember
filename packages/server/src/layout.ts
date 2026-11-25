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

/**
 * What a read that only needs `paths` (dotted) of each document selects, and the layout `decodeRow` decodes it with:
 * documents holding those paths (their top-level fields) exactly as a full decode would, without reading or decoding
 * the other columns. `_json` is read only for rows that may hold one of them there: always when a path has no typed
 * column, else only when one of its columns is NULL (an escaped value: NaN, -0…, or absent). A batch of documents with
 * a big `_json` then costs its key fields, not its whole documents.
 */
export function projectLayout(layout: Layout, paths: Iterable<string>): { layout: Layout; select: string } {
  const top = new Set<string>();
  for (const p of paths) {
    const f = p.split(".")[0]!;
    if (f !== "_id" && f !== "_creationTime") top.add(f);
  }
  const columns = layout.columns.filter((c) => top.has(c.field));
  const allTyped = [...top].every((f) => layout.column(f));
  const json = !allTyped
    ? `"_json"`
    : columns.length
      ? `CASE WHEN ${columns.map((c) => `${q(c.field)} IS NULL`).join(" OR ")} THEN "_json" ELSE '{}' END AS "_json"`
      : `'{}' AS "_json"`;
  const byField = new Map(columns.map((c) => [c.field, c]));
  const projected: Layout = {
    ...layout,
    columns,
    fieldOrder: layout.fieldOrder.filter((f) => top.has(f)),
    dataColumns: dataColumnsOf(columns),
    bytesColumns: layout.bytesColumns.filter((f) => top.has(f)),
    column: (field) => byField.get(field),
  };
  return { layout: projected, select: [`"_id"`, `"_creationTime"`, json, ...columns.map((c) => q(c.field))].join(", ") };
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

/** `o[k] = x`, where a "__proto__" key is data (an own property), never the object's prototype. */
function setOwn(o: Record<string, unknown>, k: string, x: unknown): void {
  if (k === "__proto__") Object.defineProperty(o, k, { value: x, enumerable: true, writable: true, configurable: true });
  else o[k] = x;
}

/**
 * The `_json` text of a document; with `out`, also each typed column's value into it. One implementation for
 * `encodeFields` and `encodeJsonOnly`, so the two never disagree on the text.
 */
function encodeJson(layout: Layout, doc: Record<string, unknown>, out: Record<string, SqlValue> | undefined): string {
  let json: Record<string, unknown> | undefined;
  for (const c of layout.columns) {
    const x = doc[c.field];
    const sv = toSqlValue(c.spec.cls, x);
    if (sv === ESCAPE) {
      setOwn((json ??= {}), c.field, x);
      if (out) setOwn(out, c.field, null);
    } else if (out) setOwn(out, c.field, sv);
  }
  for (const k in doc) {
    const x = doc[k];
    if (x === undefined || k === "_id" || k === "_creationTime" || layout.column(k)) continue;
    setOwn((json ??= {}), k, x);
  }
  // Every field in a column (the common case): no serialization of an empty object.
  return json ? stringifyValue(json) : "{}";
}

/** Document (without system fields) -> column values and `_json`. */
export function encodeFields(layout: Layout, doc: Record<string, unknown>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  out._json = encodeJson(layout, doc, out);
  return out;
}

/** `encodeFields(layout, doc)._json` alone: the same text, without the typed columns' values. */
export function encodeJsonOnly(layout: Layout, doc: Record<string, unknown>): string {
  return encodeJson(layout, doc, undefined);
}

/** Per layout: each schema field (in order) with its column, if it has one (no `layout.column` lookup per row). */
type DecodePlan = ReadonlyArray<{ field: string; column: Column | undefined }>;
const decodePlans = new WeakMap<Layout, DecodePlan>();
const decodePlan = (layout: Layout): DecodePlan => {
  let plan = decodePlans.get(layout);
  if (plan === undefined) {
    plan = layout.fieldOrder.map((field) => ({ field, column: layout.column(field) }));
    decodePlans.set(layout, plan);
  }
  return plan;
};

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** `doc[k] = x`, except that a "__proto__" key is data, never the prototype (`defineSchema` refuses one, `layoutOf` does not). */
const put = (doc: Record<string, unknown>, k: string, x: unknown): void => {
  if (k === "__proto__") Object.defineProperty(doc, k, { value: x, enumerable: true, writable: true, configurable: true });
  else doc[k] = x;
};

/** SQL row -> document, fields in schema order. */
export function decodeRow(layout: Layout, row: SqlRow): Doc {
  const plan = decodePlan(layout);
  const raw = row._json;
  const doc: Record<string, unknown> = { _id: String(row._id), _creationTime: Number(row._creationTime) };
  if (raw === "{}" || typeof raw !== "string") {
    // Every field is in its column (the common case): no JSON, nothing kept outside the schema.
    for (const { field, column: c } of plan) {
      if (!c) continue;
      const x = fromSqlValue(c.spec.cls, row[field]);
      if (x !== undefined) put(doc, field, x);
      else if (c.spec.nullable) put(doc, field, null);
    }
    return doc as Doc;
  }
  // Own properties only: a field named like an Object.prototype member (`toString`, `constructor`) is what the JSON
  // or the column holds, never the prototype's member.
  const json = parseValue(raw) as Record<string, unknown>;
  for (const { field, column: c } of plan) {
    if (c) {
      if (hasOwn(json, field)) put(doc, field, json[field]);
      else {
        const x = fromSqlValue(c.spec.cls, row[field]);
        if (x !== undefined) put(doc, field, x);
        else if (c.spec.nullable) put(doc, field, null);
      }
    } else if (hasOwn(json, field) && json[field] !== undefined) put(doc, field, json[field]);
  }
  // Fields no longer in the schema (kept data) come last. A "__proto__" key is data, never the prototype.
  for (const k in json) {
    if (hasOwn(doc, k) || layout.column(k)) continue;
    put(doc, k, json[k]);
  }
  return doc as Doc;
}
