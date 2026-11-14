// Identity tracking and `authorize` (docs/design/dx.md §3.13): what lets the runtime share a query result between
// identities. A run that never read the identity answers the same for everyone; `authorize` is the per-caller check
// in front of a handler that has no `ctx.auth`.
import { describe, expect, expectTypeOf, test } from "vitest";
import { defineErrors, makeFunctionReference, mutationGeneric, newQueryProfile, queryGeneric, runLocalQuery, v, type QueryCtx } from "../src/index.ts";
import { fresh, schema, withUser } from "./fixtures.ts";

const errors = defineErrors({ Forbidden: {} });
const query = queryGeneric;

describe("identity tracking", () => {
  const ada = { subject: "ada" };
  const run = (env: ReturnType<typeof fresh>, fn: unknown, args: Record<string, unknown> = {}, identity: { subject: string } | null = ada, phase?: "authorize" | "handler") => {
    const track = { read: false };
    try {
      const r = env.engine.runQuery(fn as never, args, { identity }, { identity: track, ...(phase ? { phase } : {}) });
      return { value: r.value, read: track.read, readSet: r.readSet };
    } catch (e) {
      return { error: (e as { code: string }).code, read: track.read };
    }
  };

  test("reads through getUserIdentity, require, middlewares and nested runQuery are seen, even when they throw", () => {
    const none = query({ handler: (ctx: QueryCtx) => ctx.db.query("users").collect().length });
    const who = query({ handler: (ctx: QueryCtx) => ctx.auth.getUserIdentity()?.subject ?? null });
    const must = query({ handler: (ctx: QueryCtx) => ctx.auth.require().subject });
    const withMe = query.use((ctx) => ({ ctx: { me: ctx.auth.getUserIdentity() } }))({ handler: () => 1 });
    const nested = query({ handler: (ctx: QueryCtx) => ctx.runQuery(makeFunctionReference<"query">("m:who")) });
    const env = fresh({ functions: { "m:who": who, "m:nested": nested } });
    expect(run(env, none)).toMatchObject({ value: 0, read: false });
    expect(run(env, who)).toMatchObject({ value: "ada", read: true });
    expect(run(env, must, {}, null)).toMatchObject({ error: "Unauthenticated", read: true });
    expect(run(env, withMe)).toMatchObject({ value: 1, read: true });
    expect(run(env, "m:nested")).toMatchObject({ value: "ada", read: true });
  });

  test("a data-dependent branch reads the identity only when it runs", () => {
    const env = fresh();
    const author = withUser(env);
    const branch = query({
      handler: (ctx: QueryCtx) => {
        const rows = ctx.db.query("messages").collect();
        return rows.some((m) => m.likes > 10) ? (ctx.auth.getUserIdentity()?.subject ?? null) : rows.length;
      },
    });
    expect(run(env, branch)).toMatchObject({ value: 0, read: false });
    env.insert("messages", { channel: "a", author, body: "hot", likes: 11 });
    expect(run(env, branch)).toMatchObject({ value: "ada", read: true });
  });
});

describe("authorize", () => {
  const room = query({
    args: { channel: v.string() },
    errors: [errors.Forbidden],
    authorize: (ctx, { channel }) => {
      const me = ctx.auth.require();
      if (!ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", `${me.subject}@x.dev`)).first() || channel === "closed") ctx.fail.Forbidden();
    },
    handler: (ctx, { channel }) => ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel)).collect().length,
  });

  test("full runs check first; the phases run the check or the handler alone, each with its own read set", () => {
    const env = fresh({ functions: { "m:room": room } });
    withUser(env); // ada@x.dev
    const ada = { identity: { subject: "ada" } };
    const bob = { identity: { subject: "bob" } };
    expect(env.engine.runQuery("m:room", { channel: "a" }, ada).value).toBe(0);
    expect(() => env.engine.runQuery("m:room", { channel: "a" }, bob)).toThrow(expect.objectContaining({ code: "Forbidden" }));
    expect(() => env.engine.runQuery("m:room", { channel: "a" }, { identity: null })).toThrow(expect.objectContaining({ code: "Unauthenticated" }));
    const check = env.engine.runQuery("m:room", { channel: "a" }, ada, { phase: "authorize" });
    expect(check.value).toBeUndefined();
    expect(check.readSet.map((e) => e.table)).toEqual(["users"]);
    // The handler phase skips the check (the runtime gates it) and never reads the identity.
    const track = { read: false };
    const data = env.engine.runQuery("m:room", { channel: "a" }, bob, { phase: "handler", identity: track });
    expect(data.readSet.map((e) => e.table)).toEqual(["messages"]);
    expect(track.read).toBe(false);
    // A refusal keeps the reads that decided it (the array the caller passed).
    const readSet: never[] = [];
    expect(() => env.engine.runQuery("m:room", { channel: "a" }, bob, { phase: "authorize", readSet })).toThrow();
    expect((readSet as Array<{ table: string }>).map((e) => e.table)).toEqual(["users"]);
    expect(env.engine.functionInfo("m:room")).toMatchObject({ authorize: true });
  });

  test("middlewares run before the check and before the handler; onSuccess only after the handler", () => {
    const calls: string[] = [];
    const q2 = query.use((ctx) => {
      calls.push("mw");
      return { ctx: { tag: "t" }, onSuccess: () => void calls.push("after") };
    });
    const fn = q2({
      authorize: (ctx) => {
        calls.push(`authorize:${ctx.tag}`);
      },
      handler: (ctx) => {
        calls.push(`handler:${ctx.tag}`);
        return 1;
      },
    });
    const env = fresh({ functions: { "m:fn": fn } });
    env.engine.runQuery("m:fn", {}, { identity: null });
    expect(calls).toEqual(["mw", "authorize:t", "mw", "handler:t", "after"]);
  });

  test("only queries take authorize; it must be synchronous; replicas run it too", () => {
    expect(() => (mutationGeneric as any)({ authorize: () => {}, handler: () => 1 })).toThrow(/queries only/);
    const slow = query({ authorize: (async () => {}) as never, handler: () => 1 });
    const env = fresh({ functions: { "m:slow": slow } });
    expect(() => env.engine.runQuery("m:slow", {}, { identity: null })).toThrow(expect.objectContaining({ code: "AsyncHandler" }));
    const reader = { get: () => null, scan: () => [] };
    expect(() => runLocalQuery(room, { channel: "closed" }, { schema, reader, identity: null })).toThrow(expect.objectContaining({ code: "Unauthenticated" }));
  });

  test("types: the handler of a query with authorize has no ctx.auth", () => {
    query({
      authorize: (ctx) => {
        expectTypeOf(ctx.auth.require).toBeFunction();
      },
      handler: (ctx) => {
        // @ts-expect-error ctx.auth is not available next to authorize: read the identity in authorize
        void ctx.auth;
        return ctx.db.query("users").collect();
      },
    });
  });
});

describe("query profile (ember dev feedback)", () => {
  test("counts scanned rows, rows a filter drops, the largest collect and ctx.db.sql calls, nested ones included", () => {
    const sqlCount = query({ handler: (ctx: QueryCtx) => (ctx.db.sql`SELECT count(*) AS n FROM users` as unknown[]).length });
    const env = fresh({ functions: { "m:sqlCount": sqlCount } });
    const author = withUser(env);
    for (let i = 0; i < 30; i++) env.insert("messages", { channel: "a", author, body: `m${i}`, likes: i });
    const profileOf = (fn: unknown) => {
      const profile = newQueryProfile();
      env.engine.runQuery(fn as never, {}, { identity: null }, { profile });
      return profile;
    };
    const filtered = query({ handler: (ctx: QueryCtx) => ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", "a")).filter((q) => q.gte(q.field("likes"), 25)).collect() });
    expect(profileOf(filtered)).toEqual({ scanned: 30, filteredOut: 25, collectRows: 5, sql: 0 });
    const taken = query({ handler: (ctx: QueryCtx) => ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", "a")).take(3) });
    expect(profileOf(taken)).toEqual({ scanned: 3, filteredOut: 0, collectRows: 0, sql: 0 });
    const both = query({
      handler: (ctx: QueryCtx) => {
        ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", "a")).take(2);
        ctx.db.query("users").collect();
        return ctx.runQuery(makeFunctionReference<"query">("m:sqlCount"));
      },
    });
    expect(profileOf(both)).toEqual({ scanned: 3, filteredOut: 0, collectRows: 1, sql: 1 });
  });
});
