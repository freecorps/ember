import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { attempt, report, stubFor } from "./helpers";

describe("Q2 SQL features", () => {
  it("JSON functions", async () => {
    await runInDurableObject(stubFor("q2-json"), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE d (id INTEGER PRIMARY KEY, doc TEXT)");
      sql.exec("INSERT INTO d(doc) VALUES (?), (?)", JSON.stringify({ a: { b: 1 }, tags: ["x", "y"] }), JSON.stringify({ a: { b: 2 }, tags: ["z"] }));
      const out = {
        json_extract: attempt(() => sql.exec("SELECT json_extract(doc, '$.a.b') AS b FROM d ORDER BY id").toArray()),
        arrow_ops: attempt(() => sql.exec("SELECT doc ->> '$.a.b' AS b, doc -> '$.a' AS a FROM d ORDER BY id").toArray()),
        json_each: attempt(() => sql.exec("SELECT d.id, j.value FROM d, json_each(d.doc, '$.tags') j ORDER BY d.id, j.key").toArray()),
        json_tree: attempt(() => sql.exec("SELECT COUNT(*) AS n FROM d, json_tree(d.doc)").one()),
        json_group_array: attempt(() => sql.exec("SELECT json_group_array(id) AS ids FROM d").one()),
        json_set_patch: attempt(() => sql.exec("SELECT json_set(doc, '$.c', 3) AS s, json_patch(doc, '{\"a\":null}') AS p FROM d WHERE id = 1").one()),
        jsonb: attempt(() => sql.exec("SELECT json(jsonb('{\"k\":1}')) AS v").one()),
        json_valid: attempt(() => sql.exec("SELECT json_valid('{') AS bad, json_valid('{}') AS good").one()),
      };
      report("q2.json", out);
      expect(out.json_each.ok).toBe(true);
      expect(out.json_extract.ok).toBe(true);
    });
  });

  it("math functions", async () => {
    await runInDurableObject(stubFor("q2-math"), (_i, state) => {
      const sql = state.storage.sql;
      const out: Record<string, unknown> = {};
      for (const expr of ["sqrt(16)", "pow(2, 10)", "ln(1)", "log10(1000)", "log(1000)", "log(2, 8)", "log2(8)", "exp(1)", "sin(0)", "atan2(1, 1)", "trunc(2.7)", "sign(-2)", "degrees(pi())", "floor(2.7)", "ceil(2.1)", "pi()", "mod(7, 3)", "abs(-3)", "round(2.567, 2)", "random() IS NOT NULL", "unixepoch()", "strftime('%s','now') IS NOT NULL", "printf('%05d', 42)", "format('%.2f', 3.14159)", "concat_ws('-', 'a', 'b')", "unhex('4142')", "iif(1, 'y', 'n')", "max(1, 5, 3)", "octet_length('ação')"]) {
        out[expr] = attempt(() => sql.exec(`SELECT ${expr} AS v`).one().v);
      }
      report("q2.math_and_scalar", out);
      expect((out["sqrt(16)"] as any).ok).toBe(true);
    });
  });

  it("generated columns, expression indexes, partial indexes, STRICT, WITHOUT ROWID, RETURNING, upsert", async () => {
    await runInDurableObject(stubFor("q2-ddl"), (_i, state) => {
      const sql = state.storage.sql;
      const out: Record<string, unknown> = {};
      out.strict_create = attempt(() =>
        sql.exec(`CREATE TABLE users (
          _id TEXT PRIMARY KEY,
          doc TEXT NOT NULL,
          email TEXT GENERATED ALWAYS AS (json_extract(doc, '$.email')) VIRTUAL,
          age INTEGER GENERATED ALWAYS AS (json_extract(doc, '$.age')) STORED,
          deleted INTEGER NOT NULL DEFAULT 0
        ) STRICT`),
      );
      out.strict_type_violation = attempt(() => sql.exec("INSERT INTO users(_id, doc, deleted) VALUES ('x', '{}', 'not-int')"));
      out.idx_generated = attempt(() => sql.exec("CREATE UNIQUE INDEX users_email ON users(email)"));
      out.idx_expression = attempt(() => sql.exec("CREATE INDEX users_name_expr ON users(lower(json_extract(doc, '$.name')))"));
      out.idx_partial = attempt(() => sql.exec("CREATE INDEX users_live_age ON users(age) WHERE deleted = 0"));
      sql.exec(
        "INSERT INTO users(_id, doc) VALUES (?, ?), (?, ?)",
        "u1", JSON.stringify({ email: "a@x.com", age: 30, name: "Ana" }),
        "u2", JSON.stringify({ email: "b@x.com", age: 40, name: "Bob" }),
      );
      out.generated_values = sql.exec("SELECT _id, email, age FROM users ORDER BY _id").toArray();
      out.unique_on_generated_violation = attempt(() => sql.exec("INSERT INTO users(_id, doc) VALUES ('u3', ?)", JSON.stringify({ email: "a@x.com" })));
      out.plan_expression = sql.exec("EXPLAIN QUERY PLAN SELECT _id FROM users WHERE lower(json_extract(doc, '$.name')) = 'ana'").toArray().map((r: any) => r.detail);
      out.plan_generated = sql.exec("EXPLAIN QUERY PLAN SELECT _id FROM users WHERE email = 'a@x.com'").toArray().map((r: any) => r.detail);
      out.plan_partial = sql.exec("EXPLAIN QUERY PLAN SELECT _id FROM users WHERE deleted = 0 AND age > 20").toArray().map((r: any) => r.detail);
      out.without_rowid = attempt(() => {
        sql.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v BLOB) STRICT, WITHOUT ROWID");
        sql.exec("INSERT INTO kv VALUES ('a', x'01')");
        return sql.exec("SELECT k, hex(v) AS v FROM kv").toArray();
      });
      out.returning = attempt(() => sql.exec("UPDATE users SET deleted = 1 WHERE _id = 'u2' RETURNING _id, deleted, age").toArray());
      out.upsert = attempt(() => {
        sql.exec("INSERT INTO kv VALUES ('a', x'02') ON CONFLICT(k) DO UPDATE SET v = excluded.v");
        sql.exec("INSERT INTO kv VALUES ('a', x'03') ON CONFLICT DO NOTHING");
        return sql.exec("SELECT k, hex(v) AS v FROM kv").toArray();
      });
      out.upsert_returning = attempt(() =>
        sql.exec("INSERT INTO kv VALUES ('b', x'09') ON CONFLICT(k) DO UPDATE SET v = excluded.v RETURNING k").toArray(),
      );
      out.window_fn = attempt(() => sql.exec("SELECT _id, row_number() OVER (ORDER BY age DESC) AS rn FROM users").toArray());
      out.cte_recursive = attempt(() => sql.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5) SELECT sum(x) AS s FROM c").one());
      out.foreign_keys_enforced = attempt(() => {
        sql.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
        sql.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))");
        sql.exec("INSERT INTO child(pid) VALUES (999)");
        return "insert with dangling FK succeeded (FKs NOT enforced)";
      });
      report("q2.ddl", out);
      expect((out.strict_create as any).ok).toBe(true);
      expect((out.strict_type_violation as any).ok).toBe(false);
      expect((out.returning as any).ok).toBe(true);
    });
  });

  it("ALTER TABLE ADD / DROP / RENAME COLUMN, RENAME TABLE", async () => {
    await runInDurableObject(stubFor("q2-alter"), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT, x TEXT)");
      sql.exec("CREATE INDEX t_c ON t(c)");
      sql.exec("INSERT INTO t(a, b, c, x) VALUES ('1', '2', '3', 'gone')");
      const out = {
        add_column: attempt(() => sql.exec("ALTER TABLE t ADD COLUMN d INTEGER NOT NULL DEFAULT 7")),
        add_column_notnull_no_default: attempt(() => sql.exec("ALTER TABLE t ADD COLUMN nn TEXT NOT NULL")),
        drop_plain_column: attempt(() => sql.exec("ALTER TABLE t DROP COLUMN x")),
        drop_indexed_column: attempt(() => sql.exec("ALTER TABLE t DROP COLUMN c")),
        drop_index_then_column: attempt(() => { sql.exec("DROP INDEX t_c"); sql.exec("ALTER TABLE t DROP COLUMN c"); }),
        add_column_generated_virtual: attempt(() => sql.exec("ALTER TABLE t ADD COLUMN e TEXT GENERATED ALWAYS AS (a || b) VIRTUAL")),
        add_column_generated_stored: attempt(() => sql.exec("ALTER TABLE t ADD COLUMN f TEXT GENERATED ALWAYS AS (a || b) STORED")),
        drop_column_referenced_by_generated: attempt(() => sql.exec("ALTER TABLE t DROP COLUMN b")),
        rename_column: attempt(() => sql.exec("ALTER TABLE t RENAME COLUMN a TO a2")),
        rename_table: attempt(() => sql.exec("ALTER TABLE t RENAME TO t2")),
        final: attempt(() => sql.exec("SELECT * FROM t2").toArray()),
        columns: attempt(() => sql.exec("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('t2')").toArray()),
        generated_after_rename: attempt(() => sql.exec("SELECT sql FROM sqlite_master WHERE name = 't2'").one()),
      };
      report("q2.alter", out);
      expect(out.add_column.ok && out.drop_plain_column.ok && out.rename_column.ok).toBe(true);
    });
  });

  it("cursor API surface", async () => {
    await runInDurableObject(stubFor("q2-cursor"), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, v BLOB, r REAL, n TEXT)");
      sql.exec("INSERT INTO c(v, r, n) VALUES (?, ?, ?)", new Uint8Array([1, 2, 3]), 1.5, null);
      const cur = sql.exec("SELECT * FROM c");
      const raw = sql.exec("SELECT * FROM c").raw().toArray();
      const row = cur.one();
      const multi = attempt(() => sql.exec("INSERT INTO c(n) VALUES ('a'); INSERT INTO c(n) VALUES ('b'); SELECT COUNT(*) AS n FROM c").toArray());
      const multiBind = attempt(() => sql.exec("INSERT INTO c(n) VALUES (?); SELECT ? AS x", "a", "b").toArray());
      const bigint = attempt(() => sql.exec("SELECT ? AS v", 2n ** 40n).one());
      const bigintOverflow = attempt(() => sql.exec("SELECT 9223372036854775807 AS v").one());
      const boolBind = attempt(() => sql.exec("SELECT ? AS v", true as any).one());
      const one0 = attempt(() => sql.exec("SELECT * FROM c WHERE id = -1").one());
      report("q2.cursor", {
        columnNames: cur.columnNames,
        rowTypes: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null ? "null" : v instanceof ArrayBuffer ? "ArrayBuffer" : typeof v])),
        raw,
        multiStatement: multi,
        multiStatementWithBindings: multiBind,
        bigintBind: bigint,
        int64Max: bigintOverflow,
        booleanBind: boolBind,
        oneOnEmpty: one0,
        methods: Object.getOwnPropertyNames(Object.getPrototypeOf(cur)),
        sqlStorageMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(sql)),
      });
    });
  });
});
