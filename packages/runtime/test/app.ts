/**
 * A small real Ember app (schema + functions) for the workerd tests, run by the real `@ember/server` engine.
 * `schemaV2` / `functionsV2` are the "next deploy": an optional field and a new (staged) index.
 */
import {
  action,
  defineSchema,
  defineTable,
  internalMutation,
  internalQuery,
  mutation,
  query,
  v,
  type MutationCtx,
  type QueryCtx,
  type SchemaDefinition,
} from "@ember/server";

/** Same isolate as the tests: lets tests observe side effects outside SQL. */
export const probes = {
  flaky: new Map<string, number>(),
};

const messageFields = {
  channel: v.string(),
  body: v.string(),
  author: v.optional(v.string()),
  n: v.optional(v.int64()),
  blob: v.optional(v.bytes()),
};

const tables = {
  messages: defineTable(messageFields)
    .index("by_channel", ["channel"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
  runs: defineTable({ label: v.string(), at: v.number() }),
};

export const schemaV1: SchemaDefinition<any, any> = defineSchema({ tables });

export const schemaV2: SchemaDefinition<any, any> = defineSchema({
  tables: {
    ...tables,
    messages: defineTable({ ...messageFields, priority: v.optional(v.number()) })
      .index("by_channel", ["channel"])
      .index("by_priority", ["priority"])
      .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
  },
});

type Q = QueryCtx;
type M = MutationCtx;

const messages = {
  list: query({
    args: { channel: v.string() },
    handler: (ctx: Q, { channel }: { channel: string }) =>
      ctx.db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", channel)).collect(),
  }),
  search: query({
    args: { q: v.string(), channel: v.optional(v.string()) },
    handler: (ctx: Q, args: { q: string; channel?: string }) =>
      (ctx.db.query("messages") as any)
        .withSearchIndex("search_body", (s: any) => {
          const b = s.search("body", args.q);
          return args.channel === undefined ? b : b.eq("channel", args.channel);
        })
        .collect()
        .map((m: { body: string }) => m.body),
  }),
  send: mutation({
    args: messageFields,
    handler: (ctx: M, args: { channel: string; body: string; n?: bigint; blob?: Uint8Array }) => {
      if (args.body === "fail") throw new Error("body may not be 'fail'");
      const author = ctx.auth.getUserIdentity()?.subject;
      const id = ctx.db.insert("messages", { ...args, ...(author ? { author } : {}) });
      if (args.body.startsWith("echo ")) {
        ctx.scheduler.runAfter(0, "messages:echo", { channel: args.channel, body: args.body.slice(5) });
      }
      return id;
    },
  }),
  /** Throws until the channel has a message (exercises errored subscriptions). */
  latest: query({
    args: { channel: v.string() },
    handler: (ctx: Q, { channel }: { channel: string }) => {
      const m = ctx.db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", channel)).order("desc").first();
      if (!m) throw new Error(`channel ${channel} is empty`);
      return m.body;
    },
  }),
  /** Only the scheduler may call this. */
  echo: internalMutation({
    args: { channel: v.string(), body: v.string() },
    handler: (ctx: M, args: { channel: string; body: string }) => ctx.db.insert("messages", { ...args, author: "echo-bot" }),
  }),
  secret: internalQuery({ handler: () => "classified" }),
};

const runs = {
  list: query({ handler: (ctx: Q) => ctx.db.query("runs").collect() }),
};

const jobs = {
  record: internalMutation({
    args: { label: v.string() },
    handler: (ctx: M, { label }: { label: string }) => ctx.db.insert("runs", { label, at: ctx.now }),
  }),
  schedule: mutation({
    args: { items: v.array(v.object({ fn: v.optional(v.string()), delayMs: v.number(), label: v.optional(v.string()), args: v.optional(v.any()) })) },
    handler: (ctx: M, { items }: { items: Array<{ fn?: string; delayMs: number; args?: unknown; label?: string }> }) => {
      for (const it of items) ctx.scheduler.runAfter(it.delayMs, (it.fn ?? "jobs:record") as any, (it.args ?? { label: it.label }) as any);
      return items.length;
    },
  }),
  flaky: internalMutation({
    args: { label: v.string(), failTimes: v.number() },
    handler: (ctx: M, { label, failTimes }: { label: string; failTimes: number }) => {
      const n = (probes.flaky.get(label) ?? 0) + 1;
      probes.flaky.set(label, n);
      if (n <= failTimes) throw new Error(`flaky attempt ${n}`);
      return ctx.db.insert("runs", { label, at: ctx.now });
    },
  }),
};

const auth = {
  whoami: query({ handler: (ctx: Q) => ctx.auth.getUserIdentity()?.subject ?? null }),
};

const misc = {
  // Deliberately async: the engine must reject it and roll back.
  async: mutation((async (ctx: M) => {
    ctx.db.insert("messages", { channel: "async", body: "x" });
  }) as any),
  ping: internalMutation({ args: { n: v.optional(v.number()), fail: v.optional(v.boolean()) }, handler: () => null }),
};

const actions = {
  ping: action({ args: { n: v.optional(v.number()), fail: v.optional(v.boolean()) }, handler: async () => null }),
};

export const functionsV1 = { messages, runs, jobs, auth, misc, actions };

export const functionsV2 = {
  ...functionsV1,
  messages: {
    ...messages,
    byPriority: query({
      args: { min: v.number() },
      handler: (ctx: Q, { min }: { min: number }) =>
        ctx.db
          .query("messages")
          .withIndex("by_priority", (q: any) => q.gte("priority", min))
          .collect()
          .map((m: { body: string }) => m.body),
    }),
    setPriority: mutation({
      args: { id: v.id("messages"), priority: v.number() },
      handler: (ctx: M, { id, priority }: { id: string; priority: number }) => ctx.db.patch(id as any, { priority } as any),
    }),
  },
};
