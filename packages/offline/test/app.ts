// A small app shared by the server engine (the "server") and the offline store (the "client"): the same query()
// objects run in both places.
import {
  createEngine,
  defineSchema,
  defineTable,
  mutation,
  query,
  v,
  type Engine,
  type MutationCtx,
  type QueryCtx,
  type SchemaDefinition,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { FakeEmberServer, type FakeQuery, type FakeMutation } from "@freecorps/ember-client/testing";

export const schema: SchemaDefinition<any, any> = defineSchema({
  tables: {
    messages: defineTable({ channel: v.string(), body: v.string(), author: v.optional(v.string()) })
      .index("by_channel", ["channel"])
      .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
    channels: defineTable({ name: v.string() }),
  },
});

type Q = QueryCtx;

export const messages = {
  list: query({
    args: { channel: v.string() },
    handler: (ctx: Q, { channel }: { channel: string }) =>
      ctx.db.query("messages").withIndex("by_channel", (r: any) => r.eq("channel", channel)).collect(),
  }),
  latest: query({
    args: { channel: v.string(), n: v.number() },
    handler: (ctx: Q, { channel, n }: { channel: string; n: number }) =>
      ctx.db.query("messages").withIndex("by_channel", (r: any) => r.eq("channel", channel)).order("desc").take(n),
  }),
  search: query({
    args: { q: v.string() },
    handler: (ctx: Q, { q }: { q: string }) =>
      (ctx.db.query("messages") as any).withSearchIndex("search_body", (s: any) => s.search("body", q)).collect().map((m: { body: string }) => m.body),
  }),
  mine: query({ handler: (ctx: Q) => ctx.auth.getUserIdentity()?.subject ?? null }),
  /** Not offline: a derived value, only cached. */
  count: query({ handler: (ctx: Q) => ctx.db.query("messages").collect().length }),
  send: mutation({
    args: { channel: v.string(), body: v.string() },
    handler: (ctx: MutationCtx, args: { channel: string; body: string }) => ctx.db.insert("messages", args),
  }),
  edit: mutation({
    args: { id: v.id("messages"), body: v.string() },
    handler: (ctx: MutationCtx, { id, body }: { id: any; body: string }) => ctx.db.patch(id, { body }),
  }),
  remove: mutation({
    args: { id: v.id("messages") },
    handler: (ctx: MutationCtx, { id }: { id: any }) => ctx.db.delete(id),
  }),
};

/** What the client registers to run offline. `count` is deliberately left out. */
export const offlineQueries = { messages: { list: messages.list, latest: messages.latest, search: messages.search, mine: messages.mine } };

export type Server = { engine: Engine; fake: FakeEmberServer; q(fn: string, args?: Record<string, unknown>): any; m(fn: string, args?: Record<string, unknown>): any };

/**
 * The real engine (node:sqlite) behind the client's fake WebSocket server: every query is evaluated by the engine;
 * every mutation re-runs every subscription (the fake's reactivity is per table; `_bump` stands for "anything").
 */
export function engineServer(): Server {
  const engine = createEngine({ schema, functions: { messages }, driver: createNodeSqliteDriver() });
  engine.migrate();
  const queries: Record<string, FakeQuery> = {};
  const mutations: Record<string, FakeMutation> = {};
  for (const [name, fn] of Object.entries(messages)) {
    const full = `messages:${name}`;
    if (fn.type === "query") {
      queries[full] = (db, args, ctx) => {
        db.all("_bump");
        return engine.runQuery(full, args, { identity: ctx.identity ? { subject: ctx.identity.subject } : null }).value;
      };
    } else {
      mutations[full] = (db, args, ctx) => {
        const r = engine.runMutation(full, args, { identity: ctx.identity ? { subject: ctx.identity.subject } : null });
        db.insert("_bump", {});
        return r.value;
      };
    }
  }
  const fake = new FakeEmberServer({ queries, mutations });
  return {
    engine,
    fake,
    q: (fn, args = {}) => engine.runQuery(fn, args).value,
    m: (fn, args = {}) => engine.runMutation(fn, args).value,
  };
}
