// Reactivity: engine.matches(readSet, changes) must never miss a change that alters a query result.
// Ported from docs/spikes/typegen/test/reactivity.test.ts, against the encoded-key read sets.

import { describe, expect, test } from "vitest";
import { stringifyValue } from "@ember/values";
import { createMatchIndex, queryGeneric, type QueryCtx, type RowChange } from "../src/index.ts";
import { fresh, prng, schema, withUser } from "./fixtures.ts";

type DB = QueryCtx["db"];
const Q = (handler: (db: any) => unknown) => queryGeneric({ handler: (ctx: QueryCtx) => handler(ctx.db) }) as any;
const sortById = (xs: any[]) => [...xs].sort((x, y) => (x._id < y._id ? -1 : 1));

const byChannelDesc2 = Q((db: DB) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).order("desc").take(2));
const lowestLikes2 = Q((db: DB) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "a")).take(2));
const popular = Q((db: DB) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).filter((q: any) => q.gte(q.field("likes"), 5)).collect());
const searchHello = Q((db: any) => sortById(db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", "hello")).collect()));

function setup() {
  const env = fresh();
  const author = withUser(env);
  const subs = new Map<string, { fn: any; value: string; readSet: any[] }>();
  // The interval index must agree exactly with engine.matches (its `exact` set).
  const index = createMatchIndex<string>(schema);
  const subscribe = (id: string, fn: any) => {
    const { value, readSet } = env.engine.runQuery(fn);
    subs.set(id, { fn, value: stringifyValue(value), readSet });
    index.set(id, readSet);
  };
  const msg = (channel: string, likes: number, body = "x") => env.insert("messages", { channel, author, body, likes });
  /** Runs a write; returns which subscriptions were invalidated and which actually changed (after re-running them). */
  const commit = (write: () => { changes: RowChange[] }) => {
    const { changes } = write();
    const inv: string[] = [];
    const changed: string[] = [];
    const indexed = index.match(changes);
    for (const [id, sub] of subs) {
      if (!env.engine.matches(sub.readSet, changes)) continue;
      inv.push(id);
    }
    expect([...indexed.exact].sort()).toEqual([...inv].sort());
    for (const id of inv) {
      const sub = subs.get(id)!;
      const { value, readSet } = env.engine.runQuery(sub.fn);
      sub.readSet = readSet;
      index.set(id, readSet);
      const json = stringifyValue(value);
      if (json !== sub.value) changed.push(id);
      sub.value = json;
    }
    return { inv: inv.sort(), changed: changed.sort(), changes };
  };
  return { ...env, author, subs, subscribe, msg, commit };
}

describe("invalidation: insert / update / delete", () => {
  test("insert: only subscriptions whose range contains the new row", () => {
    const s = setup();
    s.msg("a", 1);
    s.subscribe("A", byChannelDesc2);
    expect(s.commit(() => s.tx((db) => db.insert("messages", { channel: "b", author: s.author, body: "x", likes: 0 } as any))).inv).toEqual([]);
    expect(s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "new", likes: 0 } as any))).changed).toEqual(["A"]);
  });

  test("update moving a row into / out of / outside the range", () => {
    const s = setup();
    const inA = s.msg("a", 1);
    const inB = s.msg("b", 1);
    s.subscribe("A", Q((db: DB) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).collect()));
    expect(s.commit(() => s.patch(inB, { likes: 2 })).inv).toEqual([]); // outside, stays outside
    expect(s.commit(() => s.patch(inB, { channel: "a" })).changed).toEqual(["A"]); // moves in: only `after` is in range
    expect(s.commit(() => s.patch(inA, { channel: "c" })).changed).toEqual(["A"]); // moves out: only `before` is in range
    expect(s.commit(() => s.patch(inB, { body: "edited" })).changed).toEqual(["A"]); // changes inside
  });

  test("delete", () => {
    const s = setup();
    const id = s.msg("a", 1);
    s.subscribe("A", byChannelDesc2);
    expect(s.commit(() => s.del(id)).changed).toEqual(["A"]);
  });

  test("take(n) records only the covered prefix: writes past the last row do not invalidate", () => {
    const s = setup();
    s.msg("a", 1);
    s.msg("a", 2);
    s.msg("a", 3);
    s.subscribe("low", lowestLikes2); // likes 1, 2
    expect(s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "x", likes: 9 } as any))).inv).toEqual([]);
    expect(s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "x", likes: 0 } as any))).changed).toEqual(["low"]);
    // After the re-run the window moved: likes 2 is now past the end.
    expect(s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "x", likes: 2 } as any))).inv).toEqual([]);
  });

  test("filter in the read set: rows failing it before and after do not invalidate", () => {
    const s = setup();
    const id = s.msg("a", 1);
    s.subscribe("P", popular);
    expect(s.commit(() => s.patch(id, { likes: 2 })).inv).toEqual([]);
    expect(s.commit(() => s.patch(id, { likes: 6 })).changed).toEqual(["P"]); // enters
    expect(s.commit(() => s.patch(id, { likes: 3 })).changed).toEqual(["P"]); // leaves (before passed)
  });

  test("db.get subscribes to one id", () => {
    const s = setup();
    const id = s.msg("a", 1);
    const other = s.msg("a", 1);
    s.subscribe("G", Q((db: DB) => db.get(id as any)));
    expect(s.commit(() => s.patch(other, { likes: 5 })).inv).toEqual([]);
    expect(s.commit(() => s.patch(id, { likes: 5 })).changed).toEqual(["G"]);
  });

  test("search: term match or result membership invalidates; unrelated text does not", () => {
    const s = setup();
    const hit = s.msg("a", 1, "hello there");
    s.subscribe("S", searchHello);
    expect(s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "goodbye", likes: 0 } as any))).inv).toEqual([]);
    expect(s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "Héllo!", likes: 0 } as any))).changed).toEqual(["S"]);
    expect(s.commit(() => s.patch(hit, { likes: 9 })).changed).toEqual(["S"]); // non-text field of a result row
    expect(s.commit(() => s.patch(hit, { body: "nothing" })).changed).toEqual(["S"]); // leaves
  });

  test("unknown index or table in a read set matches conservatively", () => {
    const s = setup();
    const change: RowChange = { table: "messages", id: "msg_x", before: null, after: { _id: "msg_x", _creationTime: 1 } };
    expect(s.engine.matches([{ table: "messages", index: "gone", lo: new Uint8Array(), hi: new Uint8Array(), kind: "db" }], [change])).toBe(true);
    expect(s.engine.matches([{ table: "users", index: "by_email", lo: new Uint8Array(), hi: new Uint8Array([0xff]), kind: "db" }], [change])).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- property test

describe("randomised: no false negatives", () => {
  for (const seed of [1, 7, 42, 1337]) {
    test(`seed ${seed}: 300 random mutations vs 17 subscriptions`, () => {
      const s = setup();
      const rnd = prng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const channels = ["a", "b", "c"] as const;
      const words = ["hello", "world", "bye", "hell", "héllo", "zed"];
      const live: string[] = [];
      for (let i = 0; i < 12; i++) live.push(s.msg(pick(channels), Math.floor(rnd() * 6), `${pick(words)} ${pick(words)}`));
      const pinned = live[0]!;

      const queries: Record<string, any> = {
        eqA: Q((db: DB) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).collect()),
        eqBdescTake: Q((db: DB) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "b")).order("desc").take(2)),
        likesRange: Q((db: DB) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "a").gt("likes", 1).lte("likes", 4)).collect()),
        likesTake: Q((db: DB) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "c").gte("likes", 2)).take(3)),
        likesDescTake: Q((db: DB) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "a").lt("likes", 5)).order("desc").take(2)),
        allChannelsLow: Q((db: DB) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.gte("channel", "b")).take(4)),
        filtered: Q((db: DB) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "b")).filter((q: any) => q.or(q.eq(q.field("likes"), 0), q.gt(q.field("likes"), 4))).collect()),
        filteredTake: Q((db: DB) => db.query("messages").filter((q: any) => q.eq(q.field("channel"), "c")).take(2)),
        recent: Q((db: DB) => db.query("messages").order("desc").take(3)),
        count: Q((db: DB) => db.query("messages").collect().length),
        first: Q((db: DB) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "c")).first()),
        get: Q((db: DB) => db.get(pinned as any)),
        edited: Q((db: DB) => db.query("messages").withIndex("by_edited", (q: any) => q.eq("meta.edited", true)).collect()),
        page1: Q((db: DB) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).paginate({ numItems: 2, cursor: null })),
        pageDesc: Q((db: DB) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "b")).order("desc").filter((q: any) => q.neq(q.field("likes"), 2)).paginate({ numItems: 2, cursor: null })),
        search: searchHello,
        searchB: Q((db: any) => sortById(db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", "wor").eq("channel", "b")).collect())),
      };
      for (const [id, fn] of Object.entries(queries)) s.subscribe(id, fn);

      let invalidations = 0;
      let needed = 0;
      for (let step = 0; step < 300; step++) {
        const ops = 1 + Math.floor(rnd() * 3);
        const write = () =>
          s.tx((db) => {
            for (let k = 0; k < ops; k++) {
              const r = rnd();
              if (r < 0.35 || live.length < 3) {
                live.push(db.insert("messages", { channel: pick(channels), author: s.author, body: `${pick(words)} ${pick(words)}`, likes: Math.floor(rnd() * 6) } as any));
              } else if (r < 0.85) {
                const id = pick(live);
                const field = pick(["channel", "likes", "body", "meta"]);
                const value =
                  field === "channel" ? pick(channels) : field === "likes" ? Math.floor(rnd() * 6) : field === "body" ? `${pick(words)} ${pick(words)}` : rnd() < 0.5 ? undefined : { edited: rnd() < 0.5, tags: [] };
                db.patch(id as any, { [field]: value } as any);
              } else {
                const id = pick(live.filter((x) => x !== pinned || rnd() < 0.1));
                live.splice(live.indexOf(id), 1);
                db.delete(id as any);
              }
            }
          });
        // Ground truth: re-run every query from scratch.
        const before = new Map([...s.subs].map(([id, sub]) => [id, sub.value]));
        const { inv } = s.commit(write);
        const invSet = new Set(inv);
        for (const [id, fn] of Object.entries(queries)) {
          const now = stringifyValue(s.engine.runQuery(fn).value);
          const changed = now !== before.get(id);
          if (changed) {
            needed++;
            // No false negatives: every subscription whose result changed was invalidated.
            expect({ step, id, invalidated: invSet.has(id) }).toEqual({ step, id, invalidated: true });
          }
          expect(s.subs.get(id)!.value === now || !invSet.has(id)).toBe(true);
        }
        invalidations += inv.length;
      }
      // Precision is reported, not asserted (false positives only cost a re-run).
      console.log(`seed ${seed}: ${needed} needed re-runs, ${invalidations} invalidations (${((needed / invalidations) * 100).toFixed(0)}% precise)`);
      expect(needed).toBeGreaterThan(100);
    });
  }
});
