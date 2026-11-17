// Migration preflight (preflight.ts): the plan of a schema that is not deployed yet, against the live data, with
// nothing written.

import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import { createEngine, defineSchema, defineTable, mutationGeneric, preflightMigration, v, type SchemaDefinition } from "../src/index.ts";

const base = defineSchema({ tables: { users: defineTable({ name: v.string(), age: v.optional(v.number()) }) } });

function shard(schema: SchemaDefinition<any, any> = base, tableStorage?: "classic") {
  const driver = createNodeSqliteDriver();
  const engine = createEngine({ schema, driver, ...(tableStorage ? { tableStorage } : {}) });
  engine.migrate();
  const insert = (doc: Record<string, unknown>) => engine.runMutation(mutationGeneric((ctx) => ctx.db.insert("users", doc)) as any);
  const snapshot = () => ({
    master: driver.exec(`SELECT type, name, sql FROM sqlite_master ORDER BY name`).rows,
    meta: driver.exec(`SELECT key, value FROM _ember_meta ORDER BY key`).rows,
    users: driver.exec(`SELECT * FROM users ORDER BY _id`).rows,
  });
  return { driver, engine, insert, snapshot, kinds: schema.indexKinds };
}

describe("preflightMigration", () => {
  test("a refused change: data-dependent check (optional -> required with documents missing it), nothing written", () => {
    const s = shard();
    s.insert({ name: "a" });
    s.insert({ name: "b", age: 3 });
    const next = defineSchema({ tables: { users: defineTable({ name: v.string(), age: v.number() }) } });
    const before = s.snapshot();
    const r = preflightMigration(s.driver, JSON.parse(JSON.stringify(next.manifest)), s.kinds, { compact: true, shard: "global:main" });
    expect(r.status).toBe("refused");
    if (r.status === "unchecked") throw new Error("unreachable");
    expect(r.fromVersion).toBe(base.manifest.version);
    expect(r.toVersion).toBe(next.manifest.version);
    expect(r.steps).toContainEqual(expect.objectContaining({ op: "refuse", table: "users", field: "age", reason: expect.stringContaining("1 document(s)") }));
    expect(r.steps.some((x) => "sql" in x)).toBe(false);
    expect(s.snapshot()).toEqual(before);
  });

  test("the same change on an empty table, and a new index on data: planned, staged, nothing written", () => {
    const empty = shard();
    const required = defineSchema({ tables: { users: defineTable({ name: v.string(), age: v.number() }) } });
    expect(preflightMigration(empty.driver, required.manifest, empty.kinds, { compact: true }).status).toBe("ok");

    const s = shard();
    s.insert({ name: "a" });
    const indexed = defineSchema({ tables: { users: defineTable({ name: v.string(), age: v.optional(v.number()) }).index("by_name", ["name"]) } });
    const before = s.snapshot();
    const r = preflightMigration(s.driver, indexed.manifest, s.kinds, { compact: true });
    if (r.status === "unchecked") throw new Error(r.message);
    expect(r).toMatchObject({ status: "ok", changed: true, staged: [{ table: "users", index: "by_name", kind: "db" }], conversions: [] });
    expect(s.snapshot()).toEqual(before);
    // The real migration agrees.
    expect(createEngine({ schema: indexed, driver: s.driver }).migrate().staged).toEqual([{ table: "users", index: "by_name", kind: "db" }]);
  });

  test("the deployed schema itself: unchanged, no steps", () => {
    const s = shard();
    const r = preflightMigration(s.driver, base.manifest, s.kinds, { compact: true });
    expect(r).toMatchObject({ status: "ok", changed: false, steps: [], staged: [] });
  });

  test("classic tables are listed as conversions", () => {
    const s = shard(base, "classic");
    s.insert({ name: "a" });
    const r = preflightMigration(s.driver, base.manifest, s.kinds, { compact: true });
    expect(r).toMatchObject({ status: "ok", conversions: [{ table: "users" }] });
  });

  test("unchecked: a malformed manifest, an index kind the runtime does not have, a planner error", () => {
    const s = shard();
    expect(preflightMigration(s.driver, { version: "x" }, s.kinds)).toMatchObject({ status: "unchecked", code: "BadManifest" });
    expect(preflightMigration(s.driver, null, s.kinds)).toMatchObject({ status: "unchecked", code: "BadManifest" });
    const m = JSON.parse(JSON.stringify(base.manifest));
    m.tables.users.indexes.push({ kind: "geo", name: "by_place", fields: ["name"] });
    expect(preflightMigration(s.driver, m, s.kinds)).toMatchObject({ status: "unchecked", code: "UnknownIndexKind", message: expect.stringContaining("geo") });
    const broken = JSON.parse(JSON.stringify(base.manifest));
    broken.tables.users.document.fields.name = { optional: false, shape: null };
    expect(preflightMigration(s.driver, broken, s.kinds)).toMatchObject({ status: "unchecked", code: "PlanFailed" });
  });
});
