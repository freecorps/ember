import { describe, expect, test } from "vitest";
import type { GenericValidator } from "@freecorps/ember-values";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  compileSchema,
  createEngine,
  defineSchema,
  defineTable,
  introspect,
  mutationGeneric,
  v,
  type EmberError,
  type SchemaDefinition,
} from "../src/index.ts";

const users = <E extends Record<string, GenericValidator> = {}>(extra: E = {} as E) => ({ name: v.string(), ...extra });

function shard() {
  const driver = createNodeSqliteDriver();
  const open = (schema: SchemaDefinition<any, any>) => createEngine({ schema, driver });
  const insert = (schema: SchemaDefinition<any, any>, table: string, doc: Record<string, unknown>) =>
    open(schema).runMutation(mutationGeneric((ctx) => ctx.db.insert(table, doc)) as any).value as string;
  const sql = (s: string, ...p: any[]) => driver.exec(s, ...p).rows;
  const columns = (table: string) => Object.fromEntries(sql(`SELECT name, type FROM pragma_table_xinfo(?)`, table).map((r: any) => [r.name, r.type]));
  return { driver, open, insert, sql, columns };
}

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as EmberError).code === "MigrationRefused" ? (e as Error).message : `other: ${(e as Error).message}`;
  }
  return "applied";
};

describe("schema -> DDL", () => {
  test("STRICT table, typed scalar columns, _json, system and key columns, FTS5 + triggers", () => {
    const schema = defineSchema({
      tables: {
        t: defineTable({
          s: v.string(),
          n: v.number(),
          b: v.boolean(),
          i: v.int64(),
          raw: v.bytes(),
          o: v.optional(v.string()),
          on: v.optional(v.nullable(v.string())),
          nested: v.object({ x: v.number() }),
        })
          .index("by_s", ["s"])
          .searchIndex("search_s", { searchField: "s", filterFields: ["b"] }),
      },
    });
    const ddl = compileSchema(schema.manifest, schema.indexKinds).join("\n");
    expect(ddl).toContain(
      `CREATE TABLE "t" ("_rowid" INTEGER PRIMARY KEY, "_id" TEXT NOT NULL UNIQUE, "_creationTime" REAL NOT NULL, "s" TEXT, "n" REAL, "b" INTEGER, "i" TEXT, "raw" BLOB, "o" TEXT, "_json" TEXT NOT NULL DEFAULT '{}', "_k_by_creation_time" BLOB, "_k_by_s" BLOB) STRICT`,
    );
    expect(ddl).toContain(`CREATE INDEX "t__by_s" ON "t" ("_k_by_s")`);
    expect(ddl).toContain(`CREATE VIRTUAL TABLE "t__search_s" USING fts5("s", content='t', content_rowid='_rowid', tokenize='unicode61 remove_diacritics 2')`);
    expect(ddl).toMatch(/CREATE TRIGGER "t__search_s__au" AFTER UPDATE OF "s" ON "t" WHEN NOT EXISTS/);
    expect(ddl).toContain(`"_ember_meta"`);
  });

  test("introspection ignores FTS shadow tables, _cf_* and other internal tables", () => {
    const s = shard();
    const schema = defineSchema({ tables: { docs: defineTable({ text: v.string() }).searchIndex("s", { searchField: "text" }) } });
    s.open(schema).migrate();
    s.sql(`CREATE TABLE "_cf_KV" (k TEXT)`);
    s.sql(`CREATE TABLE "_jobs" (id INTEGER PRIMARY KEY)`);
    const intro = introspect(s.driver);
    expect([...intro.tables.keys()]).toEqual(["docs"]);
    expect([...intro.tables.get("docs")!.objects.keys()].sort()).toEqual(
      // Compact storage: `by_creation_time` is the primary key, no SQLite index.
      ["docs__s", "docs__s__ad", "docs__s__ai", "docs__s__au"].sort(),
    );
    expect(intro.tables.get("docs")!.storage).toEqual({ compact: true, legacy: false });
    expect(intro.stored?.version).toBe(schema.manifest.version);
  });
});

describe("migrate", () => {
  test("first boot creates everything; re-running is a no-op", () => {
    const s = shard();
    const schema = defineSchema({ tables: { users: defineTable(users()).index("by_name", ["name"]) } });
    const r1 = s.open(schema).migrate();
    expect(r1).toMatchObject({ changed: true, fromVersion: null, toVersion: schema.manifest.version });
    expect(r1.steps.map((x) => x.op)).toEqual(["createTable"]);
    expect(s.open(schema).migrate()).toMatchObject({ changed: false, steps: [] });
    // A fresh plan against the migrated database is empty (DDL text is stable).
    expect(s.open(schema).planMigration().steps).toEqual([]);
  });

  test("new optional fields: _json -> noop, scalar -> ADD COLUMN", () => {
    const s = shard();
    const v1 = defineSchema({ tables: { users: defineTable(users()) } });
    s.open(v1).migrate();
    s.insert(v1, "users", { name: "a" });
    const v2 = defineSchema({ tables: { users: defineTable(users({ age: v.optional(v.number()), tags: v.optional(v.array(v.string())) })) } });
    const r = s.open(v2).migrate();
    expect(r.steps.map((x) => [x.op, (x as any).field])).toEqual([
      ["addColumn", "age"],
      ["noop", "tags"],
    ]);
    expect(s.columns("users").age).toBe("REAL");
    const id = s.insert(v2, "users", { name: "b", age: 3, tags: ["x"] });
    const got = s.open(v2).runMutation(mutationGeneric((ctx) => ctx.db.get(id as any)) as any).value;
    expect(got).toMatchObject({ name: "b", age: 3, tags: ["x"] });
  });

  test("required field / type change: refused with data, applied on an empty table", () => {
    const s = shard();
    const v1 = defineSchema({ tables: { users: defineTable(users()), empty: defineTable({ x: v.string() }) } });
    s.open(v1).migrate();
    s.insert(v1, "users", { name: "a" });
    const required = defineSchema({ tables: { users: defineTable(users({ age: v.number() })), empty: defineTable({ x: v.string() }) } });
    expect(refused(() => s.open(required).migrate())).toMatch(/new required field age/);
    const retyped = defineSchema({ tables: { users: defineTable({ name: v.number() }), empty: defineTable({ x: v.number(), y: v.string() }) } });
    expect(refused(() => s.open(retyped).migrate())).toMatch(/users: field name changes type/);
    // Same changes on the empty table go through.
    const ok = defineSchema({ tables: { users: defineTable(users()), empty: defineTable({ x: v.number(), y: v.string() }) } });
    const r = s.open(ok).migrate();
    expect(r.steps.map((x) => x.op)).toEqual(["rebuildTable"]);
    expect(s.columns("empty")).toMatchObject({ x: "REAL", y: "TEXT" });
    // Nothing was half-applied by the refused attempts.
    expect(s.columns("users").age).toBeUndefined();
  });

  test("required -> optional is allowed; removed fields need the data gone", () => {
    const s = shard();
    const v1 = defineSchema({ tables: { users: defineTable(users({ age: v.number(), tag: v.optional(v.array(v.string())) })) } });
    s.open(v1).migrate();
    const id = s.insert(v1, "users", { name: "a", age: 1, tag: ["x"] });
    const relaxed = defineSchema({ tables: { users: defineTable(users({ age: v.optional(v.number()), tag: v.optional(v.array(v.string())) })) } });
    expect(s.open(relaxed).migrate().steps.map((x) => x.op)).toEqual(["noop"]);
    const dropped = defineSchema({ tables: { users: defineTable(users()) } });
    expect(refused(() => s.open(dropped).migrate())).toMatch(/field age was removed/);
    s.open(relaxed).runMutation(mutationGeneric((ctx) => ctx.db.patch(id as any, { age: undefined, tag: undefined })) as any);
    const r = s.open(dropped).migrate();
    expect(r.steps.map((x) => [x.op, (x as any).field])).toEqual([
      ["dropColumn", "age"],
      ["noop", "tag"],
    ]);
    expect(s.columns("users").age).toBeUndefined();
  });

  test("removed table is kept", () => {
    const s = shard();
    s.open(defineSchema({ tables: { a: defineTable({ x: v.string() }), b: defineTable({ y: v.string() }) } })).migrate();
    const r = s.open(defineSchema({ tables: { a: defineTable({ x: v.string() }) } })).migrate();
    expect(r.steps).toEqual([{ op: "keepTable", table: "b", reason: expect.any(String) }]);
    expect(s.sql(`SELECT name FROM sqlite_master WHERE name = 'b'`)).toHaveLength(1);
  });
});

describe("staged indexes", () => {
  test("new db index on a table with data: staged, not queryable until backfilled in chunks", () => {
    const s = shard();
    const v1 = defineSchema({ tables: { users: defineTable(users({ n: v.number() })) } });
    s.open(v1).migrate();
    for (let i = 0; i < 25; i++) s.insert(v1, "users", { name: `u${i % 5}`, n: i });
    const v2 = defineSchema({ tables: { users: defineTable(users({ n: v.number() })).index("by_name", ["name"]) } });
    const engine = s.open(v2);
    const report = engine.migrate();
    expect(report.steps).toEqual([expect.objectContaining({ op: "createIndex", index: "by_name", staged: true })]);
    expect(report.staged).toEqual([{ table: "users", index: "by_name", kind: "db" }]);
    const q = mutationGeneric((ctx) => ctx.db.query("users").withIndex("by_name", (r: any) => r.eq("name", "u1")).collect().map((d: any) => d.n));
    expect(() => engine.runMutation(q as any)).toThrow(/still backfilling/);
    // Writes during the backfill keep the key current.
    engine.runMutation(mutationGeneric((ctx) => ctx.db.insert("users", { name: "u1", n: 100 })) as any);
    const steps = [];
    for (let i = 0; i < 10; i++) {
      const p = engine.backfillStep(10);
      steps.push(p.processed);
      if (p.done) break;
    }
    expect(steps).toEqual([10, 10, 5]);
    expect((engine.runMutation(q as any).value as number[]).sort((a, b) => a - b)).toEqual([1, 6, 11, 16, 21, 100]);
    expect(s.open(v2).migrate()).toMatchObject({ changed: false, staged: [] });
  });

  test("index on an empty table is ready at once; changed fields rebuild; removed index is dropped", () => {
    const s = shard();
    const v1 = defineSchema({ tables: { users: defineTable(users({ n: v.number() })).index("by_x", ["name"]) } });
    expect(s.open(v1).migrate().staged).toEqual([]);
    s.insert(v1, "users", { name: "a", n: 1 });
    const v2 = defineSchema({ tables: { users: defineTable(users({ n: v.number() })).index("by_x", ["n"]) } });
    const r = s.open(v2).migrate();
    expect(r.steps.map((x) => x.op)).toEqual(["dropIndex", "createIndex"]);
    expect(r.staged).toHaveLength(1);
    const v3 = defineSchema({ tables: { users: defineTable(users({ n: v.number() })) } });
    const r3 = s.open(v3).migrate();
    expect(r3.steps.map((x) => x.op)).toEqual(["dropIndex"]);
    expect(r3.staged).toEqual([]);
    expect(s.columns("users")._k_by_x).toBeUndefined();
    expect(s.sql(`SELECT name FROM sqlite_master WHERE name = 'users__by_x'`)).toEqual([]);
  });

  test("staged FTS backfill: triggers skip the unbackfilled window, so updates/deletes cannot corrupt it", () => {
    const s = shard();
    const v1 = defineSchema({ tables: { docs: defineTable({ text: v.string() }) } });
    s.open(v1).migrate();
    const ids = Array.from({ length: 30 }, (_, i) => s.insert(v1, "docs", { text: `word${i} common` }));
    const v2 = defineSchema({ tables: { docs: defineTable({ text: v.string() }).searchIndex("s", { searchField: "text" }) } });
    const engine = s.open(v2);
    expect(engine.migrate().staged).toEqual([{ table: "docs", index: "s", kind: "search" }]);
    const search = (text: string) =>
      engine.runMutation(mutationGeneric((ctx) => (ctx.db.query("docs") as any).withSearchIndex("s", (q: any) => q.search("text", text)).collect().map((d: any) => d.text)) as any).value as string[];
    expect(() => search("common")).toThrow(/backfilling/);
    engine.backfillStep(10);
    // Edit rows on both sides of the cursor, delete one not yet backfilled, insert a new one.
    const edit = (id: string, text: string) => engine.runMutation(mutationGeneric((ctx) => ctx.db.patch(id as any, { text })) as any);
    edit(ids[2]!, "alpha common");
    edit(ids[20]!, "beta common");
    engine.runMutation(mutationGeneric((ctx) => ctx.db.delete(ids[25] as any)) as any);
    engine.runMutation(mutationGeneric((ctx) => ctx.db.insert("docs", { text: "fresh common" })) as any);
    while (!engine.backfillStep(10).done);
    expect(search("common")).toHaveLength(30);
    expect(search("alpha")).toEqual(["alpha common"]);
    expect(search("beta")).toEqual(["beta common"]);
    expect(search("word2").sort()).toEqual([21, 22, 23, 24, 26, 27, 28, 29].map((i) => `word${i} common`)); // 2 and 20 edited, 25 deleted
    expect(search("word25")).toEqual([]);
    expect(search("fresh")).toEqual(["fresh common"]);
    s.sql(`INSERT INTO "docs__s" ("docs__s") VALUES ('integrity-check')`);
  });

  test("staged FTS: editing a row FTS5 has never seen does not hit 'database disk image is malformed'", () => {
    const s = shard();
    const v1 = defineSchema({ tables: { docs: defineTable({ text: v.string() }) } });
    s.open(v1).migrate();
    const ids = Array.from({ length: 5 }, (_, i) => s.insert(v1, "docs", { text: `only${i}` }));
    const v2 = defineSchema({ tables: { docs: defineTable({ text: v.string() }).searchIndex("s", { searchField: "text" }) } });
    const engine = s.open(v2);
    engine.migrate();
    engine.runMutation(mutationGeneric((ctx) => ctx.db.patch(ids[3] as any, { text: "edited" })) as any);
    engine.runMutation(mutationGeneric((ctx) => ctx.db.delete(ids[4] as any)) as any);
    while (!engine.backfillStep(2).done);
    const all = engine.runMutation(
      mutationGeneric((ctx) => (ctx.db.query("docs") as any).withSearchIndex("s", (q: any) => q.search("text", "edited only0")).collect().map((d: any) => d.text)) as any,
    ).value;
    expect((all as string[]).sort()).toEqual(["edited", "only0"]);
    s.sql(`INSERT INTO "docs__s" ("docs__s") VALUES ('integrity-check')`);
  });
});
