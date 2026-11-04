// Materialized aggregates: maintained in the write transaction, O(1) reads, exact under a fuzz of inserts,
// group-moving updates and deletes, reactive per group, staged backfill on migration.

import { describe, expect, test } from "vitest";
import { compareValues } from "@freecorps/ember-values";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  createEngine,
  createMatchIndex,
  defineSchema,
  defineTable,
  mutationGeneric,
  queryGeneric,
  v,
  type DataModelFromSchema,
  type QueryCtx,
} from "../src/index.ts";
import { fresh, prng } from "./fixtures.ts";

const orderFields = {
  shop: v.string(),
  status: v.string(),
  amount: v.number(),
  qty: v.optional(v.int64()),
  tag: v.optional(v.string()),
  note: v.optional(v.string()),
};
const schema = defineSchema({
  tables: {
    orders: defineTable(orderFields)
      .index("by_shop", ["shop"])
      .aggregate("per_shop", { by: ["shop"], count: true, sum: ["amount", "qty"], min: ["amount"], max: ["amount", "tag"] })
      .aggregate("per_shop_status", { by: ["shop", "status"], sum: ["amount"] })
      .aggregate("total", { by: [], sum: ["amount"] }),
  },
});
type DM = DataModelFromSchema<typeof schema>;

const Q = (handler: (db: any) => unknown) => queryGeneric({ handler: (ctx: QueryCtx) => handler(ctx.db) }) as any;

/** Recomputes an aggregate from the documents (the oracle). */
function oracle(docs: any[], by: string[], sum: string[], min: string[], max: string[]) {
  const groups = new Map<string, { group: unknown[]; count: number; sum: any; min: any; max: any }>();
  for (const d of docs) {
    const group = by.map((f) => d[f]);
    const k = JSON.stringify(group);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { group, count: 0, sum: {}, min: {}, max: {} }));
    g.count++;
    for (const f of sum) {
      const x = d[f];
      const init = f === "qty" ? 0n : 0;
      g.sum[f] ??= init;
      if (x !== undefined) g.sum[f] += x;
    }
    for (const f of min) {
      g.min[f] ??= null;
      if (d[f] !== undefined && (g.min[f] === null || compareValues(d[f], g.min[f]) < 0)) g.min[f] = d[f];
    }
    for (const f of max) {
      g.max[f] ??= null;
      if (d[f] !== undefined && (g.max[f] === null || compareValues(d[f], g.max[f]) > 0)) g.max[f] = d[f];
    }
  }
  return [...groups.values()].sort((a, b) => compareValues(a.group, b.group));
}

function setup(opts: { schema?: any } = {}) {
  const env = fresh({ schema: opts.schema ?? schema });
  const order = (shop: string, amount: number, extra: Record<string, unknown> = {}) =>
    env.insert("orders", { shop, status: "new", amount, ...extra });
  const agg = (name: string, group: unknown[]) => env.run((db: any) => db.aggregate("orders", name).get(group)).value as any;
  return { ...env, order, agg };
}

describe("aggregates: values", () => {
  test("count / sum / min / max per group, through insert, patch, replace and delete", () => {
    const s = setup();
    const a = s.order("a", 10, { qty: 2n, tag: "x" });
    s.order("a", 5, { qty: 3n });
    const c = s.order("b", 7, { tag: "z" });
    expect(s.agg("per_shop", ["a"])).toEqual({ count: 2, sum: { amount: 15, qty: 5n }, min: { amount: 5 }, max: { amount: 10, tag: "x" } });
    expect(s.agg("per_shop", ["b"])).toEqual({ count: 1, sum: { amount: 7, qty: 0n }, min: { amount: 7 }, max: { amount: 7, tag: "z" } });
    expect(s.agg("total", [])).toMatchObject({ count: 3, sum: { amount: 22 } });

    // patch moves a document between groups
    s.patch(a, { shop: "b" });
    expect(s.agg("per_shop", ["a"])).toEqual({ count: 1, sum: { amount: 5, qty: 3n }, min: { amount: 5 }, max: { amount: 5, tag: null } });
    expect(s.agg("per_shop", ["b"])).toEqual({ count: 2, sum: { amount: 17, qty: 2n }, min: { amount: 7 }, max: { amount: 10, tag: "z" } });

    // deleting the max recomputes it from the multiset (one seek)
    s.del(a);
    expect(s.agg("per_shop", ["b"])).toEqual({ count: 1, sum: { amount: 7, qty: 0n }, min: { amount: 7 }, max: { amount: 7, tag: "z" } });
    s.tx((db) => db.replace(c as any, { shop: "b", status: "paid", amount: 1 } as any));
    expect(s.agg("per_shop", ["b"])).toEqual({ count: 1, sum: { amount: 1, qty: 0n }, min: { amount: 1 }, max: { amount: 1, tag: null } });
    expect(s.agg("per_shop_status", ["b", "paid"])).toEqual({ count: 1, sum: { amount: 1 }, min: {}, max: {} });
    expect(s.agg("per_shop_status", ["b", "new"])).toEqual({ count: 0, sum: { amount: 0 }, min: {}, max: {} });

    // an empty group leaves no row behind
    s.del(c);
    expect(s.sql(`SELECT count(*) AS n FROM "orders__per_shop" WHERE 1`)[0]!.n).toBe(1);
    expect(s.agg("per_shop", ["b"]).count).toBe(0);
  });

  test("range(): groups in key order, eq prefix + bounds, order and limit", () => {
    const s = setup();
    for (const [shop, status, amount] of [["a", "new", 1], ["a", "paid", 2], ["a", "paid", 3], ["b", "new", 4], ["c", "void", 5]] as const) {
      s.order(shop, amount, { status });
    }
    const rows = s.run((db: any) => db.aggregate("orders", "per_shop").range()).value as any[];
    expect(rows.map((r) => [r.group, r.count, r.sum.amount])).toEqual([[["a"], 3, 6], [["b"], 1, 4], [["c"], 1, 5]]);
    const a = s.run((db: any) => db.aggregate("orders", "per_shop_status").range((q: any) => q.eq("shop", "a"))).value as any[];
    expect(a.map((r) => [r.group, r.count])).toEqual([[["a", "new"], 1], [["a", "paid"], 2]]);
    const gt = s.run((db: any) => db.aggregate("orders", "per_shop").range((q: any) => q.gt("shop", "a"), { order: "desc", limit: 1 })).value as any[];
    expect(gt.map((r) => r.group)).toEqual([["c"]]);
    expect(() => s.run((db: any) => db.aggregate("orders", "per_shop_status").range((q: any) => q.eq("status", "x")))).toThrow(/must be on shop/);
    expect(() => s.run((db: any) => db.aggregate("orders", "per_shop").get("a"))).toThrow(/get\(\) needs/);
    expect(() => s.run((db: any) => db.aggregate("orders", "nope"))).toThrow(/not found/);
  });

  test("O(1): a read is one primary-key lookup whatever the table size; a write touches a constant number of rows", () => {
    const s = setup();
    const measure = (fn: () => void) => {
      const before = s.driver.statements;
      fn();
      return s.driver.statements - before;
    };
    const readCost = () => measure(() => s.agg("per_shop", ["a"]));
    s.order("a", 1);
    const small = readCost();
    const writeSmall = measure(() => s.order("a", 2));
    // (aggregate rows count against the 8k written-rows limit too: insert in a few transactions)
    for (let b = 0; b < 3; b++) {
      s.tx((db) => {
        for (let i = 0; i < 1000; i++) db.insert("orders", { shop: i % 2 ? "a" : "b", status: "new", amount: i } as any);
      });
    }
    expect(readCost()).toBe(small);
    expect(measure(() => s.order("a", 3))).toBe(writeSmall);
    // and it reads one row (rowsRead), not the group
    const r = s.engine.runQuery(Q((db: any) => db.aggregate("orders", "per_shop").get(["a"])));
    expect(r.value).toMatchObject({ count: 1503 });
    expect(small).toBe(1);
  });

  test("fuzz: inserts, group-moving patches and deletes always equal a recomputation", () => {
    const s = setup();
    const rnd = prng(7);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const shops = ["a", "b", "c", "d"];
    const statuses = ["new", "paid", "void"];
    const live: string[] = [];
    const doc = () => ({
      shop: pick(shops),
      status: pick(statuses),
      amount: Math.floor(rnd() * 100) - 20,
      ...(rnd() < 0.6 ? { qty: BigInt(Math.floor(rnd() * 10)) } : {}),
      ...(rnd() < 0.5 ? { tag: pick(["p", "q", "r", "s"]) } : {}),
    });
    for (let step = 0; step < 400; step++) {
      // a mutation does 1-4 operations, sometimes on the same document
      s.tx((db) => {
        const ops = 1 + Math.floor(rnd() * 4);
        for (let k = 0; k < ops; k++) {
          const r = rnd();
          if (r < 0.45 || live.length < 3) live.push(db.insert("orders", doc() as any) as string);
          else if (r < 0.8) {
            const id = pick(live);
            const p: Record<string, unknown> = {};
            if (rnd() < 0.5) p.shop = pick(shops);
            if (rnd() < 0.4) p.status = pick(statuses);
            if (rnd() < 0.5) p.amount = Math.floor(rnd() * 100) - 20;
            if (rnd() < 0.3) p.tag = rnd() < 0.5 ? undefined : pick(["p", "q", "r", "s"]);
            if (rnd() < 0.2) p.note = "n";
            db.patch(id as any, p as any);
          } else if (r < 0.9) {
            db.increment(pick(live) as any, "amount", Math.floor(rnd() * 7) - 3);
          } else {
            const i = Math.floor(rnd() * live.length);
            db.delete(live[i] as any);
            live.splice(i, 1);
          }
        }
      });
      if (step % 20 !== 19) continue;
      const docs = s.run((db) => db.query("orders").collect()).value as any[];
      const got = (name: string) => s.run((db: any) => db.aggregate("orders", name).range()).value as any[];
      expect(got("per_shop")).toEqual(oracle(docs, ["shop"], ["amount", "qty"], ["amount"], ["amount", "tag"]));
      expect(got("per_shop_status")).toEqual(oracle(docs, ["shop", "status"], ["amount"], [], []));
      expect(got("total")).toEqual(oracle(docs, [], ["amount"], [], []));
    }
    // the min/max multiset holds exactly the live values
    const docs = s.run((db) => db.query("orders").collect()).value as any[];
    const expected = docs.filter((d) => d.amount !== undefined).length + docs.filter((d) => d.tag !== undefined).length;
    expect(Number(s.sql(`SELECT coalesce(sum("n"), 0) AS n FROM "orders__per_shop__mm" WHERE 1`)[0]!.n)).toBe(expected);
  });
});

describe("aggregates: reactivity", () => {
  test("a group read is invalidated only by changes to that group's aggregate row", () => {
    const s = setup();
    const a1 = s.order("a", 1);
    s.order("b", 2);
    const getA = Q((db: any) => db.aggregate("orders", "per_shop").get(["a"]));
    const rangeAll = Q((db: any) => db.aggregate("orders", "per_shop_status").range((q: any) => q.eq("shop", "a")));
    const index = createMatchIndex<string>(schema);
    const subs = { getA: s.engine.runQuery(getA), rangeA: s.engine.runQuery(rangeAll) };
    index.set("getA", subs.getA.readSet);
    index.set("rangeA", subs.rangeA.readSet);
    const hits = (changes: any[]) => {
      const byEngine = Object.entries(subs)
        .filter(([, r]) => s.engine.matches(r.readSet, changes))
        .map(([k]) => k)
        .sort();
      expect([...index.match(changes).exact].sort()).toEqual(byEngine);
      return byEngine;
    };
    expect(hits(s.tx((db) => db.insert("orders", { shop: "b", status: "new", amount: 3 } as any)).changes)).toEqual([]);
    expect(hits(s.tx((db) => db.insert("orders", { shop: "a", status: "new", amount: 3 } as any)).changes)).toEqual(["getA", "rangeA"]);
    // a field no aggregate uses: no aggregate row changes, nothing to re-run
    const noteOnly = s.patch(a1, { note: "hello" });
    expect(noteOnly.changes.map((c: any) => c.table)).toEqual(["orders"]);
    expect(hits(noteOnly.changes)).toEqual([]);
    // status only feeds per_shop_status
    expect(hits(s.patch(a1, { status: "paid" }).changes)).toEqual(["rangeA"]);
    // +1 then -1 in one mutation: the aggregate came back, no change reported
    const back = s.tx((db) => {
      const id = db.insert("orders", { shop: "a", status: "new", amount: 9 } as any);
      db.delete(id);
    });
    expect(back.changes).toEqual([]);
  });

  test("errored queries learn the pseudo-table through `touched`", () => {
    const s = setup();
    const touched = new Set<string>();
    s.engine.runQuery(Q((db: any) => db.aggregate("orders", "per_shop").get(["a"])), {}, undefined, { touched });
    expect([...touched]).toEqual(["orders__per_shop"]);
  });
});

describe("aggregates: migration backfill", () => {
  const v1 = defineSchema({ tables: { orders: defineTable(orderFields) } });

  test("new aggregate on a table with data: staged, chunked, exact despite concurrent writes", () => {
    const driver = createNodeSqliteDriver();
    let clock = 1_700_000_000_000;
    const open = (sc: any) => createEngine({ schema: sc, driver, now: () => (clock += 1) });
    const e1 = open(v1);
    e1.migrate();
    const ids = e1.runMutation(
      mutationGeneric((ctx: any) => {
        const out: string[] = [];
        for (let i = 0; i < 1300; i++) out.push(ctx.db.insert("orders", { shop: ["a", "b", "c"][i % 3], status: "new", amount: i % 50, ...(i % 4 ? { tag: `t${i % 7}` } : {}) }));
        return out;
      }) as any,
    ).value as string[];

    const e2 = open(schema);
    const report = e2.migrate();
    expect(report.staged.map((x) => x.index).sort()).toEqual(["by_shop", "per_shop", "per_shop_status", "total"]);
    expect(() => e2.runQuery(Q((db: any) => db.aggregate("orders", "per_shop").get(["a"])))).toThrow(/backfilling/);

    const mut = (fn: (db: any) => void) => e2.runMutation(mutationGeneric((ctx: any) => fn(ctx.db)) as any);
    let steps = 0;
    for (;;) {
      // writes between chunks: rows already aggregated, rows still in the window, and new rows
      mut((db) => {
        db.patch(ids[(steps * 97) % 590]!, { shop: "c", amount: 1 });
        db.patch(ids[1299 - steps * 13]!, { shop: "a" });
        db.delete(ids[600 + steps]!);
        db.insert("orders", { shop: "d", status: "new", amount: steps });
        db.increment(ids[(5 + steps * 31) % 590]!, "amount", 2);
      });
      steps++;
      const p = e2.backfillStep(250);
      if (p.done) break;
    }
    expect(steps).toBeGreaterThan(5);
    const docs = e2.runQuery(Q((db: any) => db.query("orders").collect())).value as any[];
    const got = (name: string) => e2.runQuery(Q((db: any) => db.aggregate("orders", name).range())).value;
    expect(got("per_shop")).toEqual(oracle(docs, ["shop"], ["amount", "qty"], ["amount"], ["amount", "tag"]));
    expect(got("per_shop_status")).toEqual(oracle(docs, ["shop", "status"], ["amount"], [], []));
    expect(got("total")).toEqual(oracle(docs, [], ["amount"], [], []));

    // removing the aggregates (and by_shop) drops their tables
    expect(open(v1).migrate().steps.filter((s) => s.op === "dropIndex").length).toBe(4);
    expect(driver.exec(`SELECT name FROM sqlite_master WHERE name LIKE 'orders__per%'`).rows).toEqual([]);
  });

  test("schema validation", () => {
    expect(() => defineSchema({ tables: { t: defineTable({ a: v.string() }).aggregate("x", { by: ["a"], sum: ["a"] as any }) } })).toThrow(/number or int64/);
    expect(() => defineSchema({ tables: { t: defineTable({ a: v.string() }).aggregate("x", { by: ["b" as any] }) } })).toThrow(/unknown field/);
    expect(() => defineSchema({ tables: { t: defineTable({ a: v.string() }).index("x", ["a"]).aggregate("x", { by: ["a"] }) } })).toThrow(/duplicate/);
  });
});

// Static types (checked by tsc, not run).
export function typed(ctx: QueryCtx<DM>) {
  const g = ctx.db.aggregate("orders", "per_shop").get(["a"]);
  const n: number = g.count + g.sum.amount;
  const q: bigint = g.sum.qty;
  const m: number | null = g.min.amount;
  const t: string | null = g.max.tag;
  // @ts-expect-error not configured
  void g.min.tag;
  // @ts-expect-error unknown aggregate
  ctx.db.aggregate("orders", "nope");
  const rows = ctx.db.aggregate("orders", "per_shop_status").range((r) => r.eq("shop", "a"));
  const s: string = rows[0]!.group[1];
  return [n, q, m, t, s];
}
