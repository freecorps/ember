import { describe, expect, test } from "vitest";
import { createEngine, defineSchema, defineTable, internalMutationGeneric, v } from "../src/index.ts";
import { createNodeSqliteDriver } from "../src/testing.ts";

const privateSql = {
  tables: ["ledger"],
  ddl: [
    "create table if not exists ledger (key text primary key, n integer not null) without rowid",
    "create index if not exists ledger_n on ledger (n)",
  ],
};

const schema = defineSchema({ tables: { notes: defineTable({ text: v.string() }) }, privateSql });

const bump = internalMutationGeneric({
  args: { key: v.string(), fail: v.optional(v.boolean()) },
  handler: (ctx, { key, fail }: { key: string; fail?: boolean }) => {
    ctx.sql.exec(
      "insert into ledger (key, n) values (?, 1) on conflict (key) do update set n = n + 1",
      key,
    );
    ctx.db.insert("notes", { text: key });
    if (fail) throw new Error("boom");
    return ctx.sql.exec("select n from ledger where key = ?", key)[0]!.n;
  },
});

const nested = internalMutationGeneric({
  args: {},
  handler: (ctx) => {
    ctx.sql.exec("insert into ledger (key, n) values ('kept', 1)");
    try {
      ctx.sql.transaction(() => {
        ctx.sql.exec("insert into ledger (key, n) values ('undone', 1)");
        ctx.db.insert("notes", { text: "undone" });
        ctx.scheduler.runAfter(1000, "t:bump", { key: "never" });
        throw new Error("inner");
      });
    } catch {
      // the savepoint rolled back
    }
    return ctx.sql.exec("select key from ledger order by key").map((row) => row.key);
  },
});

const sneaky = internalMutationGeneric({
  args: { statement: v.string() },
  handler: (ctx, { statement }: { statement: string }) => ctx.sql.exec(statement),
});

function engine(s = schema) {
  const e = createEngine({ schema: s, driver: createNodeSqliteDriver(), functions: { t: { bump, nested, sneaky } } });
  e.migrate();
  return e;
}

describe("ctx.sql (private SQL tables)", () => {
  test("reads and writes in the mutation's transaction, and rolls back with it", () => {
    const e = engine();
    expect(e.runMutation("t:bump", { key: "a" }).value).toBe(1);
    expect(e.runMutation("t:bump", { key: "a" }).value).toBe(2);
    expect(() => e.runMutation("t:bump", { key: "a", fail: true })).toThrow("boom");
    expect(e.runMutation("t:bump", { key: "a" }).value).toBe(3);
  });

  test("migrate runs the DDL again without harm", () => {
    const e = engine();
    e.runMutation("t:bump", { key: "a" });
    e.migrate();
    expect(e.runMutation("t:bump", { key: "a" }).value).toBe(2);
  });

  test("transaction is a savepoint: private rows, documents and scheduled jobs are undone", () => {
    const e = engine();
    const out = e.runMutation("t:nested", {});
    expect(out.value).toEqual(["kept"]);
    expect(out.changes).toEqual([]);
    expect(out.scheduled).toEqual([]);
  });

  test("refuses anything but one statement over the private tables", () => {
    const e = engine();
    for (const statement of [
      "select * from notes",
      'select * from "notes"',
      "select * from NOTES",
      "select * from _jobs",
      "select sql from sqlite_master",
      "select * from pragma_table_info('notes')",
      "pragma table_info(ledger)",
      "attach database 'x' as y",
      "delete from ledger where key in (select _id from notes)",
      "select 1 from ledger; delete from notes",
      "select * from ledger, notes",
      "select * from ledger l join notes n on n._id = l.key",
      "select * from 'notes'",
      "insert into 'notes' (text) values ('x')",
      "with notes as (select key from ledger) select * from notes",
    ]) {
      expect(() => e.runMutation("t:sneaky", { statement }), statement).toThrow(/refused/);
    }
  });

  test("allows joins, CTEs, upserts, and any word inside literals and comments", () => {
    const e = engine();
    for (const statement of [
      "insert into ledger (key, n) values ('from notes', 1) on conflict (key) do update set n = n + 1",
      "select a.key from ledger a join ledger b on a.key = b.key -- from notes",
      "with recent as (select key from ledger where n > 0) select key from recent",
      "select min(n) as n from ledger /* join notes */",
      'update "LEDGER" set n = 2 where key = \'a\'',
    ]) {
      expect(() => e.runMutation("t:sneaky", { statement }), statement).not.toThrow();
    }
  });

  test("needs privateSql in the schema", () => {
    const plain = defineSchema({ tables: { notes: defineTable({ text: v.string() }) } });
    const e = createEngine({ schema: plain, driver: createNodeSqliteDriver(), functions: { t: { sneaky } } });
    e.migrate();
    expect(() => e.runMutation("t:sneaky", { statement: "select 1" })).toThrow(/needs defineSchema/);
  });

  test("schema checks: names and idempotent DDL", () => {
    const tables = { notes: defineTable({ text: v.string() }) };
    expect(() => defineSchema({ tables, privateSql: { tables: ["notes"], ddl: [] } })).toThrow(/also a schema table/);
    expect(() => defineSchema({ tables, privateSql: { tables: ["_x"], ddl: [] } })).toThrow(/Invalid private SQL/);
    expect(() =>
      defineSchema({ tables, privateSql: { tables: ["x"], ddl: ["create table x (a)"] } }),
    ).toThrow(/idempotent/);
    expect(() =>
      defineSchema({
        tables,
        privateSql: { tables: ["x"], ddl: ["create table if not exists x (a); delete from notes"] },
      }),
    ).toThrow(/one statement/);
    expect(() =>
      defineSchema({ tables, privateSql: { tables: ["x"], ddl: ["create table if not exists y (a)"] } }),
    ).toThrow(/declared private table/);
    expect(() =>
      defineSchema({
        tables,
        privateSql: { tables: ["x"], ddl: ["create table if not exists x as select * from notes"] },
      }),
    ).toThrow(/never copy a query/);
    expect(() =>
      defineSchema({ tables, privateSql: { tables: ["x"], ddl: ["create index if not exists i on notes (text)"] } }),
    ).toThrow(/declared private table/);
  });
});
