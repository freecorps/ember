// The test app (node and workerd): the agent and rateLimit components, an assistant with two tools, and the app
// functions a real app would write. The model is swappable (`models.current`), so each test scripts its own.
import { anyComponents, defineApp, defineSchema, defineTable, internalMutationGeneric, internalQueryGeneric, mutationGeneric, paginationOptsValidator, queryGeneric, unsafeRef, v } from "@freecorps/ember-server";
import { MINUTE, RateLimiter, rateLimit } from "@freecorps/ember-rate-limit";
import { Agent, agent, mockModel, tool, vStreamArgs, type AgentModel, type UsageEvent } from "../src/index.ts";

export const models: { current: AgentModel } = { current: mockModel([{ text: "hello" }]) };
/** Delegates to `models.current` (so tests can switch models without rebuilding the app). */
const model: AgentModel = {
  get provider() {
    return models.current.provider;
  },
  get modelId() {
    return models.current.modelId;
  },
  stream: (r) => models.current.stream(r),
};

export const limiter = new RateLimiter(anyComponents.rateLimit, {
  tokens: { kind: "token bucket", rate: 1000, period: MINUTE, capacity: 1000, maxReserved: 1_000_000 },
});

export const toolCalls: string[] = [];
/** The `slow` tool: how many run at once (tool calls of one step run concurrently). */
export const slowTool = { inFlight: 0, max: 0 };

export const assistant = new Agent(anyComponents.agent, {
  name: "support",
  model,
  instructions: "You help users with their orders.",
  tools: {
    lookupOrder: tool({
      description: "Finds an order by id",
      args: { orderId: v.string().describe("The order id, like A-1") },
      handler: async (ctx, { orderId }) => {
        toolCalls.push(`${ctx.agentName}:${orderId}`);
        return ctx.runQuery(unsafeRef<"query">("orders:get"), { orderId });
      },
    }),
    slow: tool({
      args: { ms: v.number() },
      handler: async (_ctx, { ms }) => {
        slowTool.inFlight++;
        slowTool.max = Math.max(slowTool.max, slowTool.inFlight);
        await new Promise((r) => setTimeout(r, ms));
        slowTool.inFlight--;
        return ms;
      },
    }),
    explode: tool({
      args: {},
      handler: () => {
        throw new Error("tool exploded");
      },
    }),
  },
  maxSteps: 3,
  action: "chat:generate",
  onUsage: "chat:usage",
  contextOptions: { recentMessages: 6, searchOtherMessages: { limit: 2 } },
  streaming: { throttleMs: 0, maxChars: 8 },
});

export const schema = defineSchema({
  tables: {
    orders: defineTable({ orderId: v.string(), status: v.string() }).index("by_orderId", ["orderId"]),
    usage: defineTable({ userId: v.optional(v.string()), messageId: v.string(), model: v.optional(v.string()), total: v.number() }),
  },
});

const usageArgs = {
  threadId: v.string(),
  messageId: v.string(),
  userId: v.optional(v.string()),
  agentName: v.optional(v.string()),
  model: v.optional(v.string()),
  provider: v.optional(v.string()),
  usage: v.object({ inputTokens: v.number(), outputTokens: v.number(), totalTokens: v.number() }),
};

export const functions = {
  chat: {
    createThread: mutationGeneric({ args: { userId: v.optional(v.string()), title: v.optional(v.string()) }, handler: (ctx: any, a: any) => assistant.createThread(ctx, a) }),
    thread: queryGeneric({ args: { threadId: v.string() }, handler: (ctx: any, a: any) => assistant.getThread(ctx, a.threadId) }),
    threads: queryGeneric({ args: { userId: v.string(), paginationOpts: paginationOptsValidator }, handler: (ctx: any, a: any) => assistant.listThreads(ctx, a) }),
    send: mutationGeneric({
      args: { threadId: v.string(), text: v.string(), fail: v.optional(v.boolean()) },
      handler: (ctx: any, a: any) => {
        const r = assistant.sendMessage(ctx, { threadId: a.threadId, text: a.text });
        if (a.fail) throw new Error("caller failed");
        return r;
      },
    }),
    save: mutationGeneric({ args: { threadId: v.string(), text: v.string(), role: v.optional(v.any()) }, handler: (ctx: any, a: any) => assistant.saveMessage(ctx, a) }),
    messages: queryGeneric({
      args: { threadId: v.string(), paginationOpts: paginationOptsValidator, streamArgs: vStreamArgs },
      handler: (ctx: any, a: any) => assistant.listMessages(ctx, a),
    }),
    message: queryGeneric({ args: { messageId: v.string() }, handler: (ctx: any, a: any) => assistant.getMessage(ctx, a.messageId) }),
    search: queryGeneric({ args: { threadId: v.string(), text: v.string() }, handler: (ctx: any, a: any) => assistant.searchMessages(ctx, a) }),
    abort: mutationGeneric({ args: { threadId: v.optional(v.string()), messageId: v.optional(v.string()) }, handler: (ctx: any, a: any) => assistant.abort(ctx, a.messageId ? { messageId: a.messageId } : { threadId: a.threadId }) }),
    retry: mutationGeneric({ args: { messageId: v.string() }, handler: (ctx: any, a: any) => assistant.retry(ctx, a.messageId) }),
    remove: mutationGeneric({ args: { threadId: v.string() }, handler: (ctx: any, a: any) => assistant.deleteThread(ctx, a.threadId) }),
    generate: assistant.action(),
    /** onUsage: bill the step and take its tokens from the user's budget (`reserve`: may go negative). */
    usage: internalMutationGeneric({
      args: usageArgs,
      handler: (ctx: any, e: UsageEvent) => {
        ctx.db.insert("usage", { messageId: e.messageId, total: e.usage.totalTokens, ...(e.userId ? { userId: e.userId } : {}), ...(e.model ? { model: e.model } : {}) });
        if (e.userId) limiter.limit(ctx, "tokens", { key: e.userId, count: e.usage.totalTokens, reserve: true });
        return null;
      },
    }),
    /** What a send mutation would check before scheduling another response. */
    budget: queryGeneric({ args: { userId: v.string() }, handler: (ctx: any, a: any) => limiter.check(ctx, "tokens", { key: a.userId }) }),
    usageRows: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("usage").collect().map((u: any) => ({ userId: u.userId, total: u.total, model: u.model })) }),
  },
  orders: {
    get: internalQueryGeneric({
      args: { orderId: v.string() },
      handler: (ctx: any, a: any) => {
        const o = ctx.db.query("orders").withIndex("by_orderId", (q: any) => q.eq("orderId", a.orderId)).unique();
        return o ? { orderId: o.orderId, status: o.status } : null;
      },
    }),
    seed: mutationGeneric({ args: { orderId: v.string(), status: v.string() }, handler: (ctx: any, a: any) => ctx.db.insert("orders", a) }),
  },
};

export const app = defineApp().use(agent).use(rateLimit);
