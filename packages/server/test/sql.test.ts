// ctx.db.sql: read-only, parameterized, typed SQL with table-level reactivity.

import { describe, expect, test } from "vitest";
import { compileSql, createMatchIndex, mutationGeneric, queryGeneric, v, type DataModelFromSchema, type QueryCtx } from "../src/index.ts";
import { fresh, schema, withUser } from "./fixtures.ts";

const Q = (handler: (db: any) => unknown) => queryGeneric({ handler: (ctx: QueryCtx) => handler(ctx.db) }) as any;
const TABLES = ["users", "messages"];
const check = (strings: TemplateStringsArray, ...values: unknown[]) => compileSql(strings, values, TABLES);

function setup() {
  const env = fresh();
  const ada = withUser(env);
  const bob = env.insert("users", { name: "Bob", email: "bob@x.dev", admin: true });
  const msg = (channel: string, author: string, likes: number, body = "hi") => env.insert("messages", { channel, author, body, likes });
  msg("a", ada, 1);
  msg("a", bob, 5);
  msg("b", ada, 2);
  msg("b", ada, 7, "hello");
  return { ...env, ada, bob, msg };
}

describe("ctx.db.sql: results", () => {
  test("JOIN + GROUP BY + parameters, rows typed and coerced by a validator", () => {
    const s = setup();
    const row = v.object({ name: v.string(), admin: v.boolean(), n: v.number(), likes: v.number() });
    const r = s.run((db: any) =>
      db.sql(row)`
        SELECT u.name, u.admin, count(*) AS n, sum(m.likes) AS likes
        FROM messages m JOIN users AS u ON u._id = m.author
        WHERE m.likes >= ${2}
        GROUP BY u._id ORDER BY u.name`,
    );
    expect(r.value).toEqual([
      { name: "Ada", admin: false, n: 2, likes: 9 },
      { name: "Bob", admin: true, n: 1, likes: 5 },
    ]);
  });

  test("untyped rows, CTEs, subqueries, comma joins, json_each, sql.id()", () => {
    const s = setup();
    const untyped = s.run((db: any) => db.sql`SELECT channel, max(likes) AS top FROM messages GROUP BY channel ORDER BY channel`).value;
    expect(untyped).toEqual([{ channel: "a", top: 5 }, { channel: "b", top: 7 }]);
    const cte = s.run(
      (db: any) => db.sql`WITH busy AS (SELECT author, count(*) AS c FROM messages GROUP BY author) SELECT u.name, b.c FROM busy b, users u WHERE u._id = b.author ORDER BY b.c DESC`,
    ).value;
    expect(cte).toEqual([{ name: "Ada", c: 3 }, { name: "Bob", c: 1 }]);
    const sub = s.run((db: any) => db.sql`SELECT name FROM users WHERE _id IN (SELECT author FROM messages WHERE body = ${"hello"})`).value;
    expect(sub).toEqual([{ name: "Ada" }]);
    const je = s.run((db: any) => db.sql`SELECT value FROM json_each(${JSON.stringify([3, 1, 2])}) ORDER BY value`).value;
    expect(je).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    const col = s.run((db: any) => db.sql`SELECT ${db.sql.id("email")} AS e FROM users ORDER BY 1`).value;
    expect(col).toEqual([{ e: "ada@x.dev" }, { e: "bob@x.dev" }]);
  });

  test("a row that does not match the validator is a ValidationError", () => {
    const s = setup();
    expect(() => s.run((db: any) => db.sql(v.object({ name: v.number() }))`SELECT name FROM users`)).toThrow(/does not match the validator/);
  });

  test("rowsRead counts against the 16k limit", () => {
    const s = fresh({ limits: { rowsRead: 50 } });
    const ada = withUser(s);
    s.tx((db) => {
      for (let i = 0; i < 60; i++) db.insert("messages", { channel: "a", author: ada, body: "x", likes: i } as any);
    });
    expect(() => s.run((db: any) => db.sql`SELECT _id FROM messages`)).toThrow(/Too many rows read/);
  });

  test("works in mutations too (read-only)", () => {
    const s = setup();
    const r = s.engine.runMutation(mutationGeneric((ctx: any) => ctx.db.sql`SELECT count(*) AS n FROM messages`[0].n) as any);
    expect(r.value).toBe(4);
  });
});

describe("ctx.db.sql: only one read-only SELECT over schema tables", () => {
  const rejects = (fn: () => unknown, re: RegExp) => expect(fn).toThrow(re);

  test.each([
    ["DELETE FROM messages", /only SELECT/],
    ["UPDATE users SET admin = 1", /only SELECT/],
    ["PRAGMA table_info(users)", /only SELECT/],
    ["ATTACH DATABASE 'x' AS y", /only SELECT/],
    ["SELECT 1; DELETE FROM users", /one statement/],
    ["WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x", /DELETE is not allowed/],
    ["SELECT * FROM users WHERE 1 = 1 /* ; */ ; ; ", null],
    ["SELECT * FROM _files", /unknown table/],
    ["SELECT * FROM sqlite_master", /unknown table/],
    [`SELECT * FROM "messages__search_body"`, /unknown table/],
    ["SELECT * FROM users u JOIN _ember_meta m", /unknown table/],
    ["SELECT * FROM users, _jobs", /unknown table/],
    ["SELECT (SELECT value FROM _ember_meta) FROM users", /unknown table/],
    ["SELECT * FROM main.users", /schema-qualified/],
    ["SELECT * FROM pragma_table_info('users')", /not allowed/],
    ["SELECT * FROM generate_series(1, 3)", /table-valued function/],
    ["SELECT pragma_table_info('users') FROM users", /not allowed/],
    ["SELECT load_extension('x')", /not allowed/],
    ["SELECT * FROM users WHERE name = ?", /template values/],
    ["SELECT * FROM users WHERE name = :name", /parameters are template values/],
    ["SELECT 'unterminated FROM users", /unterminated/],
    ["SELECT * FROM", /expected a table/],
    ["REPLACE INTO users VALUES (1)", /only SELECT/],
    ["SELECT * FROM nope", /unknown table/],
  ])("%s", (sql, re) => {
    const strings = Object.assign([sql], { raw: [sql] }) as unknown as TemplateStringsArray;
    if (re) rejects(() => check(strings), re);
    else expect(check(strings).tables).toEqual(["users"]);
  });

  test("keywords inside literals and quoted identifiers are data; replace() the function is fine", () => {
    expect(check`SELECT 'DELETE FROM x; PRAGMA' AS "insert", replace(name, 'a', 'b') FROM users`.tables).toEqual(["users"]);
    expect(check`SELECT * FROM USERS`.tables).toEqual(["users"]);
    expect(check`SELECT a IS NOT DISTINCT FROM b FROM messages`.tables).toEqual(["messages"]);
    expect(check`SELECT * FROM (users JOIN messages ON 1)`.tables.sort()).toEqual(["messages", "users"]);
  });

  test("values are bound, never spliced; a value inside a literal is refused", () => {
    const evil = "x'); DROP TABLE users; --";
    const c = check`SELECT * FROM users WHERE name = ${evil} AND admin = ${true} AND _creationTime > ${10n}`;
    expect(c.sql).toBe("SELECT * FROM users WHERE name = ? AND admin = ? AND _creationTime > ?");
    expect(c.params).toEqual([evil, 1, "10"]);
    expect(() => check`SELECT * FROM users WHERE name = '${"a"}'`).toThrow(/whole SQL values/);
    expect(() => check`SELECT * FROM users WHERE name = ${{ a: 1 }}`).toThrow(/unsupported parameter/);
  });

  test("sql.id() only accepts plain identifiers", () => {
    const s = setup();
    expect(() => s.run((db: any) => db.sql`SELECT ${db.sql.id('name" FROM _files --')} FROM users`)).toThrow(/invalid identifier/);
    // an identifier cannot smuggle in a table: it is quoted and still checked against the schema
    expect(() => s.run((db: any) => db.sql`SELECT * FROM ${db.sql.id("_files")}`)).toThrow(/unknown table/);
  });
});

describe("ctx.db.sql: reactivity is table-level", () => {
  test("any write to a referenced table invalidates; others do not", () => {
    const s = setup();
    const joined = Q((db: any) => db.sql`SELECT u.name, count(*) AS n FROM messages m JOIN users u ON u._id = m.author GROUP BY u._id`);
    const onlyUsers = Q((db: any) => db.sql`SELECT count(*) AS n FROM users`);
    const subs = { joined: s.engine.runQuery(joined), onlyUsers: s.engine.runQuery(onlyUsers) };
    expect(subs.joined.readSet.map((e: any) => e.table).sort()).toEqual(["messages", "users"]);
    const index = createMatchIndex<string>(schema);
    for (const [k, r] of Object.entries(subs)) index.set(k, r.readSet);
    const hits = (changes: any[]) => {
      const byEngine = Object.entries(subs)
        .filter(([, r]) => s.engine.matches(r.readSet, changes))
        .map(([k]) => k)
        .sort();
      expect([...index.match(changes).exact].sort()).toEqual(byEngine);
      return byEngine;
    };
    expect(hits(s.tx((db) => db.insert("messages", { channel: "z", author: s.bob, body: "x", likes: 0 } as any)).changes)).toEqual(["joined"]);
    expect(hits(s.patch(s.ada, { name: "Ada L." }).changes)).toEqual(["joined", "onlyUsers"]);
    // and the re-run sees the write
    expect(s.engine.runQuery(joined).value).toContainEqual({ name: "Ada L.", n: 3 });
  });

  test("`touched` records the tables even when the query fails afterwards", () => {
    const s = setup();
    const touched = new Set<string>();
    expect(() =>
      s.engine.runQuery(
        Q((db: any) => {
          db.sql`SELECT 1 FROM messages`;
          throw new Error("boom");
        }),
        {},
        undefined,
        { touched },
      ),
    ).toThrow("boom");
    expect([...touched]).toEqual(["messages"]);
  });
});

describe("ctx.db.increment", () => {
  test("adds to number / int64 fields without reading in user code; type errors are refused", () => {
    const s = setup();
    const id = s.msg("c", s.ada, 10);
    expect(s.tx((db) => db.increment(id as any, "likes" as any, 5)).value).toBe(15);
    expect(s.tx((db) => db.increment(id as any, "likes" as any, -20)).value).toBe(-5);
    expect(() => s.tx((db) => db.increment(id as any, "body" as any, 1))).toThrow(/not a number/);
    expect(() => s.tx((db) => db.increment(id as any, "likes" as any, 1n as any))).toThrow(/not an int64/);
    expect(() => s.tx((db) => db.increment(id as any, "_creationTime" as any, 1))).toThrow(/non-system/);
    expect(() => s.tx((db) => db.increment(id as any, "likes" as any, NaN))).toThrow(/finite/);
    const r = s.tx((db) => db.increment(id as any, "likes" as any, 1));
    expect(r.changes).toEqual([expect.objectContaining({ table: "messages", before: expect.objectContaining({ likes: -5 }), after: expect.objectContaining({ likes: -4 }) })]);
  });
});

// Static types (checked by tsc).
type DM = DataModelFromSchema<typeof schema>;
export function typed(ctx: QueryCtx<DM>, mctx: import("../src/index.ts").MutationCtx<DM>, id: import("../src/index.ts").GenericId<"messages">) {
  const rows = ctx.db.sql(v.object({ n: v.number() }))`SELECT count(*) AS n FROM users`;
  const n: number = rows[0]!.n;
  const u: unknown[] = ctx.db.sql`SELECT 1`;
  const likes: number = mctx.db.increment(id, "likes", 1);
  // @ts-expect-error not numeric
  mctx.db.increment(id, "body", 1);
  return [n, u, likes];
}
