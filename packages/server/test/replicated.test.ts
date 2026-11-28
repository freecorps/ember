// `.replicated()` tables (PLAN §22 L5, contracts.md "Tabelas replicadas"): written in global:main only, copied with the
// same `_id`s to the other shards through `_ember:replicaApply`.
import { describe, expect, test } from "vitest";
import {
  componentBuilders,
  composeApp,
  createEngine,
  defineApp,
  defineComponent,
  defineSchema,
  defineShard,
  defineTable,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  replicaApplyFunction,
  replicatedKinds,
  replicatedSnapshot,
  replicatedTablesOf,
  replicatedVersion,
  REPLICATED_SOURCE,
  v,
  type ReplicaApplyArgs,
  type SchemaDefinition,
} from "../src/index.ts";
import { createNodeSqliteDriver } from "../src/testing.ts";

const tables = {
  fxRates: defineTable({ base: v.string(), quote: v.string(), rate: v.number() }).index("by_pair", ["base", "quote"]).replicated(),
  plans: defineTable({ name: v.string() }).replicated({ to: ["org"] }),
  invoices: defineTable({ org: v.string(), rateId: v.id("fxRates"), amount: v.number() }).shard("org", "org"),
};
const shards = { org: defineShard({ key: v.string() }), room: defineShard({ key: v.string() }) };
const schema = defineSchema({ tables, shards }) as unknown as SchemaDefinition;

const fns = (s: SchemaDefinition) => ({
  "_ember:replicaApply": replicaApplyFunction(() => s.manifest),
  "fx:set": mutationGeneric({
    args: { base: v.string(), quote: v.string(), rate: v.number() },
    handler: (ctx, a: { base: string; quote: string; rate: number }) => {
      const db = ctx.db as any;
      const cur = db.query("fxRates").withIndex("by_pair", (q: any) => q.eq("base", a.base).eq("quote", a.quote)).first();
      if (cur) {
        db.patch(cur._id, { rate: a.rate });
        return cur._id;
      }
      return db.insert("fxRates", a);
    },
  }),
  "fx:rate": queryGeneric({
    args: { base: v.string(), quote: v.string() },
    handler: (ctx, a: { base: string; quote: string }) =>
      (ctx.db as any).query("fxRates").withIndex("by_pair", (q: any) => q.eq("base", a.base).eq("quote", a.quote)).first() ?? null,
  }),
  "fx:get": queryGeneric({ args: { id: v.string() }, handler: (ctx, a: { id: string }) => (ctx.db as any).get(a.id) }),
  "fx:status": queryGeneric({ args: { table: v.string() }, handler: (ctx, a: { table: string }) => (ctx.db as any).replicaStatus(a.table) }),
  "inv:add": mutationGeneric({
    args: { org: v.string(), rateId: v.id("fxRates"), amount: v.number() },
    handler: (ctx, a: { org: string; rateId: string; amount: number }) => {
      const rate = (ctx.db as any).get(a.rateId);
      if (!rate) throw new Error("no rate");
      return (ctx.db as any).insert("invoices", { ...a, amount: a.amount * rate.rate });
    },
  }),
  "fx:write": internalMutationGeneric({
    args: { op: v.string() },
    handler: (ctx, a: { op: string }) => {
      const db = ctx.db as any;
      if (a.op === "insert") return db.insert("fxRates", { base: "X", quote: "Y", rate: 1 });
      const r = db.query("fxRates").first();
      if (a.op === "patch") return db.patch(r._id, { rate: 3 });
      return db.delete(r._id);
    },
  }),
});

const shard = (name: string, s: SchemaDefinition = schema, driver = createNodeSqliteDriver()) => {
  const engine = createEngine({ schema: s, functions: fns(s), driver, now: () => 1000, shardName: () => name });
  engine.migrate();
  return { engine, driver, apply: (args: ReplicaApplyArgs) => engine.runMutation("_ember:replicaApply", args).value };
};

describe(".replicated() tables", () => {
  test("manifest flag, targets and validation", () => {
    expect(schema.manifest.tables.fxRates!.replicated).toEqual({});
    expect(schema.manifest.tables.plans!.replicated).toEqual({ to: ["org"] });
    expect(schema.manifest.tables.invoices!.replicated).toBeUndefined();
    expect(replicatedTablesOf(schema.manifest)).toEqual(["fxRates", "plans"]);
    expect(replicatedTablesOf(schema.manifest, "room")).toEqual(["fxRates"]);
    expect(replicatedTablesOf(schema.manifest, "global")).toEqual([]);
    expect([...replicatedKinds(schema.manifest)].sort()).toEqual(["*", "org"]);
    expect(() => defineSchema({ tables: { t: defineTable({ k: v.string() }).shard("org", "k").replicated() }, shards })).toThrow(/global:main/);
    expect(() => defineSchema({ tables: { t: defineTable({ k: v.string() }).replicated({ to: ["nope"] }) }, shards })).toThrow(/unknown shard kind/);
    expect(() => defineTable({ k: v.string() }).replicated({ to: [] })).toThrow(/non-empty/);
    // The flag is part of the schema version (and of the replicated tables' own version).
    const plain = defineSchema({ tables: { ...tables, fxRates: defineTable({ base: v.string(), quote: v.string(), rate: v.number() }).index("by_pair", ["base", "quote"]) }, shards });
    expect(plain.manifest.version).not.toBe(schema.manifest.version);
    expect(replicatedVersion(plain.manifest)).not.toBe(replicatedVersion(schema.manifest));
  });

  test("writable in global:main only: ReadOnlyTable elsewhere, with a hint", () => {
    const g = shard(REPLICATED_SOURCE);
    const id = g.engine.runMutation("fx:set", { base: "USD", quote: "BRL", rate: 5 }).value as string;
    expect(g.engine.runQuery("fx:rate", { base: "USD", quote: "BRL" }).value).toMatchObject({ _id: id, rate: 5 });
    expect(g.engine.runQuery("fx:status", { table: "fxRates" }).value).toEqual({ state: "source", seq: 0, updatedAt: null });

    const o = shard("org:acme");
    for (const op of ["insert", "patch", "delete"]) {
      if (op !== "insert") o.apply({ source: REPLICATED_SOURCE, prev: 0, rows: [{ seq: 1, table: "fxRates", id, op: "upsert", doc: { _id: id, _creationTime: 900, base: "USD", quote: "BRL", rate: 5 } }] });
      expect(() => o.engine.runMutation("fx:write", { op })).toThrow(expect.objectContaining({ code: "ReadOnlyTable", message: expect.stringContaining("global:main") }));
    }
    // A shard of unknown name refuses too.
    const anon = createEngine({ schema, functions: fns(schema), driver: createNodeSqliteDriver(), now: () => 1 });
    anon.migrate();
    expect(() => anon.runMutation("fx:write", { op: "insert" })).toThrow(expect.objectContaining({ code: "ReadOnlyTable" }));
  });

  test("copies keep the source's _id and _creationTime: v.id() in tenant rows resolves everywhere", () => {
    const g = shard(REPLICATED_SOURCE);
    const id = g.engine.runMutation("fx:set", { base: "USD", quote: "BRL", rate: 5 }).value as string;
    const src = g.engine.runQuery("fx:get", { id }).value as Record<string, unknown>;
    const rows = replicatedSnapshot((sql, ...p) => g.driver.exec(sql, ...p).rows, schema.manifest, "org");
    expect(rows).toEqual([{ table: "fxRates", id, doc: src }]);

    const o = shard("org:acme");
    expect(o.engine.runQuery("fx:status", { table: "fxRates" }).value).toEqual({ state: "pending", seq: 0, updatedAt: null });
    expect(o.engine.runQuery("fx:rate", { base: "USD", quote: "BRL" }).value).toBeNull();
    o.apply({ source: REPLICATED_SOURCE, snapshot: { id: "s1", first: true, rows, end: { cut: 4 } } });
    expect(o.engine.runQuery("fx:get", { id }).value).toEqual(src);
    // Same indexes, same queries.
    expect(o.engine.runQuery("fx:rate", { base: "USD", quote: "BRL" }).value).toEqual(src);
    expect(o.engine.runQuery("fx:status", { table: "fxRates" }).value).toEqual({ state: "ready", seq: 4, updatedAt: 1000 });
    // A tenant row holding the id, validated and resolved in the org shard.
    const inv = o.engine.runMutation("inv:add", { org: "acme", rateId: id, amount: 2 }).value as string;
    expect(inv).toMatch(/^invoices_/);

    // Deltas: update, then delete (and the snapshot end removes rows the source no longer has).
    o.apply({ source: REPLICATED_SOURCE, prev: 4, rows: [{ seq: 5, table: "fxRates", id, op: "upsert", doc: { ...src, rate: 6 } }] });
    expect(o.engine.runQuery("fx:get", { id }).value).toEqual({ ...src, rate: 6 });
    o.apply({ source: REPLICATED_SOURCE, prev: 5, rows: [{ seq: 6, table: "fxRates", id, op: "delete" }] });
    expect(o.engine.runQuery("fx:get", { id }).value).toBeNull();
    o.apply({ source: REPLICATED_SOURCE, prev: 6, rows: [{ seq: 7, table: "fxRates", id, op: "upsert", doc: src }] });
    o.apply({ source: REPLICATED_SOURCE, snapshot: { id: "s2", first: true, rows: [], end: { cut: 9 } } });
    expect(o.engine.runQuery("fx:get", { id }).value).toBeNull();
  });

  test("shards outside `to` see the table off; the table is classic storage everywhere", () => {
    const r = shard("room:1");
    expect(r.engine.runQuery("fx:status", { table: "plans" }).value).toMatchObject({ state: "off" });
    expect(r.engine.runQuery("fx:status", { table: "fxRates" }).value).toMatchObject({ state: "pending" });
    const sql = (name: string) => r.driver.exec(`SELECT sql FROM sqlite_master WHERE name = ?`, name).rows[0]!.sql as string;
    expect(sql("fxRates")).toMatch(/"_id" TEXT NOT NULL UNIQUE/);
    expect(sql("invoices")).not.toMatch(/"_id" TEXT NOT NULL UNIQUE/);
  });

  test("a table that becomes .replicated() is refused on a target shard holding its own rows (never emptied)", () => {
    const plain = defineSchema({ tables: { ...tables, fxRates: defineTable({ base: v.string(), quote: v.string(), rate: v.number() }).index("by_pair", ["base", "quote"]) }, shards }) as unknown as SchemaDefinition;
    const own = shard("org:acme", plain);
    const id = own.engine.runMutation("fx:set", { base: "USD", quote: "BRL", rate: 5 }).value as string;
    const next = createEngine({ schema, functions: fns(schema), driver: own.driver, now: () => 2000, shardName: () => "org:acme" });
    expect(() => next.migrate()).toThrow(/becomes \.replicated\(\) but this shard \(org:acme/);
    expect(own.engine.runQuery("fx:get", { id }).value).toMatchObject({ rate: 5 });
    // Empty there: nothing to lose, the table becomes a copy.
    const empty = shard("org:empty", plain);
    const next2 = createEngine({ schema, functions: fns(schema), driver: empty.driver, now: () => 2000, shardName: () => "org:empty" });
    expect(() => next2.migrate()).not.toThrow();
    expect(next2.runQuery("fx:status", { table: "fxRates" }).value).toMatchObject({ state: "pending" });
  });

  test("migrations: a copy is rebuilt (and resynced); the source refuses as any app table", () => {
    const next = defineSchema({
      tables: { ...tables, fxRates: defineTable({ base: v.string(), quote: v.string(), rate: v.number(), source: v.string() }).index("by_pair", ["base", "quote"]).replicated() },
      shards,
    }) as unknown as SchemaDefinition;
    const g = shard(REPLICATED_SOURCE);
    const id = g.engine.runMutation("fx:set", { base: "USD", quote: "BRL", rate: 5 }).value as string;
    const rows = replicatedSnapshot((sql, ...p) => g.driver.exec(sql, ...p).rows, schema.manifest, "org");
    const o = shard("org:acme");
    o.apply({ source: REPLICATED_SOURCE, snapshot: { id: "s1", first: true, rows, end: { cut: 3 } } });

    // New required field: the copy is emptied and forgets its mark (pending until the resync).
    const o2 = createEngine({ schema: next, functions: fns(next), driver: o.driver, now: () => 2000, shardName: () => "org:acme" });
    const report = o2.migrate();
    expect(report.steps.find((s) => s.table === "fxRates")).toMatchObject({ op: "rebuildTable" });
    expect(o2.runQuery("fx:get", { id }).value).toBeNull();
    expect(o2.runQuery("fx:status", { table: "fxRates" }).value).toMatchObject({ state: "pending" });

    // In global:main the rows are the source's own: refused, never emptied.
    const g2 = createEngine({ schema: next, functions: fns(next), driver: g.driver, now: () => 2000, shardName: () => REPLICATED_SOURCE });
    expect(() => g2.migrate()).toThrow(/new required field source/);
    expect(g.engine.runQuery("fx:get", { id }).value).toMatchObject({ rate: 5 });
  });

  test("a table that becomes .replicated() leaves compact storage where that loses nothing", () => {
    const before = defineSchema({ tables: { ...tables, fxRates: defineTable({ base: v.string(), quote: v.string(), rate: v.number() }).index("by_pair", ["base", "quote"]) }, shards }) as unknown as SchemaDefinition;
    const isClassic = (d: ReturnType<typeof createNodeSqliteDriver>) => /"_id" TEXT NOT NULL UNIQUE/.test(d.exec(`SELECT sql FROM sqlite_master WHERE name = 'fxRates'`).rows[0]!.sql as string);
    // An org shard: the empty compact table becomes classic.
    const o = shard("org:acme", before);
    expect(isClassic(o.driver)).toBe(false);
    shard("org:acme", schema, o.driver);
    expect(isClassic(o.driver)).toBe(true);
    // global:main with rows: stays compact, and keeps working.
    const g = shard(REPLICATED_SOURCE, before);
    g.engine.runMutation("fx:set", { base: "USD", quote: "BRL", rate: 5 });
    const g2 = shard(REPLICATED_SOURCE, schema, g.driver);
    expect(isClassic(g.driver)).toBe(false);
    expect(g2.engine.runQuery("fx:rate", { base: "USD", quote: "BRL" }).value).toMatchObject({ rate: 5 });
    // Its compact ids still land in classic copies.
    const rows = replicatedSnapshot((sql, ...p) => g.driver.exec(sql, ...p).rows, schema.manifest, "org");
    const o2 = shard("org:b");
    o2.apply({ source: REPLICATED_SOURCE, snapshot: { id: "s", first: true, rows, end: { cut: 1 } } });
    expect(o2.engine.runQuery("fx:get", { id: rows[0]!.id as string }).value).toEqual(rows[0]!.doc);
  });
});

describe(".replicated() tables of a component", () => {
  // A component's table can be `.replicated()` (e.g. @freecorps/ember-flags): it is `<install>$<table>` in the composed
  // schema, written by the component's mutations in global:main, and copied by the applier, which sees every table
  // (component tables included) while every other function keeps its own scope.
  const cschema = defineSchema({
    tables: {
      items: defineTable({ key: v.string(), n: v.number() }).index("by_key", ["key"]).replicated(),
      /** Shard-local (not replicated): the applier must never reach it. */
      local: defineTable({ key: v.string(), n: v.number() }),
    },
  });
  const b = componentBuilders<typeof cschema, undefined>();
  const comp = defineComponent({
    name: "cfg",
    schema: cschema,
    functions: {
      lib: {
        put: b.mutation({ args: { key: v.string(), n: v.number() }, handler: (ctx, a) => ctx.db.insert("items", a) }),
        get: b.query({ args: { key: v.string() }, handler: (ctx, a) => ctx.db.query("items").withIndex("by_key", (q) => q.eq("key", a.key)).first() }),
        status: b.query({ args: {}, handler: (ctx) => ctx.db.replicaStatus("items") }),
        keep: b.mutation({ args: { key: v.string(), n: v.number() }, handler: (ctx, a) => ctx.db.insert("local", a) }),
        local: b.query({ args: { id: v.string() }, handler: (ctx, a) => ctx.db.get(a.id as never) }),
      },
    },
  });
  const composed = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(comp) });
  const m = composed.schema.manifest;
  const engineOn = (name: string) => {
    const driver = createNodeSqliteDriver();
    const engine = createEngine({ schema: composed.schema, functions: { ...composed.functions, "_ember:replicaApply": replicaApplyFunction(() => m) }, driver, now: () => 1000, shardName: () => name });
    engine.migrate();
    return { engine, driver };
  };

  test("written in global:main, copied with its _id to another shard, read through the component", () => {
    expect(m.tables["cfg$items"]!.replicated).toEqual({});
    expect(replicatedTablesOf(m)).toEqual(["cfg$items"]);
    const g = engineOn(REPLICATED_SOURCE);
    const id = g.engine.runMutation("@cfg/lib:put", { key: "a", n: 1 }).value as string;
    const rows = replicatedSnapshot((sql, ...p) => g.driver.exec(sql, ...p).rows, m, "org");
    expect(rows.map((r) => [r.table, r.id])).toEqual([["cfg$items", id]]);

    const o = engineOn("org:acme");
    expect(() => o.engine.runMutation("@cfg/lib:put", { key: "b", n: 2 })).toThrow(expect.objectContaining({ code: "ReadOnlyTable" }));
    expect(o.engine.runQuery("@cfg/lib:status", {}).value).toMatchObject({ state: "pending" });
    o.engine.runMutation("_ember:replicaApply", { source: REPLICATED_SOURCE, snapshot: { id: "s1", first: true, rows, end: { cut: 1 } } });
    expect(o.engine.runQuery("@cfg/lib:get", { key: "a" }).value).toMatchObject({ _id: id, key: "a", n: 1 });
    expect(o.engine.runQuery("@cfg/lib:status", {}).value).toMatchObject({ state: "ready", seq: 1 });
    o.engine.runMutation("_ember:replicaApply", { source: REPLICATED_SOURCE, prev: 1, rows: [{ seq: 2, table: "cfg$items", id, op: "upsert", doc: { ...(rows[0]!.doc as object), n: 5 } }] });
    expect(o.engine.runQuery("@cfg/lib:get", { key: "a" }).value).toMatchObject({ n: 5 });
    o.engine.runMutation("_ember:replicaApply", { source: REPLICATED_SOURCE, prev: 2, rows: [{ seq: 3, table: "cfg$items", id, op: "delete" }] });
    expect(o.engine.runQuery("@cfg/lib:get", { key: "a" }).value).toBeNull();
  });

  test("a row whose _id belongs to another table is refused: the applier's wider scope never reaches it", () => {
    const o = engineOn("org:acme");
    const own = o.engine.runMutation("@cfg/lib:keep", { key: "mine", n: 1 }).value as string;
    o.engine.runMutation("_ember:replicaApply", { source: REPLICATED_SOURCE, snapshot: { id: "s1", first: true, rows: [], end: { cut: 0 } } });
    for (const op of ["delete", "upsert"] as const) {
      const row = { seq: 1, table: "cfg$items", id: own, op, ...(op === "upsert" ? { doc: { key: "x", n: 9 } } : {}) };
      expect(() => o.engine.runMutation("_ember:replicaApply", { source: REPLICATED_SOURCE, prev: 0, rows: [row] })).toThrow(expect.objectContaining({ code: "ValidationError", message: expect.stringContaining(`is not an id of cfg$items`) }));
    }
    expect(o.engine.runQuery("@cfg/lib:local", { id: own }).value).toMatchObject({ key: "mine", n: 1 });
  });
});

describe(".replicated() cost model", () => {
  test("deploy notes count the targets per table from the catalog; dev advice from 30 writes/min or 1000 deliveries/min", async () => {
    const { replicatedDeployNotes, replicatedTargets, replicatedWriteAdvice } = await import("../src/index.ts");
    const counts = { global: 1, org: 120, room: 12_000 };
    expect(replicatedTargets(schema.manifest, counts)).toEqual([
      { table: "fxRates", to: null, targets: 12_120 },
      { table: "plans", to: ["org"], targets: 120 },
    ]);
    const notes = replicatedDeployNotes(schema.manifest, counts);
    expect(notes[0]).toMatchObject({ warning: true, text: expect.stringContaining("12120 deliveries") });
    expect(notes[1]).toMatchObject({ warning: false, text: expect.stringMatching(/plans is \.replicated\(\) to the "org" shards: 120 target shards/) });
    expect(replicatedWriteAdvice("fxRates", 5, 3)).toBeNull();
    expect(replicatedWriteAdvice("fxRates", 30, 1)).toMatch(/30 writes in the last minute × 1 target shard here = 30 deliveries/);
    expect(replicatedWriteAdvice("fxRates", 10, 100)).toMatch(/1000 deliveries/);
  });
});
