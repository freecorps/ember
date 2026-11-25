// Sparse db indexes (`.index(name, fields, { sparse: true })`): DDL (SQLite partial index), the key column on every
// write path (NULL while a field is absent), queries, read-set matching and the migrations that turn it on and off.

import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  compileSchema,
  createEngine,
  createMatchIndex,
  defineSchema,
  defineTable,
  localReadSetMatches,
  localSchema,
  mutationGeneric,
  overlayReader,
  prepareLocalDatabase,
  queryGeneric,
  runLocalMutation,
  runLocalQuery,
  sqlLocalReader,
  sqlReplicaWriter,
  v,
  type Doc,
  type QueryCtx,
  type ReadSet,
  type RowChange,
  type SchemaDefinition,
} from "../src/index.ts";
import { fresh } from "./fixtures.ts";

const fields = { name: v.string(), k: v.optional(v.string()), tag: v.optional(v.nullable(v.string())), n: v.optional(v.number()) };
const sparseSchema = defineSchema({
  tables: {
    items: defineTable(fields)
      .index("by_k", ["k"], { sparse: true })
      // Compound: in it only with both fields; `tag` may be null (null is present).
      .index("by_name_tag", ["name", "tag"], { sparse: true })
      .index("by_n", ["n"]),
  },
});

const Q = (handler: (db: any) => unknown) => queryGeneric({ handler: (ctx: QueryCtx) => handler(ctx.db) }) as any;

function env(schema: SchemaDefinition<any, any> = sparseSchema) {
  const e = fresh({ schema });
  const keyOf = (id: string, index: string) => e.sql(`SELECT "_k_${index}" AS k FROM items WHERE _id = ?`, id)[0]!.k;
  const names = (index: string, build?: (q: any) => unknown, order: "asc" | "desc" = "asc") =>
    (e.run((db) => db.query("items").withIndex(index, build).order(order).collect()).value as any[]).map((d) => d.name);
  return { ...e, keyOf, names };
}

describe("sparse index: schema and DDL", () => {
  test("a partial index on the key column, the flag in the manifest (absent when false)", () => {
    const ddl = compileSchema(sparseSchema.manifest, sparseSchema.indexKinds);
    expect(ddl).toContain(`CREATE INDEX "items__by_k" ON "items" ("_k_by_k") WHERE "_k_by_k" IS NOT NULL`);
    expect(ddl).toContain(`CREATE INDEX "items__by_n" ON "items" ("_k_by_n")`);
    expect(sparseSchema.manifest.tables.items!.indexes).toEqual([
      { kind: "db", name: "by_k", fields: ["k"], sparse: true },
      { kind: "db", name: "by_name_tag", fields: ["name", "tag"], sparse: true },
      { kind: "db", name: "by_n", fields: ["n"] },
    ]);
    // `{ sparse: false }` is the plain index: same manifest, same hash.
    const plain = defineSchema({ tables: { t: defineTable({ k: v.optional(v.string()) }).index("by_k", ["k"]) } });
    const off = defineSchema({ tables: { t: defineTable({ k: v.optional(v.string()) }).index("by_k", ["k"], { sparse: false }) } });
    expect(off.manifest.hash).toBe(plain.manifest.hash);
    expect(() => defineTable({ k: v.string() }).index("by_k", ["k"], { sparse: "yes" as never })).toThrow(/sparse must be a boolean/);
  });

  test("scans use the partial index (no table scan, no temp B-tree), with and without bounds", () => {
    const e = env();
    e.insert("items", { name: "a", k: "x" });
    for (const sql of [
      `SELECT * FROM "items" INDEXED BY "items__by_k" WHERE "_k_by_k" >= ? AND "_k_by_k" < ? ORDER BY "_k_by_k" ASC LIMIT ?`,
      `SELECT * FROM "items" INDEXED BY "items__by_k" WHERE "_k_by_k" >= ? AND "_k_by_k" < ? ORDER BY "_k_by_k" DESC LIMIT ?`,
    ]) {
      const plan = e.sql(`EXPLAIN QUERY PLAN ${sql}`, new Uint8Array(), Uint8Array.of(0xff), 10).map((r: any) => String(r.detail));
      expect(plan.join("\n")).toMatch(/USING (COVERING )?INDEX items__by_k/);
      expect(plan.join("\n")).not.toMatch(/TEMP B-TREE/);
    }
  });
});

describe("sparse index: key column on writes", () => {
  test("insert, patch, replace and delete alternating absent and present", () => {
    const e = env();
    const a = e.insert("items", { name: "a" });
    const b = e.insert("items", { name: "b", k: "kb", tag: null, n: 1 });
    // Absent: NULL key (not in the index); present: a key. A plain index keys the absent value too.
    expect(e.keyOf(a, "by_k")).toBeNull();
    expect(e.keyOf(a, "by_name_tag")).toBeNull();
    expect(e.keyOf(a, "by_n")).toBeInstanceOf(Uint8Array);
    expect(e.keyOf(b, "by_k")).toBeInstanceOf(Uint8Array);
    expect(e.keyOf(b, "by_name_tag")).toBeInstanceOf(Uint8Array); // null is present
    expect(e.names("by_k")).toEqual(["b"]);

    // absent -> present
    e.patch(a, { k: "ka" });
    expect(e.keyOf(a, "by_k")).toBeInstanceOf(Uint8Array);
    expect(e.names("by_k", (q) => q.eq("k", "ka"))).toEqual(["a"]);
    expect(e.names("by_k")).toEqual(["a", "b"]);
    // a patch of another field keeps it
    e.patch(a, { n: 5 });
    expect(e.names("by_k", (q) => q.eq("k", "ka"))).toEqual(["a"]);
    // present -> absent (patch with undefined removes the field)
    e.patch(a, { k: undefined });
    expect(e.keyOf(a, "by_k")).toBeNull();
    expect(e.names("by_k", (q) => q.eq("k", "ka"))).toEqual([]);
    expect(e.names("by_k")).toEqual(["b"]);
    // a patch of another field while absent leaves it out
    e.patch(a, { n: 6 });
    expect(e.keyOf(a, "by_k")).toBeNull();
    // replace: present, then absent
    e.tx((db) => db.replace(a as any, { name: "a", k: "kr" } as any));
    expect(e.names("by_k", (q) => q.eq("k", "kr"))).toEqual(["a"]);
    e.tx((db) => db.replace(b as any, { name: "b" } as any));
    expect(e.keyOf(b, "by_k")).toBeNull();
    expect(e.keyOf(b, "by_name_tag")).toBeNull();
    expect(e.names("by_k")).toEqual(["a"]);
    // compound: one field absent is enough to leave it out
    e.patch(a, { tag: "t" });
    expect(e.names("by_name_tag", (q) => q.eq("name", "a"))).toEqual(["a"]);
    e.patch(a, { tag: undefined });
    expect(e.names("by_name_tag", (q) => q.eq("name", "a"))).toEqual([]);
    // delete
    e.del(a);
    expect(e.names("by_k")).toEqual([]);
    expect(e.sql(`SELECT count(*) AS n FROM items`)[0]!.n).toBe(1);
  });

  test("a key field whose stored text may differ (NUL / U+FFFD) still enters and leaves the index", () => {
    // `keyOfBefore` refuses such strings: the stored key is read, and NULL there is "not in the index" for a sparse one.
    const schema = defineSchema({ tables: { items: defineTable({ name: v.string(), k: v.optional(v.string()) }).index("by_name_k", ["name", "k"], { sparse: true }) } });
    const e = env(schema);
    const id = e.insert("items", { name: "x�" });
    expect(e.keyOf(id, "by_name_k")).toBeNull();
    e.patch(id, { k: "1" });
    expect(e.names("by_name_k", (q) => q.eq("name", "x�").eq("k", "1"))).toEqual(["x�"]);
    e.patch(id, { k: undefined });
    expect(e.keyOf(id, "by_name_k")).toBeNull();
    e.patch(id, { k: "2" });
    expect(e.names("by_name_k", (q) => q.eq("name", "x�"))).toEqual(["x�"]);
  });

  test("queries: bounds on present values match a full index; a scan without bounds leaves absent documents out", () => {
    const e = env();
    const docs = [{ name: "a", k: "1" }, { name: "b" }, { name: "c", k: "2" }, { name: "d" }, { name: "e", k: "3" }];
    for (const d of docs) e.insert("items", d);
    expect(e.names("by_k")).toEqual(["a", "c", "e"]);
    expect(e.names("by_k", undefined, "desc")).toEqual(["e", "c", "a"]);
    expect(e.names("by_k", (q) => q.gte("k", "2"))).toEqual(["c", "e"]);
    expect(e.names("by_k", (q) => q.lt("k", "3"))).toEqual(["a", "c"]);
    // `undefined` sorts first: in a plain index `lt` would include b and d; never in a sparse one.
    expect(e.names("by_n", (q) => q.lt("n", 3))).toEqual(["a", "b", "c", "d", "e"]);
    expect(e.names("by_k", (q) => q.eq("k", undefined))).toEqual([]);
    // first / paginate on it
    expect((e.run((db) => db.query("items").withIndex("by_k").first()).value as any).name).toBe("a");
    const page = e.run((db) => db.query("items").withIndex("by_k").paginate({ numItems: 2, cursor: null })).value as any;
    expect(page.page.map((d: any) => d.name)).toEqual(["a", "c"]);
    const rest = e.run((db) => db.query("items").withIndex("by_k").paginate({ numItems: 2, cursor: page.continueCursor })).value as any;
    expect(rest.page.map((d: any) => d.name)).toEqual(["e"]);
  });

  test("inside a mutation: its own writes enter and leave the index (read cache)", () => {
    const e = env();
    const id = e.insert("items", { name: "a" });
    const r = e.tx((db) => {
      const before = db.query("items").withIndex("by_k").collect().length;
      db.patch(id as any, { k: "x" } as any);
      const during = db.query("items").withIndex("by_k", (q: any) => q.eq("k", "x")).collect().length;
      db.patch(id as any, { k: undefined } as any);
      const after = db.query("items").withIndex("by_k").collect().length;
      return [before, during, after];
    });
    expect(r.value).toEqual([0, 1, 0]);
  });
});

describe("sparse index: read sets", () => {
  test("engine.matches and the match index: entering and leaving invalidate, absent-to-absent does not", () => {
    const e = env();
    const id = e.insert("items", { name: "a" });
    const eqX = e.engine.runQuery(Q((db) => db.query("items").withIndex("by_k", (q: any) => q.eq("k", "x")).collect())).readSet as ReadSet;
    const all = e.engine.runQuery(Q((db) => db.query("items").withIndex("by_k").collect())).readSet as ReadSet;
    const index = createMatchIndex<string>(sparseSchema);
    index.set("eqX", eqX);
    index.set("all", all);
    const doc = (over: Record<string, unknown>) => ({ _id: id, _creationTime: 1, name: "a", ...over }) as any;
    const change = (before: Record<string, unknown> | null, after: Record<string, unknown> | null): RowChange[] => [
      { table: "items", id, before: before && doc(before), after: after && doc(after) },
    ];
    const both = (c: RowChange[]) => ({ eqX: e.engine.matches(eqX, c), all: e.engine.matches(all, c), index: [...index.match(c).exact].sort() });
    // enters with "x" / with "y"
    expect(both(change({}, { k: "x" }))).toEqual({ eqX: true, all: true, index: ["all", "eqX"] });
    expect(both(change({}, { k: "y" }))).toEqual({ eqX: false, all: true, index: ["all"] });
    // leaves
    expect(both(change({ k: "x" }, {}))).toEqual({ eqX: true, all: true, index: ["all", "eqX"] });
    // absent before and after (another field changes), an insert and a delete without the field: not in the index
    expect(both(change({ n: 1 }, { n: 2 }))).toEqual({ eqX: false, all: false, index: [] });
    expect(both(change(null, {}))).toEqual({ eqX: false, all: false, index: [] });
    expect(both(change({}, null))).toEqual({ eqX: false, all: false, index: [] });
    // the real writes: a query on it re-runs when the document enters and leaves
    const enter = e.patch(id, { k: "x" }).changes as RowChange[];
    expect(e.engine.matches(eqX, enter)).toBe(true);
    const other = e.patch(id, { n: 3 }).changes as RowChange[];
    expect(e.engine.matches(all, other)).toBe(true); // in the index now: its document changed
    const leave = e.patch(id, { k: undefined }).changes as RowChange[];
    expect(e.engine.matches(eqX, leave)).toBe(true);
    const quiet = e.patch(id, { n: 4 }).changes as RowChange[];
    expect(e.engine.matches(all, quiet)).toBe(false);
  });
});

describe("sparse index: migrations", () => {
  const plain = defineSchema({ tables: { items: defineTable(fields).index("by_k", ["k"]) } });
  const sparse = defineSchema({ tables: { items: defineTable(fields).index("by_k", ["k"], { sparse: true }) } });

  function shard() {
    const driver = createNodeSqliteDriver();
    const open = (schema: SchemaDefinition<any, any>) => createEngine({ schema, driver });
    const insert = (schema: SchemaDefinition<any, any>, doc: Record<string, unknown>) => open(schema).runMutation(mutationGeneric((ctx) => ctx.db.insert("items", doc)) as any).value as string;
    const names = (engine: ReturnType<typeof open>) =>
      (engine.runQuery(Q((db) => db.query("items").withIndex("by_k").collect())).value as any[]).map((d) => d.name).sort();
    const sql = (s: string, ...p: any[]) => driver.exec(s, ...p).rows;
    const nullKeys = () => Number(sql(`SELECT count(*) AS n FROM items WHERE "_k_by_k" IS NULL`)[0]!.n);
    const indexSql = () => String(sql(`SELECT sql FROM sqlite_master WHERE name = 'items__by_k'`)[0]?.sql);
    return { open, insert, names, nullKeys, indexSql };
  }
  const fill = (s: ReturnType<typeof shard>, schema: SchemaDefinition<any, any>) => {
    for (let i = 0; i < 12; i++) s.insert(schema, { name: `d${String(i).padStart(2, "0")}`, ...(i % 3 === 0 ? { k: `k${i}` } : {}) });
  };

  test("plain -> sparse on a table with data: rebuilt with a staged backfill that leaves absent documents NULL", () => {
    const s = shard();
    s.open(plain).migrate();
    fill(s, plain);
    expect(s.nullKeys()).toBe(0);
    const engine = s.open(sparse);
    const r = engine.migrate();
    expect(r.steps.map((x) => [x.op, (x as { index?: string }).index])).toEqual([["dropIndex", "by_k"], ["createIndex", "by_k"]]);
    expect(r.staged).toEqual([{ table: "items", index: "by_k", kind: "db" }]);
    expect(s.indexSql()).toMatch(/WHERE "_k_by_k" IS NOT NULL$/);
    expect(() => s.names(engine)).toThrow(/still backfilling/);
    // a write during the backfill: absent stays NULL, present gets its key
    engine.runMutation(mutationGeneric((ctx) => ctx.db.insert("items", { name: "new", k: "kn" })) as any);
    engine.runMutation(mutationGeneric((ctx) => ctx.db.insert("items", { name: "new2" })) as any);
    while (!engine.backfillStep(5).done);
    expect(s.names(engine)).toEqual(["d00", "d03", "d06", "d09", "new"]);
    expect(s.nullKeys()).toBe(9);
    // nothing left to do
    expect(s.open(sparse).migrate()).toMatchObject({ changed: false, staged: [] });
    expect(s.open(sparse).planMigration().steps).toEqual([]);
  });

  test("sparse -> plain: the backfill keys every document again", () => {
    const s = shard();
    s.open(sparse).migrate();
    fill(s, sparse);
    expect(s.nullKeys()).toBe(8);
    const engine = s.open(plain);
    const r = engine.migrate();
    expect(r.steps.map((x) => x.op)).toEqual(["dropIndex", "createIndex"]);
    expect(r.staged).toHaveLength(1);
    expect(s.indexSql()).not.toMatch(/WHERE/);
    while (!engine.backfillStep(5).done);
    expect(s.nullKeys()).toBe(0);
    expect(s.names(engine)).toHaveLength(12);
  });

  test("on an empty table it is ready at once; a new sparse index backfills only present documents", () => {
    const s = shard();
    s.open(plain).migrate();
    expect(s.open(sparse).migrate().staged).toEqual([]);
    expect(s.indexSql()).toMatch(/IS NOT NULL$/);
    const none = defineSchema({ tables: { items: defineTable(fields) } });
    s.open(none).migrate();
    fill(s, none);
    const engine = s.open(sparse);
    expect(engine.migrate().staged).toHaveLength(1);
    while (!engine.backfillStep(100).done);
    expect(s.nullKeys()).toBe(8);
    expect(s.names(engine)).toEqual(["d00", "d03", "d06", "d09"]);
  });
});

describe("sparse index: local execution (client replicas)", () => {
  test("a local SQLite replica and a mutation's overlay leave absent documents out, like the server", () => {
    const e = env();
    for (const d of [{ name: "a", k: "1" }, { name: "b" }, { name: "c", k: "2" }]) e.insert("items", d);
    const all = e.run((db) => db.query("items").collect()).value as Doc[];
    const ls = localSchema(sparseSchema.manifest);
    const local = createNodeSqliteDriver();
    prepareLocalDatabase(local, ls);
    const w = sqlReplicaWriter(local, ls);
    for (const doc of all) w.upsert("items", doc);
    expect(local.exec(`SELECT name FROM sqlite_master WHERE name = 'items__by_k'`).rows).toHaveLength(1);
    expect(local.exec(`SELECT count(*) AS n FROM items WHERE "_k_by_k" IS NULL`).rows[0]!.n).toBe(1);
    const byK = Q((db) => db.query("items").withIndex("by_k").collect());
    const reader = sqlLocalReader(local, ls);
    const local1 = runLocalQuery(byK, {}, { schema: ls, reader });
    expect((local1.value as Doc[]).map((d) => d.name)).toEqual(["a", "c"]);
    // an overlay write: "b" gains a key, "a" loses its own
    const overlay = overlayReader(reader, ls);
    const ids = Object.fromEntries(all.map((d) => [d.name, d._id]));
    const out = runLocalMutation(
      mutationGeneric({
        handler: (ctx: any) => {
          ctx.db.patch(ids.b, { k: "0" });
          ctx.db.patch(ids.a, { k: undefined });
        },
      }) as any,
      {},
      { schema: ls, reader: overlay },
    );
    expect((runLocalQuery(byK, {}, { schema: ls, reader: overlay }).value as Doc[]).map((d) => d.name)).toEqual(["b", "c"]);
    expect(localReadSetMatches(ls, local1.readSet, out.changes)).toBe(true);
    // a change that stays out of the index does not re-run it
    const quiet = [{ table: "items", id: ids.a!, before: { ...all[0]!, k: undefined }, after: { ...all[0]!, k: undefined, n: 1 } }] as any;
    expect(localReadSetMatches(ls, local1.readSet, quiet)).toBe(false);
  });
});
