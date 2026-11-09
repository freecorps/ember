/**
 * A small real Ember app (schema + functions) for the workerd tests, run by the real `@freecorps/ember-server` engine.
 * `schemaV2` / `functionsV2` are the "next deploy": an optional field and a new (staged) index.
 */
import {
  action,
  internalAction,
  type ActionCtx,
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
} from "@freecorps/ember-server";

/** Same isolate as the tests: lets tests observe side effects outside SQL. */
export const probes = {
  flaky: new Map<string, number>(),
  /** `users:sync` fails while > 0 (decremented per call): exercises outbox retries. */
  syncFailures: 0,
  syncCalls: 0,
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
  /** Files (PLAN §7): refcounted `v.file()` fields. */
  photos: defineTable({ title: v.string(), file: v.file(), thumbs: v.optional(v.array(v.file())) }),
  /** Rows-written bench (rows-written.test.ts): three secondary indexes. */
  wide: defineTable({ a: v.string(), b: v.number(), c: v.string() }).index("by_a", ["a"]).index("by_b", ["b"]).index("by_c", ["c"]),
};

export const schemaV1: SchemaDefinition<any, any> = defineSchema({ tables });

/** A deploy the planner must refuse once `messages` has rows: a new required field. */
export const schemaRefused: SchemaDefinition<any, any> = defineSchema({
  tables: { ...tables, messages: defineTable({ ...messageFields, mandatory: v.string() }).index("by_channel", ["channel"]) },
});

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
  optional: query({
    args: { channel: v.string() },
    handler: (ctx: Q, { channel }: { channel: string }) =>
      ctx.db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", channel)).collect().length ? undefined : 0,
  }),
  nested: query({
    args: { channel: v.string() },
    handler: (ctx: Q, { channel }: { channel: string }) => ({
      nested: { rows: ctx.db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", channel)).collect() },
    }),
  }),
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
  /** Bulk insert (rowdiff tests). */
  seed: mutation({
    args: { channel: v.string(), n: v.number() },
    handler: (ctx: M, { channel, n }: { channel: string; n: number }) => {
      for (let i = 0; i < n; i++) ctx.db.insert("messages", { channel, body: `message number ${i} with some text` });
      return n;
    },
  }),
  edit: mutation({
    args: { id: v.id("messages"), body: v.string() },
    handler: (ctx: M, { id, body }: { id: any; body: string }) => ctx.db.patch(id, { body }),
  }),
  remove: mutation({
    args: { id: v.id("messages") },
    handler: (ctx: M, { id }: { id: any }) => ctx.db.delete(id),
  }),
  /** Read-only SQL (table-level reactivity) on DO SQLite. */
  perChannel: query({
    args: { min: v.number() },
    handler: (ctx: Q, { min }: { min: number }) =>
      (ctx.db as any).sql(v.object({ channel: v.string(), n: v.number() }))`
        SELECT channel, count(*) AS n FROM messages GROUP BY channel HAVING count(*) >= ${min} ORDER BY channel`,
  }),
};

const runs = {
  list: query({ handler: (ctx: Q) => ctx.db.query("runs").collect() }),
  add: mutation({ args: { label: v.string() }, handler: (ctx: M, { label }: { label: string }) => ctx.db.insert("runs", { label, at: ctx.now }) }),
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
  /** Schedules one job a minute out and returns its id. */
  later: mutation({
    args: { label: v.string() },
    handler: (ctx: M, { label }: { label: string }) => ctx.scheduler.runAfter(60_000, "jobs:record" as any, { label } as any),
  }),
  cancel: mutation({
    args: { id: v.string() },
    handler: (ctx: M, { id }: { id: string }) => ctx.scheduler.cancel(id),
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
  /** Revocation-exact: the runtime re-checks the session (verify with { sensitive: true }). */
  transfer: mutation({ sensitive: true, args: { amount: v.number() }, handler: (ctx: M, { amount }: { amount: number }) => ({ who: ctx.auth.getUserIdentity()?.subject ?? null, amount }) }),
  wipe: action({ sensitive: true, handler: async (ctx: ActionCtx) => (await ctx.auth.getUserIdentity())?.subject ?? null }),
};

/** Profile sync target of the auth outbox (`internal.users.sync`). */
const users = {
  sync: internalMutation({
    args: { event: v.string(), user: v.any(), key: v.string() },
    handler: (ctx: M, { event, user }: { event: string; user: { id: string } }) => {
      probes.syncCalls++;
      if (probes.syncFailures > 0) {
        probes.syncFailures--;
        throw new Error("sync down");
      }
      return ctx.db.insert("runs", { label: `${event}:${user.id}`, at: ctx.now });
    },
  }),
};

const misc = {
  // Deliberately async: the engine must reject it and roll back.
  async: mutation((async (ctx: M) => {
    ctx.db.insert("messages", { channel: "async", body: "x" });
  }) as any),
  ping: internalMutation({ args: { n: v.optional(v.number()), fail: v.optional(v.boolean()) }, handler: () => null }),
  /** Writes nothing (rows-written bench: a barrier on the socket). */
  noop: mutation({ handler: () => null }),
};

const actions = {
  ping: action({ args: { n: v.optional(v.number()), fail: v.optional(v.boolean()) }, handler: async () => null }),
  /** Exercises the whole ActionCtx. */
  combo: action({
    args: { channel: v.string(), other: v.optional(v.string()) },
    handler: async (ctx: ActionCtx, { channel, other }: { channel: string; other?: string }) => {
      const id = await ctx.runMutation("messages:send" as any, { channel, body: "from action" } as any);
      const list = (await ctx.runQuery("messages:list" as any, { channel } as any)) as unknown[];
      const secret = await ctx.runQuery("messages:secret" as any);
      const job = await ctx.scheduler.runAfter(60_000, "jobs:record" as any, { label: "later" } as any);
      const cancelled = await ctx.scheduler.cancel(job);
      const cancelledAgain = await ctx.scheduler.cancel(job);
      const who = (await ctx.auth.getUserIdentity())?.subject ?? null;
      const elsewhere = other ? ((await ctx.onShard(other).runQuery("messages:list" as any, { channel } as any)) as unknown[]).length : null;
      const nested = await ctx.runAction("actions:double" as any, { x: 21 } as any);
      return { id, n: list.length, secret, job, cancelled, cancelledAgain, who, elsewhere, nested, shard: ctx.shard };
    },
  }),
  double: internalAction({ args: { x: v.number() }, handler: async (_ctx: ActionCtx, { x }: { x: number }) => x * 2 }),
  /** Calls a function that does not exist: the error code propagates. */
  broken: action({ handler: async (ctx: ActionCtx) => ctx.runQuery("nope:nope" as any) }),
  /** Run as a scheduled action job. */
  record: internalAction({
    args: { label: v.string() },
    handler: async (ctx: ActionCtx, { label }: { label: string }) => ctx.runMutation("jobs:record" as any, { label } as any),
  }),
  /** A scheduled action job leased for 1 s when handed to the queue. */
  leased: internalAction({
    args: { label: v.string() },
    leaseMs: 1000,
    handler: async (ctx: ActionCtx, { label }: { label: string }) => ctx.runMutation("jobs:record" as any, { label } as any),
  }),
  /** Always runs in the shard's alarm, never through the queue. */
  local: internalAction({
    args: { label: v.string() },
    dispatch: "shard",
    handler: async (ctx: ActionCtx, { label }: { label: string }) => ctx.runMutation("jobs:record" as any, { label } as any),
  }),
  /** Fails `failTimes` times per label, then records it. */
  flaky: internalAction({
    args: { label: v.string(), failTimes: v.number() },
    handler: async (ctx: ActionCtx, { label, failTimes }: { label: string; failTimes: number }) => {
      const n = (probes.flaky.get(label) ?? 0) + 1;
      probes.flaky.set(label, n);
      if (n <= failTimes) throw new Error(`flaky action attempt ${n}`);
      return ctx.runMutation("jobs:record" as any, { label } as any);
    },
  }),
};

const files = {
  generate: mutation({
    args: { contentType: v.optional(v.string()), size: v.optional(v.number()), sha256: v.optional(v.string()), multipart: v.optional(v.boolean()) },
    handler: (ctx: M, args: any) => ctx.storage.generateUploadUrl(args),
  }),
  add: mutation({ args: { title: v.string(), file: v.file() }, handler: (ctx: M, a: any) => ctx.db.insert("photos", a) }),
  remove: mutation({ args: { id: v.id("photos") }, handler: (ctx: M, { id }: any) => ctx.db.delete(id) }),
  /** The permission check is the app's: here only titles not starting with "secret" get a URL. */
  url: query({
    args: { id: v.id("photos") },
    handler: (ctx: Q, { id }: any) => {
      const p = ctx.db.get(id) as any;
      if (!p || p.title.startsWith("secret")) return null;
      return ctx.storage.getUrl(p.file);
    },
  }),
  meta: query({ args: { id: v.string() }, handler: (ctx: Q, { id }: any) => ctx.storage.getMetadata(id) }),
  deleteFile: mutation({ args: { id: v.string() }, handler: (ctx: M, { id }: any) => ctx.storage.delete(id) }),
  storeAndThumb: action({
    args: { text: v.string() },
    handler: async (ctx: ActionCtx, { text }: { text: string }) => {
      const id = await ctx.storage.store(text, { contentType: "image/png" });
      const again = await ctx.storage.store(new TextEncoder().encode(text), { contentType: "image/png" });
      const back = await ctx.storage.get(id);
      const body = back ? new TextDecoder().decode(await back.arrayBuffer()) : null;
      const thumb = await ctx.images.thumbnail(id, { width: 64 });
      const thumbMeta = await ctx.storage.getMetadata(thumb);
      const info = await ctx.images.info(id);
      const url = await ctx.storage.getUrl(id);
      return { id, again, body, thumb, thumbMeta, info, url };
    },
  }),
};

/** Rows-written bench (rows-written.test.ts). */
const wide = {
  add: mutation({ args: { a: v.string(), b: v.number(), c: v.string() }, handler: (ctx: M, a: any) => ctx.db.insert("wide", a) }),
  list: query({ args: { a: v.string() }, handler: (ctx: Q, { a }: { a: string }) => ctx.db.query("wide").withIndex("by_a", (q: any) => q.eq("a", a)).collect() }),
  /** Read-modify-write of one indexed field (`b`): the other two index entries stay as they are. */
  bump: mutation({
    args: { a: v.string() },
    handler: (ctx: M, { a }: { a: string }) => {
      const doc = ctx.db.query("wide").withIndex("by_a", (q: any) => q.eq("a", a)).unique() as any;
      ctx.db.patch(doc._id, { b: doc.b + 1 });
    },
  }),
};

export const functionsV1 = { messages, runs, jobs, auth, misc, actions, users, files, wide };

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
