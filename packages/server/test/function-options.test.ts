// Builder options of PR 3c: `query({ cache })` (edge-cached anonymous GET) and `mutation/action({ retainMs: 0 })`.
import { describe, expect, expectTypeOf, it } from "vitest";
import { action, fromAuth, internalMutation, internalQuery, MAX_QUERY_CACHE_SECONDS, mutation, query, v } from "../src/index.ts";

describe("query({ cache })", () => {
  it("is kept on the function, frozen, swr only when set", () => {
    const q = query({ args: { a: v.string() }, cache: { maxAge: 30, swr: 120 }, handler: (_ctx, { a }) => a });
    expect(q.cache).toEqual({ maxAge: 30, swr: 120 });
    expect(Object.isFrozen(q.cache)).toBe(true);
    expect(query({ cache: { maxAge: 5, swr: 0 }, handler: () => 1 }).cache).toEqual({ maxAge: 5 });
    expect(query({ handler: () => 1 }).cache).toBeUndefined();
  });

  it("refuses bad values and the wrong kinds of function", () => {
    const bad = [{ maxAge: 0 }, { maxAge: 1.5 }, { maxAge: -1 }, { maxAge: 40_000_000 }, { maxAge: 1, swr: -1 }, { maxAge: 1, swr: 0.5 }, { maxAge: 1, other: 1 }, {}, null, 5];
    for (const cache of bad) expect(() => query({ cache: cache as never, handler: () => 1 }), JSON.stringify(cache)).toThrow(/cache must be/);
    expect(() => (mutation as (d: unknown) => unknown)({ cache: { maxAge: 1 }, handler: () => 1 })).toThrow(/queries only/);
    // @ts-expect-error cache is for public queries only (a type error too, not just at load)
    expect(() => internalQuery({ cache: { maxAge: 1 }, handler: () => 1 })).toThrow(/public queries/);
    expect(() => query({ shard: { org: fromAuth("org") }, cache: { maxAge: 1 }, handler: () => 1 })).toThrow(/fromAuth/);
  });

  it("takes MAX_QUERY_CACHE_SECONDS for maxAge and swr, not one more; a fromArg shard is fine", () => {
    expect(MAX_QUERY_CACHE_SECONDS).toBe(31_536_000);
    const max = MAX_QUERY_CACHE_SECONDS;
    expect(query({ cache: { maxAge: max, swr: max }, handler: () => 1 }).cache).toEqual({ maxAge: max, swr: max });
    expect(() => query({ cache: { maxAge: max + 1 }, handler: () => 1 })).toThrow(/cache must be/);
    expect(() => query({ cache: { maxAge: 1, swr: max + 1 }, handler: () => 1 })).toThrow(/cache must be/);
    const routed = query({ args: { room: v.string() }, shard: { room: "room" }, cache: { maxAge: 1 }, handler: () => 1 });
    expect(routed.cache).toEqual({ maxAge: 1 });
    expect(routed.shard).toMatchObject({ kind: "room", fromArg: "room" });
  });

  it("is typed: maxAge required, numbers only", () => {
    // @ts-expect-error maxAge is required
    expect(() => query({ cache: { swr: 1 }, handler: () => 1 })).toThrow();
    expectTypeOf(query({ cache: { maxAge: 1 }, handler: () => 1 }).cache).toEqualTypeOf<{ readonly maxAge: number; readonly swr?: number } | undefined>();
  });
});

describe("retainMs: 0", () => {
  it("mutations and actions only, and only 0", () => {
    expect(mutation({ retainMs: 0, handler: () => 1 }).retainMs).toBe(0);
    expect(internalMutation({ retainMs: 0, handler: () => 1 }).retainMs).toBe(0);
    expect(action({ retainMs: 0, handler: async () => 1 }).retainMs).toBe(0);
    expect(mutation({ handler: () => 1 }).retainMs).toBeUndefined();
    // @ts-expect-error only 0
    expect(() => mutation({ retainMs: 1000, handler: () => 1 })).toThrow(/retainMs must be 0/);
    expect(() => (query as (d: unknown) => unknown)({ retainMs: 0, handler: () => 1 })).toThrow(/mutations and actions/);
  });
});
