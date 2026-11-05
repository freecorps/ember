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
  internalActionGeneric,
  mutationGeneric,
  queryGeneric,
  anyComponents as components,
  actionGeneric,
  v,
} from "@freecorps/ember-server";
import { MINUTE, rateLimit, RateLimiter } from "@freecorps/ember-rate-limit";
import { WorkflowManager, workflows, type WorkflowStep } from "@freecorps/ember-workflows";

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

// ------------------------------------------------------------------ hooks: crons, own queue, email()

const hookSchema = defineSchema({
  tables: {
    received: defineTable({ kind: v.string(), key: v.string(), data: v.any() }).index("by_kind", ["kind"]),
  },
});
const h = componentBuilders<typeof hookSchema, { domain: string; shard: string }>();

/** A component with every hook: a cron, a queue it owns and consumes, and the Worker's email() handler. */
export const hooksComponent = defineComponent({
  name: "hooks",
  schema: hookSchema,
  config: v.object({ domain: v.string(), shard: v.string() }),
  functions: {
    lib: {
      record: h.internalMutation({
        args: { kind: v.string(), key: v.string(), data: v.any() },
        handler: (ctx, a) => ctx.db.insert("received", a),
      }),
      list: h.query({ args: { kind: v.string() }, handler: (ctx, { kind }) => ctx.db.query("received").withIndex("by_kind", (q) => q.eq("kind", kind)).collect() }),
      sweep: h.internalMutation({ args: { label: v.string() }, handler: (ctx, a) => ctx.db.insert("received", { kind: "cron", key: a.label, data: ctx.component.config.domain }) }),
      /** Sends to the component's own queue from an action (the producer binding). */
      enqueue: h.action({
        args: { key: v.string(), fail: v.optional(v.boolean()) },
        handler: async (ctx, a) => {
          await (ctx.env.EMBER_Q_HOOKS_EVENTS as Queue).send({ key: a.key, fail: !!a.fail });
          return null;
        },
      }),
    },
  },
  crons: (config) => [{ name: "sweep", schedule: "0 3 * * *", shard: config.shard, fn: "lib:sweep", args: { label: "daily" } }],
  queues: {
    events: {
      shard: (config) => config.shard,
      consumer: { maxBatchSize: 10 },
      handler: async (ctx, batch) => {
        for (const m of batch.messages) {
          const body = m.body as { key: string; fail?: boolean };
          if (body.fail && m.attempts < 2) {
            m.retry();
            continue;
          }
          await ctx.runMutation("lib:record" as any, { kind: "queue", key: body.key, data: { attempts: m.attempts, queue: batch.queue, shard: ctx.shard, domain: ctx.component.config.domain } });
          m.ack();
        }
      },
    },
  },
  email: {
    match: (to, config) => to.endsWith(`@${config.domain}`),
    shard: (config) => config.shard,
    handler: async (ctx, message) => {
      const raw = await new Response(message.raw).text();
      if (message.to.startsWith("reject@")) {
        message.setReject("not here");
        return;
      }
      await ctx.runMutation("lib:record" as any, { kind: "email", key: message.to, data: { from: message.from, subject: message.headers.get("subject"), size: message.rawSize, raw } });
    },
  },
});

export const app = defineApp()
  .use(tally, { config: { label: "tallies" } })
  .use(rateLimit)
  .use(workflows)
  .use(hooksComponent, { config: { domain: "hooks.test", shard: "hooks:main" } });

// ------------------------------------------------------------------ official components (rateLimit, workflows)

const limiter = new RateLimiter(components.rateLimit, { post: { kind: "token bucket", rate: 2, period: MINUTE, capacity: 2 } });
const workflow = new WorkflowManager(components.workflows);

/** Module "official". */
export const officialFunctions = {
  post: mutationGeneric({
    args: { user: v.string() },
    handler: (ctx: any, { user }: { user: string }) => {
      const r = limiter.limit(ctx, "post", { key: user });
      if (r.ok) ctx.db.insert("runs", { label: `post:${user}`, at: ctx.now });
      return r;
    },
  }),
  postFromAction: actionGeneric({ args: { user: v.string() }, handler: async (ctx: any, { user }: { user: string }) => limiter.limit(ctx, "post", { key: user }) }),
  record: internalMutationGeneric({ args: { label: v.string() }, handler: (ctx: any, { label }: { label: string }) => ctx.db.insert("runs", { label, at: ctx.now }) }),
  fetchish: internalActionGeneric({ args: { x: v.number() }, handler: async (_ctx: any, { x }: { x: number }) => x * 3 }),
  flow: workflow.define({
    args: { x: v.number() },
    handler: async (step: WorkflowStep, { x }: { x: number }) => {
      const y = await step.runAction<number>("official:fetchish", { x });
      await step.runMutation("official:record", { label: `wf:${y}` });
      await step.sleep(30);
      const ev = await step.waitForEvent<{ z: number }>("go");
      await step.runMutation("official:record", { label: `wf-done:${ev.z}` });
      return y + ev.z;
    },
  }),
  startFlow: mutationGeneric({ args: { x: v.number() }, handler: (ctx: any, { x }: { x: number }) => workflow.start(ctx, "official:flow", { x }) }),
  flowStatus: queryGeneric({ args: { id: v.string() }, handler: (ctx: any, { id }: { id: string }) => workflow.status(ctx, id) }),
  flowEvent: mutationGeneric({ args: { id: v.string(), z: v.number() }, handler: (ctx: any, a: { id: string; z: number }) => workflow.sendEvent(ctx, a.id, "go", { z: a.z }) }),
};

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

/** Module "hooks": reads what the hooks component received. */
export const hooksFunctions = {
  list: queryGeneric({ args: { kind: v.string() }, handler: (ctx: any, { kind }: { kind: string }) => ctx.runQuery(components.hooks.lib.list, { kind }) }),
};
