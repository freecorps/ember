import { describe, expect, expectTypeOf, it } from "vitest";
import { anyApi, defineErrors, defineSchema, defineShard, defineTable, actionGeneric as action, mutationGeneric as mutation, queryGeneric as query, internalMutationGeneric as internalMutation, unsafeRef, v, type ApiFromModules } from "@freecorps/ember-server";
import { emberTest, expectError } from "../src/index.ts";

const schema = defineSchema({
  shards: { room: defineShard({ key: v.string() }) },
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
  orgAction: action({ shard: "org", errors: [errors.TooLong], handler: async (ctx): Promise<number> => ctx.fail.TooLong({ max: 1 }) }),
};
const api = anyApi as unknown as ApiFromModules<{ messages: typeof messages }>;

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
});
