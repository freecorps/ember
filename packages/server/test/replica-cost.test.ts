// Replica tables, cost (PR 2B): the status read and the applier find the state table by reading it (no sqlite_master
// probe, no CREATE TABLE IF NOT EXISTS per apply); a resync of one page keeps nothing in `_ember_replicas_seen`; the
// source's snapshot walks an index in creation order and reads data columns only. The wire format is unchanged.

import { describe, expect, test } from "vitest";
import {
  createEngine,
  defineSchema,
  defineTable,
  mutationGeneric,
  queryGeneric,
  replicaApplyFunction,
  replicatedSnapshot,
  REPLICATED_SOURCE,
  withReplicas,
  v,
  type ReplicaApplyArgs,
  type ReplicaTableSpec,
  type SchemaDefinition,
} from "../src/index.ts";
import { createNodeSqliteDriver, type NodeSqliteDriver } from "../src/testing.ts";
import { decodeRow, layoutOf } from "../src/layout.ts";

const member: ReplicaTableSpec = {
  name: "auth:member",
  source: "auth",
  idType: "string",
  fields: [{ name: "role", type: "string", optional: false }],
};
const team: ReplicaTableSpec = { name: "auth:team", source: "auth", idType: "number", fields: [{ name: "name", type: "string", optional: false }] };
const base = defineSchema({ tables: { notes: defineTable({ text: v.string() }) } });
const schema = withReplicas(base, [member, team]);

const fns = (s: SchemaDefinition) => ({
  "_ember:replicaApply": replicaApplyFunction(() => s.manifest),
  "t:ids": queryGeneric({ args: {}, handler: (ctx) => ["auth:member", "auth:team"].flatMap((t) => (ctx.db as any).query(t).collect().map((d: any) => d.id)) }),
  "t:status": queryGeneric({ args: {}, handler: (ctx) => (ctx.db as any).replicaStatus("auth:member") }),
});

function setup(s: SchemaDefinition = schema, driver: NodeSqliteDriver = createNodeSqliteDriver(), name?: string) {
  const engine = createEngine({ schema: s, functions: fns(s), driver, now: () => 1000, ...(name ? { shardName: () => name } : {}) });
  engine.migrate();
  const sql: string[] = [];
  const exec = driver.exec;
  driver.exec = (q, ...p) => {
    sql.push(q);
    return exec.call(driver, q, ...p);
  };
  /** The statements `fn` runs. */
  const during = (fn: () => unknown) => {
    const from = sql.length;
    fn();
    return sql.slice(from);
  };
  const apply = (args: ReplicaApplyArgs) => engine.runMutation("_ember:replicaApply", args).value as Record<string, unknown>;
  return { engine, driver, during, apply };
}

const seen = (d: NodeSqliteDriver) => {
  try {
    return d.exec(`SELECT "source", "tbl", "sid" FROM "_ember_replicas_seen" ORDER BY "sid"`).rows;
  } catch {
    return null; // never created
  }
};
const page = (rows: Array<[string, string | number]>) => rows.map(([table, id]) => ({ table, id, doc: table === "auth:team" ? { name: `n${id}` } : { role: `r${id}` } }));

describe("replica status and apply: no schema probes", () => {
  test("replicaStatus on a shard that never received anything: one read, pending", () => {
    const s = setup();
    let status: unknown;
    const sql = s.during(() => (status = s.engine.runQuery("t:status").value));
    expect(status).toEqual({ state: "pending", seq: 0, updatedAt: null });
    expect(sql.filter((q) => q.includes("sqlite_master"))).toEqual([]);
    s.apply({ source: "auth", prev: 0, rows: [{ seq: 1, table: "auth:member", id: "m1", op: "upsert", doc: { role: "x" } }] });
    expect(s.during(() => (status = s.engine.runQuery("t:status").value)).filter((q) => q.includes("sqlite_master"))).toEqual([]);
    expect(status).toEqual({ state: "ready", seq: 1, updatedAt: 1000 });
  });

  test("the first apply creates the state table; later ones run no DDL", () => {
    const s = setup();
    const first = s.during(() => s.apply({ source: "auth", prev: 0, rows: [{ seq: 1, table: "auth:member", id: "m1", op: "upsert", doc: { role: "x" } }] }));
    expect(first.filter((q) => /^CREATE/i.test(q))).toHaveLength(1);
    const later = s.during(() => {
      s.apply({ source: "auth", prev: 1, rows: [{ seq: 2, table: "auth:member", id: "m2", op: "upsert", doc: { role: "y" } }] });
      s.apply({ source: "auth", prev: 1, rows: [{ seq: 2, table: "auth:member", id: "m2", op: "upsert", doc: { role: "y" } }] }); // redelivery
      s.apply({ source: "auth", prev: 9, rows: [] }); // a gap
    });
    expect(later.filter((q) => /^CREATE/i.test(q) || q.includes("sqlite_master"))).toEqual([]);
    expect(s.engine.runQuery("t:ids").value).toEqual(["m1", "m2"]);
  });

  test("a state table created by a migration (a replica rebuilt) is found by the first apply", () => {
    const driver = createNodeSqliteDriver();
    const s = setup(schema, driver);
    s.apply({ source: "auth", prev: 0, rows: [{ seq: 1, table: "auth:member", id: "m1", op: "upsert", doc: { role: "x" } }] });
    const changed = withReplicas(base, [{ ...member, fields: [...member.fields, { name: "req", type: "string", optional: false }] }, team]);
    const next = setup(changed, driver);
    expect(next.apply({ source: "auth", prev: 1, rows: [] })).toMatchObject({ resync: true });
  });
});

describe("single-page resync: nothing in _ember_replicas_seen", () => {
  test("first + end in one page: rows upserted, stale rows (string and numeric ids) deleted, no seen ids written", () => {
    const s = setup();
    s.apply({ source: "auth", snapshot: { id: "s0", first: true, rows: page([["auth:member", "a"], ["auth:member", "b"], ["auth:team", 5], ["auth:team", 7]]), end: { cut: 1 } } });
    expect(seen(s.driver)).toBeNull();
    const sql = s.during(() =>
      s.apply({ source: "auth", snapshot: { id: "s1", first: true, rows: page([["auth:member", "b"], ["auth:member", "c"], ["auth:team", 7], ["auth:team", 8.5]]), end: { cut: 3 } } }),
    );
    expect(sql.filter((q) => q.includes("_ember_replicas_seen"))).toEqual([]);
    expect(seen(s.driver)).toBeNull();
    expect(s.engine.runQuery("t:ids").value).toEqual(["b", "c", 7, 8.5]);
    expect(s.engine.runQuery("t:status").value).toEqual({ state: "ready", seq: 3, updatedAt: 1000 });
    // Deltas after the cut apply; at or below it they are skipped.
    expect(s.apply({ source: "auth", prev: 0, rows: [{ seq: 3, table: "auth:member", id: "z", op: "upsert", doc: { role: "z" } }, { seq: 4, table: "auth:member", id: "b", op: "delete" }] })).toEqual({ seq: 4, applied: 1, skipped: 1 });
    expect(s.engine.runQuery("t:ids").value).toEqual(["c", 7, 8.5]);
  });

  test("numeric ids a REAL column cannot hold (NaN, ±Infinity, -0) survive their own single-page resync", () => {
    const odd = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0];
    const teams = (ids: number[]) => page(ids.map((id) => ["auth:team", id] as [string, number]));
    const key = (x: unknown) => (Object.is(x, -0) ? "-0" : String(x));
    const ids = (s: ReturnType<typeof setup>) => (s.engine.runQuery("t:ids").value as unknown[]).map(key).sort();
    const one = setup();
    const many = setup();
    for (const s of [one, many]) s.apply({ source: "auth", snapshot: { id: "s0", first: true, rows: teams([...odd, 0, 1]), end: { cut: 1 } } });
    expect(ids(one)).toEqual(["-0", "-Infinity", "0", "1", "Infinity", "NaN"]);
    // The same page again: nothing is stale.
    expect(one.apply({ source: "auth", snapshot: { id: "s1", first: true, rows: teams([...odd, 0, 1]), end: { cut: 2 } } })).toEqual({ seq: 2, applied: 6, skipped: 0 });
    expect(ids(one)).toEqual(["-0", "-Infinity", "0", "1", "Infinity", "NaN"]);
    // Only the ids the source no longer has go: 0 does not keep -0, nor -0 keep 0; NaN and Infinity leave when absent.
    const next = [Number.NEGATIVE_INFINITY, 0, 1];
    one.apply({ source: "auth", snapshot: { id: "s2", first: true, rows: teams(next), end: { cut: 3 } } });
    expect(ids(one)).toEqual(["-Infinity", "0", "1"]);
    one.apply({ source: "auth", snapshot: { id: "s3", first: true, rows: teams([-0, Number.NaN]), end: { cut: 4 } } });
    expect(ids(one)).toEqual(["-0", "NaN"]);
    // A multi-page resync of the same pages ends with the same rows (it never deletes a row whose id column is NULL).
    many.apply({ source: "auth", snapshot: { id: "m1", first: true, rows: teams(odd.slice(0, 2)) } });
    many.apply({ source: "auth", snapshot: { id: "m1", rows: teams([...odd.slice(2), 0, 1]), end: { cut: 2 } } });
    expect(ids(many)).toEqual(["-0", "-Infinity", "0", "1", "Infinity", "NaN"]);
  });

  test("an empty single page removes every row of the source", () => {
    const s = setup();
    s.apply({ source: "auth", snapshot: { id: "s0", first: true, rows: page([["auth:member", "a"], ["auth:team", 1]]), end: { cut: 1 } } });
    expect(s.apply({ source: "auth", snapshot: { id: "s1", first: true, rows: [], end: { cut: 2 } } })).toEqual({ seq: 2, applied: 2, skipped: 0 });
    expect(s.engine.runQuery("t:ids").value).toEqual([]);
  });

  test("a multi-page resync interrupted, then a single-page one: the first one's ids are dropped, the result exact", () => {
    const s = setup();
    s.apply({ source: "auth", snapshot: { id: "s0", first: true, rows: page([["auth:member", "a"], ["auth:member", "b"], ["auth:team", 1]]), end: { cut: 1 } } });
    // A two-page resync whose second page never comes (the source restarted it).
    s.apply({ source: "auth", snapshot: { id: "s1", first: true, rows: page([["auth:member", "a"], ["auth:member", "x"]]) } });
    expect(seen(s.driver)).toHaveLength(2);
    expect(s.engine.runQuery("t:status").value).toMatchObject({ state: "syncing" });
    s.apply({ source: "auth", snapshot: { id: "s2", first: true, rows: page([["auth:member", "b"], ["auth:team", 1]]), end: { cut: 5 } } });
    expect(seen(s.driver)).toEqual([]);
    expect(s.engine.runQuery("t:ids").value).toEqual(["b", 1]);
    expect(s.engine.runQuery("t:status").value).toEqual({ state: "ready", seq: 5, updatedAt: 1000 });
  });

  test("multi-page resyncs still record and clear the ids they carried (same result as one page)", () => {
    const one = setup();
    const many = setup();
    const before = page([["auth:member", "a"], ["auth:member", "b"], ["auth:team", 1], ["auth:team", 2]]);
    for (const s of [one, many]) s.apply({ source: "auth", snapshot: { id: "s0", first: true, rows: before, end: { cut: 1 } } });
    const after = page([["auth:member", "b"], ["auth:member", "c"], ["auth:team", 2], ["auth:team", 3]]);
    one.apply({ source: "auth", snapshot: { id: "s1", first: true, rows: after, end: { cut: 4 } } });
    many.apply({ source: "auth", snapshot: { id: "s1", first: true, rows: after.slice(0, 1) } });
    many.apply({ source: "auth", snapshot: { id: "s1", rows: after.slice(1, 3) } });
    many.apply({ source: "auth", snapshot: { id: "s1", rows: after.slice(3), end: { cut: 4 } } });
    expect(many.engine.runQuery("t:ids").value).toEqual(one.engine.runQuery("t:ids").value);
    expect(seen(many.driver)).toEqual([]);
  });
});

describe("replicatedSnapshot: creation order from an index, data columns only", () => {
  const fx = () => defineTable({ base: v.string(), rate: v.number() }).index("by_base", ["base"]);
  const replicated = defineSchema({ tables: { fx: fx().replicated() } }) as unknown as SchemaDefinition;

  /** The snapshot as it was read before (SELECT *, sorted on _creationTime): the reference. */
  const reference = (d: NodeSqliteDriver, table: string, s: SchemaDefinition) => {
    const layout = layoutOf(table, s.manifest.tables[table]!.document);
    return d.exec(`SELECT * FROM "${table}" ORDER BY "_creationTime", "_rowid"`).rows.map((row) => {
      const doc = decodeRow(layout, row) as Record<string, unknown>;
      return { table, id: String(doc._id), doc };
    });
  };
  const capture = (d: NodeSqliteDriver, s: SchemaDefinition) => {
    const sql: string[] = [];
    const rows = replicatedSnapshot(
      (q, ...p) => {
        sql.push(q);
        return d.exec(q, ...p).rows;
      },
      s.manifest,
      "org",
    );
    return { rows, sql: sql.filter((q) => q.includes(`FROM "fx"`)) };
  };

  test("classic table: the by_creation_time index, no sort, no _k_* columns; same rows in the same order", () => {
    const driver = createNodeSqliteDriver();
    let clock = 1_700_000_000_000;
    const g = createEngine({ schema: replicated, driver, now: () => clock, shardName: () => REPLICATED_SOURCE });
    g.migrate();
    // Several documents in the same millisecond: ties broken the same way as before (rowid order = id order here).
    for (let i = 0; i < 30; i++) {
      if (i % 4 === 0) clock++;
      g.runMutation(mutationGeneric((ctx: any) => ctx.db.insert("fx", { base: `b${i % 5}`, rate: i })) as any);
    }
    const { rows, sql } = capture(driver, replicated);
    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toMatch(/SELECT \*/);
    expect(sql[0]).not.toContain(`"_k_by_base"`);
    expect(sql[0]).toContain(`ORDER BY "_k_by_creation_time", "_rowid"`);
    const plan = driver.exec(`EXPLAIN QUERY PLAN ${sql[0]}`).rows.map((r) => String(r.detail)).join(" | ");
    expect(plan).toMatch(/USING INDEX fx__by_creation_time/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
    expect(rows.map((r) => r.id).sort()).toEqual(reference(driver, "fx", replicated).map((r) => r.id).sort());
    expect(rows.map((r) => [r.doc._creationTime, r.doc.rate])).toEqual(reference(driver, "fx", replicated).map((r) => [r.doc._creationTime, r.doc.rate]).sort((a, b) => (a[0] as number) - (b[0] as number) || 0));
    expect(rows.map((r) => r.doc)).toEqual(reference(driver, "fx", replicated).map((r) => r.doc).sort((a, b) => (a._creationTime as number) - (b._creationTime as number) || String(a._id).localeCompare(String(b._id))));
  });

  test("a source table still in compact storage (it existed before .replicated()): rowid order, no sort", () => {
    const driver = createNodeSqliteDriver();
    let clock = 1_700_000_000_000;
    const plain = defineSchema({ tables: { fx: fx() } }) as unknown as SchemaDefinition;
    const g1 = createEngine({ schema: plain, driver, now: () => (clock += 1), shardName: () => REPLICATED_SOURCE });
    g1.migrate();
    for (let i = 0; i < 12; i++) g1.runMutation(mutationGeneric((ctx: any) => ctx.db.insert("fx", { base: `b${i}`, rate: i })) as any);
    const g2 = createEngine({ schema: replicated, driver, now: () => (clock += 1), shardName: () => REPLICATED_SOURCE });
    g2.migrate();
    expect(String(driver.exec(`SELECT sql FROM sqlite_master WHERE name = 'fx'`).rows[0]!.sql)).not.toMatch(/"_id" TEXT NOT NULL UNIQUE/);
    const { rows, sql } = capture(driver, replicated);
    expect(sql[0]).toContain(`ORDER BY "_rowid"`);
    expect(driver.exec(`EXPLAIN QUERY PLAN ${sql[0]}`).rows.map((r) => String(r.detail)).join(" | ")).not.toMatch(/TEMP B-TREE/);
    expect(rows).toEqual(reference(driver, "fx", replicated));
  });

  test("a table missing on the source is skipped", () => {
    const driver = createNodeSqliteDriver();
    expect(replicatedSnapshot((q, ...p) => driver.exec(q, ...p).rows, replicated.manifest, "org")).toEqual([]);
  });

  test("the snapshot fills a target shard (same wire as before)", () => {
    const driver = createNodeSqliteDriver();
    const g = createEngine({ schema: replicated, driver, now: () => 5, shardName: () => REPLICATED_SOURCE });
    g.migrate();
    for (let i = 0; i < 3; i++) g.runMutation(mutationGeneric((ctx: any) => ctx.db.insert("fx", { base: `b${i}`, rate: i })) as any);
    const rows = replicatedSnapshot((q, ...p) => driver.exec(q, ...p).rows, replicated.manifest, "org");
    const o = setup(replicated, createNodeSqliteDriver(), "org:acme");
    o.apply({ source: REPLICATED_SOURCE, snapshot: { id: "s", first: true, rows, end: { cut: 3 } } });
    const got = o.engine.runQuery(queryGeneric({ args: {}, handler: (ctx) => (ctx.db as any).query("fx").collect() }) as any).value as any[];
    expect(got.map((d) => [d._id, d.base])).toEqual(rows.map((r) => [r.id, r.doc.base]));
    expect(seen(o.driver)).toBeNull();
  });
});
