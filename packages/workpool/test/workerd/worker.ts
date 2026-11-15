/**
 * The workerd test app: the workpool component installed twice (`aiPool`, and `globalPool` used pinned to global:main),
 * a work action that measures how many calls run at once, and an onComplete that records results. Action jobs are
 * not sent to a Queue: `dispatchAction` records them and the test delivers them to the Worker's queue consumer
 * (concurrently, or never: a stalled queue), as the runtime's own lease tests do.
 */
import { anyComponents, actionGeneric, defineApp, defineSchema, defineTable, internalActionGeneric, internalMutationGeneric, mutationGeneric, queryGeneric, unsafeRef, v } from "@freecorps/ember-server";
import { createEmberWorker, type ActionJobMessage } from "@freecorps/ember-runtime";
import { Workpool, vOnCompleteArgs, workpool, type OnCompleteArgs } from "../../src/index.ts";
import type { FunctionReference } from "@freecorps/ember-server";

export { Shard } from "@freecorps/ember-runtime";

export const probes = { actions: [] as ActionJobMessage[], inFlight: 0, max: 0, started: [] as string[] };

export const schema = defineSchema({ tables: { done: defineTable({ workId: v.string(), label: v.string(), result: v.any() }) } });

const call = unsafeRef<"action">("work:call");
const done = unsafeRef("work:done") as FunctionReference<"mutation", "internal", OnCompleteArgs>;
const pool = (maxParallelism: number) => new Workpool(anyComponents.aiPool, { maxParallelism });
const globalPool = new Workpool(anyComponents.globalPool, { maxParallelism: 2, shard: "global:main" });

export const functions = {
  work: {
    call: internalActionGeneric({
      args: { label: v.string(), ms: v.optional(v.number()) },
      handler: async (_ctx: unknown, a: { label: string; ms?: number }) => {
        probes.inFlight++;
        probes.max = Math.max(probes.max, probes.inFlight);
        probes.started.push(a.label);
        try {
          await new Promise((r) => setTimeout(r, a.ms ?? 25));
          return `done:${a.label}`;
        } finally {
          probes.inFlight--;
        }
      },
    }),
    done: internalMutationGeneric({
      args: vOnCompleteArgs,
      handler: (ctx: any, a: any) => void ctx.db.insert("done", { workId: a.workId, label: a.context.label, result: a.result }),
    }),
  },
  api: {
    enqueue: mutationGeneric({
      args: { labels: v.array(v.string()), max: v.number() },
      handler: (ctx: any, a: { labels: string[]; max: number }) => a.labels.map((label) => pool(a.max).enqueueAction(ctx, call, { label }, { onComplete: done, context: { label } })),
    }),
    /** On any shard: enqueues into the pool pinned to global:main (one cap for every shard). */
    enqueueGlobal: actionGeneric({
      args: { labels: v.array(v.string()) },
      handler: async (ctx: any, a: { labels: string[] }) => globalPool.enqueueActionBatch(ctx, call, a.labels.map((label) => ({ label, ms: 40 }))),
    }),
    status: queryGeneric({ args: { id: v.string() }, handler: (ctx: any, a: { id: string }) => pool(1).status(ctx, a.id) }),
    stats: queryGeneric({ args: {}, handler: (ctx: any) => pool(1).stats(ctx) }),
    globalStats: queryGeneric({ args: {}, handler: (ctx: any) => globalPool.here.stats(ctx) }),
    done: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("done").collect().map((d: any) => ({ workId: d.workId, label: d.label, result: d.result })) }),
  },
};

export const app = defineApp()
  .use(workpool, { name: "aiPool", config: { reclaimIntervalMs: 300 } })
  .use(workpool, { name: "globalPool" });

export default createEmberWorker({
  schema,
  functions,
  app,
  dispatchAction: async (_env, msg) => void probes.actions.push(msg),
});
