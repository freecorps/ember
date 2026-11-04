// The subscription matching index (interval structure per (table, index)) against engine.matches.

import { describe, expect, it } from "vitest";
import { compareBytes } from "@ember/values";
import { createMatchIndex, IntervalSet, queryGeneric, type QueryCtx, type ReadSet, type RowChange } from "../src/index.ts";
import { fresh, prng, schema, withUser } from "./fixtures.ts";

const Q = (handler: (db: any) => unknown) => queryGeneric({ handler: (ctx: QueryCtx) => handler(ctx.db) }) as any;
const b = (...xs: number[]) => Uint8Array.from(xs);

describe("IntervalSet", () => {
  it("stabs half-open byte intervals through buffer, rebuilds and tombstones (vs brute force)", () => {
    const rnd = prng(3);
    const set = new IntervalSet<number>();
    const live = new Map<number, { lo: Uint8Array; hi: Uint8Array; rec: any }>();
    const key = () => b(...Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Math.floor(rnd() * 8)));
    let next = 0;
    for (let step = 0; step < 3000; step++) {
      const r = rnd();
      if (r < 0.5 || live.size < 5) {
        let lo = key();
        let hi = key();
        if (compareBytes(lo, hi) > 0) [lo, hi] = [hi, lo];
        const id = next++;
        live.set(id, { lo, hi, rec: set.add({ key: id, lo, hi, entry: {} as any }) });
      } else if (r < 0.7) {
        const ids = [...live.keys()];
        const id = ids[Math.floor(rnd() * ids.length)]!;
        set.remove(live.get(id)!.rec);
        live.delete(id);
      } else {
        const k = key();
        const got: number[] = [];
        set.stab(k, (rec) => got.push(rec.key));
        const want = [...live].filter(([, x]) => compareBytes(x.lo, k) <= 0 && compareBytes(k, x.hi) < 0).map(([id]) => id);
        expect(got.sort((x, y) => x - y)).toEqual(want.sort((x, y) => x - y));
      }
      expect(set.size).toBe(live.size);
    }
  });
});

describe("createMatchIndex", () => {
  it("db ranges, filters, table-wide keys (failing queries), plugin exact vs loose, replace and delete", () => {
    const env = fresh();
    const author = withUser(env);
    const hello = env.insert("messages", { channel: "a", author, body: "hello", likes: 1 });
    const index = createMatchIndex<string>(schema);
    const rs = (fn: any): ReadSet => env.engine.runQuery(fn).readSet;
    index.set("chanA", rs(Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).collect())));
    index.set("popularB", rs(Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "b")).filter((q: any) => q.gte(q.field("likes"), 5)).collect())));
    index.set("search", rs(Q((db) => db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", "hello")).collect())));
    index.set("failing", null, ["users"]);
    index.set("never", null);
    expect(index.size).toBe(5);

    const doc = (over: Record<string, unknown>) => ({ _id: "msg_1", _creationTime: 5, channel: "c", author, body: "x", likes: 0, ...over }) as any;
    const ins = (over: Record<string, unknown>): RowChange[] => [{ table: "messages", id: "msg_1", before: null, after: doc(over) }];
    const m = (changes: RowChange[]) => {
      const r = index.match(changes);
      return { exact: [...r.exact].sort(), loose: [...r.loose].sort() };
    };
    expect(m(ins({ channel: "a" }))).toEqual({ exact: ["chanA"], loose: ["search"] });
    expect(m(ins({ channel: "b", likes: 1 }))).toEqual({ exact: [], loose: ["search"] }); // fails the filter
    expect(m(ins({ channel: "b", likes: 9 }))).toEqual({ exact: ["popularB"], loose: ["search"] });
    expect(m(ins({ body: "hello again" }))).toEqual({ exact: ["search"], loose: [] });
    expect(m([{ table: "messages", id: hello, before: doc({ _id: hello, channel: "a", body: "hello" }), after: doc({ _id: hello, channel: "z", body: "hello" }) }])).toEqual({
      exact: ["chanA", "search"],
      loose: [],
    });
    expect(m([{ table: "users", id: author, before: null, after: { _id: author, _creationTime: 1 } as any }])).toEqual({ exact: ["failing"], loose: [] });
    // replace: chanA now reads channel "z"; delete
    index.set("chanA", rs(Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "z")).collect())));
    expect(m(ins({ channel: "a" })).exact).toEqual([]);
    expect(m(ins({ channel: "z" })).exact).toEqual(["chanA"]);
    index.delete("chanA");
    index.delete("search");
    expect(m(ins({ channel: "z", body: "hello" }))).toEqual({ exact: [], loose: [] });
    expect(index.has("chanA")).toBe(false);
    // an unknown index of a known table (or an unknown table) is table-wide
    index.set("gone", [{ table: "messages", index: "gone", lo: b(), hi: b(1), kind: "db" }]);
    expect(m(ins({})).exact).toEqual(["gone"]);
  });

  it("runQuery reports the tables a failing query touched", () => {
    const env = fresh();
    const touched = new Set<string>();
    const failing = Q((db) => {
      db.query("users").collect();
      db.get("msg_01ARZ3NDEKTSV4RRFFQ69G5FAV");
      throw new Error("boom");
    });
    expect(() => env.engine.runQuery(failing, {}, { identity: null }, { touched })).toThrow("boom");
    expect([...touched].sort()).toEqual(["messages", "users"]);
  });

  // Benchmark (always on, small enough for a laptop): 10k subscriptions, 1k changes.
  it("10k subscriptions x 1k changes: matches like engine.matches, within a sane time bound", () => {
    const env = fresh();
    const author = withUser(env);
    const rnd = prng(11);
    const CHANNELS = 1000;
    for (let i = 0; i < 300; i++) env.insert("messages", { channel: `c${Math.floor(rnd() * CHANNELS)}`, author, body: `w${i} hello`, likes: Math.floor(rnd() * 10) });
    // Read sets come from real query runs; several subscriptions share a shape (distinct args / identities).
    const shapes: ReadSet[] = [];
    for (let c = 0; c < CHANNELS; c++) {
      shapes.push(env.engine.runQuery(Q((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", `c${c}`)).take(20))).readSet);
      if (c % 4 === 0) {
        const lo = c % 10;
        shapes.push(env.engine.runQuery(Q((db) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", `c${c}`).gte("likes", lo)).collect())).readSet);
      }
    }
    for (let i = 0; i < 20; i++) shapes.push(env.engine.runQuery(Q((db) => db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", `w${i}`)).collect())).readSet);
    const subs: Array<[string, ReadSet]> = [];
    for (let i = 0; i < 10_000; i++) subs.push([`s${i}`, shapes[i % shapes.length]!]);

    const index = createMatchIndex<string>(schema);
    const t0 = performance.now();
    for (const [k, rs] of subs) index.set(k, rs);
    const tAdd = performance.now() - t0;

    const commits: RowChange[][] = [];
    for (let c = 0; c < 100; c++) {
      const changes: RowChange[] = [];
      for (let j = 0; j < 10; j++) {
        const id = `msg_${c}_${j}`;
        const mk = () => ({ _id: id, _creationTime: c * 10 + j, channel: `c${Math.floor(rnd() * CHANNELS)}`, author, body: `z${j}`, likes: Math.floor(rnd() * 10) }) as any;
        const r = rnd();
        changes.push(r < 0.4 ? { table: "messages", id, before: null, after: mk() } : r < 0.8 ? { table: "messages", id, before: mk(), after: mk() } : { table: "messages", id, before: mk(), after: null });
      }
      commits.push(changes);
    }
    const t1 = performance.now();
    const results = commits.map((ch) => index.match(ch).exact);
    const tMatch = performance.now() - t1;

    // Ground truth on a sample of commits (the linear scan is the slow path being replaced).
    const t2 = performance.now();
    for (let c = 0; c < 10; c++) {
      const want = subs.filter(([, rs]) => env.engine.matches(rs, commits[c]!)).map(([k]) => k).sort();
      expect([...results[c]!].sort()).toEqual(want);
    }
    const tLinear = (performance.now() - t2) * 10;
    const hits = results.reduce((n, r) => n + r.size, 0);
    console.log(`match index: add 10k ${tAdd.toFixed(0)} ms, 1k changes ${tMatch.toFixed(0)} ms (${hits} hits); linear ≈ ${tLinear.toFixed(0)} ms`);
    expect(tAdd).toBeLessThan(1000);
    expect(tMatch).toBeLessThan(1500);
  });
});
