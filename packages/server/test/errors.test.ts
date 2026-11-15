// Application errors (docs/design/dx.md §3.2): defineErrors, the builders' `errors:` and `ctx.fail`, the wire form,
// and `ctx.auth.require()`.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AppError,
  checkedEnv,
  checkShard,
  claimShardOf,
  fromAuth,
  SYSTEM_AUTH,
  defineApp,
  defineErrors,
  defineSchema,
  defineTable,
  EmberError,
  errorFromWire,
  errorInfo,
  isAppError,
  makeFunctionReference,
  mutationGeneric,
  shardSpecOf,
  queryGeneric,
  v,
  type EnvOf,
  type ErrorSpecsOf,
  type MutationCtx,
  type ShardDef,
} from "../src/index.ts";
import { fresh } from "./fixtures.ts";

const errors = defineErrors({
  TooLong: { data: v.object({ max: v.number() }), message: (d: { max: number }) => `at most ${d.max}` },
  Closed: { message: "The channel is closed" },
  Big: { data: v.object({ n: v.int64() }) },
});

describe("defineErrors", () => {
  it("builds typed AppErrors with validated data and messages", () => {
    const e = errors.TooLong({ max: 3 });
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(EmberError);
    expect(e).toMatchObject({ kind: "app", code: "TooLong", data: { max: 3 }, message: "at most 3" });
    expectTypeOf(e.data).toEqualTypeOf<{ max: number }>();
    expectTypeOf(e.code).toEqualTypeOf<"TooLong">();
    expect(errors.Closed().message).toBe("The channel is closed");
    expect(errors.Closed(undefined, { message: "custom" }).message).toBe("custom");
    expect(errors.TooLong.is(e)).toBe(true);
    expect(errors.Closed.is(e)).toBe(false);
    expect(errors.TooLong.code).toBe("TooLong");
    expect(errors.Closed.message).toBe("The channel is closed");
    expect(errors.TooLong.message).toBeUndefined(); // a function of the data
    expect(errors.TooLong.shape).toEqual({ kind: "object", fields: { max: { shape: { kind: "number" }, optional: false } } });
  });

  it("refuses bad data, bad codes and conflicting definitions", () => {
    expect(() => errors.TooLong({ max: "x" } as never)).toThrow(/errors.TooLong: invalid data at max/);
    expect(() => (errors.Closed as (d: unknown) => unknown)({ x: 1 })).toThrow(/takes no data/);
    expect(() => defineErrors({ notPascal: {} })).toThrow(/PascalCase/);
    // Redefining a code (ember dev re-evaluates the app on every save) is fine here; codegen refuses real duplicates.
    expect(() => defineErrors({ TooLong: { data: v.object({ max: v.string() }) } })).not.toThrow();
  });

  it("wire form: kind and data for app errors; codes for the rest", () => {
    expect(errorInfo(errors.Big({ n: 5n }))).toEqual({ code: "Big", message: "Big", data: { n: 5n }, kind: "app" });
    expect(errorInfo(new EmberError("NotFound", "x"))).toEqual({ code: "NotFound", message: "x" });
    expect(errorInfo(new Error("plain"))).toEqual({ code: "Error", message: "plain" });
    const back = errorFromWire({ code: "Big", message: "m", data: { n: 1n }, kind: "app" });
    expect(isAppError(back) && back.code).toBe("Big");
    expect(isAppError(errorFromWire({ code: "NotFound", message: "m" }))).toBe(false);
  });

  it("an app error's HTTP status survives the wire", () => {
    const e = defineErrors({ Gone: { status: 410 } });
    const w = errorInfo(e.Gone());
    expect(w).toMatchObject({ code: "Gone", kind: "app", status: 410 });
    expect((errorFromWire(w) as AppError).status).toBe(410);
  });
});

describe("functions with errors", () => {
  it("`errors:` is kept on the function, typed, and `ctx.fail` throws them (rolling back)", () => {
    const send = mutationGeneric({
      args: { channel: v.string() },
      errors: [errors.TooLong, errors.Closed],
      handler: (ctx, { channel }) => {
        ctx.db.insert("users", { name: channel, email: `${channel}@x`, admin: false });
        if (channel === "closed") ctx.fail.Closed();
        if (channel.length > 3) return ctx.fail.TooLong({ max: 3 });
        // @ts-expect-error not declared
        void ctx.fail.Big;
        return channel;
      },
    });
    expect(send.errors?.map((e) => e.code)).toEqual(["TooLong", "Closed"]);
    expectTypeOf<NonNullable<typeof send.__errors>>().toEqualTypeOf<ErrorSpecsOf<[typeof errors.TooLong, typeof errors.Closed]>>();
    const s = fresh();
    expect(s.engine.runMutation(send as never, { channel: "ok" }).value).toBe("ok");
    expect(() => s.engine.runMutation(send as never, { channel: "toolong" })).toThrow(expect.objectContaining({ code: "TooLong", kind: "app", data: { max: 3 } }));
    expect(() => s.engine.runMutation(send as never, { channel: "closed" })).toThrow(expect.objectContaining({ code: "Closed" }));
    expect(s.sql("SELECT count(*) AS n FROM users")[0]!.n).toBe(1);
  });

  it("refuses an `errors` list that is not defineErrors entries", () => {
    expect(() => mutationGeneric({ errors: [() => new Error("x")] as never, handler: () => null })).toThrow(/defineErrors/);
  });

  it("ctx.auth.require(): the identity, or Unauthenticated", () => {
    const me = queryGeneric({ handler: (ctx) => ctx.auth.require().subject });
    const s = fresh();
    expect(s.engine.runQuery(me as never, {}, { identity: { subject: "u1" } }).value).toBe("u1");
    expect(() => s.engine.runQuery(me as never, {})).toThrow(expect.objectContaining({ code: "Unauthenticated", kind: "system" }));
  });

  it("a nested mutation's error reaches the caller, which may catch it", () => {
    const inner = mutationGeneric({ errors: [errors.Closed], handler: (ctx: MutationCtx & { fail: { Closed(): never } }) => ctx.fail.Closed() });
    const outer = mutationGeneric({
      handler: (ctx) => {
        try {
          ctx.runMutation(makeFunctionReference<"mutation", {}>("m:inner"));
          return "no";
        } catch (e) {
          return errors.Closed.is(e) ? "caught" : "other";
        }
      },
    });
    const s = fresh({ functions: { m: { inner, outer } } as never });
    expect(s.engine.runMutation("m:outer", {}).value).toBe("caught");
  });
});

describe("shard: on functions", () => {
  it("validates the spec and keeps it on the function", () => {
    const list = queryGeneric({ shard: { room: "roomId" }, args: { roomId: v.string() }, handler: () => 1 });
    expect(list.shard).toEqual({ kind: "room", fromArg: "roomId" });
    expect(queryGeneric({ shard: "org", handler: () => 1 }).shard).toEqual({ kind: "org" });
    expect(() => queryGeneric({ shard: { room: "nope" } as never, args: { roomId: v.string() }, handler: () => 1 })).toThrow(/must be a required argument/);
    expect(() => queryGeneric({ shard: { a: "x", b: "y" } as never, args: { x: v.string() }, handler: () => 1 })).toThrow(/one kind/);
    // @ts-expect-error not an argument
    void (() => queryGeneric({ shard: { room: "nope" }, args: { roomId: v.string() }, handler: () => 1 }));
  });

  it("refuses to run on another shard kind or another key (WrongShard)", () => {
    let shard = "room:r1";
    const list = queryGeneric({ shard: { room: "roomId" }, args: { roomId: v.string() }, handler: (_c, { roomId }) => roomId });
    const stats = queryGeneric({ shard: "org", handler: () => "ok" });
    const s = fresh({ shardName: () => shard });
    expect(s.engine.runQuery(list as never, { roomId: "r1" }).value).toBe("r1");
    expect(() => s.engine.runQuery(list as never, { roomId: "r2" })).toThrow(expect.objectContaining({ code: "WrongShard" }));
    expect(() => s.engine.runQuery(stats as never, {})).toThrow(/runs in "org" shards, not in room:r1/);
    shard = "org:acme";
    expect(s.engine.runQuery(stats as never, {}).value).toBe("ok");
  });
});

describe("shard: fromAuth (the key is a claim of the identity)", () => {
  const as = (org?: unknown) => ({ identity: { subject: "ana", claims: org === undefined ? {} : { org } } });

  it("keeps a serializable spec, and refuses bad claim names", () => {
    const list = queryGeneric({ shard: { org: fromAuth("org") }, handler: () => 1 });
    expect(list.shard).toEqual({ kind: "org", fromClaim: "org" });
    expect(JSON.parse(JSON.stringify(list.shard))).toEqual({ kind: "org", fromClaim: "org" });
    expect(shardSpecOf({ team: fromAuth("team_id") }, { kind: "object", fields: {} }, "q()")).toEqual({ kind: "team", fromClaim: "team_id" });
    expect(() => fromAuth("" as string)).toThrow(/bad claim name/);
    expect(() => fromAuth("a b" as string)).toThrow(/bad claim name/);
    expect(() => queryGeneric({ shard: { org: 1 } as never, handler: () => 1 })).toThrow(/must name an argument/);
    // Typed: an argument name or fromAuth(...), nothing else.
    expectTypeOf(fromAuth("org")).toEqualTypeOf<ReturnType<typeof fromAuth<"org">>>();
    expectTypeOf<{ org: ReturnType<typeof fromAuth> }>().toExtend<ShardDef<{}>>();
    // @ts-expect-error not an argument, not a claim
    void (() => queryGeneric({ shard: { org: { claim: "org" } }, handler: () => 1 }));
  });

  it("checkShard: no identity is Unauthenticated, another or no claim is WrongShard, system runs skip the claim", () => {
    const spec = { kind: "org", fromClaim: "org" };
    expect(() => checkShard("f", spec, "org:a", {}, { identity: null })).toThrow(expect.objectContaining({ code: "Unauthenticated" }));
    expect(() => checkShard("f", spec, "org:a", {}, undefined)).toThrow(expect.objectContaining({ code: "Unauthenticated" }));
    expect(() => checkShard("f", spec, "org:a", {}, as("b"))).toThrow(expect.objectContaining({ code: "WrongShard", data: { expected: "org:b", shard: "org:a" } }));
    expect(() => checkShard("f", spec, "org:a", {}, as())).toThrow(expect.objectContaining({ code: "WrongShard", data: { expected: "org", shard: "org:a" } }));
    expect(() => checkShard("f", spec, "org:a", {}, as({ id: "a" }))).toThrow(expect.objectContaining({ code: "WrongShard" }));
    expect(() => checkShard("f", spec, "room:a", {}, as("a"))).toThrow(/runs in "org" shards/);
    expect(() => checkShard("f", spec, "org:a", {}, as("a"))).not.toThrow();
    expect(() => checkShard("f", spec, "org:7", {}, as(7))).not.toThrow();
    expect(() => checkShard("f", spec, "org:a", {}, SYSTEM_AUTH)).not.toThrow();
    expect(() => checkShard("f", spec, "org:a", {}, { identity: null }, { claims: false })).not.toThrow();
    expect(claimShardOf(spec, as("a").identity)).toBe("org:a");
    expect(claimShardOf(spec, as().identity)).toBeUndefined();
    expect(claimShardOf(spec, null)).toBeUndefined();
    expect(claimShardOf({ kind: "org" }, as("a").identity)).toBeUndefined();
  });

  it("the engine checks the caller's claim in queries, mutations and nested calls", () => {
    let shard = "org:acme";
    const list = queryGeneric({ shard: { org: fromAuth("org") }, handler: (ctx) => `list@${ctx.auth.getUserIdentity()?.subject ?? "-"}` });
    const add = mutationGeneric({ shard: { org: fromAuth("org") }, handler: (ctx) => ctx.runQuery(makeFunctionReference<"query", {}, string>("o:list"), {}) });
    const s = fresh({ shardName: () => shard, functions: { o: { list, add } } as never });
    expect(s.engine.runQuery("o:list", {}, as("acme")).value).toBe("list@ana");
    expect(() => s.engine.runQuery("o:list", {}, { identity: null })).toThrow(expect.objectContaining({ code: "Unauthenticated" }));
    expect(() => s.engine.runQuery("o:list", {}, as("other"))).toThrow(expect.objectContaining({ code: "WrongShard", data: { expected: "org:other", shard: "org:acme" } }));
    expect(s.engine.runMutation("o:add", {}, as("acme")).value).toBe("list@ana");
    expect(() => s.engine.runMutation("o:add", {}, as("other"))).toThrow(expect.objectContaining({ code: "WrongShard" }));
    // A scheduled job (system run): no identity, no claim to check.
    expect(s.engine.runMutation("o:add", {}, SYSTEM_AUTH).value).toBe("list@-");
    shard = "room:r1";
    expect(() => s.engine.runQuery("o:list", {}, as("acme"))).toThrow(/runs in "org" shards/);
  });

  it("is a per-caller check (functionInfo.authorize): the authorize phase checks the claim, the shared handler does not", () => {
    const list = queryGeneric({ shard: { org: fromAuth("org") }, handler: () => "shared" });
    const s = fresh({ shardName: () => "org:acme", functions: { o: { list } } as never });
    expect(s.engine.functionInfo("o:list")).toMatchObject({ authorize: true, claim: "org" });
    expect(s.engine.runQuery("o:list", {}, as("acme"), { phase: "authorize" }).value).toBeUndefined();
    expect(() => s.engine.runQuery("o:list", {}, as("other"), { phase: "authorize" })).toThrow(expect.objectContaining({ code: "WrongShard" }));
    expect(s.engine.runQuery("o:list", {}, { identity: null }, { phase: "handler" }).value).toBe("shared");
  });
});

describe("middlewares (.use)", () => {
  const authErrors = defineErrors({ NoOrg: { data: v.object({ orgId: v.string() }) } });
  const authed = mutationGeneric.use((ctx) => ({ ctx: { user: ctx.auth.require().subject } }));
  const orgMutation = authed.use({
    args: { orgId: v.string() },
    errors: [authErrors.NoOrg],
    handler: (ctx, { orgId }) => {
      if (orgId === "none") ctx.fail.NoOrg({ orgId });
      const org = `${ctx.user}@${orgId}`;
      return { ctx: { org }, onSuccess: (c, result) => void c.db.insert("users", { name: String(result), email: org, admin: false }) };
    },
  });

  it("adds ctx, args and errors to every function, and runs onSuccess in the same transaction", () => {
    const rename = orgMutation({
      args: { name: v.string() },
      errors: [errors.TooLong],
      handler: (ctx, { orgId, name }) => {
        expectTypeOf(ctx.user).toEqualTypeOf<string>();
        expectTypeOf(ctx.org).toEqualTypeOf<string>();
        expectTypeOf(orgId).toEqualTypeOf<string>();
        if (name.length > 5) ctx.fail.TooLong({ max: 5 });
        void ctx.fail.NoOrg; // the middleware's errors are the function's too
        return `${ctx.org}:${name}`;
      },
    });
    expectTypeOf<NonNullable<typeof rename.__errors>["code"]>().toEqualTypeOf<"NoOrg" | "TooLong">();
    expectTypeOf<NonNullable<typeof rename.__args>>().toEqualTypeOf<{ name: string; orgId: string }>();
    expect(Object.keys(rename.args.fields).sort()).toEqual(["name", "orgId"]);
    expect(rename.errors?.map((e) => e.code)).toEqual(["NoOrg", "TooLong"]);
    expect(rename.declaresErrors).toBe(true);

    const s = fresh();
    const id = { identity: { subject: "ana" } };
    expect(s.engine.runMutation(rename as never, { orgId: "acme", name: "x" }, id).value).toBe("ana@acme:x");
    expect(() => s.engine.runMutation(rename as never, { orgId: "none", name: "x" }, id)).toThrow(expect.objectContaining({ code: "NoOrg", data: { orgId: "none" } }));
    expect(() => s.engine.runMutation(rename as never, { orgId: "acme", name: "x" })).toThrow(expect.objectContaining({ code: "Unauthenticated" }));
    expect(() => s.engine.runMutation(rename as never, { orgId: "acme", name: "toolong" }, id)).toThrow(expect.objectContaining({ code: "TooLong" }));
    expect(() => s.engine.runMutation(rename as never, { name: "x" }, id)).toThrow(/Invalid arguments/);
    // One onSuccess row for the one success; the failed calls wrote nothing.
    expect(s.sql("SELECT count(*) AS n FROM users")[0]!.n).toBe(1);
  });

  it("refuses an argument defined twice and async middlewares of mutations", () => {
    expect(() => orgMutation({ args: { orgId: v.string() }, handler: () => null })).toThrow(/also defined by a middleware/);
    expect(() => orgMutation.use({ args: { orgId: v.string() }, handler: () => undefined })({ handler: () => null })).toThrow(/defined by two middlewares/);
    const bad = mutationGeneric.use((async () => ({ ctx: {} })) as never)({ handler: () => 1 });
    expect(() => fresh().engine.runMutation(bad as never, {})).toThrow(expect.objectContaining({ code: "AsyncHandler" }));
  });
});

describe("defineApp({ env })", () => {
  it("validates names and checks declared vars when read", () => {
    const app = defineApp({ env: { STRIPE_KEY: v.string(), MODE: v.optional(v.union(v.literal("test"), v.literal("live"))) } });
    expectTypeOf<EnvOf<typeof app>>().toEqualTypeOf<{ STRIPE_KEY: string; MODE?: "test" | "live" }>();
    const ok = checkedEnv({ STRIPE_KEY: "sk", OTHER: 1 }, app.env);
    expect(ok.STRIPE_KEY).toBe("sk");
    expect(ok.MODE).toBeUndefined();
    expect(ok.OTHER).toBe(1);
    expect(() => checkedEnv({}, app.env).STRIPE_KEY).toThrow(expect.objectContaining({ code: "EnvMissing", message: expect.stringMatching(/ember env set STRIPE_KEY/) }));
    expect(() => checkedEnv({ STRIPE_KEY: "x", MODE: "prod" }, app.env).MODE).toThrow(/env MODE is invalid/);
    expect(() => defineApp({ env: { lower: v.string() } })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => defineApp({ env: { N: v.number() } })).toThrow(/env vars are strings/);
    expect(() => defineApp({ env: { EMBER_X: v.string() } })).toThrow(/managed by ember/);
  });
});

describe("validators v2 in functions and schemas", () => {
  it("fills argument defaults before the handler (types: optional for callers, set inside)", () => {
    const list = queryGeneric({
      args: { limit: v.number().int().min(1).default(10), q: v.string().min(1) },
      handler: (_ctx, { limit, q }) => {
        expectTypeOf(limit).toEqualTypeOf<number>();
        return `${q}:${limit}`;
      },
    });
    expectTypeOf<NonNullable<typeof list.__args>>().toEqualTypeOf<{ q: string; limit?: number }>();
    const viaObject = queryGeneric({ args: v.object({ limit: v.number().default(10) }), handler: (_ctx, { limit }) => limit });
    expectTypeOf<NonNullable<typeof viaObject.__args>>().toEqualTypeOf<{ limit?: number }>();
    const s = fresh();
    expect(s.engine.runQuery(list as never, { q: "x" }).value).toBe("x:10");
    expect(s.engine.runQuery(list as never, { q: "x", limit: 3 }).value).toBe("x:3");
    expect(() => s.engine.runQuery(list as never, { q: "" })).toThrow(expect.objectContaining({ code: "ValidationError", data: { path: "q", issues: [{ path: "q", message: "Must not be empty" }] } }));
    expect(() => s.engine.runQuery(list as never, { q: "x", limit: 0 })).toThrow(/limit: Expected at least 1/);
  });

  it("tables refuse defaults; refinements are checked on write", () => {
    expect(() => defineSchema({ tables: { t: defineTable({ n: v.number().default(1) }) } })).toThrow(/default\(\) is for function arguments/);
    const schema = defineSchema({ tables: { users: defineTable({ email: v.string().email() }) } });
    const s = fresh({ schema });
    expect(() => s.tx((db) => db.insert("users", { email: "nope" } as never))).toThrow(/Expected an email address/);
  });
});
