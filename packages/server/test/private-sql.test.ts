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

  test("refuses schema tables and Ember's own", () => {
    const e = engine();
    for (const statement of [
      "select * from notes",
      'select * from "notes"',
      "select * from _jobs",
      "delete from ledger where key in (select _id from notes)",
    ]) {
      expect(() => e.runMutation("t:sneaky", { statement })).toThrow(/may not name/);
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
  });
});
