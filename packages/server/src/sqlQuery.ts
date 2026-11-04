// `ctx.db.sql` (PLAN §19): a read-only, parameterized SQL tagged template over the shard's tables.
//
//   ctx.db.sql`SELECT channel, count(*) AS n FROM messages WHERE likes > ${min} GROUP BY channel`      -> unknown[]
//   ctx.db.sql(v.object({ channel: v.string(), n: v.number() }))`SELECT ...`                          -> typed rows
//
// Safety comes from a strict tokenizer, not from trusting the text:
// - template values are always bound parameters (`?`); identifiers only through `sql.id(name)` (quoted);
// - one statement, starting with SELECT or WITH; any write / DDL / transaction / PRAGMA / ATTACH keyword is
//   rejected wherever it appears (outside string literals and quoted identifiers);
// - every FROM / JOIN source must be a schema table, a CTE of the statement or json_each / json_tree; schema
//   qualified names (`main.t`), internal tables (`_files`, `sqlite_master`, index shadows) and table-valued
//   PRAGMA functions are refused.
// Reactivity is per table: the query records the full key range of every table it references.
//
// Columns are the physical layout (contracts.md): top-level scalar fields are columns (booleans 0/1, int64 as
// TEXT), everything else is in `_json` (use json_extract("_json", '$.path')).

import { validate, type GenericValidator, type Infer, type Shape } from "@freecorps/ember-values";
import { q, type SqlValue } from "./driver.ts";
import { EmberError } from "./errors.ts";

const ID = Symbol.for("ember.sql.id");

/** A safe identifier (column / alias / table) for `ctx.db.sql`: validated and quoted, never a parameter. */
export type SqlIdentifier = { readonly [ID]: string };

export function sqlId(name: string): SqlIdentifier {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new EmberError("QueryError", `sql.id(): invalid identifier ${JSON.stringify(name)}`);
  }
  return Object.freeze({ [ID]: name });
}
const isId = (x: unknown): x is SqlIdentifier => typeof x === "object" && x !== null && typeof (x as any)[ID] === "string";

type SqlParam = string | number | bigint | boolean | null | undefined | Uint8Array | Date | SqlIdentifier;

export interface SqlTag<Row> {
  (strings: TemplateStringsArray, ...values: SqlParam[]): Row[];
}
/** `ctx.db.sql` — a tag (rows are `unknown`), or call it with a validator to type and check the rows. */
export interface SqlReader extends SqlTag<unknown> {
  <V extends GenericValidator>(rowValidator: V): SqlTag<Infer<V>>;
  /** A safe identifier (validated, quoted). */
  id(name: string): SqlIdentifier;
}

// ------------------------------------------------------------------------------------------------ tokenizer

type Tok =
  | { k: "word"; v: string; u: string }
  | { k: "qident"; v: string }
  | { k: "string" }
  | { k: "blob" }
  | { k: "number" }
  | { k: "param"; v: string }
  | { k: "punct"; v: string };

const PUNCT3 = ["->>"];
const PUNCT2 = ["||", "<=", ">=", "<>", "!=", "==", "<<", ">>", "->"];
const PUNCT1 = "(),.;+-*/%<>=&|~";

const bad = (msg: string): never => {
  throw new EmberError("QueryError", `ctx.db.sql: ${msg}`);
};

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  const quoted = (close: string, kind: "string" | "qident") => {
    i++;
    let text = "";
    for (;;) {
      if (i >= n) bad(`unterminated ${kind === "string" ? "string literal" : "quoted identifier"}`);
      const c = sql[i]!;
      if (c === close) {
        if (close !== "]" && sql[i + 1] === close) {
          text += c;
          i += 2;
          continue;
        }
        i++;
        break;
      }
      text += c;
      i++;
    }
    return text;
  };
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) bad("unterminated comment");
      i = end + 2;
      continue;
    }
    if (c === "'") {
      quoted("'", "string");
      out.push({ k: "string" });
      continue;
    }
    if (c === '"' || c === "`") {
      out.push({ k: "qident", v: quoted(c, "qident") });
      continue;
    }
    if (c === "[") {
      out.push({ k: "qident", v: quoted("]", "qident") });
      continue;
    }
    if ((c === "x" || c === "X") && sql[i + 1] === "'") {
      i++;
      quoted("'", "string");
      out.push({ k: "blob" });
      continue;
    }
    if (/[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i + 1;
      while (j < n && (/[A-Za-z0-9_$]/.test(sql[j]!) || sql.charCodeAt(j) > 127)) j++;
      const v = sql.slice(i, j);
      out.push({ k: "word", v, u: v.toUpperCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let j = i;
      if (c === "0" && /[xX]/.test(sql[i + 1] ?? "")) {
        j += 2;
        while (j < n && /[0-9A-Fa-f_]/.test(sql[j]!)) j++;
      } else {
        while (j < n && /[0-9_.]/.test(sql[j]!)) j++;
        if (/[eE]/.test(sql[j] ?? "")) {
          j++;
          if (/[+-]/.test(sql[j] ?? "")) j++;
          while (j < n && /[0-9]/.test(sql[j]!)) j++;
        }
      }
      if (j < n && /[A-Za-z_]/.test(sql[j]!)) bad(`malformed number near ${JSON.stringify(sql.slice(i, j + 1))}`);
      out.push({ k: "number" });
      i = j;
      continue;
    }
    if (c === "?" || c === ":" || c === "@" || c === "$" || c === "#") {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      out.push({ k: "param", v: sql.slice(i, j) });
      i = j;
      continue;
    }
    const three = sql.slice(i, i + 3);
    const two = sql.slice(i, i + 2);
    if (PUNCT3.includes(three)) {
      out.push({ k: "punct", v: three });
      i += 3;
    } else if (PUNCT2.includes(two)) {
      out.push({ k: "punct", v: two });
      i += 2;
    } else if (PUNCT1.includes(c)) {
      out.push({ k: "punct", v: c });
      i++;
    } else bad(`unexpected character ${JSON.stringify(c)}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ validation

/** Words that make a statement write, change the schema, control transactions or reach outside the database. */
const FORBIDDEN = new Set([
  "INSERT", "UPDATE", "DELETE", "UPSERT", "CREATE", "DROP", "ALTER", "ATTACH", "DETACH", "PRAGMA", "VACUUM",
  "REINDEX", "ANALYZE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "TRANSACTION", "TRIGGER",
  "RETURNING", "INTO", "EXPLAIN",
]);
/** Functions that are never allowed (DO SQLite disables most; refuse them by name anyway). */
const FORBIDDEN_FUNCTIONS = new Set(["LOAD_EXTENSION", "FTS3_TOKENIZER", "READFILE", "WRITEFILE", "EDIT", "SQLITE_DBPAGE"]);
const TABLE_FUNCTIONS = new Set(["JSON_EACH", "JSON_TREE"]);
const CLAUSE_END = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "WINDOW", "UNION", "EXCEPT", "INTERSECT", "SELECT", "VALUES"]);

const isIdent = (t: Tok | undefined): t is Extract<Tok, { k: "word" | "qident" }> => !!t && (t.k === "word" || t.k === "qident");
const identName = (t: Extract<Tok, { k: "word" | "qident" }>) => t.v;
const isWord = (t: Tok | undefined, u: string) => !!t && t.k === "word" && t.u === u;
const isPunct = (t: Tok | undefined, v: string) => !!t && t.k === "punct" && t.v === v;

/** Index of the `)` matching the `(` at `open`. */
function closeParen(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    if (isPunct(toks[i], "(")) depth++;
    else if (isPunct(toks[i], ")") && --depth === 0) return i;
  }
  return bad("unbalanced parentheses");
}

/** CTE names declared by `WITH` clauses anywhere in the statement (lower-cased). */
function cteNames(toks: Tok[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i], "WITH")) continue;
    let j = i + 1;
    if (isWord(toks[j], "RECURSIVE")) j++;
    for (;;) {
      const t = toks[j];
      if (!isIdent(t)) break;
      names.add(identName(t).toLowerCase());
      j++;
      if (isPunct(toks[j], "(")) j = closeParen(toks, j) + 1;
      if (!isWord(toks[j], "AS")) break;
      j++;
      if (isWord(toks[j], "NOT")) j++;
      if (isWord(toks[j], "MATERIALIZED")) j++;
      if (!isPunct(toks[j], "(")) break;
      j = closeParen(toks, j) + 1;
      if (!isPunct(toks[j], ",")) break;
      j++;
    }
  }
  return names;
}

export type CompiledSql = { sql: string; params: SqlValue[]; tables: string[] };

/**
 * Builds and checks the statement. `tables`: schema table names (case-insensitive in SQL, like SQLite).
 * Returns the SQL, its parameters and the schema tables it reads.
 */
export function compileSql(strings: readonly string[], values: readonly unknown[], schemaTables: Iterable<string>): CompiledSql {
  let text = strings[0] ?? "";
  const params: SqlValue[] = [];
  values.forEach((x, i) => {
    if (isId(x)) text += q(x[ID]);
    else {
      params.push(toParam(x));
      text += "?";
    }
    text += strings[i + 1] ?? "";
  });

  const toks = tokenize(text);
  while (toks.length && isPunct(toks[toks.length - 1], ";")) toks.pop();
  if (!toks.length) bad("empty statement");
  if (toks.some((t) => isPunct(t, ";"))) bad("only one statement is allowed");
  const first = toks[0]!;
  if (!(first.k === "word" && (first.u === "SELECT" || first.u === "WITH"))) bad("only SELECT (or WITH ... SELECT) statements are allowed");

  let placeholders = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k === "param") {
      if (t.v !== "?") bad(`parameters are template values (\${...}), not ${t.v}`);
      placeholders++;
    } else if (t.k === "word") {
      const call = isPunct(toks[i + 1], "(");
      // `replace(...)` is a scalar function; the REPLACE statement is never followed by `(`.
      if (FORBIDDEN.has(t.u) || (t.u === "REPLACE" && !call)) bad(`${t.u} is not allowed (read-only SELECT)`);
      if (call && FORBIDDEN_FUNCTIONS.has(t.u)) bad(`function ${t.v}() is not allowed`);
      if (call && t.u.startsWith("PRAGMA_")) bad(`function ${t.v}() is not allowed`);
    }
  }
  if (placeholders !== params.length) {
    bad("template values must be whole SQL values (not inside string literals or identifiers); a literal ? is not allowed");
  }

  const byLower = new Map<string, string>();
  for (const name of schemaTables) byLower.set(name.toLowerCase(), name);
  const ctes = cteNames(toks);
  const read = new Set<string>();

  // Walk FROM / JOIN sources, tracking per-depth whether we are in a FROM clause (for comma joins).
  const inFrom: boolean[] = [false];
  let depth = 0;
  let expectSource = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (expectSource) {
      if (isPunct(t, "(")) {
        // Subquery or parenthesized join: the next token decides.
        inFrom[++depth] = true;
        continue;
      }
      expectSource = false;
      if (t.k === "word" && (t.u === "SELECT" || t.u === "WITH" || t.u === "VALUES")) {
        inFrom[depth] = false;
        continue;
      }
      if (!isIdent(t)) bad("expected a table after FROM / JOIN");
      const name = identName(t as Extract<Tok, { k: "word" | "qident" }>);
      if (isPunct(toks[i + 1], ".")) bad(`schema-qualified table names are not allowed (${name}.…)`);
      if (isPunct(toks[i + 1], "(")) {
        if (!TABLE_FUNCTIONS.has(name.toUpperCase())) bad(`table-valued function ${name}() is not allowed`);
        continue;
      }
      const lower = name.toLowerCase();
      if (ctes.has(lower)) continue;
      const table = byLower.get(lower);
      if (!table) bad(`unknown table ${JSON.stringify(name)} (only tables of the schema can be read)`);
      read.add(table!);
      continue;
    }
    if (isPunct(t, "(")) inFrom[++depth] = false;
    else if (isPunct(t, ")")) {
      inFrom[depth] = false;
      depth = Math.max(0, depth - 1);
    } else if (t.k === "word" && (t.u === "FROM" || t.u === "JOIN")) {
      // `x IS [NOT] DISTINCT FROM y` is a comparison, not a FROM clause.
      const prev = toks[i - 1];
      const prev2 = toks[i - 2];
      if (t.u === "FROM" && isWord(prev, "DISTINCT") && (isWord(prev2, "IS") || isWord(prev2, "NOT"))) continue;
      inFrom[depth] = true;
      expectSource = true;
    } else if (isPunct(t, ",") && inFrom[depth]) expectSource = true;
    else if (t.k === "word" && CLAUSE_END.has(t.u)) inFrom[depth] = false;
  }
  if (expectSource) bad("expected a table after FROM / JOIN");
  return { sql: text, params, tables: [...read] };
}

function toParam(x: unknown): SqlValue {
  if (x === null || x === undefined) return null;
  switch (typeof x) {
    case "string":
    case "number":
      return x;
    case "boolean":
      return x ? 1 : 0;
    case "bigint":
      // int64 columns hold the decimal text.
      return x.toString();
  }
  if (x instanceof Uint8Array) return x;
  if (x instanceof Date) return x.getTime();
  return bad(`unsupported parameter of type ${Array.isArray(x) ? "array" : typeof x} (pass JSON.stringify(x) and use json(?) for JSON)`);
}

// ------------------------------------------------------------------------------------------------ rows

/** Column values -> what the row validator expects (0/1 -> boolean, TEXT -> int64, NULL -> absent if optional). */
export function coerceRow(shape: Shape, row: Record<string, unknown>): unknown {
  if (shape.kind !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(row)) {
    const f = shape.fields[k];
    if (!f) {
      out[k] = x;
      continue;
    }
    out[k] = coerceValue(f.shape, x);
    if (out[k] === null && f.optional && !accepts(f.shape, "null")) delete out[k];
  }
  return out;
}

const accepts = (s: Shape, kind: Shape["kind"]): boolean => s.kind === kind || s.kind === "any" || (s.kind === "union" && s.members.some((m) => accepts(m, kind)));

function coerceValue(s: Shape, x: unknown): unknown {
  if (x === null) return null;
  if ((typeof x === "number" || typeof x === "bigint") && accepts(s, "boolean") && !accepts(s, "number") && (x == 0 || x == 1)) return x == 1;
  if ((typeof x === "string" || typeof x === "number") && accepts(s, "int64") && !accepts(s, typeof x === "string" ? "string" : "number")) {
    try {
      return BigInt(x);
    } catch {
      return x;
    }
  }
  if (typeof x === "bigint" && accepts(s, "number") && !accepts(s, "int64")) return Number(x);
  if (typeof x === "string" && (s.kind === "object" || s.kind === "array" || s.kind === "record")) {
    try {
      return JSON.parse(x);
    } catch {
      return x;
    }
  }
  return x;
}

/** The `ctx.db.sql` object of one transaction. */
export function makeSqlReader(run: (c: CompiledSql) => Record<string, unknown>[], schemaTables: Iterable<string>, tableOfId?: (id: string) => string | undefined): SqlReader {
  const tables = [...schemaTables];
  const exec = (strings: TemplateStringsArray, values: unknown[]) => {
    if (!strings || !Array.isArray(strings.raw)) bad("use it as a tagged template: ctx.db.sql`SELECT ...`");
    return run(compileSql(strings, values, tables));
  };
  const tag = (first: unknown, ...rest: unknown[]): any => {
    if (Array.isArray(first) && Array.isArray((first as any).raw)) return exec(first as unknown as TemplateStringsArray, rest);
    const validator = first as GenericValidator;
    if (!validator || typeof validator !== "object" || !("shape" in validator)) bad("call it as a tag, or with a row validator: ctx.db.sql(v.object({...}))`...`");
    return (strings: TemplateStringsArray, ...values: unknown[]) =>
      exec(strings, values).map((row, i) => {
        const value = coerceRow(validator.shape, row);
        const r = validate(validator.shape, value, tableOfId ? { tableOfId } : {});
        if (!r.ok) throw new EmberError("ValidationError", `ctx.db.sql: row ${i} does not match the validator: ${r.path}: ${r.message}`, { path: r.path });
        return value;
      });
  };
  return Object.assign(tag, { id: sqlId }) as SqlReader;
}
