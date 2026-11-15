import { describe, expect, expectTypeOf, it } from "vitest";
import { anyApi, fromAuth, defineErrors, defineSchema, defineTriggers, defineShard, defineTable, actionGeneric as action, mutationGeneric as mutation, queryGeneric as query, internalMutationGeneric as internalMutation, unsafeRef, v, type ApiFromModules } from "@freecorps/ember-server";
import { emberTest, expectError } from "../src/index.ts";

const schema = defineSchema({
  shards: { room: defineShard({ key: v.string() }), org: defineShard({ key: v.string() }) },
  tables: {
    messages: defineTable({ room: v.string(), body: v.string(), author: v.optional(v.string()) }).index("by_room", ["room"]),
    log: defineTable({ what: v.string() }),
  },
});
const errors = defineErrors({ EmptyMessage: {}, TooLong: { data: v.object({ max: v.number() }) } });

const messages = {
  list: query({ args: { room: v.string() }, handler: (ctx, { room }) => ctx.db.query("messages").withIndex("by_room", (q) => q.eq("room", room)).collect().map((m) => (m as { body: string }).body) }),
  send: mutation({
    args: { room: v.string(), body: v.string() },
    errors: [errors.EmptyMessage, errors.TooLong],
    handler: (ctx, { room, body }) => {
      if (!body) ctx.fail.EmptyMessage();
      if (body.length > 5) ctx.fail.TooLong({ max: 5 });
      const id = ctx.db.insert("messages", { room, body, ...(ctx.auth.getUserIdentity() ? { author: ctx.auth.getUserIdentity()!.subject } : {}) });
      ctx.scheduler.runAfter(60_000, "messages:audit", { what: `sent ${body}` });
      return id;
    },
  }),
  audit: internalMutation({ args: { what: v.string() }, handler: (ctx, { what }) => ctx.db.insert("log", { what }) }),
  log: query({ handler: (ctx) => ctx.db.query("log").collect().map((r) => (r as { what: string }).what) }),
  shout: action({ args: { room: v.string(), body: v.string() }, handler: async (ctx, a): Promise<number> => {
    await ctx.runMutation(unsafeRef<"mutation">("messages:send"), { room: a.room, body: a.body.toUpperCase() });
    return ((await ctx.runQuery(unsafeRef<"query">("messages:list"), { room: a.room })) as string[]).length;
  } }),
  byRoom: query({ shard: { room: "room" }, args: { room: v.string() }, handler: (ctx) => ctx.db.query("messages").collect().length }),
  inOrg: query({ shard: { org: fromAuth("org") }, handler: (ctx) => ctx.db.query("log").collect().map((r) => (r as { what: string }).what) }),
  noteOrg: mutation({ shard: { org: fromAuth("org") }, args: { what: v.string() }, handler: (ctx, { what }) => {
    ctx.db.insert("log", { what });
    ctx.scheduler.runAfter(1_000, "messages:noteOrgLater", { what: `${what} later` });
  } }),
  noteOrgLater: internalMutation({ shard: { org: fromAuth("org") }, args: { what: v.string() }, handler: (ctx, { what }) => void ctx.db.insert("log", { what }) }),
  orgCount: action({ shard: { org: fromAuth("org") }, handler: async (ctx): Promise<string> => {
    const items = (await ctx.runQuery(unsafeRef<"query">("messages:inOrg"))) as string[];
    return `${ctx.shard}:${items.length}`;
  } }),
  /** `ctx.scheduler.get` in a query (L7). */
  job: query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.scheduler.get(id) }),
  orgAction: action({ shard: "org", errors: [errors.TooLong], handler: async (ctx): Promise<number> => ctx.fail.TooLong({ max: 1 }) }),
};
const api = anyApi as unknown as ApiFromModules<{ messages: typeof messages }>;

describe("emberTest: ctx.scheduler.get / list", () => {
  it("follows a job from pending to success, and to canceled", async () => {
    const t = emberTest({ schema, modules: { messages } });
    await t.mutation(api.messages.send, { room: "a", body: "hi" });
    const [j] = t.scheduled();
    expect(await t.query(api.messages.job, { id: j!.id })).toMatchObject({ name: "messages:audit", args: { what: "sent hi" }, state: { kind: "pending" }, scheduledTime: t.now() + 60_000 });
    await t.finishScheduled();
    expect(await t.query(api.messages.job, { id: j!.id })).toMatchObject({ state: { kind: "success" }, completedTime: j!.runAt, attempts: 1 });
    const id = await t.run((ctx) => ctx.scheduler.runAfter(1000, unsafeRef<"mutation">("messages:audit"), { what: "x" }));
    await t.run((ctx) => ctx.scheduler.cancel(id));
    expect((await t.query(api.messages.job, { id }))?.state).toEqual({ kind: "canceled" });
    expect((await t.run((ctx) => ctx.scheduler.list({ state: "canceled" }))).map((x) => x.id)).toEqual([id]);
    expect(await t.query(api.messages.job, { id: "job_nope" })).toBeNull();
  });
});

describe("emberTest", () => {
  it("runs queries and mutations with the real engine, typed", async () => {
    const t = emberTest({ schema, modules: { messages } });
    const id = await t.mutation(api.messages.send, { room: "a", body: "hi" });
    expectTypeOf(id).toEqualTypeOf<import("@freecorps/ember-server").GenericId<"messages">>();
    expect(await t.query(api.messages.list, { room: "a" })).toEqual(["hi"]);
    // @ts-expect-error args are required
    void (() => t.query(api.messages.list));
  });

  it("typed application errors (expectError) roll back", async () => {
    const t = emberTest({ schema, modules: { messages } });
    const e = await expectError(t.mutation(api.messages.send, { room: "a", body: "toolong" }), api.messages.send, "TooLong");
    expectTypeOf(e.data).toEqualTypeOf<{ max: number }>();
    expect(e.data.max).toBe(5);
    await expect(expectError(t.mutation(api.messages.send, { room: "a", body: "ok" }), api.messages.send, "EmptyMessage")).rejects.toThrow(/but the call returned/);
    // @ts-expect-error not an error of messages.send
    void (() => expectError(Promise.resolve(), api.messages.send, "Nope"));
    expect(await t.query(api.messages.list, { room: "a" })).toEqual(["ok"]);
  });

  it("identities, scheduled jobs and the clock", async () => {
    const t = emberTest({ schema, modules: { messages } });
    const ana = t.withIdentity({ subject: "ana" });
    await ana.mutation(api.messages.send, { room: "a", body: "x" });
    expect(await t.run((ctx) => ctx.db.query("messages").collect().map((m: { author?: string }) => m.author))).toEqual(["ana"]);
    expect(t.scheduled().map((j) => j.fn)).toEqual(["messages:audit"]);
    expect(await t.advance(30_000)).toBe(0);
    expect(await t.advance(30_000)).toBe(1);
    expect(await t.query(api.messages.log)).toEqual(["sent x"]);
    await t.mutation(api.messages.send, { room: "a", body: "y" });
    expect(await t.finishScheduled()).toBe(1);
  });

  it("actions call back into the shard; shards route like the client", async () => {
    const t = emberTest({ schema, modules: { messages } });
    expect(await t.action(api.messages.shout, { room: "r", body: "hey" })).toBe(1);
    expect(await t.query(api.messages.list, { room: "r" })).toEqual(["HEY"]);
    const routed = Object.assign(Object.create(null), { [Symbol.for("ember.functionName")]: "messages:byRoom", [Symbol.for("ember.functionShard")]: { kind: "room", fromArg: "room" } });
    await t.mutation(api.messages.send, { room: "r1", body: "z" }, { shard: "room:r1" });
    expect(await t.query(routed as typeof api.messages.byRoom, { room: "r1" })).toBe(1);
    await expect(t.query(routed as typeof api.messages.byRoom, { room: "r2" })).resolves.toBe(0);
    await expect(t.query(api.messages.byRoom, { room: "r1" }, { shard: "global:main" })).rejects.toMatchObject({ code: "WrongShard" });
    await expect(t.action(api.messages.orgAction, {}, { shard: "global:main" })).rejects.toMatchObject({ code: "WrongShard" });
    expect((await expectError(t.action(api.messages.orgAction, {}, { shard: "org:x" }), api.messages.orgAction, "TooLong")).data).toEqual({ max: 1 });
  });

  it("withIdentity claims route fromAuth functions to the claim's shard", async () => {
    const t = emberTest({ schema, modules: { messages } });
    const a = t.withIdentity({ subject: "ana", claims: { org: "a" } });
    const b = t.withIdentity({ subject: "bia", claims: { org: "b" } });
    await a.mutation(api.messages.noteOrg, { what: "a1" });
    await b.mutation(api.messages.noteOrg, { what: "b1" });
    expect(await a.query(api.messages.inOrg)).toEqual(["a1"]);
    expect(await b.query(api.messages.inOrg)).toEqual(["b1"]);
    expect(await t.query(api.messages.inOrg, {}, { shard: "org:a" }).catch((e) => e.code)).toBe("Unauthenticated");
    expect(await t.run((ctx) => ctx.db.query("log").collect().length, { shard: "org:a" })).toBe(1);
    // Another shard named explicitly: the engine refuses it.
    await expect(a.query(api.messages.inOrg, {}, { shard: "org:b" })).rejects.toMatchObject({ code: "WrongShard", data: { expected: "org:a", shard: "org:b" } });
    await expect(t.query(api.messages.inOrg)).rejects.toMatchObject({ code: "Unauthenticated" });
    await expect(t.withIdentity({ subject: "cris" }).query(api.messages.inOrg)).rejects.toMatchObject({ code: "WrongShard" });
    // Actions too, and their ctx.runQuery runs on the same shard, as the caller.
    expect(await a.action(api.messages.orgCount)).toBe("org:a:1");
    // Scheduled jobs run as the system on the shard they were scheduled on (no identity, no claim to check).
    expect(await t.finishScheduled()).toBe(2);
    expect(await a.query(api.messages.inOrg)).toEqual(["a1", "a1 later"]);
    expect(await b.query(api.messages.inOrg)).toEqual(["b1", "b1 later"]);
  });
});

describe("emberTest with triggers", () => {
  const triggers = defineTriggers({
    messages: (ctx, change) => {
      if (change.operation === "insert") ctx.db.insert("log", { what: `trigger ${(change.newDoc as { body: string }).body}` });
    },
    log: (ctx, change) => {
      const what = (change.newDoc as { what: string } | null)?.what ?? "";
      if (what.startsWith("sent ")) ctx.db.insert("log", { what: `seen ${what}` });
    },
  });

  it("runs them on mutations, scheduled jobs and actions' runMutation", async () => {
    const t = emberTest({ schema, modules: { messages }, triggers });
    await t.mutation(api.messages.send, { room: "r1", body: "hi" });
    expect(await t.query(api.messages.log, {})).toEqual(["trigger hi"]);
    await t.finishScheduled();
    expect(await t.query(api.messages.log, {})).toEqual(["trigger hi", "sent hi", "seen sent hi"]);
    await t.action(api.messages.shout, { room: "r1", body: "yo" });
    expect((await t.query(api.messages.log, {})).slice(3)).toEqual(["trigger YO"]);
  });

  it("picks up modules.triggers.default", async () => {
    const t = emberTest({ schema, modules: { messages, triggers: { default: triggers } } });
    await t.run((ctx) => ctx.db.insert("messages", { room: "r", body: "x" }));
    expect(await t.query(api.messages.log, {})).toEqual(["trigger x"]);
  });
});

describe("replica tables (seedReplica)", () => {
  const replicas = [
    { name: "auth:member", source: "auth", idType: "string" as const, fields: [{ name: "userId", type: "string" as const, optional: false }, { name: "role", type: "string" as const, optional: false }], indexes: [{ name: "by_userId", fields: ["userId"] }] },
  ];
  const members = {
    roleOf: query({
      args: { userId: v.string() },
      handler: (ctx, { userId }) => {
        const db = ctx.db as unknown as { query(t: string): { withIndex(i: string, f: (q: { eq(f: string, v: unknown): unknown }) => unknown): { first(): { role: string } | null } } };
        return db.query("auth:member").withIndex("by_userId", (q) => q.eq("userId", userId)).first()?.role ?? null;
      },
    }),
    promote: mutation({
      args: {},
      handler: (ctx) => {
        const db = ctx.db as unknown as { insert(t: string, d: unknown): string };
        return db.insert("auth:member", { id: "x", userId: "u", role: "owner" });
      },
    }),
  };
  const mapi = anyApi as unknown as ApiFromModules<{ members: typeof members }>;

  it("seeds, updates and deletes rows by source id; functions read them and cannot write them", async () => {
    const t = emberTest({ schema, modules: { members }, replicas });
    await t.seedReplica("auth:member", [{ id: "m1", userId: "ana", role: "member" }], { shard: "org:acme" });
    expect(await t.query(mapi.members.roleOf, { userId: "ana" }, { shard: "org:acme" })).toBe("member");
    expect(await t.query(mapi.members.roleOf, { userId: "ana" }, { shard: "org:other" })).toBeNull();
    await t.seedReplica("auth:member", [{ id: "m1", userId: "ana", role: "admin" }], { shard: "org:acme" });
    expect(await t.query(mapi.members.roleOf, { userId: "ana" }, { shard: "org:acme" })).toBe("admin");
    await t.seedReplica("auth:member", [{ id: "m1", delete: true }], { shard: "org:acme" });
    expect(await t.query(mapi.members.roleOf, { userId: "ana" }, { shard: "org:acme" })).toBeNull();
    await expect(t.mutation(mapi.members.promote, {}, { shard: "org:acme" })).rejects.toMatchObject({ code: "ReadOnlyTable" });
    await expect(t.seedReplica("messages", [{ id: "x" }])).rejects.toThrow(/not a replica table/);
  });

  it("a refused seed leaves nothing behind: the next seed of the same shard still applies", async () => {
    const t = emberTest({ schema, modules: { members }, replicas });
    await expect(t.seedReplica("auth:member", [{ id: "m1", userId: "ana", role: 42 }], { shard: "org:acme" })).rejects.toThrow();
    await t.seedReplica("auth:member", [{ id: "m1", userId: "ana", role: "member" }], { shard: "org:acme" });
    expect(await t.query(mapi.members.roleOf, { userId: "ana" }, { shard: "org:acme" })).toBe("member");
    await t.seedReplica("auth:member", [{ id: "m1", userId: "ana", role: "admin" }], { shard: "org:acme" });
    expect(await t.query(mapi.members.roleOf, { userId: "ana" }, { shard: "org:acme" })).toBe("admin");
  });

  it("the app's triggers fire on replica changes (derive data from membership), and cannot write replicas themselves", async () => {
    const triggers = defineTriggers({
      "auth:member": (ctx, change) => {
        const doc = (change.newDoc ?? change.oldDoc) as { role: string };
        ctx.db.insert("log", { what: `${change.operation} ${doc.role}` });
      },
    });
    const t = emberTest({ schema, modules: { messages }, replicas, triggers });
    await t.seedReplica("auth:member", [{ id: "m1", userId: "ana", role: "member" }]);
    await t.seedReplica("auth:member", [{ id: "m1", userId: "ana", role: "admin" }, { id: "m1", delete: true }]);
    expect(await t.query(api.messages.log, {})).toEqual(["insert member", "update admin", "delete admin"]);
    const bad = defineTriggers({ log: (ctx) => void ctx.db.insert("auth:member", { id: "y", userId: "u", role: "x" }) });
    const t2 = emberTest({ schema, modules: { messages }, replicas, triggers: bad });
    await expect(t2.run((ctx) => ctx.db.insert("log", { what: "x" }))).rejects.toMatchObject({ code: "ReadOnlyTable" });
  });
});

describe(".replicated() tables and ctx.shards", () => {
  const rschema = defineSchema({
    shards: { org: defineShard({ key: v.string() }), room: defineShard({ key: v.string() }) },
    tables: {
      fxRates: defineTable({ base: v.string(), rate: v.number() }).index("by_base", ["base"]).replicated({ to: ["org"] }),
      quotes: defineTable({ rateId: v.id("fxRates"), amount: v.number() }),
    },
  });
  const rates = {
    set: mutation({ args: { base: v.string(), rate: v.number() }, handler: (ctx, a) => ctx.db.insert("fxRates", a) }),
    get: query({
      shard: "org",
      args: { base: v.string() },
      handler: (ctx, { base }) => ({ rate: ctx.db.query("fxRates").withIndex("by_base", (q) => q.eq("base", base)).first()?.rate ?? null, state: ctx.db.replicaStatus("fxRates").state }),
    }),
    quote: mutation({
      shard: "org",
      args: { rateId: v.id("fxRates"), amount: v.number() },
      handler: (ctx, { rateId, amount }) => ctx.db.insert("quotes", { rateId, amount: amount * (ctx.db.get(rateId)?.rate ?? NaN) }),
    }),
    forge: mutation({ shard: "org", args: {}, handler: (ctx) => ctx.db.insert("fxRates", { base: "X", rate: 1 }) }),
    count: query({ args: {}, handler: (ctx) => ctx.db.query("quotes").collect().length }),
    report: action({
      args: {},
      handler: async (ctx) => ({
        list: (await ctx.shards.list("org")).shards.map((s) => s.shard),
        out: await ctx.shards.fanOut("org", unsafeRef<"query">("rates:count"), {}),
      }),
    }),
  };
  const rapi = anyApi as unknown as ApiFromModules<{ rates: typeof rates }>;

  it("global:main's writes reach the other shards on sync, with the same ids; off-source writes are refused", async () => {
    const t = emberTest({ schema: rschema, modules: { rates } });
    expect(await t.query(rapi.rates.get, { base: "USD" }, { shard: "org:a" })).toEqual({ rate: null, state: "pending" });
    const id = await t.mutation(rapi.rates.set, { base: "USD", rate: 5 });
    // Eventual: not there until a sync (finishScheduled / advance sync too).
    expect(await t.query(rapi.rates.get, { base: "USD" }, { shard: "org:a" })).toEqual({ rate: null, state: "pending" });
    expect(await t.syncReplicas()).toBe(1);
    expect(await t.query(rapi.rates.get, { base: "USD" }, { shard: "org:a" })).toEqual({ rate: 5, state: "ready" });
    await t.mutation(rapi.rates.quote, { rateId: id, amount: 2 }, { shard: "org:a" });
    await t.run((ctx) => ctx.db.patch(id, { rate: 6 }));
    // A shard created later starts from a full copy.
    await t.finishScheduled();
    expect(await t.query(rapi.rates.get, { base: "USD" }, { shard: "org:a" })).toEqual({ rate: 6, state: "ready" });
    expect(await t.query(rapi.rates.get, { base: "USD" }, { shard: "org:b" })).toEqual({ rate: null, state: "pending" });
    await t.syncReplicas();
    expect(await t.query(rapi.rates.get, { base: "USD" }, { shard: "org:b" })).toEqual({ rate: 6, state: "ready" });
    await expect(t.mutation(rapi.rates.forge, {}, { shard: "org:a" })).rejects.toMatchObject({ code: "ReadOnlyTable" });

    const r = await t.action(rapi.rates.report, {});
    expect(r.list).toEqual(["org:a", "org:b"]);
    expect(r.out).toEqual([
      { shard: "org:a", ok: true, value: 1 },
      { shard: "org:b", ok: true, value: 0 },
    ]);
  });
});
