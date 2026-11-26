// The SQL Explorer's read-only check (sql-readonly.ts): one query statement, decided by tokens (strings, quoted names
// and comments are data), and an adversarial list of what must never pass.
import { createNodeSqliteDriver } from "../src/testing.ts";
import { describe, expect, it } from "vitest";
import { checkReadOnlySql, planTree, tokenizeSql } from "../src/sql-readonly.ts";

const ok = (sql: string) => checkReadOnlySql(sql).ok;

describe("checkReadOnlySql: accepted", () => {
  const accepted = [
    "SELECT 1",
    "select * from messages",
    "SELECT 1;",
    "SELECT 1;;  ",
    "select/**/1;--",
    "SELECT 1 -- a comment; DROP TABLE x\n",
    "SELECT 1 /* ; DROP TABLE x; */",
    "SELECT 'a;b' AS x",
    "SELECT 'DROP TABLE messages; DELETE FROM x' AS s",
    "SELECT 'it''s; fine'",
    'SELECT "quoted;ident" FROM t',
    'SELECT "update", "delete" FROM "insert"',
    "SELECT [weird name;], `x;y` FROM t",
    "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
    "WITH RECURSIVE c(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM c WHERE n < 5) SELECT n FROM c",
    "WITH a AS MATERIALIZED (SELECT 1) SELECT * FROM a",
    "VALUES (1, 2), (3, 4)",
    "EXPLAIN QUERY PLAN SELECT * FROM messages WHERE channel = ?",
    "explain query plan with x as (select 1) select * from x",
    "SELECT replace(body, 'a', 'b') FROM messages",
    "SELECT REPLACE (body, 'a', 'b') FROM messages",
    "SELECT CASE WHEN 1 THEN 'a' ELSE 'b' END",
    "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
    "SELECT * FROM sqlite_schema",
    "SELECT * FROM main.sqlite_master",
    "SELECT * FROM temp.sqlite_master",
    "SELECT * FROM sqlite_temp_master",
    'SELECT "replace"(body, \'a\', \'b\'), [replace](body, \'a\', \'b\') FROM messages',
    "\uFEFFSELECT 1",
    " \uFEFF SELECT 1 \uFEFF",
    "SELECT :a::b, $c::d",
    "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'sqlite x'",
    "SELECT * FROM 'messages'",
    "SELECT * FROM pragma_table_info('messages')",
    "SELECT * FROM pragma_index_list('messages')",
    "SELECT json_extract(_json, '$.a') FROM t WHERE _id = :id OR _id = @id OR _id = $id OR _id = ?1",
    "SELECT x'00ff', 1e3, .5, 0x1F",
    "SELECT a ->> '$.b', a -> '$.c' FROM t",
    "SELECT * FROM _jobs",
    "SELECT * FROM \"messages__search_body\" WHERE \"messages__search_body\" MATCH 'hi'",
  ];
  it.each(accepted)("%s", (sql) => expect(checkReadOnlySql(sql)).toMatchObject({ ok: true }));

  it("says when the text is an EXPLAIN QUERY PLAN, and counts parameters", () => {
    expect(checkReadOnlySql("EXPLAIN QUERY PLAN SELECT ?, ?")).toEqual({ ok: true, explain: true, params: 2 });
    expect(checkReadOnlySql("SELECT ':x' , ?")).toEqual({ ok: true, explain: false, params: 1 });
  });

  it("every accepted statement is valid SQLite that writes nothing", () => {
    // node:sqlite as the stand-in for DO SQLite, through the SqlDriver interface (one statement per exec).
    const db = createNodeSqliteDriver();
    for (const ddl of [
      `CREATE TABLE messages (_rowid INTEGER PRIMARY KEY, _id TEXT, channel TEXT, body TEXT, _json TEXT DEFAULT '{}')`,
      `CREATE TABLE "insert" ("update" TEXT, "delete" TEXT)`,
      `CREATE TABLE t (_id TEXT, _json TEXT, a TEXT, "quoted;ident" TEXT, [weird name;] TEXT, \`x;y\` TEXT)`,
      `CREATE TABLE _jobs (id INTEGER)`,
      `CREATE VIRTUAL TABLE messages__search_body USING fts5(body)`,
    ])
      db.exec(ddl);
    const changes = () => (db.exec("SELECT total_changes() AS n").rows[0] as { n: number }).n;
    for (const sql of accepted) {
      const before = changes();
      // Unbound parameters are NULL: every statement runs as written.
      db.exec(sql);
      expect(changes(), sql).toBe(before);
    }
  });
});

describe("checkReadOnlySql: refused (adversarial)", () => {
  const refused: Array<[string, RegExp]> = [
    ["SELECT 1; DROP TABLE x", /one statement/],
    ["SELECT 1;DROP TABLE x;", /one statement/],
    ["SELECT 1; -- c\n SELECT 2", /one statement/],
    ["SELECT 1 /* x */ ; /* y */ DELETE FROM t", /one statement/],
    ["select 'a';delete from t", /one statement/],
    ["DROP TABLE messages", /read-only queries only/],
    ["drop/**/table messages", /read-only queries only/],
    ["  /* hi */ DELETE FROM messages", /read-only queries only/],
    ["INSERT INTO t VALUES (1)", /read-only queries only/],
    ["UPDATE t SET a = 1", /read-only queries only/],
    ["REPLACE INTO t VALUES (1)", /read-only queries only/],
    ["CREATE TABLE x (a)", /read-only queries only/],
    ["ALTER TABLE t ADD COLUMN b", /read-only queries only/],
    ["VACUUM", /read-only queries only/],
    ["PRAGMA writable_schema = 1", /read-only queries only/],
    ["pragma table_info(messages)", /read-only queries only/],
    ["ATTACH DATABASE 'x' AS y", /read-only queries only/],
    ["DETACH y", /read-only queries only/],
    ["BEGIN", /read-only queries only/],
    ["ANALYZE", /read-only queries only/],
    ["REINDEX", /read-only queries only/],
    ["EXPLAIN SELECT 1", /EXPLAIN only as EXPLAIN QUERY PLAN/],
    ["EXPLAIN QUERY DELETE FROM t", /EXPLAIN only as EXPLAIN QUERY PLAN/],
    ["EXPLAIN QUERY PLAN DELETE FROM t", /read-only queries only/],
    ["EXPLAIN QUERY PLAN", /of what/],
    ["SELECT 1 UNION SELECT 2 EXPLAIN", /EXPLAIN only at the start/],
    ["WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", /DELETE is not allowed/],
    ["WITH x AS (SELECT 1) DELETE FROM t", /DELETE is not allowed/],
    ["WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", /INSERT is not allowed/],
    ["WITH x AS (SELECT 1) UPDATE t SET a = 1", /UPDATE is not allowed/],
    ["WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x", /REPLACE is not allowed/],
    ["SELECT * FROM t WHERE a IN (INSERT INTO t VALUES (1))", /INSERT is not allowed/],
    ["SELECT 1 RETURNING *", /RETURNING is not allowed/],
    ["SELECT load_extension('evil')", /load_extension is not allowed/],
    ['SELECT "load_extension"(\'evil\')', /load_extension is not allowed/],
    ["SELECT LOAD_EXTENSION('x', 'y')", /load_extension is not allowed/],
    ["SELECT writefile('/tmp/x', 'y')", /writefile is not allowed/],
    ["SELECT fts3_tokenizer('simple')", /fts3_tokenizer is not allowed/],
    ["SELECT * FROM sqlite_sequence", /internal table/],
    ["SELECT * FROM sqlite_stat1", /internal table/],
    ['SELECT * FROM "sqlite_sequence"', /internal table/],
    ["SELECT * FROM [SQLITE_DBPAGE]", /internal table/],
    ["SELECT * FROM _cf_KV", /internal table/],
    ['SELECT * FROM "_cf_METADATA"', /internal table/],
    ["SELECT * FROM main._cf_kv", /internal table/],
    ["SELECT * FROM pragma_database_list", /only the schema pragmas/],
    ["SELECT * FROM pragma_compile_options()", /only the schema pragmas/],
    ['SELECT * FROM "pragma_journal_mode"', /only the schema pragmas/],
    ["SELECT 'unterminated", /unterminated string/],
    ['SELECT "unterminated', /unterminated quoted identifier/],
    ["SELECT 1 /* hides; DROP TABLE x", /unterminated \/\* comment/],
    ["SELECT (1", /unbalanced \(/],
    ["SELECT 1)", /unbalanced \)/],
    ["", /empty statement/],
    [";", /empty statement/],
    ["-- only a comment", /empty statement/],
    ["SELECT 1 \\ 2", /unexpected character/],
    // Where SQLite tokenizes differently from a plain reading (see "agrees with SQLite" below).
    ["SELECT * FROM \uFEFFsqlite_sequence", /internal table/],
    ["SELECT * FROM \uFEFF_cf_KV", /internal table/],
    ["SELECT * FROM t, \uFEFFpragma_database_list", /only the schema pragmas/],
    ["WITH x AS (SELECT 1) \uFEFFDELETE FROM t", /DELETE is not allowed/],
    ["SELECT 1 \uFEFFRETURNING *", /RETURNING is not allowed/],
    ["SELECT $a('x) , * FROM sqlite_sequence --')", /Tcl-style/],
    ["SELECT :a('x) , * FROM _cf_KV --')", /Tcl-style/],
    ["SELECT @a(';) DELETE FROM t --')", /Tcl-style/],
    ["SELECT $a::b(x)", /Tcl-style/],
    ["SELECT 1 -- \u0000\nDELETE FROM t", /NUL/],
    ["SELECT 1 /* \u0000 */", /NUL/],
    ["SELECT 1\u0000; DELETE FROM t", /NUL/],
    ["SELECT $ FROM t", /needs a name/],
    // A 'string' is a name where only a name fits: shaped like a restricted one, it is refused.
    ["SELECT * FROM 'sqlite_sequence'", /internal table/],
    ["SELECT * FROM main.'sqlite_sequence'", /internal table/],
    ["SELECT * FROM t, '_cf_KV'", /internal table/],
    ["SELECT * FROM t CROSS JOIN '_CF_KV'", /internal table/],
    ["SELECT * FROM (SELECT 1) LEFT JOIN '_cf_METADATA' ON 1", /internal table/],
    ["SELECT * FROM 'pragma_database_list'", /only the schema pragmas/],
    ["SELECT * FROM 'pragma_database_list'()", /only the schema pragmas/],
    ["SELECT * FROM pragma_table_info('_cf_KV')", /internal table/],
    ["SELECT * FROM t WHERE name = 'sqlite_sequence'", /internal table/],
    // A name is refused wherever it is: an alias or a CTE called like an internal table too (no parser here).
    ["SELECT 1 AS sqlite_version", /internal table/],
    ["WITH sqlite_x AS (SELECT 1) SELECT * FROM sqlite_x", /internal table/],
  ];
  it.each(refused)("%s", (sql, why) => {
    const r = checkReadOnlySql(sql);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(why);
      expect(r.at).toBeGreaterThanOrEqual(0);
    }
  });

  it("agrees with SQLite where its tokenizer differs from a plain reading: these really read internal tables", () => {
    const db = createNodeSqliteDriver();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v)");
    db.exec("INSERT INTO t (v) VALUES (1)");
    for (const sql of ["SELECT * FROM \uFEFFsqlite_sequence", "SELECT $a('x) , * FROM sqlite_sequence --')", "SELECT :a('x) , * FROM sqlite_sequence --')", "SELECT * FROM 'sqlite_sequence'", "SELECT * FROM main.'sqlite_sequence'"]) {
      expect(db.exec(sql).rows, sql).toEqual([expect.objectContaining({ name: "t", seq: 1 })]);
      expect(ok(sql), sql).toBe(false);
    }
    // And a BOM before a keyword is that keyword: this DELETE runs in SQLite.
    db.exec("WITH x AS (SELECT 1) \uFEFFDELETE FROM t");
    expect(db.exec("SELECT count(*) AS n FROM t").rows).toEqual([{ n: 0 }]);
  });

  it("a non-string is refused, never thrown", () => {
    expect(ok(5 as unknown as string)).toBe(false);
  });
});

describe("tokenizeSql", () => {
  it("strings, quoted names and comments are one token or none; offsets point into the text", () => {
    const t = tokenizeSql(`SELECT 'a;b', "x""y", [z] -- c\nFROM t /* d */;`);
    expect(t.map((x) => [x.kind, x.value])).toEqual([
      ["word", "select"],
      ["string", "'a;b'"],
      ["punct", ","],
      ["quoted", 'x"y'],
      ["punct", ","],
      ["quoted", "z"],
      ["word", "from"],
      ["word", "t"],
      ["punct", ";"],
    ]);
    expect(t[1]!.at).toBe(7);
  });
});

describe("planTree", () => {
  it("nests EXPLAIN QUERY PLAN rows by parent", () => {
    expect(
      planTree([
        [2, 0, 0, "SCAN t"],
        [5, 0, 0, "USE TEMP B-TREE"],
        [7, 5, 0, "SEARCH u"],
      ]),
    ).toEqual([
      { id: 2, detail: "SCAN t", children: [] },
      { id: 5, detail: "USE TEMP B-TREE", children: [{ id: 7, detail: "SEARCH u", children: [] }] },
    ]);
  });

  it("nests a row that comes before its parent's", () => {
    expect(
      planTree([
        [7, 5, 0, "SEARCH u"],
        [5, 0, 0, "USE TEMP B-TREE"],
        [9, 9, 0, "SELF"],
      ]),
    ).toEqual([
      { id: 5, detail: "USE TEMP B-TREE", children: [{ id: 7, detail: "SEARCH u", children: [] }] },
      { id: 9, detail: "SELF", children: [] },
    ]);
  });
});
