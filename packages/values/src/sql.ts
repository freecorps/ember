// Document <-> SQL scalar conversion (contracts: SqlValue has no bigint/boolean; the engine converts).
//
// A top-level field gets its own typed column when all of its members map to one "column class":
//   text    string | id | file | string literal   -> TEXT
//   real    number | number literal                -> REAL   (NaN / ±Infinity / -0 escape to the JSON column)
//   int64   int64 | bigint literal                 -> TEXT   (decimal; DO SQLite cannot bind bigint)
//   boolean boolean | boolean literal              -> INTEGER (0/1; binding `true` would store "true")
//   bytes   bytes                                  -> BLOB
// plus optionally `null`. A field that is both optional and nullable lives in JSON (NULL could not tell
// "absent" from null). Everything else (objects, arrays, records, any, mixed unions) lives in JSON.

import { literalValue, type FieldShape, type Shape } from "./shape.ts";

export type SqlValue = null | number | string | Uint8Array;

export type ColumnClass = "text" | "real" | "int64" | "boolean" | "bytes";
export type SqlColumnType = "TEXT" | "REAL" | "INTEGER" | "BLOB";

export type ColumnSpec = {
  cls: ColumnClass;
  sqlType: SqlColumnType;
  /** null is a legal value of the field (column NULL means null, not absent). */
  nullable: boolean;
  /** absent is legal (column NULL means absent). Never both nullable and optional. */
  optional: boolean;
};

export const SQL_TYPE: Record<ColumnClass, SqlColumnType> = {
  text: "TEXT",
  real: "REAL",
  int64: "TEXT",
  boolean: "INTEGER",
  bytes: "BLOB",
};

function classOf(shape: Shape): ColumnClass | "null" | undefined {
  switch (shape.kind) {
    case "string":
    case "id":
    case "file":
      return "text";
    case "number":
      return "real";
    case "int64":
      return "int64";
    case "boolean":
      return "boolean";
    case "bytes":
      return "bytes";
    case "null":
      return "null";
    case "literal": {
      const val = literalValue(shape);
      return typeof val === "string" ? "text" : typeof val === "number" ? "real" : typeof val === "bigint" ? "int64" : "boolean";
    }
    default:
      return undefined;
  }
}

function flatten(shape: Shape): Shape[] {
  return shape.kind === "union" ? shape.members.flatMap(flatten) : [shape];
}

/** The column for a top-level field, or undefined when it is stored in the JSON column. */
export function columnSpecFor(field: FieldShape): ColumnSpec | undefined {
  const classes = new Set(flatten(field.shape).map(classOf));
  if (classes.has(undefined)) return undefined;
  const nullable = classes.delete("null");
  if (classes.size !== 1) return undefined;
  if (nullable && field.optional) return undefined;
  const cls = [...classes][0] as ColumnClass;
  return { cls, sqlType: SQL_TYPE[cls], nullable, optional: field.optional };
}

/** Marker: the value cannot be represented in its column and must go to the JSON column instead. */
export const ESCAPE: unique symbol = Symbol("ember.escape");

/** Field value -> column value. `undefined`/`null` -> NULL. Returns ESCAPE for NaN, ±Infinity and -0. */
export function toSqlValue(cls: ColumnClass, x: unknown): SqlValue | typeof ESCAPE {
  if (x === undefined || x === null) return null;
  switch (cls) {
    case "text":
      return x as string;
    case "real":
      return Number.isFinite(x) && !Object.is(x, -0) ? (x as number) : ESCAPE;
    case "int64":
      return (x as bigint).toString();
    case "boolean":
      return x ? 1 : 0;
    case "bytes":
      return x as Uint8Array;
  }
}

/** Column value -> field value (NULL -> undefined; the caller decides between null and absent). */
export function fromSqlValue(cls: ColumnClass, x: SqlValue | bigint | ArrayBuffer | undefined): unknown {
  if (x === null || x === undefined) return undefined;
  switch (cls) {
    case "text":
      return String(x);
    case "real":
      return Number(x);
    case "int64":
      return BigInt(x as string | number | bigint);
    case "boolean":
      return x === 1 || x === 1n || x === "1";
    case "bytes":
      return x instanceof Uint8Array ? x : new Uint8Array(x as ArrayBuffer);
  }
}

const utf8Length = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
};

/** Approximate encoded size of a value in bytes (used for the per-document size limit). */
export function valueSize(x: unknown): number {
  switch (typeof x) {
    case "string":
      return utf8Length(x) + 2;
    case "number":
    case "bigint":
      return 9;
    case "boolean":
    case "undefined":
      return 1;
    case "object": {
      if (x === null) return 1;
      if (x instanceof Uint8Array) return x.length + 2;
      if (Array.isArray(x)) {
        let n = 2;
        for (const item of x) n += valueSize(item);
        return n;
      }
      let n = 2;
      for (const [k, item] of Object.entries(x)) if (item !== undefined) n += utf8Length(k) + 1 + valueSize(item);
      return n;
    }
    default:
      return 0;
  }
}
