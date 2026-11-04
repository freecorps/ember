import { describe, expect, test } from "bun:test";
import { queryGeneric, SubscriptionManager } from "cfx";
import { toJson } from "cfx/values";
import { fresh, withUser } from "./helpers";

const Q = (handler: (db: any, args: any) => Promise<unknown>) => queryGeneric({ handler: (ctx: any, args: any) => handler(ctx.db, args) }) as any;

const byChannelDesc2 = Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).order("desc").take(2));
const lowestLikes2 = Q((db) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "a")).take(2));
const popular = Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).filter((q: any) => q.gte(q.field("likes"), 5)).collect());
const searchHello = Q(async (db) => (await db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", "hello")).collect()).sort((x: any, y: any) => (x._id < y._id ? -1 : 1)));

async function setup() {
  const env = fresh();
  const author = await withUser(env);
  const subs = new SubscriptionManager(env.engine);
  const msg = (channel: string, likes: number, body = "x") => env.insert("messages", { channel, author, body, likes });
  /** Runs a write, returns [invalidated subs, patches]. */
  const commit = async (write: () => Promise<{ changes: any[] }>) => {
    const { changes } = await write();
    const inv = subs.invalidated(changes);
    const patches = await subs.onCommit(changes);
    return { inv: inv.sort(), patched: patches.map((p) => p.subId).sort(), patches };
  };
  return { ...env, author, subs, msg, commit };
}

describe("invalidation: insert / update / delete", () => {
  test("insert: only subscriptions whose range contains the new row", async () => {
    const s = await setup();
    await s.msg("a", 1);
    await s.subs.subscribe("A", byChannelDesc2);
    const b = await s.commit(() => s.tx((db) => db.insert("messages", { channel: "b", author: s.author, body: "x", likes: 0 })));
    expect(b.inv).toEqual([]);
    const a = await s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "new", likes: 0 })));
    expect(a.inv).toEqual(["A"]);
    expect(a.patches[0]!.diff).toMatchObject({ kind: "docs", removed: [], changed: [] });
    expect((a.patches[0]!.diff as any).added.map((d: any) => d.body)).toEqual(["new"]);
  });

  test("update moving a row into / out of / outside the range", async () => {
    const s = await setup();
    const inA = await s.msg("a", 1);
    const inB = await s.msg("b", 1);
    await s.subs.subscribe("A", Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).collect()));
    expect((await s.commit(() => s.patch(inB, { likes: 2 }))).inv).toEqual([]); // outside, stays outside
    const into = await s.commit(() => s.patch(inB, { channel: "a" })); // moves in: only `after` is in range
    expect(into.inv).toEqual(["A"]);
    expect((into.patches[0]!.diff as any).added.map((d: any) => d._id)).toEqual([inB]);
    const out = await s.commit(() => s.patch(inA, { channel: "c" })); // moves out: only `before` is in range
    expect(out.inv).toEqual(["A"]);
    expect((out.patches[0]!.diff as any).removed).toEqual([inA]);
    const inside = await s.commit(() => s.patch(inB, { body: "edited" })); // changes inside
    expect((inside.patches[0]!.diff as any).changed.map((d: any) => d.body)).toEqual(["edited"]);
  });

  test("delete", async () => {
    const s = await setup();
    const id = await s.msg("a", 1);
    await s.subs.subscribe("A", byChannelDesc2);
    const del = await s.commit(() => s.del(id));
    expect(del.inv).toEqual(["A"]);
    expect((del.patches[0]!.diff as any).removed).toEqual([id]);
  });

  test("take(n) records only the covered prefix: writes past the last row do not invalidate", async () => {
    const s = await setup();
    await s.msg("a", 1);
    await s.msg("a", 2);
    await s.msg("a", 3);
    await s.subs.subscribe("low", lowestLikes2); // likes 1, 2
    const past = await s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "x", likes: 9 })));
    expect(past.inv).toEqual([]); // likes 9 sorts after the 2nd row: cannot enter the top 2
    const before = await s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "x", likes: 0 })));
    expect(before.inv).toEqual(["low"]);
    expect((s.subs.valueOf("low") as any[]).map((m) => m.likes)).toEqual([0, 1]);
    // The re-run narrowed the read set again (now ends at likes=1).
    expect(s.subs.readSetOf("low")![0]).toMatchObject({ upper: { inclusive: true } });
    expect((s.subs.readSetOf("low")![0] as any).upper.key.slice(0, 2)).toEqual(["a", 1]);
  });

  test("filter in the read set: rows failing it before and after do not invalidate", async () => {
    const s = await setup();
    const id = await s.msg("a", 1);
    await s.subs.subscribe("P", popular);
    expect((await s.commit(() => s.patch(id, { likes: 2 }))).inv).toEqual([]);
    expect((await s.commit(() => s.patch(id, { likes: 6 }))).inv).toEqual(["P"]); // enters
    expect((await s.commit(() => s.patch(id, { likes: 3 }))).inv).toEqual(["P"]); // leaves (before passed)
  });

  test("db.get subscribes to one id", async () => {
    const s = await setup();
    const id = await s.msg("a", 1);
    const other = await s.msg("a", 1);
    await s.subs.subscribe("G", Q((db) => db.get(id)));
    expect((await s.commit(() => s.patch(other, { likes: 5 }))).inv).toEqual([]);
    expect((await s.commit(() => s.patch(id, { likes: 5 }))).patched).toEqual(["G"]);
  });

  test("re-run with an unchanged result emits no patch", async () => {
    const s = await setup();
    const id = await s.msg("a", 1);
    await s.subs.subscribe("P", Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).collect().then((r: any[]) => r.length)));
    const r = await s.commit(() => s.patch(id, { likes: 2 }));
    expect(r.inv).toEqual(["P"]);
    expect(r.patched).toEqual([]);
  });

  test("search: term match or result membership invalidates; unrelated text does not", async () => {
    const s = await setup();
    const hit = await s.msg("a", 1, "hello there");
    await s.subs.subscribe("S", searchHello);
    expect((await s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "goodbye", likes: 0 })))).inv).toEqual([]);
    expect((await s.commit(() => s.tx((db) => db.insert("messages", { channel: "a", author: s.author, body: "Héllo!", likes: 0 })))).patched).toEqual(["S"]);
    expect((await s.commit(() => s.patch(hit, { likes: 9 }))).patched).toEqual(["S"]); // non-text field of a result row
    expect((await s.commit(() => s.patch(hit, { body: "nothing" }))).patched).toEqual(["S"]); // leaves
  });
});

// ------------------------------------------------------------------------------------------- property test

function prng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe("randomised: no false negatives, exact patches", () => {
  for (const seed of [1, 7, 42, 1337]) {
    test(`seed ${seed}: 300 random mutations vs 16 subscriptions`, async () => {
      const s = await setup();
      const rnd = prng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const channels = ["a", "b", "c"] as const;
      const words = ["hello", "world", "bye", "hell", "héllo", "zed"];
      const live: string[] = [];
      for (let i = 0; i < 12; i++) live.push(await s.msg(pick(channels), Math.floor(rnd() * 6), `${pick(words)} ${pick(words)}`));
      const pinned = live[0]!;

      const queries: Record<string, any> = {
        eqA: Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).collect()),
        eqBdescTake: Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "b")).order("desc").take(2)),
        likesRange: Q((db) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "a").gt("likes", 1).lte("likes", 4)).collect()),
        likesTake: Q((db) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "c").gte("likes", 2)).take(3)),
        likesDescTake: Q((db) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "a").lt("likes", 5)).order("desc").take(2)),
        allChannelsLow: Q((db) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.gte("channel", "b")).take(4)),
        filtered: Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "b")).filter((q: any) => q.or(q.eq(q.field("likes"), 0), q.gt(q.field("likes"), 4))).collect()),
        filteredTake: Q((db) => db.query("messages").filter((q: any) => q.eq(q.field("channel"), "c")).take(2)),
        recent: Q((db) => db.query("messages").order("desc").take(3)),
        count: Q(async (db) => (await db.query("messages").collect()).length),
        first: Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "c")).first()),
        get: Q((db) => db.get(pinned)),
        edited: Q((db) => db.query("messages").withIndex("by_edited", (q: any) => q.eq("meta.edited", true)).collect()),
        page1: Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).paginate({ numItems: 2, cursor: null })),
        search: searchHello,
        searchB: Q(async (db) => (await db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", "wor").eq("channel", "b")).collect()).sort((x: any, y: any) => (x._id < y._id ? -1 : 1))),
      };
      for (const [id, fn] of Object.entries(queries)) await s.subs.subscribe(id, fn);

      let invalidations = 0;
      let needed = 0;
      for (let step = 0; step < 300; step++) {
        const ops = 1 + Math.floor(rnd() * 3);
        const { changes } = await s.tx(async (db) => {
          for (let k = 0; k < ops; k++) {
            const r = rnd();
            if (r < 0.35 || live.length < 3) {
              live.push(await db.insert("messages", { channel: pick(channels), author: s.author, body: `${pick(words)} ${pick(words)}`, likes: Math.floor(rnd() * 6) }));
            } else if (r < 0.85) {
              const id = pick(live);
              const field = pick(["channel", "likes", "body", "meta"]);
              const value = field === "channel" ? pick(channels) : field === "likes" ? Math.floor(rnd() * 6) : field === "body" ? `${pick(words)} ${pick(words)}` : rnd() < 0.5 ? undefined : { edited: rnd() < 0.5, tags: [] };
              await db.patch(id, { [field]: value });
            } else {
              const id = pick(live.filter((x) => x !== pinned || rnd() < 0.1));
              live.splice(live.indexOf(id), 1);
              await db.delete(id);
            }
          }
        });
        const inv = new Set(s.subs.invalidated(changes));
        const changed: string[] = [];
        for (const [id, fn] of Object.entries(queries)) {
          const now = toJson((await s.engine.runQuery(fn)).value);
          if (now !== toJson(s.subs.valueOf(id))) changed.push(id);
        }
        // No false negatives: every subscription whose result changed was invalidated.
        for (const id of changed) expect({ step, id, invalidated: inv.has(id) }).toEqual({ step, id, invalidated: true });
        const patches = await s.subs.onCommit(changes);
        expect(patches.map((p) => p.subId).sort()).toEqual(changed.sort());
        invalidations += inv.size;
        needed += changed.length;
      }
      // Precision is reported, not asserted (false positives only cost a re-run).
      console.log(`seed ${seed}: ${needed} needed re-runs, ${invalidations} invalidations (${((needed / invalidations) * 100).toFixed(0)}% precise)`);
    });
  }
});
