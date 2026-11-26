// Read-only SQL for the dashboard's SQL Explorer (docs/design/contracts.md "Dashboard", `POST /api/_ember/sql`).
//
// `checkReadOnlySql` decides, from the text alone, whether a statement may run against a shard's SQLite: exactly one
// statement, a `SELECT` (or `WITH ... SELECT`, or `VALUES`), optionally behind `EXPLAIN QUERY PLAN`. It tokenizes the
// text like SQLite does (string literals, quoted identifiers in all three styles, `--` and `/* */` comments), so a `;`
// or a `DROP` inside a string, a quoted name or a comment is data, never a statement. It refuses:
//   - a second statement (anything but comments and `;` after the first `;`);
//   - any statement but a query: PRAGMA, ATTACH/DETACH, INSERT/UPDATE/DELETE/REPLACE, CREATE/DROP/ALTER, VACUUM,
//     REINDEX, ANALYZE, transactions and savepoints (`END` is not one of them: it closes a `CASE`); `EXPLAIN` without `QUERY PLAN` (bytecode listings, not plans);
//   - those write keywords anywhere in the text, unquoted (`WITH x AS (DELETE ...)`, a write in a CTE, `RETURNING`):
//     a column or table really called that is written quoted (`"update"`);
//   - `load_extension` and the file / pointer functions of the SQLite shell (`readfile`, `writefile`, `edit`,
//     `fts3_tokenizer`), quoted or not;
//   - names of SQLite's and Cloudflare's internal tables (`sqlite_*`, `_cf_*`), quoted or not, except `sqlite_master`
//     and `sqlite_schema` (the schema, read-only by nature). Any name: a column alias or a CTE called `sqlite_x` too
//     (deciding which names are tables would need a parser, and `FROM sqlite_stat1 AS s` must not pass);
//   - the same names as 'single-quoted strings' shaped like a name (SQLite reads a string as a name where only a name
//     fits: `FROM '_cf_KV'`); a string value equal to one (`WHERE name = 'sqlite_sequence'`) is refused with them,
//     a pattern (`'sqlite_%'`) is not;
//   - what SQLite tokenizes differently from the plain reading: a NUL anywhere, a Tcl-style parameter `$a(...)`
//     (and a BOM where a token starts is whitespace, as in SQLite, so `\uFEFF_cf_KV` is `_cf_KV`);
//   - `pragma_*` table-valued functions, except the schema introspection ones (`pragma_table_info`,
//     `pragma_table_xinfo`, `pragma_index_list`, `pragma_index_info`, `pragma_index_xinfo`, `pragma_foreign_key_list`):
//     SQLite only exposes side-effect-free pragmas as functions, and those six read the schema, nothing else.
//
// It is the first of two locks: the runtime also runs the statement in a transaction it always rolls back, and
// refuses an answer whose cursor wrote a row (`rowsWritten > 0`). Pure TS: no Cloudflare or Node API.
//
// Not `ctx.db.sql` (sqlQuery.ts): that one is for app code and only reads schema tables. This one is the project
// administrator's, through the dashboard: every table of the shard but the internal ones above (`_jobs`, `_files`,
// replica and index tables included), schema-qualified names allowed (ATTACH is refused, so only main / temp exist).

export type SqlTokenKind = "word" | "quoted" | "string" | "number" | "param" | "punct" | "blob";

export interface SqlToken {
  kind: SqlTokenKind;
  /** The token's text as written (quotes included). */
  text: string;
  /** For `word` and `quoted`: the name, unquoted, in lower case. For `punct`: the operator. */
  value: string;
  /** Offset in the source text. */
  at: number;
}

export class SqlTokenizeError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
const isDigit = (c: number) => c >= 48 && c <= 57;
// Identifier characters as SQLite has them: ASCII letters, digits, `_`, `$` (not first), and every byte >= 0x80.
const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
const isIdPart = (c: number) => isIdStart(c) || isDigit(c) || c === 36;

/** U+FEFF: SQLite reads its UTF-8 form (EF BB BF) as whitespace where a token starts (tokenize.c `CC_BOM`). */
const BOM = 0xfeff;

/**
 * SQLite's tokens of `sql`, without whitespace and comments. Unterminated strings, names and comments throw.
 * Where SQLite would read the text differently from a plain tokenizer, it follows SQLite (or throws):
 *   - a BOM where a token starts is whitespace (`\uFEFFDELETE` is the keyword DELETE), inside a name it is part of it;
 *   - a NUL ends SQLite's input (what follows is never parsed the same way): refused anywhere;
 *   - `$name(...)`, `:name(...)`, `@name(...)` are one Tcl-style parameter in SQLite (up to the `)` or a space, quotes
 *     included), so `$a('x) FROM t --')` hides `FROM t` from a tokenizer that sees a string: refused.
 */
export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  const n = sql.length;
  const nul = sql.indexOf("\0");
  if (nul >= 0) throw new SqlTokenizeError("unexpected NUL character", nul);
  let i = 0;
  while (i < n) {
    const c = sql.charCodeAt(i);
    if (isSpace(c) || c === BOM) {
      i++;
      continue;
    }
    // -- comment to the end of the line
    if (c === 45 && sql.charCodeAt(i + 1) === 45) {
      const nl = sql.indexOf("\n", i + 2);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    // /* comment */ (an unterminated one runs to the end in SQLite: refused here, it hides what follows)
    if (c === 47 && sql.charCodeAt(i + 1) === 42) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new SqlTokenizeError("unterminated /* comment", i);
      i = end + 2;
      continue;
    }
    const start = i;
    // 'string' ('' escapes a quote); x'blob'
    if (c === 39 || ((c === 120 || c === 88) && sql.charCodeAt(i + 1) === 39)) {
      const blob = c !== 39;
      i += blob ? 2 : 1;
      for (;;) {
        if (i >= n) throw new SqlTokenizeError("unterminated string literal", start);
        if (sql.charCodeAt(i) === 39) {
          if (sql.charCodeAt(i + 1) === 39) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      const text = sql.slice(start, i);
      out.push({ kind: blob ? "blob" : "string", text, value: text, at: start });
      continue;
    }
    // "name", `name` (doubled quote escapes), [name]
    if (c === 34 || c === 96 || c === 91) {
      const close = c === 91 ? 93 : c;
      i++;
      let name = "";
      for (;;) {
        if (i >= n) throw new SqlTokenizeError("unterminated quoted identifier", start);
        const d = sql.charCodeAt(i);
        if (d === close) {
          if (close !== 93 && sql.charCodeAt(i + 1) === close) {
            name += sql[i];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        name += sql[i];
        i++;
      }
      out.push({ kind: "quoted", text: sql.slice(start, i), value: name.toLowerCase(), at: start });
      continue;
    }
    if (isIdStart(c)) {
      i++;
      while (i < n && isIdPart(sql.charCodeAt(i))) i++;
      const text = sql.slice(start, i);
      out.push({ kind: "word", text, value: text.toLowerCase(), at: start });
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(sql.charCodeAt(i + 1)))) {
      if (c === 48 && (sql.charCodeAt(i + 1) | 32) === 120) {
        i += 2;
        while (i < n && /[0-9a-fA-F_]/.test(sql[i]!)) i++;
      } else {
        while (i < n && (isDigit(sql.charCodeAt(i)) || sql[i] === "_" || sql[i] === ".")) i++;
        if (i < n && (sql.charCodeAt(i) | 32) === 101) {
          i++;
          if (sql[i] === "+" || sql[i] === "-") i++;
          while (i < n && isDigit(sql.charCodeAt(i))) i++;
        }
      }
      // A number glued to letters (`1abc`) is a syntax error in SQLite; the letters become their own word here.
      out.push({ kind: "number", text: sql.slice(start, i), value: sql.slice(start, i), at: start });
      continue;
    }
    // ?, ?NNN, :name, @name, $name (a name as SQLite reads it: identifier characters and `::` pairs)
    if (c === 63 || c === 58 || c === 64 || c === 36) {
      i++;
      if (c === 63) while (i < n && isDigit(sql.charCodeAt(i))) i++;
      else {
        let named = 0;
        for (;;) {
          if (i < n && isIdPart(sql.charCodeAt(i))) {
            i++;
            named++;
          } else if (sql.charCodeAt(i) === 58 && sql.charCodeAt(i + 1) === 58) i += 2;
          else break;
        }
        if (!named) throw new SqlTokenizeError(`a ${sql[start]} parameter needs a name`, start);
        if (sql.charCodeAt(i) === 40) throw new SqlTokenizeError("Tcl-style parameters ($name(...)) are not supported", start);
      }
      out.push({ kind: "param", text: sql.slice(start, i), value: sql.slice(start, i), at: start });
      continue;
    }
    // Operators: the two-character ones first.
    const two = sql.slice(i, i + 2);
    const op = ["||", "<=", ">=", "==", "!=", "<>", "<<", ">>", "->"].includes(two) ? (sql.slice(i, i + 3) === "->>" ? "->>" : two) : sql[i]!;
    if (!"||<=>=!=<><<>>->>;(),.+-*/%&|~<>=".includes(op[0]!)) throw new SqlTokenizeError(`unexpected character ${JSON.stringify(sql[i])}`, i);
    i += op.length;
    out.push({ kind: "punct", text: op, value: op, at: start });
  }
  return out;
}

/** Statement keywords that write, change the schema or the connection: refused anywhere unquoted. */
const WRITE_KEYWORDS = new Set([
  "insert",
  "update",
  "delete",
  "create",
  "drop",
  "alter",
  "vacuum",
  "pragma",
  "attach",
  "detach",
  "reindex",
  "analyze",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "returning",
]);

/** Functions that reach outside the database (extensions, files) or take raw pointers. Refused quoted or not. */
const FORBIDDEN_FUNCTIONS = new Set(["load_extension", "readfile", "writefile", "edit", "fts3_tokenizer", "fts5_tokenizer"]);

/** Table-valued pragma functions that only read the schema: allowed. */
export const ALLOWED_PRAGMA_FUNCTIONS: readonly string[] = ["pragma_table_info", "pragma_table_xinfo", "pragma_index_list", "pragma_index_info", "pragma_index_xinfo", "pragma_foreign_key_list"];

/** A string SQLite could read as a name: identifier characters only (as the tokenizer has them). */
const NAME_SHAPED = /^[\w$\u0080-\uffff]+$/;

const ALLOWED_INTERNAL = new Set(["sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_temp_schema"]);

export type ReadOnlySqlCheck =
  | {
      ok: true;
      /** The text began with `EXPLAIN QUERY PLAN`. */
      explain: boolean;
      /** Placeholders in the text (`?`, `?NNN`, `:name`...). */
      params: number;
    }
  | { ok: false; message: string; at: number };

const refuse = (message: string, at: number): ReadOnlySqlCheck => ({ ok: false, message, at });

/** Whether `sql` is one read-only query (see the header). Never throws. */
export function checkReadOnlySql(sql: string): ReadOnlySqlCheck {
  if (typeof sql !== "string") return refuse("sql must be a string", 0);
  let tokens: SqlToken[];
  try {
    tokens = tokenizeSql(sql);
  } catch (e) {
    return refuse((e as Error).message, e instanceof SqlTokenizeError ? e.at : 0);
  }
  // One statement: trailing `;` are fine, anything after the first one is not.
  const semi = tokens.findIndex((t) => t.kind === "punct" && t.value === ";");
  if (semi >= 0) {
    const extra = tokens.slice(semi).find((t) => !(t.kind === "punct" && t.value === ";"));
    if (extra) return refuse("only one statement: nothing may follow the first ;", extra.at);
    tokens = tokens.slice(0, semi);
  }
  if (!tokens.length) return refuse("empty statement", 0);
  let body = 0;
  let explain = false;
  const kw = (t: SqlToken | undefined, v: string) => t?.kind === "word" && t.value === v;
  if (kw(tokens[0], "explain")) {
    if (!kw(tokens[1], "query") || !kw(tokens[2], "plan")) return refuse("EXPLAIN only as EXPLAIN QUERY PLAN", tokens[0]!.at);
    explain = true;
    body = 3;
  }
  const first = tokens[body];
  if (!first) return refuse("EXPLAIN QUERY PLAN of what?", tokens[0]!.at);
  if (!(first.kind === "word" && (first.value === "select" || first.value === "with" || first.value === "values"))) {
    return refuse(`read-only queries only (SELECT, WITH ... SELECT, VALUES, EXPLAIN QUERY PLAN): ${first.text} is refused`, first.at);
  }
  let params = 0;
  let depth = 0;
  for (let i = body; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct") {
      if (t.value === "(") depth++;
      else if (t.value === ")" && --depth < 0) return refuse("unbalanced )", t.at);
      continue;
    }
    if (t.kind === "param") {
      params++;
      continue;
    }
    let name: string;
    if (t.kind === "string") {
      // SQLite takes a 'string' as a name where only a name fits (`FROM 'sqlite_sequence'`, `JOIN '_cf_KV'`,
      // `main.'x'`, `'pragma_database_list'()`): one shaped like a name is checked as one. Not a LIKE pattern
      // (`'sqlite_%'`), which names nothing.
      const inner = t.text.slice(1, -1).replace(/''/g, "'");
      if (!NAME_SHAPED.test(inner)) continue;
      name = inner.toLowerCase();
    } else if (t.kind === "word" || t.kind === "quoted") name = t.value;
    else continue;
    if (t.kind === "word") {
      if (WRITE_KEYWORDS.has(name)) return refuse(`${t.text} is not allowed in a read-only query (a name spelled like it is written quoted: "${t.text}")`, t.at);
      // REPLACE is a statement (and INSERT OR REPLACE) but also the string function replace(x, y, z).
      if (name === "replace" && !(tokens[i + 1]?.kind === "punct" && tokens[i + 1]!.value === "(")) return refuse("REPLACE is not allowed in a read-only query (replace(x, y, z) is)", t.at);
      if (name === "explain") return refuse("EXPLAIN only at the start, as EXPLAIN QUERY PLAN", t.at);
    }
    if (FORBIDDEN_FUNCTIONS.has(name)) return refuse(`${name} is not allowed`, t.at);
    if (name.startsWith("pragma_") && !ALLOWED_PRAGMA_FUNCTIONS.includes(name)) return refuse(`${name}: only the schema pragmas (${ALLOWED_PRAGMA_FUNCTIONS.join(", ")}) can be read`, t.at);
    if ((name.startsWith("sqlite_") && !ALLOWED_INTERNAL.has(name)) || name.startsWith("_cf_")) return refuse(`${t.text} is an internal table of SQLite or Cloudflare (only sqlite_master / sqlite_schema can be read)`, t.at);
  }
  if (depth !== 0) return refuse("unbalanced (", tokens[tokens.length - 1]!.at);
  return { ok: true, explain, params };
}

/** Bounds of `POST /api/_ember/sql`'s row cap. */
export const SQL_ROWS_DEFAULT = 500;
export const SQL_ROWS_MAX = 5000;
/** Largest SQL text it takes. */
export const SQL_TEXT_MAX = 100_000;
/** Most bound parameters. */
export const SQL_PARAMS_MAX = 100;

/** A node of `EXPLAIN QUERY PLAN`'s answer, as a tree (`id`, `parent`, `detail` rows). */
export interface SqlPlanNode {
  id: number;
  detail: string;
  children: SqlPlanNode[];
}

/** The plan rows (`[id, parent, notused, detail]`) as a tree, in row order; rows whose parent is unknown are roots. */
export function planTree(rows: ReadonlyArray<readonly unknown[]>): SqlPlanNode[] {
  const roots: SqlPlanNode[] = [];
  const byId = new Map<number, SqlPlanNode>();
  const nodes = rows.map((r) => {
    const node: SqlPlanNode = { id: Number(r[0]), detail: String(r[3] ?? ""), children: [] };
    byId.set(node.id, node);
    return { node, parent: Number(r[1]) };
  });
  // Two passes: a row may come before its parent's. A node is never its own parent.
  for (const { node, parent } of nodes) {
    const p = parent !== node.id ? byId.get(parent) : undefined;
    (p ? p.children : roots).push(node);
  }
  return roots;
}
