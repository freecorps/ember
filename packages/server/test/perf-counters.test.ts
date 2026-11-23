// Cost regressions in the engine's hot paths, measured with the node:sqlite driver's counters (rows returned by a
// read = rowsRead, rows changed or returned by a write = rowsWritten) and the statements it ran.

import { describe, expect, test } from "vitest";
import { concatBytes, decodeKey, encodeKey } from "@freecorps/ember-values";
import { cloneBytes } from "../src/engine.ts";
import { defineSchema, defineTable, queryGeneric, v, type QueryCtx } from "../src/index.ts";
import { fresh, withUser } from "./fixtures.ts";

const Q = (handler: (db: any) => unknown) => queryGeneric({ handler: (ctx: QueryCtx) => handler(ctx.db) }) as any;

/** `fresh()` plus a log of the SQL the engine runs. */
function logged(opts: Parameters<typeof fresh>[0] = {}) {
  const s = fresh(opts);
  const log: string[] = [];
  const exec = s.driver.exec.bind(s.driver);
  s.driver.exec = (sql, ...params) => {
    log.push(sql);
    return exec(sql, ...params);
  };
  /** The statements `fn` runs. */
  const during = (fn: () => unknown): string[] => {
    const from = log.length;
    fn();
    return log.slice(from);
  };
  return { ...s, log, during };
}

describe("search: reads what the query takes", () => {
  const searchHello = (n: number) => Q((db: any) => db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", "hello")).take(n));

  function setup() {
    const s = logged();
    const author = withUser(s);
    s.tx((db) => {
      for (let i = 0; i < 50; i++) db.insert("messages", { channel: i % 2 ? "a" : "b", author, body: `hello ${i}`, likes: i } as any);
    });
    return { ...s, author };
  }

  test("take(n) reads n rows, not the 1024 max; collect() still reads them all", () => {
    const s = setup();
    const r = s.engine.runQuery(searchHello(3));
    expect(r.value).toHaveLength(3);
    expect(r.usage!.rowsRead).toBe(3);
    expect(r.usage!.documentsRead).toBe(3);
    // The same top 3 as the full result.
    const all = s.engine.runQuery(Q((db: any) => db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", "hello")).collect()));
    expect(all.usage!.rowsRead).toBe(50);
    expect((r.value as any[]).map((d) => d._id)).toEqual((all.value as any[]).slice(0, 3).map((d) => d._id));
  });

  test("selects the data columns only (no _rowid, no _k_* index BLOBs)", () => {
    const s = setup();
    const sql = s.during(() => s.engine.runQuery(searchHello(2))).find((x) => x.includes("MATCH"))!;
    expect(sql).not.toContain("t.*");
    expect(sql).not.toMatch(/SELECT[^]*"_k_[^]*FROM/);
    expect(sql).toMatch(/SELECT t\."_id", t\."_creationTime", t\."_json", t\."channel"/);
  });

  test("a JS .filter() after the search keeps the max (it may drop rows)", () => {
    const s = setup();
    const r = s.engine.runQuery(
      Q((db: any) =>
        db
          .query("messages")
          .withSearchIndex("search_body", (q: any) => q.search("body", "hello"))
          .filter((q: any) => q.gte(q.field("likes"), 45))
          .take(2),
      ),
    );
    expect((r.value as any[]).map((d) => d.likes).sort()).toHaveLength(2);
    for (const d of r.value as any[]) expect(d.likes).toBeGreaterThanOrEqual(45);
    expect(r.usage!.rowsRead).toBe(50);
  });

  test("rows the JS re-check drops (a NULL column whose value is NaN in _json): the max again, right results", () => {
    const schema = defineSchema({
      tables: {
        notes: defineTable({ body: v.string(), score: v.union(v.number(), v.null()) }).searchIndex("search_body", { searchField: "body", filterFields: ["score"] }),
      },
    });
    const s = logged({ schema });
    s.tx((db: any) => {
      // NaN escapes to `_json` (its column is NULL): `score IS NULL` lets them through, the JS check drops them.
      // Short bodies: bm25 ranks them first.
      for (let i = 0; i < 4; i++) db.insert("notes", { body: "hello", score: NaN });
      for (let i = 0; i < 3; i++) db.insert("notes", { body: `hello there number ${i}`, score: null });
    });
    const q = (n: number) => Q((db: any) => db.query("notes").withSearchIndex("search_body", (q: any) => q.search("body", "hello").eq("score", null)).take(n));
    const r = s.engine.runQuery(q(2));
    expect(r.value).toHaveLength(2);
    for (const d of r.value as any[]) expect(d.score).toBeNull();
    // Asked for 2 (all NaN rows), then the max (7).
    expect(r.usage!.rowsRead).toBe(2 + 7);
  });

  test("a smaller result still invalidates on changes to rows past it", () => {
    const s = setup();
    const { value, readSet } = s.engine.runQuery(searchHello(2));
    const shown = new Set((value as any[]).map((d) => d._id));
    const other = (s.engine.runQuery(Q((db: any) => db.query("messages").collect())).value as any[]).find((d) => d.body.startsWith("hello") && !shown.has(d._id))!;
    // A row ranked past the 2 taken: its change may move it into them.
    expect(s.engine.matches(readSet, s.patch(other._id, { body: "hello" }).changes)).toBe(true);
    // A new matching row.
    expect(s.engine.matches(readSet, s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "hello again", likes: 0 } as any)).changes)).toBe(true);
    // Unrelated text: no.
    const unrelated = s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "nothing here", likes: 0 } as any)).changes;
    expect(s.engine.matches(readSet, unrelated)).not.toBe(true);
  });
});

describe(".filter(): batches sized to the take", () => {
  function setup(n = 200) {
    const s = fresh();
    const author = withUser(s);
    s.tx((db) => {
      for (let i = 0; i < n; i++) db.insert("messages", { channel: "a", author, body: "x", likes: i } as any);
    });
    return s;
  }
  const filtered = (n: number, min: number) =>
    Q((db: any) =>
      db
        .query("messages")
        .withIndex("by_channel", (q: any) => q.eq("channel", "a"))
        .filter((q: any) => q.gte(q.field("likes"), min))
        .take(n),
    );

  test("take(1) with a filter that keeps every row reads 8 rows, not 128", () => {
    const s = setup();
    const r = s.engine.runQuery(filtered(1, 0));
    expect((r.value as any[]).map((d) => d.likes)).toEqual([0]);
    expect(r.usage!.rowsRead).toBe(8);
    expect(s.engine.runQuery(filtered(10, 0)).usage!.rowsRead).toBe(20);
  });

  test("matches far into the range: batches grow (8, 32, 128...) and the results are the same", () => {
    const s = setup();
    const r = s.engine.runQuery(filtered(3, 150));
    expect((r.value as any[]).map((d) => d.likes)).toEqual([150, 151, 152]);
    // 8 + 32 + 128 = 168 rows cover rows 0..167.
    expect(r.usage!.rowsRead).toBe(8 + 32 + 128);
    // Read set: up to the last match, as before.
    const range = r.readSet.find((e: any) => e.index === "by_channel");
    expect(range!.filter).toBeDefined();
    expect(s.engine.runQuery(filtered(1000, 190)).value).toHaveLength(10);
  });

  test("collect() with a filter still sees every row", () => {
    const s = setup(300);
    const r = s.engine.runQuery(
      Q((db: any) =>
        db
          .query("messages")
          .withIndex("by_channel", (q: any) => q.eq("channel", "a"))
          .filter((q: any) => q.eq(q.field("likes"), 299))
          .collect(),
      ),
    );
    expect((r.value as any[]).map((d) => d.likes)).toEqual([299]);
    expect(r.usage!.rowsRead).toBe(300);
  });
});

describe("aggregates: no needless reads, seeks or writes", () => {
  const schema = defineSchema({
    tables: {
      orders: defineTable({ shop: v.string(), amount: v.number(), note: v.optional(v.string()) })
        .aggregate("mm", { by: ["shop"], min: ["amount"], max: ["amount"] })
        .aggregate("cnt", { by: ["shop"] }),
    },
  });
  function setup() {
    const s = logged({ schema });
    const ids = s.tx((db: any) => [5, 5, 5, 9].map((amount) => db.insert("orders", { shop: "a", amount }))).value as string[];
    const agg = (name: string) => s.engine.runQuery(Q((db: any) => db.aggregate("orders", name).get(["a"]))).value as any;
    return { ...s, ids, agg };
  }
  const seeks = (sql: string[]) => sql.filter((x) => x.includes("__mm") && x.includes("ORDER BY"));

  test("deleting the min while copies of it are left does not seek the multiset", () => {
    const s = setup();
    expect(seeks(s.during(() => s.del(s.ids[0]!)))).toEqual([]);
    expect(s.agg("mm")).toMatchObject({ count: 3, min: { amount: 5 }, max: { amount: 9 } });
    expect(seeks(s.during(() => s.del(s.ids[1]!)))).toEqual([]);
    // The last 5: now the next min is looked up.
    expect(seeks(s.during(() => s.del(s.ids[2]!)))).toHaveLength(1);
    expect(s.agg("mm")).toMatchObject({ count: 1, min: { amount: 9 }, max: { amount: 9 } });
    // The max, and the last one: the group goes.
    s.del(s.ids[3]!);
    expect(s.agg("mm")).toMatchObject({ count: 0, min: { amount: null }, max: { amount: null } });
    expect(s.sql(`SELECT count(*) AS n FROM "orders__mm__mm"`)[0]!.n).toBe(0);
  });

  test("a count-only delete is one UPDATE (no read); the group's last document one DELETE", () => {
    const s = setup();
    const cnt = (sql: string[]) => sql.filter((x) => x.includes('"orders__cnt"'));
    const one = cnt(s.during(() => s.del(s.ids[0]!)));
    expect(one).toHaveLength(1);
    expect(one[0]).toMatch(/^UPDATE/);
    expect(s.agg("cnt").count).toBe(3);
    s.del(s.ids[1]!);
    s.del(s.ids[2]!);
    const last = cnt(s.during(() => s.del(s.ids[3]!)));
    expect(last.map((x) => x.split(" ")[0])).toEqual(["UPDATE", "DELETE"]);
    expect(s.sql(`SELECT count(*) AS n FROM "orders__cnt"`)[0]!.n).toBe(0);
    expect(s.agg("cnt").count).toBe(0);
  });

  test("a count-only delete reports the group before and after (reactivity)", () => {
    const s = setup();
    const { changes } = s.del(s.ids[0]!);
    const c = changes.find((x: any) => x.table === "orders__cnt");
    expect(c.before.count).toBe(4);
    expect(c.after.count).toBe(3);
    s.del(s.ids[1]!);
    s.del(s.ids[2]!);
    const last = s.del(s.ids[3]!).changes.find((x: any) => x.table === "orders__cnt");
    expect(last.before.count).toBe(1);
    expect(last.after).toBeNull();
  });

  test("a patch that changes no aggregated field touches no aggregate table", () => {
    const s = setup();
    const sql = s.during(() => s.patch(s.ids[0]!, { note: "hi" }));
    expect(sql.filter((x) => x.includes("orders__"))).toEqual([]);
    // A changed min/max value: moved within the group, count unchanged.
    s.patch(s.ids[3]!, { amount: 1 });
    expect(s.agg("mm")).toMatchObject({ count: 4, min: { amount: 1 }, max: { amount: 5 } });
  });

  test("the mm key prefix is encodeKey([fi]) ++ group key: byte-identical to encodeKey([fi, ...group])", () => {
    const groups: unknown[][] = [
      [],
      ["a"],
      ["", "b"],
      ["\u0000x", "ü", "😀", "\ud800", "a\u0000ÿ"],
      [0, -0, 1.5, -1e300, NaN, Infinity, -Infinity],
      [0n, -1n, 2n ** 62n, -(2n ** 63n)],
      [true, false, null, undefined],
      [new Uint8Array([0, 255, 0, 1]), new Uint8Array()],
      [[1, ["x", null]], { b: 1, a: [2] }, {}],
    ];
    for (const group of groups) {
      const key = encodeKey(group);
      for (const fi of [0, 1, 2, 15]) {
        expect(concatBytes(encodeKey([fi]), key)).toEqual(encodeKey([fi, ...decodeKey(key)]));
      }
    }
  });
});

describe("cloneBytes", () => {
  test("no v.bytes() column: the same row, nothing copied", () => {
    const row = { _id: "x", _json: "{}", _k_by_name: new Uint8Array([1, 2]) };
    expect(cloneBytes(row, [])).toBe(row);
  });

  test("copies the v.bytes() columns only (the _k_* BLOBs are never decoded into documents)", () => {
    const data = new Uint8Array([1, 2, 3]);
    const k = new Uint8Array([9]);
    const row = { _id: "x", data, _k_by_name: k };
    const out = cloneBytes(row, ["data"]);
    expect(out).not.toBe(row);
    expect(out.data).toEqual(data);
    expect(out.data).not.toBe(data);
    expect(out._k_by_name).toBe(k);
    // A NULL bytes column: nothing to copy.
    const empty = { _id: "y", data: null };
    expect(cloneBytes(empty, ["data"])).toBe(empty);
  });
});
