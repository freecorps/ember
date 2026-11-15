// The patterns of convex-test's documentation (basic calls, identities, scheduled functions with fake timers,
// `t.run`, HTTP actions), written from scratch against `@freecorps/ember-testing/convex-test`.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionGeneric as action,
  anyApi,
  defineSchema,
  defineTable,
  httpAction,
  httpRouter,
  internalMutationGeneric as internalMutation,
  mutationGeneric as mutation,
  queryGeneric as query,
  unsafeRef,
  v,
  type ApiFromModules,
} from "@freecorps/ember-server";
import { convexTest, modulePaths, toIdentity } from "../src/convex-test.ts";

const schema = defineSchema({
  tables: {
    messages: defineTable({ author: v.string(), body: v.string() }),
    tasks: defineTable({ owner: v.string(), text: v.string() }).index("by_owner", ["owner"]),
    log: defineTable({ what: v.string(), at: v.number() }),
  },
});

const messages = {
  list: query({ handler: (ctx) => ctx.db.query("messages").collect().map((m) => ({ author: m.author, body: m.body })) }),
  send: mutation({ args: { author: v.string(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("messages", a) }),
};

/** Tasks of the signed-in user (keyed by Convex's tokenIdentifier, which ports read from the identity's claims). */
const tasks = {
  mine: query({
    handler: (ctx) => {
      const me = ctx.auth.getUserIdentity();
      if (!me) return [];
      const owner = String(me.claims?.tokenIdentifier);
      return ctx.db.query("tasks").withIndex("by_owner", (q) => q.eq("owner", owner)).collect().map((t) => t.text);
    },
  }),
  add: mutation({
    args: { text: v.string() },
    handler: (ctx, { text }) => {
      const me = ctx.auth.require();
      return ctx.db.insert("tasks", { owner: String(me.claims?.tokenIdentifier), text });
    },
  }),
  whoami: query({ handler: (ctx) => ctx.auth.getUserIdentity() }),
};

const jobs = {
  /** Schedules `record` after `delayMs` and returns the job id. */
  later: mutation({ args: { delayMs: v.number(), what: v.string() }, handler: (ctx, a) => ctx.scheduler.runAfter(a.delayMs, unsafeRef<"mutation">("jobs:record"), { what: a.what }) }),
  record: internalMutation({ args: { what: v.string() }, handler: (ctx, { what }) => ctx.db.insert("log", { what, at: ctx.now }) }),
  /** An action scheduled by a mutation, that writes through a mutation (convex-test's "mutation schedules action"). */
  kickoff: mutation({ args: { what: v.string() }, handler: (ctx, a) => ctx.scheduler.runAfter(0, unsafeRef<"action">("jobs:work"), a) }),
  work: action({
    args: { what: v.string() },
    handler: async (ctx, { what }) => {
      await ctx.runMutation(unsafeRef<"mutation">("jobs:record"), { what: `${what}:done` });
    },
  }),
  /** A chain: each run schedules the next one second later, `n` times. */
  chain: internalMutation({
    args: { n: v.number() },
    handler: (ctx, { n }) => {
      ctx.db.insert("log", { what: `chain ${n}`, at: ctx.now });
      if (n > 1) ctx.scheduler.runAfter(1000, unsafeRef<"mutation">("jobs:chain"), { n: n - 1 });
    },
  }),
  startChain: mutation({ args: { n: v.number() }, handler: (ctx, a) => ctx.scheduler.runAfter(1000, unsafeRef<"mutation">("jobs:chain"), a) }),
  forever: internalMutation({ handler: (ctx) => ctx.scheduler.runAfter(1000, unsafeRef<"mutation">("jobs:forever"), {}) }),
  startForever: mutation({ handler: (ctx) => ctx.scheduler.runAfter(0, unsafeRef<"mutation">("jobs:forever"), {}) }),
  boom: internalMutation({ handler: () => {
    throw new Error("boom");
  } }),
  startBoom: mutation({ handler: (ctx) => ctx.scheduler.runAfter(0, unsafeRef<"mutation">("jobs:boom"), {}) }),
  status: query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.scheduler.get(id) }),
  log: query({ handler: (ctx) => ctx.db.query("log").collect().map((l) => l.what) }),
};

const http = httpRouter();
http.route({
  path: "/postMessage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const { author, body } = (await request.json()) as { author: string; body: string };
    await ctx.runMutation(unsafeRef<"mutation">("messages:send"), { author, body });
    return new Response(null, { status: 200 });
  }),
});

const api = anyApi as unknown as ApiFromModules<{ messages: typeof messages; tasks: typeof tasks; jobs: typeof jobs }>;

// What `import.meta.glob("../ember/**/*.ts")` gives: lazy loaders by path, `_generated` and the schema included.
const modules = {
  "../ember/_generated/api.ts": async () => ({}),
  "../ember/schema.ts": async () => ({ default: schema }),
  "../ember/messages.ts": async () => messages,
  "../ember/tasks.ts": async () => tasks,
  "../ember/jobs.ts": async () => jobs,
  "../ember/http.ts": async () => ({ default: http }),
};

afterEach(() => {
  vi.useRealTimers();
});

describe("convexTest: the basics", () => {
  it("mutations and queries, as convex-test's first example", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.messages.send, { body: "Hi!", author: "Sarah" });
    await t.mutation(api.messages.send, { body: "Hey!", author: "Tom" });
    expect(await t.query(api.messages.list, {})).toMatchObject([
      { body: "Hi!", author: "Sarah" },
      { body: "Hey!", author: "Tom" },
    ]);
  });

  it("t.run: set up and inspect the database directly (an async callback is awaited)", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) => ctx.db.insert("messages", { author: "Ana", body: "seeded" }));
    const doc = await t.run(async (ctx) => {
      const d = await ctx.db.get(id);
      return d?.body;
    });
    expect(doc).toBe("seeded");
    expect(await t.query(api.messages.list, {})).toEqual([{ author: "Ana", body: "seeded" }]);
  });

  it("HTTP actions through t.fetch", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/postMessage", { method: "POST", body: JSON.stringify({ author: "Web", body: "over http" }) });
    expect(res.status).toBe(200);
    expect(await t.query(api.messages.list, {})).toEqual([{ author: "Web", body: "over http" }]);
    expect((await t.fetch("/nope")).status).toBe(404);
  });
});

describe("convexTest: identities", () => {
  it("withIdentity: each user sees their own data; the identity's fields are claims", async () => {
    const t = convexTest(schema, modules);
    const asSarah = t.withIdentity({ name: "Sarah" });
    await asSarah.mutation(api.tasks.add, { text: "Add tests" });
    const asLee = t.withIdentity({ name: "Lee", email: "lee@example.test", role: "admin" });
    await asLee.mutation(api.tasks.add, { text: "Review" });
    expect(await asSarah.query(api.tasks.mine, {})).toEqual(["Add tests"]);
    expect(await asLee.query(api.tasks.mine, {})).toEqual(["Review"]);
    expect(await t.query(api.tasks.mine, {})).toEqual([]);
    await expect(t.mutation(api.tasks.add, { text: "x" })).rejects.toMatchObject({ code: "Unauthenticated" });
    const lee = await asLee.query(api.tasks.whoami, {});
    expect(lee).toMatchObject({ issuer: "https://convex.test", claims: { name: "Lee", email: "lee@example.test", role: "admin" } });
    expect(lee!.claims!.tokenIdentifier).toBe(`https://convex.test|${lee!.subject}`);
    // Deterministic and explicit subjects.
    expect(toIdentity({ name: "Sarah" }).subject).toBe(toIdentity({ name: "Sarah" }).subject);
    expect(toIdentity({ subject: "u1", issuer: "https://idp" }).claims).toEqual({ tokenIdentifier: "https://idp|u1" });
  });
});

describe("convexTest: scheduled functions with fake timers", () => {
  it("advanceTimersByTime fires the job; finishInProgressScheduledFunctions awaits it", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.jobs.later, { delayMs: 10_000, what: "later" });
    expect((await t.query(api.jobs.status, { id }))?.state.kind).toBe("pending");
    vi.advanceTimersByTime(5_000);
    await t.finishInProgressScheduledFunctions();
    expect(await t.query(api.jobs.log, {})).toEqual([]);
    vi.advanceTimersByTime(5_000);
    await t.finishInProgressScheduledFunctions();
    expect(await t.query(api.jobs.log, {})).toEqual(["later"]);
    expect(await t.query(api.jobs.status, { id })).toMatchObject({ state: { kind: "success" }, completedTime: expect.any(Number) });
  });

  it("a mutation that schedules an action: vi.runAllTimers + finishInProgressScheduledFunctions", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.kickoff, { what: "report" });
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();
    expect(await t.query(api.jobs.log, {})).toEqual(["report:done"]);
  });

  it("finishAllScheduledFunctions(vi.runAllTimers) runs chains; a job that always reschedules is reported", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.startChain, { n: 3 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.jobs.log, {})).toEqual(["chain 3", "chain 2", "chain 1"]);

    const loop = convexTest(schema, modules);
    await loop.mutation(api.jobs.startForever, {});
    await expect(loop.finishAllScheduledFunctions(vi.runAllTimers, 5)).rejects.toThrow(/still pending after 5 rounds/);
  });

  it("a failing scheduled function is marked failed and does not throw into the test", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.startBoom, {});
    const [job] = (await t.ember()).scheduled();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.jobs.status, { id: job!.id })).toMatchObject({ state: { kind: "failed", error: expect.stringContaining("boom") } });
  });

  it("without fake timers, real timers run due jobs", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.later, { delayMs: 0, what: "now" });
    await new Promise((r) => setTimeout(r, 20));
    await t.finishInProgressScheduledFunctions();
    expect(await t.query(api.jobs.log, {})).toEqual(["now"]);
  });

  it("close() clears the real timers of jobs not run yet: they never run after the test", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.later, { delayMs: 30, what: "late" });
    t.close();
    await new Promise((r) => setTimeout(r, 60));
    await t.finishInProgressScheduledFunctions();
    expect(await t.query(api.jobs.log, {})).toEqual([]);
  });
});

describe("module paths", () => {
  it("strip the folder of _generated (or the common one) and the extension; loaded modules work too", async () => {
    expect([...modulePaths(["../convex/_generated/api.ts", "../convex/chat/rooms.ts", "../convex/messages.js"]).values()]).toEqual(["_generated/api", "chat/rooms", "messages"]);
    expect([...modulePaths(["./a.ts", "./sub/b.ts"]).values()]).toEqual(["a", "sub/b"]);
    expect([...modulePaths(["messages"]).values()]).toEqual(["messages"]);
    const t = convexTest(schema, { messages });
    await t.mutation(api.messages.send, { body: "x", author: "y" });
    expect(await t.query(api.messages.list, {})).toHaveLength(1);
  });
});
