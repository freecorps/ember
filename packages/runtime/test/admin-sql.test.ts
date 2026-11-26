// The SQL Explorer endpoint (`POST /api/_ember/sql`, admin-sql.ts): one read-only query on a shard's DO SQLite, a row
// cap, EXPLAIN QUERY PLAN as a tree, refusals before the shard, and a transaction that never commits.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runReadOnlySql } from "../src/admin-sql.ts";

const admin = (path: string, body?: unknown, token: string | null = "admin-secret") =>
  SELF.fetch(`http://ember/api/_ember/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

const sql = (shard: string, text: string, extra: Record<string, unknown> = {}) => admin("sql", { shard, sql: text, ...extra });

async function seed(shard: string, n: number) {
  for (let i = 0; i < n; i++) expect((await admin("data/insert", { shard, table: "messages", doc: { channel: i % 2 ? "odd" : "even", body: `message ${i}` } })).status).toBe(200);
}

describe("POST /api/_ember/sql", () => {
  it("runs a SELECT: columns, rows, rows read, nothing written", async () => {
    const shard = "sql:rows";
    await seed(shard, 3);
    const r = await sql(shard, "SELECT channel, body FROM messages ORDER BY _rowid");
    expect(r.status).toBe(200);
    expect(r.body.value).toMatchObject({
      columns: ["channel", "body"],
      rows: [
        ["even", "message 0"],
        ["odd", "message 1"],
        ["even", "message 2"],
      ],
      rowsWritten: 0,
      truncated: false,
      explain: false,
    });
    expect(r.body.value.rowsRead).toBeGreaterThanOrEqual(3);
    expect(r.body.value.ms).toBeTypeOf("number");
    // Parameters are bound, never spliced; the schema is readable.
    const p = await sql(shard, "SELECT count(*) AS n FROM messages WHERE channel = ?", { params: ["odd"] });
    expect(p.body.value.rows).toEqual([[1]]);
    const named = await sql(shard, "SELECT body FROM messages WHERE channel = :c AND body LIKE ?2", { params: ["even", "%2"] });
    expect(named.body.value.rows).toEqual([["message 2"]]);
    const master = await sql(shard, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'");
    expect(master.body.value.rows).toEqual([["messages"]]);
    const cte = await sql(shard, "WITH x AS (SELECT channel FROM messages) SELECT channel, count(*) FROM x GROUP BY channel ORDER BY channel");
    expect(cte.body.value.rows).toEqual([
      ["even", 2],
      ["odd", 1],
    ]);
  });

  it("caps the rows (default 500, limit up to 5000) and says the result was cut", async () => {
    const shard = "sql:cap";
    await seed(shard, 5);
    const r = await sql(shard, "SELECT _id FROM messages", { limit: 2 });
    expect(r.body.value).toMatchObject({ truncated: true });
    expect(r.body.value.rows).toHaveLength(2);
    expect((await sql(shard, "SELECT _id FROM messages", { limit: 5 })).body.value.truncated).toBe(false);
    const series = await sql(shard, "WITH RECURSIVE c(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM c WHERE n < 800) SELECT n FROM c");
    expect([series.body.value.rows.length, series.body.value.truncated]).toEqual([500, true]);
    for (const limit of [0, 5001, 1.5, "10"]) expect((await sql(shard, "SELECT 1", { limit })).status).toBe(400);
  });

  it("explain: EXPLAIN QUERY PLAN as a tree, by flag or in the text", async () => {
    const shard = "sql:plan";
    await seed(shard, 2);
    const r = await sql(shard, "SELECT * FROM messages WHERE _id = ?", { explain: true, params: ["x"] });
    expect(r.status).toBe(200);
    expect(r.body.value.explain).toBe(true);
    expect(r.body.value.columns).toEqual(["id", "parent", "notused", "detail"]);
    expect(r.body.value.plan.length).toBeGreaterThan(0);
    expect(r.body.value.plan[0].detail).toMatch(/SEARCH|SCAN/);
    const t = await sql(shard, "EXPLAIN QUERY PLAN SELECT channel FROM messages ORDER BY body");
    expect(t.body.value.explain).toBe(true);
    expect(JSON.stringify(t.body.value.plan)).toMatch(/SCAN/);
  });

  it("refuses writes, chained statements and internal tables before the shard; the data stays", async () => {
    const shard = "sql:guard";
    await seed(shard, 2);
    for (const text of [
      "DELETE FROM messages",
      "SELECT 1; DROP TABLE messages",
      "WITH x AS (SELECT 1) DELETE FROM messages",
      "PRAGMA writable_schema = 1",
      "ATTACH DATABASE ':memory:' AS x",
      "EXPLAIN SELECT 1",
      "SELECT * FROM _cf_KV",
      "SELECT * FROM sqlite_sequence",
      "SELECT load_extension('x')",
      // SQLite reads these differently from a plain tokenizer (BOM = whitespace, Tcl-style parameter, NUL).
      "SELECT * FROM \uFEFF_cf_KV",
      "WITH x AS (SELECT 1) \uFEFFDELETE FROM messages",
      "SELECT $a('x) , * FROM sqlite_sequence --')",
      "SELECT 1 -- \u0000\nDELETE FROM messages",
      // A 'string' where only a name fits is a name to SQLite.
      "SELECT * FROM '_cf_KV'",
      "SELECT * FROM messages, 'sqlite_sequence'",
    ]) {
      const r = await sql(shard, text);
      expect([text, r.status, r.body.error.code]).toEqual([text, 400, "SqlRefused"]);
    }
    expect((await sql(shard, "SELECT count(*) FROM messages")).body.value.rows).toEqual([[2]]);
    // A leading BOM is whitespace, as SQLite has it.
    expect((await sql(shard, "\uFEFFSELECT 7")).body.value.rows).toEqual([[7]]);
    // Strings with ; and DROP are data.
    const s = await sql(shard, "SELECT 'x; DROP TABLE messages' AS s, \"body\" FROM messages LIMIT 1");
    expect(s.body.value.rows[0][0]).toBe("x; DROP TABLE messages");
    // SQLite's own errors are the caller's (400 SqlError), not the endpoint's.
    const bad = await sql(shard, "SELECT * FROM no_such_table");
    expect([bad.status, bad.body.error.code]).toEqual([400, "SqlError"]);
    expect(bad.body.error.message).toMatch(/no such table/);
  });

  it("schema pragmas as table-valued functions are allowed (and served by DO SQLite); other pragma functions are not", async () => {
    const shard = "sql:pragma";
    await seed(shard, 1);
    const r = await sql(shard, "SELECT name FROM pragma_table_info('messages') ORDER BY cid");
    expect(r.status).toBe(200);
    expect(r.body.value.rows.map((x: string[]) => x[0])).toEqual(expect.arrayContaining(["_id", "channel", "body", "_json"]));
    expect((await sql(shard, "SELECT * FROM pragma_database_list")).body.error.code).toBe("SqlRefused");
  });

  it("validates the body and needs the admin token", async () => {
    expect((await admin("sql", { shard: "sql:x", sql: "SELECT 1" }, null)).status).toBe(401);
    expect((await admin("sql")).status).toBe(405);
    expect((await admin("sql", { shard: "no colon", sql: "SELECT 1" })).status).toBe(400);
    expect((await admin("sql", { shard: "sql:x" })).status).toBe(400);
    expect((await admin("sql", { shard: "sql:x", sql: "SELECT ?", params: [{ a: 1 }] })).status).toBe(400);
    expect((await admin("sql", { shard: "sql:x", sql: "SELECT ?", params: "x" })).status).toBe(400);
    expect((await admin("sql", { shard: "sql:x", sql: "SELECT 1", explain: "yes" })).status).toBe(400);
    expect((await admin("sql", { shard: "sql:x", sql: `SELECT '${"x".repeat(100_001)}'` })).status).toBe(413);
    // Without content-length (a chunked body) the cap holds too: the body is bounded while it is read.
    const big = JSON.stringify({ shard: "sql:x", sql: "SELECT 1", params: ["x".repeat(400_001)] });
    const chunked = await SELF.fetch("http://ember/api/_ember/sql", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          for (let i = 0; i < big.length; i += 65_536) c.enqueue(new TextEncoder().encode(big.slice(i, i + 65_536)));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
    const ok = await admin("sql", { shard: "sql:x", sql: "SELECT ?, ?, ?", params: [true, null, 1.5] });
    expect(ok.body.value.rows).toEqual([[1, null, 1.5]]);
  });
});

describe("runReadOnlySql (defense in depth)", () => {
  /** A storage whose cursor claims it wrote: the answer is refused, and the transaction callback threw (no commit). */
  it("a cursor that wrote is refused and its transaction aborted", () => {
    let committed = false;
    let aborted = false;
    const storage = {
      transactionSync<T>(fn: () => T): T {
        try {
          const r = fn();
          committed = true;
          return r;
        } catch (e) {
          aborted = true;
          throw e;
        }
      },
      sql: {
        exec: () => ({ columnNames: ["n"], raw: () => [[1]][Symbol.iterator](), rowsRead: 1, rowsWritten: 1 }),
      },
    } as unknown as Parameters<typeof runReadOnlySql>[0];
    const r = runReadOnlySql(storage, { sql: "SELECT 1" });
    expect(r).toMatchObject({ ok: false, code: "SqlWrote" });
    expect([committed, aborted]).toEqual([false, true]);
    // Even a good answer never commits.
    aborted = false;
    (storage.sql as unknown as { exec: () => unknown }).exec = () => ({ columnNames: ["n"], raw: () => [[1]][Symbol.iterator](), rowsRead: 1, rowsWritten: 0 });
    expect(runReadOnlySql(storage, { sql: "SELECT 1" })).toMatchObject({ ok: true, value: { rows: [[1]], rowsWritten: 0 } });
    expect([committed, aborted]).toEqual([false, true]);
    // The check runs here too: a write never reaches the storage.
    (storage.sql as unknown as { exec: () => unknown }).exec = () => {
      throw new Error("must not run");
    };
    expect(runReadOnlySql(storage, { sql: "DELETE FROM t" })).toMatchObject({ ok: false, code: "SqlRefused" });
  });
});
