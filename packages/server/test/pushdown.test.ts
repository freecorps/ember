// `.filter()` pushed to SQLite (pushdown.ts, PR 3b): equivalence with the JS evaluation it replaces.
//
// 1. Per row: the SQL verdict, when it is not NULL, is exactly `passes(filter, doc)` (random documents with escaped
//    values, absent and null fields, surrogates; random expressions with literals of every type).
// 2. Per run: an engine with the pushdown and one without return the same documents, cursors, read sets and usage
//    (rowsRead, documentsRead) for take / first / collect / paginate, both orders, with and without an index, in
//    queries and mutations, on compact formats 2 and 3 and classic storage, through array rows and object rows.

import { describe, expect, it } from "vitest";
import { v } from "@freecorps/ember-values";
import { createNodeSqliteDriver } from "../src/testing.ts";
import { createEngine, defineSchema, defineTable, mutationGeneric, queryGeneric, type SqlDriver } from "../src/index.ts";
import { passes } from "../src/filter.ts";
import { decodeRow, decodeValues, layoutOf } from "../src/layout.ts";
import { MAX_PUSHED_NODES, MAX_PUSHED_SQL, pushFilter } from "../src/pushdown.ts";
import type { Doc, FilterExpr } from "../src/types.ts";
import { prng } from "./fixtures.ts";

const document = {
  s: v.string(),
  os: v.optional(v.string()),
  ns: v.union(v.string(), v.null()),
  n: v.number(),
  on: v.optional(v.number()),
  nn: v.union(v.number(), v.null()),
  b: v.boolean(),
  ob: v.optional(v.boolean()),
  lit: v.union(v.literal("a"), v.literal("b")),
  big: v.optional(v.int64()),
  bytes: v.optional(v.bytes()),
  arr: v.optional(v.array(v.number())),
  obj: v.optional(v.object({ x: v.number(), y: v.optional(v.string()) })),
  any: v.optional(v.any()),
};
const schema = defineSchema({
  tables: {
    t: defineTable(document).index("by_s", ["s"]).index("by_n", ["n"]).index("by_b_n", ["b", "n"]),
  },
});

type R = () => number;
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const STRINGS = ["", "a", "b", "ab", "B", "é", "ação", "😀", "￿", "", "z😀", "a\u0000", "\ud800", "x\udc00y", "10", "9"];
const NUMBERS = [0, -0, 1, -1, 2.5, 1e21, -1e-7, NaN, Infinity, -Infinity, 3, 42, 2 ** 53 + 2];

function randomDoc(r: R): Record<string, unknown> {
  const d: Record<string, unknown> = {
    s: pick(r, STRINGS),
    ns: r() < 0.3 ? null : pick(r, STRINGS),
    n: pick(r, NUMBERS),
    nn: r() < 0.3 ? null : pick(r, NUMBERS),
    b: r() < 0.5,
    lit: r() < 0.5 ? "a" : "b",
  };
  if (r() < 0.6) d.os = pick(r, STRINGS);
  if (r() < 0.6) d.on = pick(r, NUMBERS);
  if (r() < 0.6) d.ob = r() < 0.5;
  if (r() < 0.3) d.big = BigInt(Math.floor(r() * 100) - 50);
  if (r() < 0.3) d.bytes = new Uint8Array([Math.floor(r() * 4)]);
  if (r() < 0.3) d.arr = [pick(r, NUMBERS)];
  if (r() < 0.4) d.obj = r() < 0.5 ? { x: pick(r, NUMBERS) } : { x: pick(r, NUMBERS), y: pick(r, STRINGS) };
  if (r() < 0.3) d.any = pick(r, [1, "a", null, true, [1], { s: "a" }, 5n]);
  return d;
}

const FIELDS = ["s", "os", "ns", "n", "on", "nn", "b", "ob", "lit", "big", "bytes", "arr", "obj", "obj.x", "obj.y", "any", "_id", "_creationTime", "missing"];
const LITERALS: Array<() => unknown> = [
  ...STRINGS.map((x) => () => x),
  ...NUMBERS.map((x) => () => x),
  () => true,
  () => false,
  () => null,
  () => undefined,
  () => 0n,
  () => 7n,
  () => new Uint8Array([1]),
];

const CMP = ["eq", "neq", "lt", "lte", "gt", "gte"] as const;

function randomExpr(r: R, depth = 0): FilterExpr {
  const k = r();
  if (depth < 3 && k < 0.15) return { op: "and", args: Array.from({ length: Math.floor(r() * 3) + (r() < 0.1 ? 0 : 1) }, () => randomExpr(r, depth + 1)) };
  if (depth < 3 && k < 0.28) return { op: "or", args: Array.from({ length: Math.floor(r() * 3) + (r() < 0.1 ? 0 : 1) }, () => randomExpr(r, depth + 1)) };
  if (depth < 3 && k < 0.36) return { op: "not", args: [randomExpr(r, depth + 1)] };
  if (k < 0.38) return { field: pick(r, ["b", "ob", "s"]) };
  if (k < 0.4) return { literal: pick(r, [true, false, 1]) };
  // Mostly a typed field against a literal of its type (what SQLite compares), else anything.
  const typed = r() < 0.7;
  const path = typed ? pick(r, Object.keys(TYPED)) : pick(r, FIELDS);
  const field: FilterExpr = { field: path };
  const literal: FilterExpr = r() < 0.06 ? { field: pick(r, FIELDS) } : { literal: typed && r() < 0.8 ? pick(r, TYPED[path]!)() : pick(r, LITERALS)() };
  return { op: pick(r, CMP), args: r() < 0.8 ? [field, literal] : [literal, field] };
}

const strings = STRINGS.map((x) => () => x);
const numbers = [...NUMBERS, 1_700_000_000_050, 1_700_000_000_120.5].map((x) => () => x);
const booleans = [() => true, () => false];
/** Fields SQLite reads (typed columns, `_id`, `_creationTime`) and literals of their type. */
const TYPED: Record<string, Array<() => unknown>> = {
  s: strings,
  os: strings,
  ns: [...strings, () => null],
  lit: [() => "a", () => "b", () => "c"],
  n: numbers,
  on: [...numbers, () => undefined],
  nn: [...numbers, () => null],
  b: booleans,
  ob: [...booleans, () => undefined],
  _creationTime: numbers,
  _id: [() => "t_", () => "t_01HF7YAT2R00RT3DKDXHTV5WH3", () => "u"],
};

/** `e` through the `.filter()` builder (what a handler writes), so the run gets the same expression. */
function built(q: any, e: FilterExpr): unknown {
  if ("field" in e) return q.field(e.field);
  if ("literal" in e) return e.literal;
  return q[e.op](...e.args.map((a) => built(q, a)));
}

/** An engine over node:sqlite; `objects`: a driver without `execRaw` (object rows only). */
function engine(o: { pushdown: boolean; storage?: "compact" | "classic"; format?: 2 | 3; objects?: boolean }) {
  const inner = createNodeSqliteDriver();
  const driver: SqlDriver = o.objects ? { exec: (q, ...p) => inner.exec(q, ...p), transaction: (fn) => inner.transaction(fn), truncatesTextAtNul: inner.truncatesTextAtNul === true } : inner;
  let clock = 1_700_000_000_000;
  const e = createEngine({
    schema,
    driver,
    now: () => (clock += 1),
    random: prng(7),
    filterPushdown: o.pushdown,
    ...(o.storage ? { tableStorage: o.storage } : {}),
    ...(o.format ? { compactFormat: o.format } : {}),
  });
  e.migrate();
  return { e, inner };
}

function seed(e: ReturnType<typeof engine>["e"], docs: Record<string, unknown>[]) {
  for (const d of docs) e.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.db.insert("t", d) }) as any, {});
}

describe("the SQL verdict is passes() wherever it decides", () => {
  it("random documents × random expressions", () => {
    const r = prng(1234);
    const { e, inner } = engine({ pushdown: true });
    const docs = Array.from({ length: 300 }, () => randomDoc(r));
    seed(e, docs);
    // Texts as DO SQLite stores a lone surrogate (WTF-8 bytes, read back as U+FFFD each): SQLite must not decide them.
    inner.exec(`UPDATE "t" SET "s" = CAST(X'EDA080' AS TEXT) WHERE "_rowid" % 7 = 0`);
    inner.exec(`UPDATE "t" SET "os" = CAST(X'61EDB080' AS TEXT) WHERE "_rowid" % 5 = 0 AND "os" IS NOT NULL`);
    const layout = layoutOf("t", schema.manifest.tables.t!.document);
    const rows = inner.exec(`SELECT * FROM "t"`).rows;
    const decoded = rows.map((row) => decodeRow(layout, row));
    let decided = 0;
    let pushedExprs = 0;
    let rejected = 0;
    for (let i = 0; i < 1500; i++) {
      const f = randomExpr(r);
      const pushed = pushFilter(layout, f, !inner.truncatesTextAtNul);
      if (!pushed) continue;
      pushedExprs++;
      const verdicts = inner.exec(`SELECT "_rowid" AS rid, ${pushed.sql} AS m FROM "t"`, ...pushed.params).rows;
      for (let j = 0; j < verdicts.length; j++) {
        const m = verdicts[j]!.m;
        const doc = decoded[rows.findIndex((x) => x._rowid === verdicts[j]!.rid)]!;
        if (m === null) continue;
        decided++;
        if (m === 0) rejected++;
        const want = passes(f, doc as Doc);
        if ((m === 1) !== want) throw new Error(`verdict ${m} != passes ${want} for ${JSON.stringify(f, (_, x) => (typeof x === "bigint" ? `${x}n` : Number.isNaN(x) ? "NaN" : x))} on ${JSON.stringify(doc, (_, x) => (typeof x === "bigint" ? `${x}n` : x))}`);
      }
    }
    // The test means something: most expressions are pushed and most rows decided, both ways.
    expect(pushedExprs).toBeGreaterThan(700);
    expect(decided).toBeGreaterThan(100_000);
    expect(rejected).toBeGreaterThan(30_000);
    expect(decided - rejected).toBeGreaterThan(30_000);
  });

  it("not pushed: no decidable part, malformed nodes, non-primitive literals, field paths that are not strings", () => {
    const layout = layoutOf("t", schema.manifest.tables.t!.document);
    const none: unknown[] = [
      { field: "b" },
      { literal: true },
      { op: "eq", args: [{ field: "obj.x" }, { literal: 1 }] },
      { op: "eq", args: [{ field: "arr" }, { literal: 1 }] },
      { op: "eq", args: [{ field: "s" }, { literal: ["a"] }] },
      { op: "and", args: [{ op: "eq", args: [{ field: "n" }, { literal: 1 }] }, { op: "eq", args: [{ field: "any" }, { literal: { a: 1 } }] }] },
      { op: "eq", args: [{ field: 3 }, { literal: 1 }] },
      { op: "xor", args: [{ field: "n" }, { literal: 1 }] },
      { op: "eq", args: [{ field: "n" }] },
      { op: "and", args: "nope" },
      { op: "eq", args: [{ field: "n" }, { field: "on" }] },
    ];
    for (const f of none) expect(pushFilter(layout, f as FilterExpr, true)).toBeUndefined();
    // Decided without comparing: the type order and the empty `and` / `or`.
    expect(pushFilter(layout, { op: "lt", args: [{ field: "n" }, { literal: "x" }] }, true)?.params).toEqual([]);
    expect(pushFilter(layout, { op: "and", args: [] }, true)?.sql).toBe("1");
    // A string comparison is not pushed when the driver cuts TEXT at NUL; the type order still is.
    expect(pushFilter(layout, { op: "eq", args: [{ field: "s" }, { literal: "a" }] }, false)).toBeUndefined();
    expect(pushFilter(layout, { op: "eq", args: [{ field: "s" }, { literal: 1 }] }, false)).toBeDefined();
  });
});

type Run = { value: unknown; readSet: unknown; usage: unknown };

const strip = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (_, y) => (typeof y === "bigint" ? `${y}n` : y instanceof Uint8Array ? [...y] : Number.isNaN(y) ? "NaN" : Object.is(y, -0) ? "-0" : y)));

describe("array rows (SqlDriver.execRaw)", () => {
  it("decodeValues gives decodeRow's document, field order and escaped values included", () => {
    const r = prng(77);
    const { e, inner } = engine({ pushdown: true });
    seed(e, Array.from({ length: 300 }, () => randomDoc(r)));
    // A document with a field outside the schema (kept data), as older code may have written it.
    inner.exec(`UPDATE "t" SET "_json" = json_set("_json", '$.extra', 1) WHERE "_rowid" = (SELECT min("_rowid") FROM "t")`);
    const layout = layoutOf("t", schema.manifest.tables.t!.document);
    const cols = layout.dataColumns.map((c) => `"${c}"`).join(", ");
    const objects = inner.exec(`SELECT ${cols} FROM "t" ORDER BY "_rowid"`).rows;
    const arrays = inner.execRaw!(`SELECT "_rowid", ${cols} FROM "t" ORDER BY "_rowid"`).rows;
    expect(arrays).toHaveLength(objects.length);
    for (let i = 0; i < objects.length; i++) {
      const a = decodeRow(layout, objects[i]!);
      const b = decodeValues(layout, arrays[i]!, 1);
      expect(Object.keys(b)).toEqual(Object.keys(a));
      expect(strip(b)).toEqual(strip(a));
    }
    expect(Object.keys(decodeRow(layout, objects[0]!))).toContain("extra");
  });

  it("a query's db.get and scans read array rows; a driver without execRaw gives the same documents", () => {
    const r = prng(3);
    const docs = Array.from({ length: 50 }, () => randomDoc(r));
    const a = engine({ pushdown: true });
    const b = engine({ pushdown: true, objects: true });
    seed(a.e, docs);
    seed(b.e, docs);
    const fn = queryGeneric({
      handler: (ctx: any) => {
        const all = ctx.db.query("t").collect();
        return { all, got: all.map((d: Doc) => ctx.db.get(d._id)), page: ctx.db.query("t").withIndex("by_n", (q: any) => q.gt("n", 0)).order("desc").paginate({ numItems: 7, cursor: null }) };
      },
    }) as any;
    const x = a.e.runQuery(fn, {});
    const y = b.e.runQuery(fn, {});
    expect(strip(x)).toEqual(strip(y));
  });
});

describe("pushdown on × off: the same results, read sets and usage", () => {
  const variants: Array<{ name: string; storage?: "compact" | "classic"; format?: 2 | 3; objects?: boolean }> = [
    { name: "compact 3, array rows" },
    { name: "compact 3, object rows", objects: true },
    { name: "compact 2", format: 2 },
    { name: "classic", storage: "classic" },
  ];
  for (const variant of variants) {
    it(variant.name, () => {
      const r = prng(99);
      const docs = Array.from({ length: 240 }, () => randomDoc(r));
      const on = engine({ pushdown: true, ...variant });
      const off = engine({ pushdown: false, ...variant });
      seed(on.e, docs);
      seed(off.e, docs);
      const query = (e: ReturnType<typeof engine>["e"], build: (ctx: any) => unknown): Run => {
        try {
          const out = e.runQuery(queryGeneric({ handler: build as any }) as any, {});
          return { value: strip(out.value), readSet: strip(out.readSet), usage: strip(out.usage) };
        } catch (err) {
          return { value: `error ${(err as Error).message}`, readSet: null, usage: null };
        }
      };
      const mutate = (e: ReturnType<typeof engine>["e"], build: (ctx: any) => unknown): Run => {
        try {
          const out = e.runMutation(mutationGeneric({ handler: build as any }) as any, {});
          return { value: strip(out.value), readSet: null, usage: strip(out.usage) };
        } catch (err) {
          return { value: `error ${(err as Error).message}`, readSet: null, usage: null };
        }
      };
      let nonEmpty = 0;
      for (let i = 0; i < 160; i++) {
        const f = randomExpr(r);
        const pred = (q: any) => built(q, f);
        const order = r() < 0.5 ? "asc" : "desc";
        const n = pick(r, [0, 1, 3, 10, 50]);
        const index = pick(r, [undefined, "by_s", "by_n", "by_b_n"] as const);
        const base = (ctx: any) => {
          let qy = ctx.db.query("t");
          if (index === "by_s") qy = qy.withIndex("by_s", (q: any) => q.gte("s", "a"));
          if (index === "by_n") qy = qy.withIndex("by_n", (q: any) => q.lt("n", 40));
          if (index === "by_b_n") qy = qy.withIndex("by_b_n", (q: any) => q.eq("b", true));
          return qy.order(order).filter(pred);
        };
        const cases: Array<[string, (ctx: any) => unknown]> = [
          ["take", (ctx) => base(ctx).take(n)],
          ["first", (ctx) => base(ctx).first()],
          ["collect", (ctx) => base(ctx).collect()],
          [
            "paginate",
            (ctx) => {
              const p1 = base(ctx).paginate({ numItems: Math.max(1, n), cursor: null });
              const p2 = base(ctx).paginate({ numItems: Math.max(1, n), cursor: p1.continueCursor });
              const back = base(ctx).paginate({ numItems: 1, cursor: null, endCursor: p1.continueCursor });
              return [p1, p2, back];
            },
          ],
        ];
        for (const [name, build] of cases) {
          const a = query(on.e, build);
          const b = query(off.e, build);
          expect({ i, name, ...a }).toEqual({ i, name, ...b });
          if (name === "collect" && Array.isArray(a.value) && a.value.length) nonEmpty++;
        }
        const m1 = mutate(on.e, (ctx) => base(ctx).take(n).map((d: Doc) => d._id));
        const m2 = mutate(off.e, (ctx) => base(ctx).take(n).map((d: Doc) => d._id));
        expect({ i, ...m1 }).toEqual({ i, ...m2 });
      }
      // Most runs return documents (and so most filters keep some rows and drop others).
      expect(nonEmpty).toBeGreaterThan(50);
    });
  }

  it("a mutation that reads by filter then patches: the same rows written and the same documents", () => {
    const r = prng(5);
    const docs = Array.from({ length: 120 }, () => randomDoc(r));
    const on = engine({ pushdown: true });
    const off = engine({ pushdown: false });
    seed(on.e, docs);
    seed(off.e, docs);
    const fn = mutationGeneric({
      handler: (ctx: any) => {
        const hit = ctx.db.query("t").filter((q: any) => q.and(q.eq(q.field("b"), true), q.gt(q.field("n"), 0))).take(5);
        for (const d of hit) ctx.db.patch(d._id, { n: 1 });
        return hit.map((d: Doc) => d._id);
      },
    }) as any;
    const a = on.e.runMutation(fn, {});
    const b = off.e.runMutation(fn, {});
    expect(strip(a)).toEqual(strip(b));
    expect(on.inner.exec(`SELECT * FROM "t" ORDER BY "_rowid"`).rows).toEqual(off.inner.exec(`SELECT * FROM "t" ORDER BY "_rowid"`).rows);
  });

  it("filters with many values: bound once, or not pushed, never over the statement's limit", () => {
    const { e } = engine({ pushdown: true });
    seed(e, [{ s: "a", ns: null, n: 1, nn: null, b: true, lit: "a" }]);
    const wide = (k: number) =>
      queryGeneric({
        handler: (ctx: any) => ctx.db.query("t").filter((q: any) => q.or(...Array.from({ length: k }, (_, i) => q.eq(q.field("s"), `v${i}`)), q.eq(q.field("s"), "a"))).collect().length,
      }) as any;
    for (const k of [10, 40, 120]) expect(e.runQuery(wide(k), {}).value).toBe(1);
  });

  it("big filters without bound values: not pushed past the size budget (SQLite's expression depth, DO's 100 KB)", () => {
    const layout = layoutOf("t", schema.manifest.tables.t!.document);
    // `eq(on, undefined)` binds nothing: only the number of nodes and the SQL length can keep it out of SQLite.
    const flat = (k: number): FilterExpr => ({ op: "or", args: Array.from({ length: k }, () => ({ op: "eq", args: [{ field: "on" }, { literal: undefined }] })) });
    const small = pushFilter(layout, flat(20), true);
    expect(small?.params).toEqual([]);
    expect(small!.sql.length).toBeLessThanOrEqual(MAX_PUSHED_SQL);
    expect(pushFilter(layout, flat(MAX_PUSHED_NODES), true)).toBeUndefined();
    expect(pushFilter(layout, flat(2000), true)).toBeUndefined();
    // Under the node budget but over the SQL one: text range comparisons (the longest SQL per node).
    const texts = (k: number): FilterExpr => ({ op: "or", args: Array.from({ length: k }, (_, i) => ({ op: "lt", args: [{ field: "os" }, { literal: `v${i}` }] })) });
    const one = pushFilter(layout, texts(1), true)!.sql.length;
    const k = Math.ceil(MAX_PUSHED_SQL / one) + 1;
    expect(k).toBeLessThan(MAX_PUSHED_NODES);
    expect(pushFilter(layout, texts(k - 10), true)).toBeDefined();
    expect(pushFilter(layout, texts(k), true)).toBeUndefined();
    const on = engine({ pushdown: true });
    const off = engine({ pushdown: false });
    const docs = [
      { s: "a", ns: null, n: 1, nn: null, b: true, lit: "a" },
      { s: "b", ns: null, n: 2, nn: null, b: true, lit: "a", on: 3 },
    ];
    seed(on.e, docs);
    seed(off.e, docs);
    for (const k of [20, 400, 2000]) {
      const fn = queryGeneric({
        handler: (ctx: any) => ctx.db.query("t").filter((q: any) => q.or(...Array.from({ length: k }, () => q.eq(q.field("on"), undefined)))).collect().map((d: Doc) => d.s),
      }) as any;
      expect(on.e.runQuery(fn, {}).value).toEqual(["a"]);
      expect(strip(on.e.runQuery(fn, {}).usage)).toEqual(strip(off.e.runQuery(fn, {}).usage));
    }
  });
});

describe("a column added to a table whose rows kept the field in _json", () => {
  const v1 = defineSchema({ tables: { g: defineTable({ a: v.string() }) } });
  const v2 = defineSchema({ tables: { g: defineTable({ a: v.string(), x: v.optional(v.number()) }).index("by_x", ["x"]) } });

  /** The `i` of a row (`a` is `r<i>`), in SQL. */
  const N = `CAST(substr("a", 2) AS INTEGER)`;

  /** Rows written under v1 (half of them keep `x` in `_json`: data outside the schema), then v2 adds the column. */
  function grown(pushdown: boolean) {
    const inner = createNodeSqliteDriver();
    let clock = 1_700_000_000_000;
    const open = (schema: typeof v1 | typeof v2) => createEngine({ schema, driver: inner, now: () => (clock += 1), random: prng(11), filterPushdown: pushdown });
    const e1 = open(v1);
    e1.migrate();
    for (let i = 0; i < 12; i++) e1.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.db.insert("g", { a: `r${i}` }) }) as any, {});
    inner.exec(`UPDATE "g" SET "_json" = json_set("_json", '$.x', ${N} % 3) WHERE ${N} % 2 = 0`);
    const e = open(v2);
    const report = e.migrate();
    expect(report.steps).toContainEqual(expect.objectContaining({ op: "addColumn", table: "g", field: "x" }));
    while (!e.backfillStep().done);
    return { e, inner };
  }

  const ids = (e: ReturnType<typeof grown>["e"]) => (e.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("g").collect().map((d: Doc) => d._id) }) as any, {}).value as string[]);
  const docs = (e: ReturnType<typeof grown>["e"]) => (e.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("g").collect() }) as any, {}).value as Doc[]);
  const patch = (e: ReturnType<typeof grown>["e"], id: string, x: number) => e.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.db.patch(id, { x }) }) as any, {});

  it("a patch of the field is what reads return (the stale `_json` value is rewritten)", () => {
    const { e, inner } = grown(true);
    const all = ids(e);
    // Rows 0, 2, 4, ... hold `x` in `_json` (0, 1 or 2); patching them writes the column, and must drop the old value.
    for (const [i, id] of all.entries()) if (i % 3 === 1) patch(e, id, 10 + i);
    const got = docs(e);
    for (const [i, d] of got.entries()) {
      if (i % 3 === 1) expect(d.x).toBe(10 + i);
    }
    // No row keeps a value in `_json` beside a non-NULL column.
    expect(inner.exec(`SELECT count(*) AS n FROM "g" WHERE "x" IS NOT NULL AND instr("_json", '"x"') > 0`).rows[0]!.n).toBe(0);
    // The index key is the patched value too: a range on it finds exactly the patched rows.
    const ranged = e.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("g").withIndex("by_x", (q: any) => q.gte("x", 10)).collect().map((d: Doc) => d.x) }) as any, {}).value;
    expect(ranged).toEqual(got.filter((_, i) => i % 3 === 1).map((d) => d.x));
  });

  it("the SQL verdict is passes() on such rows, also when a column and `_json` disagree (older writes)", () => {
    const { e, inner } = grown(true);
    for (const [i, id] of ids(e).entries()) if (i % 4 === 3) patch(e, id, i % 3);
    // What an older `patchValues` left: the column patched, the old value still in `_json` (which reads return).
    inner.exec(`UPDATE "g" SET "x" = 7 WHERE ${N} % 4 = 2 AND instr("_json", '"x"') > 0`);
    const layout = layoutOf("g", v2.manifest.tables.g!.document);
    const rows = inner.exec(`SELECT * FROM "g" ORDER BY "_rowid"`).rows;
    const decoded = rows.map((row) => decodeRow(layout, row));
    expect(decoded.some((d, i) => rows[i]!.x === 7 && d.x !== 7)).toBe(true);
    let decided = 0;
    for (const op of CMP) {
      for (const x of [undefined, 0, 1, 2, 7, 10]) {
        for (const args of [[{ field: "x" }, { literal: x }], [{ literal: x }, { field: "x" }]] as FilterExpr[][]) {
          const f = { op, args } as FilterExpr;
          const pushed = pushFilter(layout, f, true)!;
          const verdicts = inner.exec(`SELECT ${pushed.sql} AS m FROM "g" ORDER BY "_rowid"`, ...pushed.params).rows;
          for (const [i, { m }] of verdicts.entries()) {
            if (m === null) continue;
            decided++;
            expect({ f, doc: decoded[i], m: m === 1 }).toEqual({ f, doc: decoded[i], m: passes(f, decoded[i]!) });
          }
        }
      }
    }
    expect(decided).toBeGreaterThan(100);
  });

  it("pushdown on × off: the same documents and usage", () => {
    const on = grown(true);
    const off = grown(false);
    for (const g of [on, off]) for (const [i, id] of ids(g.e).entries()) if (i % 3 === 0) patch(g.e, id, i % 4);
    for (const x of [0, 1, 2, 3]) {
      const fn = queryGeneric({ handler: (ctx: any) => ctx.db.query("g").filter((q: any) => q.or(q.eq(q.field("x"), x), q.gt(q.field("x"), 2))).collect() }) as any;
      const a = on.e.runQuery(fn, {});
      const b = off.e.runQuery(fn, {});
      expect(strip({ value: a.value, usage: a.usage })).toEqual(strip({ value: b.value, usage: b.usage }));
    }
  });
});
