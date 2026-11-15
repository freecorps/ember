// How an app tests code that uses a workpool, with @freecorps/ember-testing (`emberTest({ app })`), and the pattern for
// one cap across shards: a pool pinned to `global:main`, enqueued from actions (ctx.onShard), deduplicated by key.
import {
  anyComponents,
  componentsOf,
  actionGeneric,
  defineApp,
  defineSchema,
  defineTable,
  internalActionGeneric,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  unsafeRef,
  v,
} from "@freecorps/ember-server";
import { emberTest } from "@freecorps/ember-testing";
import { describe, expect, test } from "vitest";
import { Workpool, vOnCompleteArgs, workpool, type OnCompleteArgs, type WorkpoolComponentApi } from "../src/index.ts";
import type { FunctionReference } from "@freecorps/ember-server";

const app = defineApp().use(workpool, { name: "aiPool" });
// What codegen's `components` (`ComponentsApi<typeof app>`) gives the app is what the helper takes.
const typedComponents: { aiPool: WorkpoolComponentApi } = componentsOf(app);
void typedComponents;
const schema = defineSchema({
  tables: {
    docs: defineTable({ text: v.string(), summary: v.optional(v.string()), error: v.optional(v.string()) }),
    calls: defineTable({ docId: v.string(), shard: v.string() }),
  },
});

// In an app these come from `./_generated/server` (`components`, `internal`); here, by name.
const internal = {
  summarize: unsafeRef<"action">("ai:summarize"),
  saved: unsafeRef("ai:saved") as FunctionReference<"mutation", "internal", OnCompleteArgs>,
  summarizeGlobal: unsafeRef<"action">("global:summarize"),
  savedGlobal: unsafeRef("global:saved") as FunctionReference<"mutation", "internal", OnCompleteArgs>,
  writeBack: unsafeRef<"mutation">("global:writeBack"),
  forward: unsafeRef<"action">("global:forward"),
};

// ------------------------------------------------------------------------------------------- one shard (the usual case)

const pool = new Workpool(anyComponents.aiPool, { maxParallelism: 2, retry: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 } });
let failNext = 0;

const ai = {
  start: mutationGeneric({
    args: { text: v.string() },
    handler: (ctx: any, a: { text: string }) => {
      const docId = ctx.db.insert("docs", { text: a.text });
      const workId = pool.enqueueAction(ctx, internal.summarize, { text: a.text }, { onComplete: internal.saved, context: { docId } });
      return { docId, workId };
    },
  }),
  summarize: internalActionGeneric({
    args: { text: v.string() },
    handler: async (_ctx: unknown, a: { text: string }) => {
      if (failNext-- > 0) throw new Error("model overloaded");
      return a.text.slice(0, 5);
    },
  }),
  saved: internalMutationGeneric({
    args: vOnCompleteArgs,
    handler: (ctx: any, { context, result }: any) => {
      if (result.kind === "success") ctx.db.patch(context.docId, { summary: result.returnValue });
      else if (result.kind === "failed") ctx.db.patch(context.docId, { error: result.error });
    },
  }),
  progress: queryGeneric({ args: { workId: v.string() }, handler: (ctx: any, a: { workId: string }) => pool.status(ctx, a.workId) }),
  doc: queryGeneric({ args: { id: v.string() }, handler: (ctx: any, a: { id: string }) => ctx.db.get(a.id) }),
};

// ------------------------------------------------------------------------------------------- one cap across shards

/** Pinned: every call goes to global:main through ctx.onShard, so only actions can use it. */
const globalPool = new Workpool(anyComponents.aiPool, { maxParallelism: 2, shard: "global:main" });

const global = {
  /** Called on an org shard (an action: the pool lives in another shard). */
  start: actionGeneric({
    args: { docId: v.string() },
    handler: async (ctx: any, a: { docId: string }) =>
      globalPool.enqueueAction(ctx, internal.summarizeGlobal, { docId: a.docId, shard: ctx.shard }, { onComplete: internal.savedGlobal, context: { docId: a.docId, shard: ctx.shard }, key: `summarize:${a.docId}` }),
  }),
  /** From a mutation: schedule an action (atomic with the mutation), which enqueues at least once; the key dedupes. */
  request: mutationGeneric({
    args: { docId: v.string() },
    handler: (ctx: any, a: { docId: string }) => void ctx.scheduler.runAfter(0, internal.forward, a),
  }),
  forward: internalActionGeneric({ args: { docId: v.string() }, handler: async (ctx: any, a: { docId: string }) => ctx.runAction(unsafeRef<"action">("global:start"), a) }),
  /** The work runs in global:main: it reaches the caller's shard explicitly. */
  summarize: internalActionGeneric({
    args: { docId: v.string(), shard: v.string() },
    handler: async (ctx: any, a: { docId: string; shard: string }) => {
      await ctx.onShard(a.shard).runMutation(unsafeRef<"mutation">("global:record"), { docId: a.docId, shard: ctx.shard });
      return `summary of ${a.docId}`;
    },
  }),
  record: internalMutationGeneric({ args: { docId: v.string(), shard: v.string() }, handler: (ctx: any, a: any) => void ctx.db.insert("calls", a) }),
  /** onComplete runs in global:main too: it hands the result back to the caller's shard with a job. */
  saved: internalMutationGeneric({
    args: vOnCompleteArgs,
    handler: (ctx: any, { context, result }: any) => void ctx.scheduler.runAfter(0, unsafeRef<"action">("global:deliver"), { ...context, result }),
  }),
  deliver: internalActionGeneric({
    args: { docId: v.string(), shard: v.string(), result: v.any() },
    handler: async (ctx: any, a: any) => ctx.onShard(a.shard).runMutation(internal.writeBack, { docId: a.docId, summary: a.result.returnValue }),
  }),
  writeBack: internalMutationGeneric({ args: { docId: v.string(), summary: v.string() }, handler: (ctx: any, a: any) => void ctx.db.insert("calls", { docId: `${a.docId}=${a.summary}`, shard: "writeBack" }) }),
  /** Reads of a pinned pool: from an action, or with `pool.here` in a function running in global:main. */
  stats: actionGeneric({ args: {}, handler: async (ctx: any) => globalPool.stats(ctx) }),
  statsHere: queryGeneric({ args: {}, handler: (ctx: any) => globalPool.here.stats(ctx) }),
  calls: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("calls").collect().map((c: any) => `${c.docId}@${c.shard}`) }),
};

const t0 = () => emberTest({ schema, modules: { ai, global }, app });

describe("workpool with @freecorps/ember-testing", () => {
  test("enqueue in a mutation, watch the status, onComplete writes the result back", async () => {
    const t = t0();
    const { docId, workId } = await t.mutation(unsafeRef<"mutation">("ai:start"), { text: "hello world" }) as any;
    expect(await t.query(unsafeRef<"query">("ai:progress"), { workId })).toEqual({ state: "running", attempt: 1 });
    await t.advance(0); // runs what is due now: the action and its onComplete
    expect(await t.query(unsafeRef<"query">("ai:progress"), { workId })).toEqual({ state: "finished", result: { kind: "success", returnValue: "hello" } });
    expect(await t.query(unsafeRef<"query">("ai:doc"), { id: docId })).toMatchObject({ summary: "hello" });
  });

  test("retries follow the clock: t.advance moves past the backoff", async () => {
    const t = t0();
    failNext = 1;
    const { docId, workId } = await t.mutation(unsafeRef<"mutation">("ai:start"), { text: "retry me" }) as any;
    await t.advance(0);
    const s = (await t.query(unsafeRef<"query">("ai:progress"), { workId })) as any;
    expect(s).toMatchObject({ state: "running", attempt: 2, lastError: "model overloaded" });
    await t.advance(s.retryAt - t.now());
    expect(await t.query(unsafeRef<"query">("ai:doc"), { id: docId })).toMatchObject({ summary: "retry" });
  });

  test("one cap across shards: a pool pinned to global:main, enqueued from actions on org shards", async () => {
    const t = t0();
    await t.action(unsafeRef<"action">("global:start"), { docId: "a1" }, { shard: "org:a" });
    await t.action(unsafeRef<"action">("global:start"), { docId: "b1" }, { shard: "org:b" });
    // From a mutation (org:b): the forwarding action may run twice (at least once); the key keeps one item.
    await t.mutation(unsafeRef<"mutation">("global:request"), { docId: "b2" }, { shard: "org:b" });
    await t.mutation(unsafeRef<"mutation">("global:request"), { docId: "b2" }, { shard: "org:b" });
    expect(await t.action(unsafeRef<"action">("global:stats"), {}, { shard: "org:a" })).toMatchObject({ running: 2, pending: 0, maxParallelism: 2 });
    await t.advance(0);
    const stats = (await t.query(unsafeRef<"query">("global:statsHere"), {}, { shard: "global:main" })) as any;
    expect(stats).toMatchObject({ running: 0, pending: 0, totals: { enqueued: 3, succeeded: 3 } });
    // Every item ran once, in global:main; each result went back to its own shard.
    expect(((await t.query(unsafeRef<"query">("global:calls"), {}, { shard: "org:a" })) as string[]).sort()).toEqual(["a1=summary of a1@writeBack", "a1@global:main"]);
    expect(((await t.query(unsafeRef<"query">("global:calls"), {}, { shard: "org:b" })) as string[]).sort()).toEqual(["b1=summary of b1@writeBack", "b1@global:main", "b2=summary of b2@writeBack", "b2@global:main"]);
    // The org shards have no pool of their own.
    expect(await t.query(unsafeRef<"query">("global:statsHere"), {}, { shard: "org:a" })).toMatchObject({ totals: { enqueued: 0 } });
  });
});
