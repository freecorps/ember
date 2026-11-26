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
import { pushFilter } from "../src/pushdown.ts";
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
});
