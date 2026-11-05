/**
 * A component installed in the workerd test app (PLAN §12): tables, a scheduled job, an action, an HTTP route,
 * a callback through a function handle.
 */
import {
  componentBuilders,
  createFunctionHandle,
  defineApp,
  defineComponent,
  defineSchema,
  defineTable,
  httpActionGeneric,
  httpRouter,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  anyComponents as components,
  actionGeneric,
  v,
} from "@freecorps/ember-server";

const schema = defineSchema({
  tables: {
    tallies: defineTable({ key: v.string(), n: v.number() }).index("by_key", ["key"]),
  },
});
const c = componentBuilders<typeof schema, { label: string }>();

const bump = (ctx: any, key: string, by: number) => {
  const row = ctx.db.query("tallies").withIndex("by_key", (q: any) => q.eq("key", key)).unique();
  if (row) ctx.db.patch(row._id, { n: row.n + by });
  else ctx.db.insert("tallies", { key, n: by });
  return (row?.n ?? 0) + by;
};

const hooks = {
  hit: c.httpAction(async (ctx, request) => {
    const key = new URL(request.url).searchParams.get("key") ?? "http";
    const n = await ctx.runMutation("lib:bump" as any, { key, by: 1 });
    return Response.json({ n, label: ctx.component.config.label, shard: ctx.shard });
  }),
};

export const tally = defineComponent({
  name: "tally",
  schema,
  config: v.object({ label: v.string() }),
  functions: {
    lib: {
      bump: c.mutation({ args: { key: v.string(), by: v.number() }, handler: (ctx, a) => bump(ctx, a.key, a.by) }),
      get: c.query({ args: { key: v.string() }, handler: (ctx, { key }) => ctx.db.query("tallies").withIndex("by_key", (q) => q.eq("key", key)).unique()?.n ?? 0 }),
      /** Schedules its own internal mutation (relative name), and optionally an app callback (handle). */
      bumpLater: c.mutation({
        args: { key: v.string(), delayMs: v.number(), notify: v.optional(v.string()) },
        handler: (ctx, a) => {
          ctx.scheduler.runAfter(a.delayMs, "lib:applyLater", { key: a.key, notify: a.notify });
          return null;
        },
      }),
      applyLater: c.internalMutation({
        args: { key: v.string(), notify: v.optional(v.string()) },
        handler: (ctx, a) => {
          const n = bump(ctx, a.key, 1);
          if (a.notify) ctx.runMutation(a.notify as any, { key: a.key, n });
          return n;
        },
      }),
      /** An action in the component scope: its runMutation resolves inside the component. */
      bumpTwice: c.action({
        args: { key: v.string() },
        handler: async (ctx, { key }) => {
          await ctx.runMutation("lib:bump" as any, { key, by: 1 });
          return (await ctx.runMutation("lib:bump" as any, { key, by: 1 })) as number;
        },
      }),
      /** Tries to reach an app function by name from the component: must not resolve. */
      reachApp: c.action({ args: {}, handler: async (ctx) => ctx.runQuery("components:count" as any, { key: "x" }) }),
      label: c.query({ args: {}, handler: (ctx) => ctx.component.config.label }),
    },
    hooks,
  },
  http: httpRouter().route({ path: "/hit", method: "POST", handler: hooks.hit, shard: (r) => new URL(r.url).searchParams.get("shard") ?? "global:main" }),
});

export const app = defineApp().use(tally, { config: { label: "tallies" } });

/** App functions (module "components") that call the component. */
export const componentFunctions = {
  bump: mutationGeneric({
    args: { key: v.string(), fail: v.optional(v.boolean()) },
    handler: (ctx: any, { key, fail }: { key: string; fail?: boolean }) => {
      const n = ctx.runMutation(components.tally.lib.bump, { key, by: 1 });
      if (fail) throw new Error("app failed");
      return n;
    },
  }),
  count: queryGeneric({ args: { key: v.string() }, handler: (ctx: any, { key }: { key: string }) => ctx.runQuery(components.tally.lib.get, { key }) }),
  later: mutationGeneric({
    args: { key: v.string(), delayMs: v.number() },
    handler: (ctx: any, a: { key: string; delayMs: number }) =>
      ctx.runMutation(components.tally.lib.bumpLater, { ...a, notify: createFunctionHandle("components:notified") }),
  }),
  notified: internalMutationGeneric({
    args: { key: v.string(), n: v.number() },
    handler: (ctx: any, a: { key: string; n: number }) => ctx.db.insert("runs", { label: `notified:${a.key}:${a.n}`, at: ctx.now }),
  }),
  twice: actionGeneric({ args: { key: v.string() }, handler: async (ctx: any, { key }: { key: string }) => ctx.runAction(components.tally.lib.bumpTwice, { key }) }),
  reach: actionGeneric({ args: {}, handler: async (ctx: any) => ctx.runAction(components.tally.lib.reachApp, {}) }),
  /** An action calling a component's internal mutation by absolute name: refused. */
  sneak: actionGeneric({ args: {}, handler: async (ctx: any) => ctx.runMutation("@tally/lib:applyLater", { key: "s" }) }),
};

export const http = httpRouter().route({
  path: "/hello",
  method: "GET",
  handler: httpActionGeneric(async (ctx, request) => {
    const who = (await ctx.auth.getUserIdentity())?.subject ?? "anon";
    const n = await ctx.runQuery("components:count" as any, { key: new URL(request.url).searchParams.get("key") ?? "x" });
    return new Response(`hello ${who} ${n}`);
  }),
});
