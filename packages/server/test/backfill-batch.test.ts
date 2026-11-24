// Staged backfill cost (PR 2B): one read of the batch's rows (the boundary is the read itself, not a second scan),
// and aggregates accumulated per group in memory within the batch (one
// write per group touched, one per distinct min/max value) — bit-identical to maintaining them row by row, and
// resumable after a failure mid-batch (the batch and its cursor commit together).

import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver, type NodeSqliteDriver } from "../src/testing.ts";
import { createEngine, defineSchema, defineTable, docKey, mutationGeneric, queryGeneric, v, type QueryCtx } from "../src/index.ts";
import { prng } from "./fixtures.ts";

const fields = {
  shop: v.string(),
  status: v.string(),
  amount: v.number(),
  qty: v.optional(v.int64()),
  tag: v.optional(v.string()),
};
const plain = defineSchema({ tables: { orders: defineTable(fields) } });
const indexed = defineSchema({ tables: { orders: defineTable(fields).index("by_shop", ["shop", "amount"]) } });
const counted = defineSchema({ tables: { orders: defineTable(fields).aggregate("n", { by: ["shop"] }) } });
const full = defineSchema({
  tables: {
    orders: defineTable(fields)
      .aggregate("per_shop", { by: ["shop"], sum: ["amount", "qty"], min: ["amount", "tag"], max: ["amount", "tag"] })
      .aggregate("per_status", { by: ["shop", "status"], sum: ["amount"] })
      .aggregate("total", { by: [], sum: ["amount", "qty"], min: ["amount"] })
      .aggregate("n", { by: ["status"] }),
  },
});

const Q = (handler: (db: any) => unknown) => queryGeneric({ handler: (ctx: QueryCtx) => handler(ctx.db) }) as any;

/** Docs with float amounts (sums depend on the order of the additions), int64 quantities, ties and gaps. */
function docs(n: number, seed = 1) {
  const rnd = prng(seed);
  return Array.from({ length: n }, (_, i) => ({
    shop: ["a", "b", "c"][Math.floor(rnd() * 3)]!,
    status: rnd() < 0.5 ? "new" : "paid",
    amount: Math.floor(rnd() * 40) / 10 + 0.1,
    ...(rnd() < 0.7 ? { qty: BigInt(Math.floor(rnd() * 9)) } : {}),
    ...(rnd() < 0.6 ? { tag: `t${Math.floor(rnd() * 5)}` } : {}),
  }));
}

function shard(schema: any, driver: NodeSqliteDriver = createNodeSqliteDriver()) {
  let clock = 1_700_000_000_000;
  const engine = createEngine({ schema, driver, now: () => (clock += 1) });
  engine.migrate();
  const insertAll = (rows: Record<string, unknown>[]) =>
    engine.runMutation(mutationGeneric((ctx: any) => rows.map((d) => ctx.db.insert("orders", d))) as any).value as string[];
  return { engine, driver, insertAll };
}

/** Rows read / written and statements while `fn` runs (node:sqlite counters). */
function cost<R>(driver: NodeSqliteDriver, fn: () => R) {
  const exec = driver.exec;
  const out = { value: undefined as R, statements: 0, rowsRead: 0, rowsWritten: 0, sql: [] as string[] };
  driver.exec = (s, ...p) => {
    const r = exec.call(driver, s, ...p);
    out.statements++;
    out.rowsRead += r.rowsRead;
    out.rowsWritten += r.rowsWritten;
    out.sql.push(s);
    return r;
  };
  try {
    out.value = fn();
  } finally {
    driver.exec = exec;
  }
  return out;
}

const aggregateTables = (driver: NodeSqliteDriver) =>
  Object.fromEntries(
    driver
      .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orders__%' ORDER BY name`)
      .rows.map((r) => [String(r.name), driver.exec(`SELECT * FROM "${String(r.name)}" ORDER BY "key"`).rows]),
  );

/** `schema`'s derived state built live (one row at a time) vs staged on existing rows and backfilled `limit` at a time. */
function liveAndBackfilled(schema: any, rows: Record<string, unknown>[], limit: number) {
  const live = shard(schema);
  live.insertAll(rows);
  const staged = shard(plain);
  staged.insertAll(rows);
  const s2 = shard(schema, staged.driver);
  expect(s2.engine.migrate().staged.length).toBeGreaterThan(0);
  return { live, staged: s2, step: () => s2.engine.backfillStep(limit) };
}

const keys = (d: NodeSqliteDriver) =>
  d.exec(`SELECT "_id", "_k_by_shop" FROM "orders" ORDER BY "_rowid"`).rows.map((r) => [r._id, r._k_by_shop ? Buffer.from(r._k_by_shop as Uint8Array).toString("hex") : ""]);

describe("backfill: one read per batch", () => {
  test("db index: the batch is read once (500 rows, was 1000), one key UPDATE per row", () => {
    const { staged, step } = liveAndBackfilled(indexed, docs(1200), 500);
    const r = cost(staged.driver, step);
    expect(r.value).toMatchObject({ processed: 500, indexReady: false });
    const reads = r.sql.filter((s) => /FROM "orders"/.test(s));
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toMatch(/SELECT \*/); // data columns only, not the other `_k_*` BLOBs
    expect(r.sql.filter((s) => s.startsWith(`UPDATE "orders"`))).toHaveLength(500);
    expect(r.rowsRead).toBeLessThanOrEqual(500 + 2); // the batch, the job row, the staged check
    while (!step().done);
    const got = staged.engine.runQuery(Q((db) => db.query("orders").withIndex("by_shop", (q: any) => q.eq("shop", "b")).collect())).value as any[];
    const all = staged.engine.runQuery(Q((db) => db.query("orders").collect())).value as any[];
    expect(got.map((d) => d._id)).toEqual(
      all
        .filter((d) => d.shop === "b")
        .sort((x, y) => x.amount - y.amount || x._creationTime - y._creationTime)
        .map((d) => d._id),
    );
  });

  test.each([1, 44, 45, 46, 137, 183, 500])("db index keys exact whatever the batch size (batches of %i)", (limit) => {
    const { live, staged, step } = liveAndBackfilled(indexed, docs(183, limit), limit);
    expect(keys(staged.driver).every(([, k]) => k === "")).toBe(true);
    let steps = 1;
    while (!step().done) steps++;
    expect(steps).toBeGreaterThanOrEqual(Math.ceil(183 / limit));
    expect(steps).toBeLessThanOrEqual(Math.ceil(183 / limit) + 1);
    const decoded = staged.engine.runQuery(Q((db) => db.query("orders").collect())).value as any[];
    expect(keys(staged.driver).map(([, k]) => k)).toEqual(decoded.map((d) => Buffer.from(docKey(d, ["shop", "amount", "_creationTime", "_id"])).toString("hex")));
    // Same index order as the table built live (ids differ between the two shards: compare the documents).
    const order = (e: typeof live.engine) => (e.runQuery(Q((db) => db.query("orders").withIndex("by_shop").collect())).value as any[]).map((d) => [d.shop, d.amount, d.status]);
    expect(order(staged.engine)).toEqual(order(live.engine));
  });
});

describe("backfill: only the index's fields are read", () => {
  test("a big field outside the index is not selected; escaped values (NaN, -0) and absent fields keyed as live", () => {
    const rows = docs(120, 9).map((d, i) => ({
      ...d,
      // A big field no index reads: not in the batch's read (was decoded whole for every row).
      status: "x".repeat(4000),
      // Values a REAL column cannot hold go to `_json`: still read for those rows.
      amount: i % 7 === 0 ? NaN : i % 11 === 0 ? -0 : d.amount,
    }));
    const { live, staged, step } = liveAndBackfilled(indexed, rows, 50);
    const r = cost(staged.driver, step);
    const read = r.sql.find((s) => /FROM "orders" WHERE "_rowid" >/.test(s))!;
    expect(read).toMatch(/"shop"/);
    expect(read).toMatch(/"amount"/);
    expect(read).not.toMatch(/"status"|"tag"|"qty"/);
    expect(read).toMatch(/CASE WHEN "shop" IS NULL OR "amount" IS NULL THEN "_json" ELSE '\{\}' END/);
    while (!step().done);
    const decoded = staged.engine.runQuery(Q((db) => db.query("orders").collect())).value as any[];
    expect(keys(staged.driver).map(([, k]) => k)).toEqual(decoded.map((d) => Buffer.from(docKey(d, ["shop", "amount", "_creationTime", "_id"])).toString("hex")));
    const order = (e: typeof live.engine) => (e.runQuery(Q((db) => db.query("orders").withIndex("by_shop").collect())).value as any[]).map((d) => [d.shop, Object.is(d.amount, -0) ? "-0" : d.amount]);
    expect(order(staged.engine)).toEqual(order(live.engine));
  });

  test("aggregates read their group, sum and min/max fields only, and match the live result", () => {
    const rows = docs(150, 4).map((d, i) => ({ ...d, status: i % 2 ? "new" : "paid" }));
    const { live, staged, step } = liveAndBackfilled(defineSchema({ tables: { orders: defineTable(fields).aggregate("per_shop", { by: ["shop"], sum: ["qty"], min: ["tag"] }) } }), rows, 40);
    const r = cost(staged.driver, step);
    const read = r.sql.find((s) => /FROM "orders" WHERE "_rowid" >/.test(s))!;
    expect(read).toMatch(/"shop".*"qty".*"tag"|"shop".*"tag".*"qty"/);
    expect(read).not.toMatch(/"status"|"amount"/);
    while (!step().done);
    expect(aggregateTables(staged.driver)).toEqual(aggregateTables(live.driver));
  });
});

describe("backfill: aggregates accumulated per group", () => {
  test("count-only aggregate: one write per group touched by the batch (3, was 500)", () => {
    const { staged, step } = liveAndBackfilled(counted, docs(500), 500);
    const r = cost(staged.driver, step);
    expect(r.value).toMatchObject({ processed: 500, indexReady: true });
    const writes = r.sql.filter((s) => s.includes(`"orders__n"`));
    expect(writes).toHaveLength(3);
    expect(r.rowsWritten).toBeLessThanOrEqual(3 + 1); // the groups, the finished job
  });

  test("sums, min/max multisets: one read + one write per group, one write per distinct (field, value)", () => {
    const rows = docs(500, 7);
    const { staged, step } = liveAndBackfilled(defineSchema({ tables: { orders: defineTable(fields).aggregate("per_shop", { by: ["shop"], sum: ["amount"], max: ["tag"] }) } }), rows, 500);
    const r = cost(staged.driver, step);
    const distinct = new Set(rows.filter((d) => d.tag !== undefined).map((d) => `${d.shop}/${d.tag}`)).size;
    expect(r.sql.filter((s) => s.startsWith(`INSERT INTO "orders__per_shop" `))).toHaveLength(3);
    expect(r.sql.filter((s) => s.startsWith(`SELECT "count", "v" FROM "orders__per_shop"`))).toHaveLength(3);
    expect(r.sql.filter((s) => s.includes(`"orders__per_shop__mm"`))).toHaveLength(distinct);
    expect(distinct).toBeLessThan(20);
  });

  test.each([1, 7, 128, 500, 1000])("bit-identical to row-by-row maintenance (float and int64 sums, min/max, empty group key), batches of %i", (limit) => {
    // A second pass over existing groups: the first batches create them, later ones read and extend them.
    const { live, staged, step } = liveAndBackfilled(full, docs(777, 3), limit);
    while (!step().done);
    expect(aggregateTables(staged.driver)).toEqual(aggregateTables(live.driver));
  });

  test("a failure mid-batch leaves the cursor where it was; resumed, the result is exact (nothing counted twice)", () => {
    const { live, staged, step } = liveAndBackfilled(full, docs(900, 11), 400);
    step(); // first batch committed
    const before = aggregateTables(staged.driver);
    const cursor = () => staged.driver.exec(`SELECT "name", "cursor" FROM "_ember_indexes" ORDER BY "name"`).rows;
    const at = cursor();
    const exec = staged.driver.exec;
    let n = 0;
    staged.driver.exec = (s, ...p) => {
      if (s.startsWith(`INSERT INTO "orders__`) && ++n === 2) throw new Error("boom");
      return exec.call(staged.driver, s, ...p);
    };
    expect(step).toThrow("boom");
    staged.driver.exec = exec;
    expect(cursor()).toEqual(at);
    expect(aggregateTables(staged.driver)).toEqual(before);
    while (!step().done);
    expect(aggregateTables(staged.driver)).toEqual(aggregateTables(live.driver));
  });

  test("writes during the backfill: rows behind the cursor live, rows in the window by the backfill, exact at the end", () => {
    // Integer amounts: with writes in between, live maintenance adds a group's values in another order than the
    // backfill does, and float sums depend on that order (as they did before the batching).
    const rows = docs(600, 5).map((d) => ({ ...d, amount: Math.round(d.amount * 10) }));
    const { live, staged, step } = liveAndBackfilled(full, rows, 128);
    const ids = staged.engine.runQuery(Q((db) => db.query("orders").collect())).value as any[];
    const liveIds = live.engine.runQuery(Q((db) => db.query("orders").collect())).value as any[];
    const both = (fn: (db: any, i: number) => void) => {
      for (const [s, list] of [[staged, ids], [live, liveIds]] as const) {
        s.engine.runMutation(mutationGeneric((ctx: any) => fn({ ...ctx.db, id: (i: number) => list[i]._id, db: ctx.db }, 0)) as any);
      }
    };
    for (let k = 0; ; k++) {
      both((x) => {
        x.db.patch(x.id((k * 37) % 300), { shop: "c", amount: 25 });
        x.db.delete(x.id(599 - k));
        x.db.insert("orders", { shop: "d", status: "new", amount: k });
      });
      if (step().done) break;
    }
    // Same documents on both sides; the backfilled aggregate equals the oracle of those documents.
    const agg = (s: typeof live) => s.engine.runQuery(Q((db) => ["per_shop", "per_status", "total", "n"].map((a) => db.aggregate("orders", a).range()))).value;
    expect(agg(staged)).toEqual(agg(live));
  });
});

describe("backfill: a projected row keys exactly like the whole document", () => {
  // Typed columns hold top-level scalars only (columnSpecFor): an object field, and so every dotted path, lives in
  // `_json`, which projectLayout then always selects. Random documents (nested objects, absent/optional fields,
  // nulls, NaN/-0/±Infinity) and random path sets: the projected decode yields the same key as the full decode.
  const nested = {
    shop: v.string(),
    amount: v.number(),
    qty: v.optional(v.int64()),
    note: v.union(v.string(), v.null()),
    flag: v.optional(v.boolean()),
    any: v.union(v.string(), v.number()),
    meta: v.object({ kind: v.string(), n: v.optional(v.number()), deep: v.optional(v.object({ x: v.number() })) }),
    opt: v.optional(v.object({ x: v.number(), y: v.optional(v.string()) })),
  };
  const PATHS = ["shop", "amount", "qty", "note", "flag", "any", "meta", "meta.kind", "meta.n", "meta.deep", "meta.deep.x", "opt", "opt.x", "opt.y", "shop.x", "amount.y", "_creationTime", "_id"];
  const odd = [NaN, -0, Infinity, -Infinity, 0, 1.5];
  function nestedDocs(n: number, seed: number) {
    const rnd = prng(seed);
    const num = () => (rnd() < 0.3 ? odd[Math.floor(rnd() * odd.length)]! : Math.floor(rnd() * 100) / 10);
    return Array.from({ length: n }, () => ({
      shop: ["a", "b", ""][Math.floor(rnd() * 3)]!,
      amount: num(),
      ...(rnd() < 0.5 ? { qty: BigInt(Math.floor(rnd() * 9) - 4) } : {}),
      note: rnd() < 0.4 ? null : `n${Math.floor(rnd() * 3)}`,
      ...(rnd() < 0.5 ? { flag: rnd() < 0.5 } : {}),
      any: rnd() < 0.5 ? `s${Math.floor(rnd() * 3)}` : num(),
      meta: { kind: ["k1", "k2"][Math.floor(rnd() * 2)]!, ...(rnd() < 0.5 ? { n: num() } : {}), ...(rnd() < 0.5 ? { deep: { x: num() } } : {}) },
      ...(rnd() < 0.5 ? { opt: { x: num(), ...(rnd() < 0.5 ? { y: "y" } : {}) } } : {}),
    }));
  }

  test("projected vs full decode, 300 documents × 200 random path sets", async () => {
    const { layoutOf, projectLayout, decodeRow, fieldOf } = await import("../src/layout.ts");
    const schema = defineSchema({ tables: { orders: defineTable(nested) } });
    const s = shard(schema);
    s.insertAll(nestedDocs(300, 21));
    const layout = layoutOf("orders", (schema as any).manifest.tables.orders.document);
    const full = s.driver.exec(`SELECT * FROM "orders" ORDER BY "_rowid"`).rows.map((r) => decodeRow(layout, r) as Record<string, unknown>);
    const rnd = prng(5);
    for (let t = 0; t < 200; t++) {
      const paths = PATHS.filter(() => rnd() < 0.3);
      if (!paths.length) paths.push(PATHS[Math.floor(rnd() * PATHS.length)]!);
      const p = projectLayout(layout, paths);
      const got = s.driver.exec(`SELECT ${p.select} FROM "orders" ORDER BY "_rowid"`).rows.map((r) => decodeRow(p.layout, r) as Record<string, unknown>);
      for (let i = 0; i < full.length; i++) {
        const key = (d: Record<string, unknown>) => Buffer.from(docKey(d as any, paths)).toString("hex");
        expect(key(got[i]!), `${paths.join(",")} row ${i}`).toBe(key(full[i]!));
        for (const path of paths) expect(Object.is(fieldOf(got[i]!, path), fieldOf(full[i]!, path)) || typeof fieldOf(full[i]!, path) === "object").toBe(true);
      }
    }
  });

  test("db index and aggregate over dotted paths: backfilled = live", () => {
    const rows = nestedDocs(200, 33);
    const base = defineTable(nested);
    const schema = defineSchema({
      tables: {
        orders: defineTable(nested)
          .index("by_kind", ["meta.kind", "meta.n", "opt.x"])
          .aggregate("per_kind", { by: ["meta.kind"], sum: ["meta.n"], min: ["opt.x"], max: ["meta.deep.x"] }),
      },
    });
    const live = shard(schema);
    live.insertAll(rows);
    const staged = shard(defineSchema({ tables: { orders: base } }));
    staged.insertAll(rows);
    const s2 = shard(schema, staged.driver);
    expect(s2.engine.migrate().staged.length).toBeGreaterThan(0);
    while (!s2.engine.backfillStep(37).done);
    const k = (d: NodeSqliteDriver) => d.exec(`SELECT "_k_by_kind" AS k FROM "orders" ORDER BY "_rowid"`).rows.map((r) => Buffer.from(r.k as Uint8Array).toString("hex"));
    const decoded = s2.engine.runQuery(Q((db) => db.query("orders").collect())).value as any[];
    expect(k(staged.driver)).toEqual(decoded.map((d) => Buffer.from(docKey(d, ["meta.kind", "meta.n", "opt.x", "_creationTime", "_id"])).toString("hex")));
    const order = (e: typeof live.engine) => (e.runQuery(Q((db) => db.query("orders").withIndex("by_kind").collect())).value as any[]).map((d) => JSON.stringify([d.meta, d.opt ?? null, String(d.amount)]));
    expect(order(s2.engine)).toEqual(order(live.engine));
    expect(aggregateTables(staged.driver)).toEqual(aggregateTables(live.driver));
  });
});
