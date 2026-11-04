import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, openSqlite, v } from "cfx";
import { introspect, planMigration } from "cfx/ddl";
import "../plugins/vector";

const ops = (plan: { steps: { op: string; risk: string }[] }) => plan.steps.map((s) => `${s.op}`);
const base = () => ({ title: v.string(), n: v.number() });

async function at(schemaV1: ReturnType<typeof defineSchema>, rows: Record<string, unknown>[] = []) {
  const sql = openSqlite();
  const { engine } = Engine.push(sql, schemaV1);
  for (const r of rows) {
    await engine.runMutation({ isRegistered: true, type: "mutation", visibility: "public", args: { kind: "object", fields: {} }, handler: (ctx: any) => ctx.db.insert("docs", r) } as any);
  }
  return sql;
}

describe("schema -> DDL", () => {
  test("typed columns for top-level scalars, _rest JSON for the rest, ambiguous optional+nullable goes to _rest", async () => {
    const sql = openSqlite();
    Engine.push(
      sql,
      defineSchema({
        docs: defineTable({
          s: v.string(), f: v.number(), i: v.int64(), b: v.boolean(), id: v.id("docs"), lit: v.union(v.literal("a"), v.literal("b")),
          nullable: v.union(v.string(), v.null()), optNullable: v.optional(v.union(v.string(), v.null())), opt: v.optional(v.string()),
          obj: v.object({ x: v.string() }), arr: v.array(v.string()), mixed: v.union(v.string(), v.number()),
        }),
      }),
    );
    const cols = Object.fromEntries([...introspect(sql).tables.get("docs")!.columns]);
    expect(cols).toEqual({
      _rowid: "INTEGER", _id: "TEXT", _creationTime: "REAL",
      s: "TEXT", f: "REAL", i: "INTEGER", b: "INTEGER", id: "TEXT", lit: "TEXT", nullable: "TEXT", opt: "TEXT", _rest: "TEXT",
    });
  });

  test("round trip of every value kind through columns and _rest", async () => {
    const sql = openSqlite();
    const { engine } = Engine.push(sql, defineSchema({
      docs: defineTable({
        i: v.int64(), b: v.boolean(), nul: v.union(v.string(), v.null()), on: v.optional(v.union(v.string(), v.null())),
        o: v.optional(v.string()), nested: v.object({ big: v.int64(), list: v.array(v.boolean()) }),
      }),
    }));
    const doc = { i: 2n ** 60n, b: false, nul: null, on: null, nested: { big: -5n, list: [true, false] } };
    const fn: any = { isRegistered: true, type: "mutation", args: { kind: "object", fields: {} }, handler: (ctx: any) => ctx.db.insert("docs", doc) };
    const { value: id } = await engine.runMutation(fn);
    const q: any = { isRegistered: true, type: "query", args: { kind: "object", fields: {} }, handler: (ctx: any) => ctx.db.get(id) };
    const { value } = await engine.runQuery(q);
    expect(value).toEqual({ _id: id, _creationTime: expect.any(Number), ...doc });
    expect("o" in (value as object)).toBe(false); // absent optional stays absent; `on: null` stays null
  });
});

describe("migration planning (sqlite introspection + stored schema)", () => {
  const v1 = defineSchema({ docs: defineTable(base()).index("by_n", ["n"]) });

  test("re-pushing the same schema is a no-op", async () => {
    const sql = await at(v1, [{ title: "a", n: 1 }]);
    expect(planMigration(sql, v1.export()).steps).toEqual([]);
  });

  test("add table", async () => {
    const sql = await at(v1);
    const plan = planMigration(sql, defineSchema({ docs: defineTable(base()).index("by_n", ["n"]), other: defineTable({ x: v.string() }) }).export());
    expect(ops(plan)).toEqual(["createTable", "createObject"]);
  });

  test("add / drop / change index", async () => {
    const sql = await at(v1, [{ title: "a", n: 1 }]);
    const v2 = defineSchema({ docs: defineTable(base()).index("by_n", ["n", "title"]).index("by_title", ["title"]) });
    const plan = planMigration(sql, v2.export());
    expect(plan.steps.map((s) => `${s.op}:${(s as any).name}:${s.risk}`)).toEqual([
      "dropObject:docs__by_n:safe", "createObject:docs__by_n:backfill", "createObject:docs__by_title:backfill",
    ]);
    const v3 = defineSchema({ docs: defineTable(base()) });
    expect(ops(planMigration(sql, v3.export()))).toEqual(["dropObject"]);
  });

  test("add optional nested field = no-op (lives in _rest, no data touched)", async () => {
    const sql = await at(v1, [{ title: "a", n: 1 }]);
    const v2 = defineSchema({ docs: defineTable({ ...base(), tags: v.optional(v.array(v.string())) }).index("by_n", ["n"]) });
    const plan = planMigration(sql, v2.export());
    expect(plan.ok).toBe(true);
    expect(plan.steps.map((s) => s.op)).toEqual(["noop", "validateData"]);
    expect(plan.steps.every((s) => !("sql" in s))).toBe(true);
  });

  test("add optional scalar field = metadata-only ADD COLUMN", async () => {
    const sql = await at(v1, [{ title: "a", n: 1 }]);
    const v2 = defineSchema({ docs: defineTable({ ...base(), note: v.optional(v.string()) }).index("by_n", ["n"]) });
    const plan = planMigration(sql, v2.export());
    expect(plan.steps.map((s) => `${s.op}:${s.risk}`)).toEqual(["addColumn:safe", "validateData:validate"]);
  });

  test("add required field: fine on an empty table, refused with data", async () => {
    const v2 = defineSchema({ docs: defineTable({ ...base(), owner: v.string() }).index("by_n", ["n"]) });
    expect(planMigration(await at(v1), v2.export()).ok).toBe(true);
    const plan = planMigration(await at(v1, [{ title: "a", n: 1 }]), v2.export());
    expect(plan.ok).toBe(false);
    expect((plan.steps.find((s) => s.op === "fail") as any).reason).toMatch(/owner: Missing required field/);
  });

  test("change column type: rebuild when empty, refused with data (needs a data migration)", async () => {
    const v2 = defineSchema({ docs: defineTable({ title: v.string(), n: v.string() }).index("by_n", ["n"]) });
    expect(ops(planMigration(await at(v1), v2.export()))).toEqual(["rebuildTable"]);
    const sql = await at(v1, [{ title: "a", n: 1 }]);
    const plan = planMigration(sql, v2.export());
    expect(plan.ok).toBe(false);
    expect(() => Engine.push(sql, v2)).toThrow(/changes type REAL -> TEXT on 1 rows/);
  });

  test("type change inside _rest is caught by validating existing documents", async () => {
    const w1 = defineSchema({ docs: defineTable({ meta: v.object({ k: v.string() }) }) });
    const w2 = defineSchema({ docs: defineTable({ meta: v.object({ k: v.number() }) }) });
    const sql = await at(w1, [{ meta: { k: "x" } }]);
    const plan = planMigration(sql, w2.export());
    expect(plan.ok).toBe(false);
    expect((plan.steps[0] as any).reason).toMatch(/meta.k: Expected number/);
  });

  test("widening a field (string -> string | number) moves it to _rest, rewriting rows; data survives", async () => {
    const w1 = defineSchema({ docs: defineTable({ k: v.string() }).index("by_k", ["k"]) });
    const w2 = defineSchema({ docs: defineTable({ k: v.union(v.string(), v.number()) }).index("by_k", ["k"]) });
    const sql = await at(w1, [{ k: "x" }]);
    const plan = planMigration(sql, w2.export());
    expect(plan.steps.map((s) => `${s.op}:${s.risk}`)).toEqual(["dropObject:safe", "moveField:backfill", "validateData:validate", "createObject:backfill"]);
    const { engine } = Engine.push(sql, w2);
    const { value } = await engine.runQuery({ isRegistered: true, type: "query", args: { kind: "object", fields: {} }, handler: (ctx: any) => ctx.db.query("docs").withIndex("by_k", (q: any) => q.eq("k", "x")).collect() } as any);
    expect((value as any[]).map((d) => d.k)).toEqual(["x"]);
  });

  test("new search index on existing rows is backfilled", async () => {
    const sql = await at(v1, [{ title: "hello world", n: 1 }, { title: "bye", n: 2 }]);
    const v2 = defineSchema({ docs: defineTable(base()).index("by_n", ["n"]).searchIndex("s", { searchField: "title" }) });
    const { engine, plan } = Engine.push(sql, v2);
    expect(plan.steps.find((s) => (s as any).name === "docs__s")!.risk).toBe("backfill");
    const { value } = await engine.runQuery({ isRegistered: true, type: "query", args: { kind: "object", fields: {} }, handler: (ctx: any) => ctx.db.query("docs").withSearchIndex("s", (q: any) => q.search("title", "hello")).collect() } as any);
    expect((value as any[]).map((d) => d.title)).toEqual(["hello world"]);
  });

  test("removing a table keeps its data (orphan), removing a field with data is refused", async () => {
    const sql = await at(v1, [{ title: "a", n: 1 }]);
    expect(ops(planMigration(sql, defineSchema({}).export()))).toEqual(["keepOrphanTable"]);
    const plan = planMigration(sql, defineSchema({ docs: defineTable({ n: v.number() }).index("by_n", ["n"]) }).export());
    expect(plan.ok).toBe(false);
    expect(plan.steps.some((s) => s.op === "fail" && /title was removed/.test((s as any).reason))).toBe(true);
  });
});
