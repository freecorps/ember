// Nested `ctx.runQuery` reuse (NestedQueryMemo): a per-user query over a list every user sees runs the list once per
// memo (the runtime keeps one per shard version). Identity reads of the nested call are tracked apart from the
// outer's, its read set is the caller's too, its `authorize` runs per caller, and each caller gets its own copy.
import { describe, expect, test } from "vitest";
import { defineErrors, makeFunctionReference, NESTED_MEMO_MAX_BYTES, NestedQueryMemo, queryGeneric, v, type QueryCtx } from "../src/index.ts";
import { fresh, withUser } from "./fixtures.ts";

const query = queryGeneric;
const errors = defineErrors({ Forbidden: {} });
const listRef = makeFunctionReference<"query">("m:list");

const list = query({ args: { channel: v.string() }, handler: (ctx: QueryCtx, { channel }: { channel: string }) => ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel)).collect() });
const feed = query({
  args: { channel: v.string() },
  handler: (ctx: QueryCtx, { channel }: { channel: string }) => {
    const me = ctx.auth.require().subject;
    const rows = ctx.runQuery(listRef, { channel }) as Array<Record<string, unknown>>;
    // Changes what it got: never another caller's copy.
    for (const r of rows) r.seenBy = me;
    return rows;
  },
});
const whoRef = makeFunctionReference<"query">("m:who");
const who = query({ handler: (ctx: QueryCtx) => ctx.auth.getUserIdentity()?.subject ?? null });
const viaWho = query({ handler: (ctx: QueryCtx) => ctx.runQuery(whoRef) });
const gatedRef = makeFunctionReference<"query">("m:gated");
const gated = query({
  args: { channel: v.string() },
  errors: [errors.Forbidden],
  authorize: (ctx) => {
    if (ctx.auth.require().subject === "eve") ctx.fail.Forbidden();
  },
  handler: (ctx, { channel }) => ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel)).collect().length,
});
const viaGated = query({ args: { channel: v.string() }, handler: (ctx: QueryCtx, { channel }: { channel: string }) => ctx.runQuery(gatedRef, { channel }) });

function env() {
  const e = fresh({ functions: { "m:list": list, "m:feed": feed, "m:who": who, "m:viaWho": viaWho, "m:gated": gated, "m:viaGated": viaGated } });
  const author = withUser(e);
  e.insert("messages", { channel: "a", author, body: "one", likes: 1 });
  e.insert("messages", { channel: "a", author, body: "two", likes: 2 });
  return e;
}
const as = (subject: string) => ({ identity: { subject } });

describe("NestedQueryMemo", () => {
  test("the list runs once for every user; each gets its own copy; the outer read set includes the nested one", () => {
    const e = env();
    const memo = new NestedQueryMemo();
    const runs = ["ada", "bob", "cy"].map((u) => {
      const track = { read: false };
      const r = e.engine.runQuery("m:feed", { channel: "a" }, as(u), { identity: track, nested: memo });
      return { ...r, read: track.read };
    });
    expect(memo.misses).toBe(1);
    expect(memo.hits).toBe(2);
    for (const [i, u] of ["ada", "bob", "cy"].entries()) {
      expect((runs[i]!.value as Array<{ seenBy: string; body: string }>).map((r) => [r.body, r.seenBy])).toEqual([["one", u], ["two", u]]);
      expect(runs[i]!.read).toBe(true);
      // The nested scan of `messages` is in every caller's read set (the change of a message re-runs them all).
      expect(runs[i]!.readSet.some((x) => x.table === "messages" && x.index === "by_channel")).toBe(true);
    }
    // Without the memo: the same values.
    const plain = e.engine.runQuery("m:feed", { channel: "a" }, as("bob")).value;
    expect(runs[1]!.value).toEqual(plain);
  });

  test("a nested call that reads the identity is not reused (and the outer knows it read it)", () => {
    const e = env();
    const memo = new NestedQueryMemo();
    const out = ["ada", "bob"].map((u) => {
      const track = { read: false };
      return { v: e.engine.runQuery("m:viaWho", {}, as(u), { identity: track, nested: memo }).value, read: track.read };
    });
    expect(out).toEqual([{ v: "ada", read: true }, { v: "bob", read: true }]);
    expect(memo.hits).toBe(0);
    expect(memo.entries.size).toBe(0);
  });

  test("the nested query's authorize runs per caller: a refused caller fails, the others share its handler", () => {
    const e = env();
    const memo = new NestedQueryMemo();
    const run = (u: string) => {
      try {
        return e.engine.runQuery("m:viaGated", { channel: "a" }, as(u), { identity: { read: false }, nested: memo }).value;
      } catch (x) {
        return (x as { code: string }).code;
      }
    };
    expect(run("ada")).toBe(2);
    expect(run("eve")).toBe("Forbidden");
    expect(run("bob")).toBe(2);
    expect(memo.hits).toBe(1);
  });

  test("a top-level run that did not read the identity serves later nested calls", () => {
    const e = env();
    const memo = new NestedQueryMemo();
    e.engine.runQuery("m:feed", { channel: "a" }, as("ada")); // learns that m:list is called nested
    const track = { read: false };
    e.engine.runQuery("m:list", { channel: "a" }, as("x"), { identity: track, nested: memo });
    expect(memo.entries.size).toBe(1);
    e.engine.runQuery("m:feed", { channel: "a" }, as("bob"), { identity: { read: false }, nested: memo });
    expect(memo.hits).toBe(1);
  });

  test("a result that is not plain data is never shared (a copy would change it)", () => {
    const e = env();
    const dated = query({ handler: () => ({ at: new Date(0) }) });
    const viaDated = query({ handler: (ctx: QueryCtx) => (ctx.runQuery(makeFunctionReference<"query">("m:dated")) as { at: Date }).at instanceof Date });
    const e2 = fresh({ functions: { "m:dated": dated, "m:viaDated": viaDated } });
    const memo = new NestedQueryMemo();
    for (let i = 0; i < 2; i++) expect(e2.engine.runQuery("m:viaDated", {}, as("ada"), { identity: { read: false }, nested: memo }).value).toBe(true);
    expect(memo.entries.size).toBe(0);
    void e;
  });

  test("a byte budget: the oldest entries go first, a result over a quarter of it is not kept", () => {
    const memo = new NestedQueryMemo(256, 400_000);
    const rows = (n: number, w: number) => Array.from({ length: n }, (_, i) => ({ _id: `m${i}`, body: "x".repeat(w) }));
    // ~20 KB each (2 bytes per char): 19 fit in 400 KB, the 20th evicts the first.
    for (let i = 0; i < 20; i++) memo.set(`k${i}`, rows(10, 1000), [], ["messages"]);
    expect(memo.bytes).toBeLessThanOrEqual(400_000);
    expect(memo.entries.has("k0")).toBe(false);
    expect(memo.entries.has("k19")).toBe(true);
    expect(memo.entries.size).toBeGreaterThan(10);
    // ~200 KB: over a quarter of the budget, never kept (the call runs every time), the others stay.
    const before = memo.entries.size;
    memo.set("huge", rows(100, 1000), [], ["messages"]);
    expect(memo.entries.has("huge")).toBe(false);
    expect(memo.entries.size).toBe(before);
    // Replacing a key frees its old size first.
    const bytes = memo.bytes;
    memo.set("k19", rows(10, 1000), [], ["messages"]);
    expect(memo.bytes).toBe(bytes);
    expect([...memo.entries.values()].reduce((n, e) => n + e.bytes, 0)).toBe(memo.bytes);
  });

  test("the read set's filter literals and plugin data count: small results with big metadata stay within the budget", () => {
    const memo = new NestedQueryMemo(256, 400_000);
    const bound = new Uint8Array(4);
    const entry = (i: number, size: number) => ({
      table: "messages",
      index: "by_channel",
      lo: bound,
      hi: bound,
      kind: "db",
      filter: { op: "eq", field: "body", value: new Uint8Array(size).fill(i) } as any,
      data: { terms: ["w".repeat(size / 4)] },
    });
    // ~30 KB of metadata each, a null result: 13 fit (were all 32 kept, ~1 MB).
    for (let i = 0; i < 32; i++) memo.set(`k${i}`, null, [entry(i, 20_000)], ["messages"]);
    expect(memo.bytes).toBeLessThanOrEqual(400_000);
    expect(memo.entries.size).toBeLessThanOrEqual(13);
    expect([...memo.entries.values()].every((e) => e.bytes > 30_000)).toBe(true);
    // Metadata over a quarter of the budget: not kept, the others stay.
    const before = memo.entries.size;
    memo.set("big", null, [entry(1, 80_000)], ["messages"]);
    expect(memo.entries.has("big")).toBe(false);
    expect(memo.entries.size).toBe(before);
    // So is a read set of many small entries adding up past it.
    memo.set("many", null, Array.from({ length: 2000 }, () => ({ table: "messages", index: "by_channel", lo: bound, hi: bound, kind: "db" })), ["messages"]);
    expect(memo.entries.has("many")).toBe(false);
  });

  test("a huge collection in the read set's metadata stops early, before its children are all on the stack", () => {
    const memo = new NestedQueryMemo(256, 400_000);
    const bound = new Uint8Array(4);
    let reads = 0;
    const big = new Proxy(new Array<number>(1_000_000).fill(1), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    memo.set("huge", null, [{ table: "messages", index: "by_channel", lo: bound, hi: bound, kind: "db", data: { terms: big } }], ["messages"]);
    expect(memo.entries.has("huge")).toBe(false);
    // A quarter of 400 KB at 16 bytes a child: ~6 250 children visited, not a million.
    expect(reads).toBeLessThan(10_000);
  });

  test("the default budget keeps a big shared list out of a 128 MB isolate's way", () => {
    const memo = new NestedQueryMemo();
    expect(memo.maxBytes).toBe(NESTED_MEMO_MAX_BYTES);
    const list = Array.from({ length: 2000 }, (_, i) => ({ _id: `m${i}`, body: "y".repeat(500) })); // ~2 MB
    for (let i = 0; i < 30; i++) memo.set(`list${i}`, list, [], ["messages"]);
    expect(memo.bytes).toBeLessThanOrEqual(NESTED_MEMO_MAX_BYTES);
    expect(memo.entries.size).toBeLessThan(30);
    expect(memo.entries.size).toBeGreaterThan(0);
  });
});
