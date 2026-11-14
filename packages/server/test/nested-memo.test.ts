// Nested `ctx.runQuery` reuse (NestedQueryMemo): a per-user query over a list every user sees runs the list once per
// memo (the runtime keeps one per shard version). Identity reads of the nested call are tracked apart from the
// outer's, its read set is the caller's too, its `authorize` runs per caller, and each caller gets its own copy.
import { describe, expect, test } from "vitest";
import { defineErrors, makeFunctionReference, NestedQueryMemo, queryGeneric, v, type QueryCtx } from "../src/index.ts";
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
});
