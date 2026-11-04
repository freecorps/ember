import { describe, expect, test } from "vitest";
import { compareValues, encodeKey, compareBytes } from "@freecorps/ember-values";
import { defineSchema, defineTable, v, type EmberError } from "../src/index.ts";
import { fresh, prng, withUser } from "./fixtures.ts";

const ids = (docs: any[]) => docs.map((d) => d._id);

function seeded(n = 40, seed = 3) {
  const s = fresh();
  const author = withUser(s);
  const rnd = prng(seed);
  const channels = ["a", "b", "c"];
  for (let i = 0; i < n; i++) {
    s.insert("messages", {
      channel: channels[Math.floor(rnd() * 3)]!,
      author,
      body: `m${i}`,
      likes: Math.floor(rnd() * 6),
      ...(rnd() < 0.5 ? { meta: { edited: rnd() < 0.5, tags: [] } } : {}),
    });
  }
  const all = s.run((db) => db.query("messages").collect()).value as any[];
  return { ...s, all, author };
}

const byKey = (fields: string[]) => (x: any, y: any) => {
  for (const f of [...fields, "_creationTime", "_id"]) {
    const get = (d: any) => f.split(".").reduce((o, p) => (o && typeof o === "object" ? o[p] : undefined), d);
    const c = compareValues(get(x), get(y));
    if (c) return c;
  }
  return 0;
};

describe("withIndex ranges", () => {
  test("eq / gt / gte / lt / lte / order agree with a JS reference", () => {
    const s = seeded();
    const ops = ["gt", "gte", "lt", "lte"] as const;
    const cmp = { gt: (c: number) => c > 0, gte: (c: number) => c >= 0, lt: (c: number) => c < 0, lte: (c: number) => c <= 0 };
    for (const ch of ["a", "b", "z"]) {
      for (const lo of [undefined, ...ops.slice(0, 2)]) {
        for (const hi of [undefined, ...ops.slice(2)]) {
          for (const order of ["asc", "desc"] as const) {
            const lv = 2;
            const hv = 4;
            const got = s.run((db) =>
              db
                .query("messages")
                .withIndex("by_channel_likes", (q: any) => {
                  let r = q.eq("channel", ch);
                  if (lo) r = r[lo]("likes", lv);
                  if (hi) r = r[hi]("likes", hv);
                  return r;
                })
                .order(order)
                .collect(),
            ).value as any[];
            let want = s.all
              .filter((d) => d.channel === ch)
              .filter((d) => !lo || cmp[lo](compareValues(d.likes, lv)))
              .filter((d) => !hi || cmp[hi](compareValues(d.likes, hv)))
              .sort(byKey(["channel", "likes"]));
            if (order === "desc") want = want.reverse();
            expect(ids(got)).toEqual(ids(want));
          }
        }
      }
    }
  });

  test("range on the first field, nested field index, by_creation_time, by_id", () => {
    const s = seeded();
    const got = s.run((db) => db.query("messages").withIndex("by_channel", (q: any) => q.gte("channel", "b")).collect()).value as any[];
    expect(ids(got)).toEqual(ids(s.all.filter((d) => d.channel >= "b").sort(byKey(["channel"]))));
    const edited = s.run((db) => db.query("messages").withIndex("by_edited", (q: any) => q.eq("meta.edited", true)).collect()).value as any[];
    expect(ids(edited)).toEqual(ids(s.all.filter((d) => d.meta?.edited === true)));
    // Missing nested field = undefined, which sorts first and is distinct from null/false.
    const missing = s.run((db) => db.query("messages").withIndex("by_edited", (q: any) => q.eq("meta.edited", undefined)).collect()).value as any[];
    expect(ids(missing)).toEqual(ids(s.all.filter((d) => d.meta === undefined)));
    const recent = s.run((db) => db.query("messages").order("desc").take(3)).value as any[];
    expect(ids(recent)).toEqual(ids(s.all.slice(-3).reverse()));
    const ct = s.all[5]._creationTime;
    const after = s.run((db) => db.query("messages").withIndex("by_creation_time", (q: any) => q.gt("_creationTime", ct)).collect()).value as any[];
    expect(ids(after)).toEqual(ids(s.all.slice(6)));
    const one = s.run((db) => db.query("messages").withIndex("by_id", (q: any) => q.eq("_id", s.all[3]._id)).unique()).value as any;
    expect(one._id).toBe(s.all[3]._id);
  });

  test("invalid ranges are rejected", () => {
    const s = seeded(3);
    const err = (fn: (q: any) => any, index = "by_channel_likes") => {
      try {
        s.run((db) => db.query("messages").withIndex(index as any, fn).collect());
      } catch (e) {
        return (e as EmberError).code;
      }
      return "ok";
    };
    expect(err((q) => q.eq("likes", 1))).toBe("QueryError"); // out of order
    expect(err((q) => q.gt("channel", "a").eq("likes", 1))).toBe("QueryError");
    expect(err((q) => q.eq("channel", "a").lt("likes", 1).gt("likes", 0))).toBe("QueryError");
    expect(err((q) => q, "nope")).toBe("QueryError");
    expect(err((q) => q.eq("channel", "a").eq("likes", 1).eq("_creationTime", 1).eq("_id", "x"))).toBe("ok");
  });

  test("the query plan seeks the key index (no table scan)", () => {
    const s = seeded(5);
    const plan = s.sql(
      `EXPLAIN QUERY PLAN SELECT * FROM "messages" INDEXED BY "messages__by_channel" WHERE "_k_by_channel" >= ? AND "_k_by_channel" < ? ORDER BY "_k_by_channel" LIMIT 5`,
      encodeKey(["a"]),
      encodeKey(["b"]),
    );
    expect(plan.map((r: any) => r.detail).join("; ")).toMatch(/SEARCH messages USING INDEX messages__by_channel/);
  });
});

describe("filter / take / first / unique / paginate", () => {
  test("filter in JS with index value order", () => {
    const s = seeded();
    const got = s.run((db) =>
      db
        .query("messages")
        .withIndex("by_channel", (q: any) => q.eq("channel", "a"))
        .filter((q: any) => q.or(q.eq(q.field("likes"), 0), q.and(q.gt(q.field("likes"), 3), q.not(q.eq(q.field("meta.edited"), true)))))
        .take(4),
    ).value as any[];
    const want = s.all
      .filter((d) => d.channel === "a")
      .filter((d) => d.likes === 0 || (d.likes > 3 && d.meta?.edited !== true))
      .sort(byKey(["channel"]))
      .slice(0, 4);
    expect(ids(got)).toEqual(ids(want));
  });

  test("first / unique", () => {
    const s = seeded();
    expect((s.run((db) => db.query("messages").first()).value as any)._id).toBe(s.all[0]._id);
    expect(s.run((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "zz")).first()).value).toBeNull();
    expect(() => s.run((db) => db.query("messages").unique())).toThrow(/more than one/);
    const u = s.run((db) => db.query("users").withIndex("by_email", (q: any) => q.eq("email", "ada@x.dev")).unique()).value as any;
    expect(u.name).toBe("Ada");
  });

  test("paginate walks every row exactly once, in order, with and without filters", () => {
    const s = seeded(57);
    for (const order of ["asc", "desc"] as const) {
      for (const withFilter of [false, true]) {
        const pages: any[][] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 100; i++) {
          const r = s.run((db) => {
            let qq: any = db.query("messages").withIndex("by_channel_likes", (q: any) => q.gte("channel", "a")).order(order);
            if (withFilter) qq = qq.filter((q: any) => q.neq(q.field("likes"), 3));
            return qq.paginate({ cursor, numItems: 7 });
          }).value as any;
          pages.push(r.page);
          if (r.isDone) break;
          expect(r.page).toHaveLength(7);
          cursor = r.continueCursor;
        }
        let want = s.all.filter((d) => !withFilter || d.likes !== 3).sort(byKey(["channel", "likes"]));
        if (order === "desc") want = want.reverse();
        expect(ids(pages.flat())).toEqual(ids(want));
        expect(pages.length).toBe(Math.max(1, Math.ceil(want.length / 7))); // peek: no empty last page
      }
    }
  });

  test("paginate with endCursor re-runs a pinned page", () => {
    const s = seeded(20);
    const first = s.run((db) => db.query("messages").paginate({ cursor: null, numItems: 5 })).value as any;
    s.insert("messages", { channel: "a", author: s.author, body: "late", likes: 1 });
    const pinned = s.run((db) => db.query("messages").paginate({ cursor: null, numItems: 5, endCursor: first.continueCursor })).value as any;
    expect(ids(pinned.page)).toEqual(ids(first.page));
    expect(() => s.run((db) => db.query("messages").paginate({ cursor: "garbage", numItems: 5 }))).toThrow(/cursor/);
  });

  test("a query runs once", () => {
    const s = seeded(2);
    expect(() =>
      s.run((db) => {
        const qq = db.query("messages");
        qq.collect();
        return qq.collect();
      }),
    ).toThrow(/only be run once/);
  });
});

describe("read sets", () => {
  test("take(n) records only the covered prefix; full scans the whole range", () => {
    const s = seeded(30);
    const { readSet } = s.run((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).take(2));
    expect(readSet).toHaveLength(1);
    const e = readSet[0];
    expect(e).toMatchObject({ table: "messages", index: "by_channel", kind: "db" });
    expect(compareBytes(e.lo, encodeKey(["a"]))).toBe(0);
    // hi is just past the 2nd row, well before the end of channel "a".
    const second = s.all.filter((d) => d.channel === "a").sort(byKey(["channel"]))[1];
    const k2 = encodeKey(["a", second._creationTime, second._id]);
    expect(compareBytes(e.hi, k2)).toBeGreaterThan(0);
    expect(compareBytes(e.hi, Uint8Array.from([...k2, 1]))).toBeLessThan(0);
    const full = s.run((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).collect()).readSet[0];
    expect(compareBytes(full.hi, Uint8Array.from([...encodeKey(["a"]), 0xff]))).toBe(0);
  });

  test("db.get records a point range on by_id; filters are recorded", () => {
    const s = seeded(3);
    const { readSet } = s.run((db) => {
      db.get(s.all[0]._id);
      return db.query("messages").filter((q: any) => q.eq(q.field("likes"), 1)).collect();
    });
    expect(readSet.map((e: any) => e.index)).toEqual(["by_id", "by_creation_time"]);
    expect(readSet[1].filter).toEqual({ op: "eq", args: [{ field: "likes" }, { literal: 1 }] });
  });
});

describe("search", () => {
  test("diacritics, prefix, filter fields, bm25 order", () => {
    const s = fresh();
    const author = withUser(s);
    const m = (channel: string, body: string) => s.insert("messages", { channel, author, body, likes: 0 });
    const a = m("a", "Ação rápida no código");
    const b = m("a", "acao acao acao");
    const c = m("b", "acao em outro canal");
    m("a", "nada a ver");
    const search = (text: string, channel?: string) =>
      ids(
        s.run((db) =>
          (db.query("messages") as any)
            .withSearchIndex("search_body", (q: any) => (channel ? q.search("body", text).eq("channel", channel) : q.search("body", text)))
            .collect(),
        ).value as any[],
      );
    expect(new Set(search("acao"))).toEqual(new Set([a, b, c]));
    expect(search("acao")[0]).toBe(b); // highest term frequency first
    expect(search("acao", "b")).toEqual([c]);
    expect(search("cód")).toEqual([a]); // prefix on the last term
    expect(search("")).toEqual([]);
    expect(search('"); DROP TABLE messages; --')).toEqual([]); // no FTS syntax injection
    // Updates and deletes keep the external-content index in sync.
    s.patch(b, { body: "outra coisa" });
    s.del(c);
    expect(search("acao")).toEqual([a]);
    expect(search("coisa")).toEqual([b]);
  });

  test("trigram tokenizer: substring search", () => {
    const sch = defineSchema({ tables: { docs: defineTable({ text: v.string() }).searchIndex("s", { searchField: "text", tokenizer: "trigram" }) } });
    const s = fresh({ schema: sch });
    const x = s.insert("docs", { text: "the ember engine" });
    s.insert("docs", { text: "something else" });
    const r = s.run((db) => (db.query("docs") as any).withSearchIndex("s", (q: any) => q.search("text", "mber eng")).collect());
    expect(ids(r.value as any[])).toEqual([x]);
    expect(r.readSet[0]).toMatchObject({ kind: "search", index: "s" });
  });
});
