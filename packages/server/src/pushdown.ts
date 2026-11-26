// `.filter()` decided by SQLite (PR 3b): the comparisons of a filter that SQLite can answer exactly as `passes` does
// (filter.ts, the index value order) become one SQL expression evaluated on each scanned row. It gives 1 (the row
// passes), 0 (it does not) or NULL (not decided: the engine decodes the row and runs `passes`, as before).
//
// The scan itself does not change: the same statement over the same index range, the same LIMIT, the same rows read
// (and so the same `rowsRead`, `documentsRead`, read set and pagination). What changes is that a row SQLite rejects is
// never decoded nor evaluated in JS, and (in a query) its `_json` and text columns are not even handed to JS.
//
// What SQLite decides: `eq`/`neq`/`lt`/`lte`/`gt`/`gte` between a field and a literal, combined with `and`/`or`/`not`
// (three-valued: SQLite's AND/OR/NOT on 0/1/NULL is Kleene logic, so a definite answer is the one every evaluation
// of the undecided parts would give). The field must be `_id`, `_creationTime` or a top-level typed column of class
// text, real or boolean (layout.ts); the literal a primitive. Per row:
//   - the field is in `_json` (an escaped value: NaN, -0, ±Infinity; or anything a column cannot hold): NULL;
//   - the column is NULL: the field is `null` (nullable) or absent, compared in JS once, when the SQL is built;
//   - the literal has another type than the column: the type order decides, also once, in JS;
//   - same type: SQLite compares. Text with BINARY collation is UTF-8 byte order, which is the code point order of
//     `compareStrings`; literals with a lone surrogate or a NUL are left to JS. Numbers: only finite literals other
//     than -0 (columns never hold NaN, -0 or ±Infinity: those go to `_json`). Booleans: 0 / 1.
// Anything else in the expression is NULL (left to JS). An expression with no decided part, a malformed one, or one
// with a non-primitive literal or a non-string field path (whose JS evaluation could throw) is not pushed at all.

import { compareValues } from "@freecorps/ember-values";
import { lit, q, type SqlValue } from "./driver.ts";
import type { Layout } from "./layout.ts";
import type { FilterExpr } from "./types.ts";

/** The SQL of a pushed filter (1 / 0 / NULL per row) and its bound values, in the order of their `?`. */
export type PushedFilter = { sql: string; params: SqlValue[] };

type Cmp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
const CMP = new Set<string>(["eq", "neq", "lt", "lte", "gt", "gte"]);
const SQL_OP: Record<Cmp, string> = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
/** `l op r` is `r flip(op) l` (compareValues is antisymmetric). */
const FLIP: Record<Cmp, Cmp> = { eq: "eq", neq: "neq", lt: "gt", lte: "gte", gt: "lt", gte: "lte" };
const TEST: Record<Cmp, (c: number) => boolean> = {
  eq: (c) => c === 0,
  neq: (c) => c !== 0,
  lt: (c) => c < 0,
  lte: (c) => c <= 0,
  gt: (c) => c > 0,
  gte: (c) => c >= 0,
};

/** A field SQLite can read: its column, the JS type of a non-NULL value (and one such value), what NULL means. */
type FieldInfo = { column: string; type: "string" | "number" | "boolean"; sample: unknown; nullValue: unknown; notNull: boolean };

/** Field names that need no escaping in an SQL identifier, a string literal or a JSON key (`"name"`). */
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function fieldInfo(layout: Layout, path: string): FieldInfo | undefined {
  if (path === "_id") return { column: "_id", type: "string", sample: "", nullValue: undefined, notNull: true };
  if (path === "_creationTime") return { column: "_creationTime", type: "number", sample: 0, nullValue: undefined, notNull: true };
  if (!PLAIN_NAME.test(path)) return undefined;
  const c = layout.column(path);
  if (!c) return undefined;
  const nullValue = c.spec.nullable ? null : undefined;
  switch (c.spec.cls) {
    case "text":
      return { column: path, type: "string", sample: "", nullValue, notNull: false };
    case "real":
      return { column: path, type: "number", sample: 0, nullValue, notNull: false };
    case "boolean":
      return { column: path, type: "boolean", sample: false, nullValue, notNull: false };
    default:
      return undefined;
  }
}

/** A string SQLite stores, binds and compares as JS does: no lone surrogate (bound as U+FFFD), no NUL. */
function plainString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const isPrimitive = (x: unknown): boolean => x === null || x === undefined || typeof x === "string" || typeof x === "number" || typeof x === "boolean" || typeof x === "bigint";

/**
 * Whether JS evaluates `e` without throwing and without touching anything but plain data: every node well formed (as
 * `compileExpr` reads it), every field path a string, every literal a primitive or bytes. Only then may SQLite answer
 * for some rows without JS running the expression.
 */
function safe(e: FilterExpr, depth = 0): boolean {
  if (depth > 64 || typeof e !== "object" || e === null) return false;
  if ("field" in e) return typeof e.field === "string";
  if ("literal" in e) return isPrimitive(e.literal) || e.literal instanceof Uint8Array;
  const { op, args } = e as { op?: unknown; args?: unknown };
  if (!Array.isArray(args) || !args.every((a) => typeof a === "object" && a !== null)) return false;
  if (op === "and" || op === "or") return args.every((a) => safe(a as FilterExpr, depth + 1));
  if (op === "not") return args.length >= 1 && safe(args[0] as FilterExpr, depth + 1);
  if (typeof op === "string" && CMP.has(op)) return args.length >= 2 && safe(args[0] as FilterExpr, depth + 1) && safe(args[1] as FilterExpr, depth + 1);
  return false;
}

class Builder {
  readonly params: SqlValue[] = [];
  decided = false;
  constructor(
    private readonly layout: Layout,
    private readonly text: boolean,
  ) {}

  expr(e: FilterExpr): string {
    if ("field" in e || "literal" in e) return "NULL";
    const args = e.args;
    switch (e.op) {
      case "and":
        return args.length ? `(${args.map((a) => this.expr(a)).join(" AND ")})` : this.constant(true);
      case "or":
        return args.length ? `(${args.map((a) => this.expr(a)).join(" OR ")})` : this.constant(false);
      case "not":
        return `(NOT ${this.expr(args[0]!)})`;
    }
    const op = e.op as Cmp;
    const [l, r] = args as [FilterExpr, FilterExpr];
    if ("field" in l && "literal" in r) return this.compare(l.field, op, r.literal);
    if ("literal" in l && "field" in r) return this.compare(r.field, FLIP[op], l.literal);
    return "NULL";
  }

  private constant(b: boolean): string {
    this.decided = true;
    return b ? "1" : "0";
  }

  /** `compareValues(doc[path], x) op 0`, per row. */
  private compare(path: string, op: Cmp, x: unknown): string {
    const f = fieldInfo(this.layout, path);
    if (!f) return "NULL";
    const test = TEST[op];
    let present: string;
    if (typeof x !== f.type) present = test(compareValues(f.sample, x)) ? "1" : "0";
    else if (f.type === "string" && (!this.text || !plainString(x as string))) return "NULL";
    else if (f.type === "number" && !(Number.isFinite(x) && !Object.is(x, -0))) return "NULL";
    else {
      present = `${q(f.column)} ${SQL_OP[op]} ?`;
      this.params.push(f.type === "boolean" ? (x ? 1 : 0) : (x as SqlValue));
    }
    this.decided = true;
    if (f.notNull) return `(${present})`;
    const absent = test(compareValues(f.nullValue, x)) ? "1" : "0";
    // `_json` holds the field (an escaped value) only if its quoted name is in the text: otherwise the column decides.
    return `(CASE WHEN instr("_json", ${lit(`"${f.column}"`)}) > 0 THEN NULL WHEN ${q(f.column)} IS NULL THEN ${absent} ELSE ${present} END)`;
  }
}

/**
 * The SQL expression deciding `e` on a row of a table with `layout`, or undefined when nothing of it can be decided
 * there (the scan then runs as before, every row evaluated in JS). `text`: string comparisons may be pushed (not when
 * the driver reads TEXT back cut at a NUL: the document would differ from what SQLite compares; the type order and NULL
 * are still decided).
 */
export function pushFilter(layout: Layout, e: FilterExpr, text: boolean): PushedFilter | undefined {
  if (!safe(e)) return undefined;
  if ("field" in e || "literal" in e) return undefined;
  const b = new Builder(layout, text);
  const sql = b.expr(e);
  return b.decided ? { sql, params: b.params } : undefined;
}
