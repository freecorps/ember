// PR 5b (v0.10): ctx.storage in memory, measure / lastStats, close / dispose, advance syncing replicas between jobs,
// and convexTest forwarding app / triggers / replicas / limits.
import { describe, expect, it } from "vitest";
import {
  actionGeneric as action,
  anyApi,
  componentBuilders,
  defineApp,
  defineComponent,
  defineSchema,
  defineShard,
  defineTable,
  defineTriggers,
  httpAction,
  httpRouter,
  internalMutationGeneric as internalMutation,
  mutationGeneric as mutation,
  queryGeneric as query,
  unsafeRef,
  v,
  type ApiFromModules,
  type FileMetadata,
} from "@freecorps/ember-server";
import { emberTest } from "../src/index.ts";
import { convexTest } from "../src/convex-test.ts";

const sha256 = async (s: string) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Waits (real time) until `cond` holds: a condition, not a fixed sleep, so a slow runner only takes longer. */
const until = async (cond: () => boolean, what: string, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe("ctx.storage in actions and HTTP actions", () => {
  const schema = defineSchema({
    shards: { org: defineShard({ key: v.string() }) },
    tables: { docs: defineTable({ name: v.string(), file: v.file() }) },
  });
  const files = {
    store: action({
      args: { text: v.string(), contentType: v.optional(v.string()) },
      handler: async (ctx, { text, contentType }): Promise<string> => ctx.storage.store(text, contentType ? { contentType } : {}),
    }),
    storeBlob: action({ args: {}, handler: async (ctx): Promise<string> => ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })) }),
    read: action({
      args: { id: v.string() },
      handler: async (ctx, { id }) => {
        const f = await ctx.storage.get(id);
        return f ? { text: new TextDecoder().decode(await f.arrayBuffer()), size: f.size, sha256: f.sha256, contentType: f.contentType } : null;
      },
    }),
    meta: action({ args: { id: v.string() }, handler: async (ctx, { id }): Promise<FileMetadata | null> => ctx.storage.getMetadata(id) }),
    url: action({ args: { id: v.string(), download: v.optional(v.string()) }, handler: async (ctx, { id, download }) => ctx.storage.getUrl(id, download ? { download } : {}) }),
    remove: action({ args: { id: v.string() }, handler: async (ctx, { id }) => ctx.storage.delete(id) }),
    upload: action({ args: { size: v.number() }, handler: async (ctx, { size }) => ctx.storage.generateUploadUrl({ contentType: "text/plain", size }) }),
    uploadHashed: action({
      args: { size: v.number(), sha256: v.string() },
      handler: async (ctx, { size, sha256 }) => ctx.storage.generateUploadUrl({ contentType: "text/plain", size, sha256 }),
    }),
    attach: mutation({ args: { name: v.string(), file: v.file() }, handler: (ctx, a) => ctx.db.insert("docs", a) }),
    /** The mutation side sees the same `_files`. */
    metaInQuery: query({ args: { id: v.file() }, handler: (ctx, { id }) => ctx.storage.getMetadata(id) }),
  };
  const api = anyApi as unknown as ApiFromModules<{ files: typeof files }>;

  it("store / get / getMetadata / delete with the runtime's metadata (sha256 hex, size, contentType, dedup)", async () => {
    using t = emberTest({ schema, modules: { files } });
    const id = await t.action(api.files.store, { text: "hello", contentType: "text/plain" });
    const meta = await t.action(api.files.meta, { id });
    expect(meta).toMatchObject({ _id: id, storageId: id, sha256: await sha256("hello"), size: 5, contentType: "text/plain", state: "ready", _creationTime: t.now() });
    expect(await t.query(api.files.metaInQuery, { id: id as never })).toEqual(meta);
    expect(await t.action(api.files.read, { id })).toEqual({ text: "hello", size: 5, sha256: await sha256("hello"), contentType: "text/plain" });
    // Content-addressed per shard: the same bytes are the same file.
    expect(await t.action(api.files.store, { text: "hello" })).toBe(id);
    // Another shard has its own files.
    const other = await t.action(api.files.store, { text: "hello" }, { shard: "org:a" });
    expect(other).not.toBe(id);
    expect(await t.action(api.files.meta, { id: other }, { shard: "org:a" })).toMatchObject({ sha256: await sha256("hello") });
    expect(await t.action(api.files.meta, { id: other })).toBeNull();
    // A Blob's type is its contentType; without one, get() says application/octet-stream as R2 would.
    const blob = await t.action(api.files.storeBlob, {});
    expect(await t.action(api.files.meta, { id: blob })).toMatchObject({ size: 3, contentType: "image/png" });
    const raw = await t.action(api.files.store, { text: "raw" });
    expect((await t.action(api.files.meta, { id: raw }))?.contentType).toBeNull();
    expect((await t.action(api.files.read, { id: raw }))?.contentType).toBe("application/octet-stream");

    // A referenced file cannot be deleted; an unreferenced one is gone for get/getMetadata.
    const doc = await t.mutation(api.files.attach, { name: "a", file: id as never });
    await expect(t.action(api.files.remove, { id })).rejects.toMatchObject({ code: "FileInUse" });
    await t.run((ctx) => ctx.db.delete(doc));
    await t.action(api.files.remove, { id });
    expect(await t.action(api.files.meta, { id })).toBeNull();
    expect(await t.action(api.files.read, { id })).toBeNull();
    expect(await t.action(api.files.meta, { id: "nope" })).toBeNull();
  });

  it("advance runs the file GC: a stored file nothing references goes after the grace period, a referenced one stays", async () => {
    using t = emberTest({ schema, modules: { files } });
    const kept = await t.action(api.files.store, { text: "kept" });
    const lost = await t.action(api.files.store, { text: "lost" });
    await t.mutation(api.files.attach, { name: "k", file: kept as never });
    await t.advance(23 * 3600_000);
    expect(await t.action(api.files.meta, { id: lost })).not.toBeNull();
    await t.advance(2 * 3600_000);
    expect(await t.action(api.files.meta, { id: lost })).toBeNull();
    expect(await t.action(api.files.read, { id: kept })).toMatchObject({ text: "kept" });
  });

  it("getUrl gives a signed URL that t.fetch serves, until it expires", async () => {
    using t = emberTest({ schema, modules: { files } });
    const id = await t.action(api.files.store, { text: "body", contentType: "text/markdown" });
    const url = (await t.action(api.files.url, { id }))!;
    expect(url).toMatch(/^http:\/\/ember\.test\/api\/storage\/get\?/);
    const res = await t.fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown");
    expect(await res.text()).toBe("body");
    const dl = await t.fetch((await t.action(api.files.url, { id, download: "notes.md" }))!);
    expect(dl.headers.get("content-disposition")).toContain("notes.md");
    expect((await t.fetch(url.replace(/sig=[^&]+/, "sig=00"))).status).toBe(403);
    await t.advance(8 * 24 * 3600_000);
    expect((await t.fetch(url)).status).toBe(403);
  });

  it("generateUploadUrl tickets upload through t.fetch (PUT + confirm), and the file becomes ready", async () => {
    using t = emberTest({ schema, modules: { files } });
    const ticket = await t.action(api.files.upload, { size: 2 });
    expect(await t.action(api.files.meta, { id: ticket.storageId })).toMatchObject({ state: "pending", size: 2, sha256: null });
    expect((await t.fetch(ticket.url!, { method: "PUT", body: "abc", headers: ticket.headers! })).status).toBe(400); // wrong size
    expect((await t.fetch(ticket.url!, { method: "PUT", body: "ok", headers: ticket.headers! })).status).toBe(200);
    const confirmed = await t.fetch("/api/storage/confirm", { method: "POST", body: JSON.stringify({ shard: ticket.shard, storageId: ticket.storageId, token: ticket.token }) });
    expect(await confirmed.json()).toMatchObject({ ok: true, file: { storageId: ticket.storageId, state: "ready", sha256: await sha256("ok"), size: 2, contentType: "text/plain" } });
    expect(await t.action(api.files.read, { id: ticket.storageId })).toMatchObject({ text: "ok", contentType: "text/plain" });
    expect((await t.fetch("/api/storage/confirm", { method: "POST", body: JSON.stringify({ shard: ticket.shard, storageId: ticket.storageId, token: "bad" }) })).status).toBe(404);
  });

  it("a PUT whose body does not match the declared sha256 is refused and leaves the shared object alone", async () => {
    using t = emberTest({ schema, modules: { files } });
    const declared = await sha256("ok");
    const ticket = () => t.action(api.files.uploadHashed, { size: 2, sha256: declared });
    const put = (tk: Awaited<ReturnType<typeof ticket>>, body: string) => t.fetch(tk.url!, { method: "PUT", body, headers: tk.headers! });
    const confirm = (tk: Awaited<ReturnType<typeof ticket>>) => t.fetch("/api/storage/confirm", { method: "POST", body: JSON.stringify({ shard: tk.shard, storageId: tk.storageId, token: tk.token }) });
    const first = await ticket();
    const second = await ticket();
    expect((await put(first, "ok")).status).toBe(200);
    expect((await confirm(first)).status).toBe(200);
    // Same length, other bytes, through the second ticket (same content-addressed key).
    const bad = await put(second, "no");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "checksum_mismatch" } });
    expect(await t.action(api.files.read, { id: first.storageId })).toMatchObject({ text: "ok" });
    expect(await t.action(api.files.meta, { id: second.storageId })).toMatchObject({ state: "pending" });
    // The right bytes still go through the second ticket.
    expect((await put(second, "ok")).status).toBe(200);
    expect((await confirm(second)).status).toBe(200);
    expect(await t.action(api.files.read, { id: first.storageId })).toMatchObject({ text: "ok" });
  });

  it("HTTP actions get ctx.storage too", async () => {
    const http = httpRouter();
    http.route({
      path: "/upload",
      method: "POST",
      handler: httpAction(async (ctx, req) => {
        const id = await ctx.storage.store(await req.blob(), { contentType: req.headers.get("content-type") ?? "application/octet-stream" });
        return Response.json({ id, url: await ctx.storage.getUrl(id) });
      }),
    });
    using t = emberTest({ schema, modules: { files }, http });
    const res = await t.fetch("/upload", { method: "POST", body: "from http", headers: { "content-type": "text/plain" } });
    const { id, url } = (await res.json()) as { id: string; url: string };
    expect(await t.action(api.files.meta, { id })).toMatchObject({ size: 9, contentType: "text/plain" });
    expect(await (await t.fetch(url)).text()).toBe("from http");
  });
});

describe("measure / lastStats", () => {
  const schema = defineSchema({ tables: { items: defineTable({ n: v.number() }).index("by_n", ["n"]) } });
  const items = {
    seed: mutation({ args: { count: v.number() }, handler: (ctx, { count }) => void Array.from({ length: count }, (_, n) => ctx.db.insert("items", { n })) }),
    all: query({ handler: (ctx) => ctx.db.query("items").collect().length }),
    one: query({ args: { n: v.number() }, handler: (ctx, { n }) => ctx.db.query("items").withIndex("by_n", (q) => q.eq("n", n)).first()?.n ?? null }),
    both: action({
      handler: async (ctx): Promise<number> => {
        await ctx.runMutation(unsafeRef<"mutation">("items:seed"), { count: 2 });
        return (await ctx.runQuery(unsafeRef<"query">("items:all"))) as number;
      },
    }),
    later: mutation({ handler: (ctx) => void ctx.scheduler.runAfter(10, unsafeRef<"mutation">("items:seed"), { count: 3 }) }),
    /** Schedules a job at once and waits (real time) until it ran, then returns. */
    waitsForJob: action({
      handler: async (ctx): Promise<void> => {
        const id = await ctx.scheduler.runAfter(0, unsafeRef<"mutation">("items:seed"), { count: 3 });
        const deadline = Date.now() + 5_000;
        while ((await ctx.scheduler.get(id))?.state.kind !== "success") {
          if (Date.now() > deadline) throw new Error("job did not run");
          await new Promise((r) => setTimeout(r, 2));
        }
      },
    }),
  };
  const api = anyApi as unknown as ApiFromModules<{ items: typeof items }>;

  it("reports the engine's counters of the last call, and sums them over measure(fn)", async () => {
    using t = emberTest({ schema, modules: { items } });
    expect(t.lastStats()).toBeNull();
    await t.mutation(api.items.seed, { count: 10 });
    expect(t.lastStats()).toMatchObject({ rowsWritten: 10, documentsRead: 0 });
    expect(await t.query(api.items.all, {})).toBe(10);
    expect(t.lastStats()).toEqual({ rowsRead: 10, rowsWritten: 0, documentsRead: 10 });
    await t.query(api.items.one, { n: 3 });
    const indexed = t.lastStats()!;
    expect(indexed.documentsRead).toBe(1);
    expect(indexed.rowsRead).toBeLessThan(10);

    const { value, stats } = await t.measure(async () => {
      await t.query(api.items.all, {});
      return t.query(api.items.all, {});
    });
    expect(value).toBe(10);
    expect(stats).toEqual({ rowsRead: 20, rowsWritten: 0, documentsRead: 20 });

    // An action: its nested calls, summed.
    expect(await t.action(api.items.both, {})).toBe(12);
    expect(t.lastStats()).toMatchObject({ rowsWritten: 2, documentsRead: 12 });
    // Scheduled jobs count as calls of their own, and inside measure.
    await t.mutation(api.items.later, {});
    const m = await t.measure(() => t.finishScheduled());
    expect(m.value).toBe(1);
    expect(m.stats.rowsWritten).toBe(3);
    expect(t.lastStats()?.rowsWritten).toBe(3);
  });

  it("convexTest: a job its (real) timer starts is a call of its own, not part of the call that scheduled it", async () => {
    using c = convexTest(schema, { items });
    await c.mutation(api.items.later, {});
    const base = await c.ember();
    expect(base.lastStats()?.rowsWritten).toBe(0);
    // Its timer (10 ms) has started it once it is gone from scheduled(), however late the runner fires it.
    await until(() => base.scheduled().length === 0, "the job's timer");
    await c.finishInProgressScheduledFunctions();
    expect(base.lastStats()?.rowsWritten).toBe(3);
  });

  it("convexTest: a job that runs while the action that scheduled it still runs stays out of that action's stats", async () => {
    using c = convexTest(schema, { items });
    const base = await c.ember();
    // No measure around: the job is a call of its own; the action itself wrote nothing.
    await c.action(api.items.waitsForJob, {});
    expect(base.lastStats()).toEqual({ rowsRead: 0, rowsWritten: 0, documentsRead: 0 });
    // Inside a measure, the job ran within it, so it counts there (and still not in the action's lastStats).
    const m = await base.measure(() => c.action(api.items.waitsForJob, {}));
    expect(base.lastStats()).toEqual({ rowsRead: 0, rowsWritten: 0, documentsRead: 0 });
    expect(m.stats.rowsWritten).toBe(3);
  });

  it("t.run: what an async callback writes after its first await counts too (once)", async () => {
    using t = emberTest({ schema, modules: { items } });
    const { stats } = await t.measure(() =>
      t.run(async (ctx) => {
        ctx.db.insert("items", { n: 1 });
        await Promise.resolve();
        ctx.db.insert("items", { n: 2 });
        ctx.db.insert("items", { n: 3 });
      }),
    );
    expect(stats.rowsWritten).toBe(t.lastStats()!.rowsWritten);
    const once = await t.measure(() => t.run((ctx) => void ctx.db.insert("items", { n: 4 })));
    expect(stats.rowsWritten).toBe(3 * once.stats.rowsWritten);
  });

  it("concurrent calls do not mix", async () => {
    using t = emberTest({ schema, modules: { items } });
    await t.mutation(api.items.seed, { count: 5 });
    const [a, b] = await Promise.all([t.measure(() => t.action(api.items.both, {})), t.measure(() => t.query(api.items.one, { n: 1 }))]);
    expect(a.stats.rowsWritten).toBe(2);
    expect(b.stats).toMatchObject({ rowsWritten: 0, documentsRead: 1 });
  });
});

describe("close / dispose", () => {
  const schema = defineSchema({ tables: { log: defineTable({ what: v.string() }) } });
  const log = {
    add: mutation({ args: { what: v.string() }, handler: (ctx, a) => void ctx.scheduler.runAfter(1000, unsafeRef<"mutation">("log:write"), a) }),
    write: internalMutation({ args: { what: v.string() }, handler: (ctx, a) => void ctx.db.insert("log", a) }),
    slow: action({
      handler: async (ctx): Promise<string> => {
        await new Promise((r) => setTimeout(r, 5));
        await ctx.runMutation(unsafeRef<"mutation">("log:write"), { what: "slow" });
        return "done";
      },
    }),
  };
  const api = anyApi as unknown as ApiFromModules<{ log: typeof log }>;

  it("close() frees the databases and pending jobs; later calls throw", async () => {
    // `using` closes it even when an assertion fails first (close() is idempotent).
    using t = emberTest({ schema, modules: { log } });
    await t.mutation(api.log.add, { what: "x" });
    const engine = t.engine();
    expect(t.scheduled()).toHaveLength(1);
    t.close();
    expect(t.scheduled()).toHaveLength(0);
    // The SQLite database behind it is closed.
    expect(() => engine.runMutation(unsafeRef<"mutation">("log:write") as never, { what: "z" })).toThrow(/not open/);
    await expect(t.mutation(api.log.add, { what: "y" })).rejects.toThrow(/closed/);
    expect(() => t.engine()).toThrow(/closed/);
    t.close(); // idempotent
  });

  it("using / await using", async () => {
    let outer: ReturnType<typeof emberTest>;
    {
      using t = emberTest({ schema, modules: { log } });
      outer = t;
      await t.mutation(api.log.add, { what: "x" });
    }
    await expect(outer.mutation(api.log.add, { what: "y" })).rejects.toThrow(/closed/);
    let running: Promise<string>;
    {
      await using t = emberTest({ schema, modules: { log } });
      outer = t;
      running = t.action(api.log.slow, {});
    }
    // await using waited for the action before closing.
    expect(await running).toBe("done");
    expect(() => outer.engine()).toThrow(/closed/);
  });

  it("convexTest: close() closes the harness underneath, and await using waits for scheduled functions in progress", async () => {
    const t = convexTest(schema, { log });
    const base = await t.ember();
    t.close();
    expect(() => base.engine()).toThrow(/closed/);
    await expect(t.mutation(api.log.add, { what: "y" })).rejects.toThrow(/closed/);
    let b: Awaited<ReturnType<typeof t.ember>>;
    {
      await using c = convexTest(schema, { log });
      b = await c.ember();
      await c.mutation(api.log.add, { what: "z" });
    }
    expect(() => b.engine()).toThrow(/closed/);
  });
});

describe("advance syncs .replicated() tables between jobs", () => {
  const schema = defineSchema({
    shards: { org: defineShard({ key: v.string() }) },
    tables: {
      rates: defineTable({ base: v.string(), rate: v.number() }).index("by_base", ["base"]).replicated({ to: ["org"] }),
      seen: defineTable({ rate: v.union(v.number(), v.null()) }),
    },
  });
  const fx = {
    set: mutation({ args: { rate: v.number() }, handler: (ctx, { rate }) => void ctx.db.insert("rates", { base: "USD", rate }) }),
    /** On global:main: writes a rate at +1 s, then (+2 s) runs `look` on org:a. */
    plan: action({
      handler: async (ctx): Promise<void> => {
        await ctx.scheduler.runAfter(1000, unsafeRef<"mutation">("fx:set"), { rate: 7 });
        await ctx.onShard("org:a").scheduler.runAfter(2000, unsafeRef<"mutation">("fx:look"), {});
      },
    }),
    look: mutation({ shard: "org", handler: (ctx) => void ctx.db.insert("seen", { rate: ctx.db.query("rates").withIndex("by_base", (q) => q.eq("base", "USD")).first()?.rate ?? null }) }),
    seen: query({ shard: "org", handler: (ctx) => ctx.db.query("seen").collect().map((s) => s.rate) }),
  };
  const api = anyApi as unknown as ApiFromModules<{ fx: typeof fx }>;

  it("a job on another shard reads what an earlier job of the same advance wrote on global:main", async () => {
    using t = emberTest({ schema, modules: { fx } });
    // org:a exists (and has had its first copy) before the clock moves.
    expect(await t.query(api.fx.seen, {}, { shard: "org:a" })).toEqual([]);
    await t.syncReplicas();
    await t.action(api.fx.plan, {});
    expect(await t.advance(5000)).toBe(2);
    expect(await t.query(api.fx.seen, {}, { shard: "org:a" })).toEqual([7]);
  });
});

describe("convexTest forwards app / triggers / replicas / limits", () => {
  const schema = defineSchema({ tables: { notes: defineTable({ text: v.string() }), log: defineTable({ what: v.string() }) } });
  const counterSchema = defineSchema({ tables: { counters: defineTable({ n: v.number() }) } });
  const cb = componentBuilders<typeof counterSchema, { step: number }>();
  const counter = defineComponent({
    name: "counter",
    schema: counterSchema,
    config: v.object({ step: v.number() }),
    functions: {
      lib: {
        bump: cb.mutation({ args: {}, handler: (ctx) => ctx.db.insert("counters", { n: ctx.component.config.step }) }),
        total: cb.query({ args: {}, handler: (ctx) => ctx.db.query("counters").collect().reduce((s, c) => s + c.n, 0) }),
      },
    },
  });
  const app = defineApp().use(counter, { name: "c", config: { step: 3 } });
  const notes = {
    add: mutation({ args: { text: v.string() }, handler: (ctx, a) => void ctx.db.insert("notes", a) }),
    many: mutation({ args: { n: v.number() }, handler: (ctx, { n }) => void Array.from({ length: n }, () => ctx.db.insert("notes", { text: "x" })) }),
    log: query({ handler: (ctx) => ctx.db.query("log").collect().map((l) => l.what) }),
    bump: mutation({ handler: (ctx) => void ctx.runMutation(unsafeRef<"mutation">("@c/lib:bump")) }),
    total: query({ handler: (ctx) => ctx.runQuery(unsafeRef<"query">("@c/lib:total")) as number }),
    member: query({
      args: { userId: v.string() },
      handler: (ctx, { userId }) => {
        const db = ctx.db as unknown as { query(t: string): { collect(): Array<{ userId: string; role: string }> } };
        return db.query("auth:member").collect().find((m) => m.userId === userId)?.role ?? null;
      },
    }),
  };
  const api = anyApi as unknown as ApiFromModules<{ notes: typeof notes }>;

  it("app composes components", async () => {
    using t = convexTest(schema, { notes }, { app });
    await t.mutation(api.notes.bump, {});
    await t.mutation(api.notes.bump, {});
    expect(await t.query(api.notes.total, {})).toBe(6);
  });

  it("triggers", async () => {
    const triggers = defineTriggers({ notes: (ctx, c) => void ctx.db.insert("log", { what: `${c.operation} ${(c.newDoc as { text: string }).text}` }) });
    using t = convexTest(schema, { notes }, { triggers });
    await t.mutation(api.notes.add, { text: "hi" });
    expect(await t.query(api.notes.log, {})).toEqual(["insert hi"]);
  });

  it("replicas", async () => {
    const replicas = [{ name: "auth:member", source: "auth", idType: "string" as const, fields: [{ name: "userId", type: "string" as const, optional: false }, { name: "role", type: "string" as const, optional: false }], indexes: [] }];
    using t = convexTest(schema, { notes }, { replicas });
    await (await t.ember()).seedReplica("auth:member", [{ id: "m1", userId: "ana", role: "owner" }]);
    expect(await t.query(api.notes.member, { userId: "ana" })).toBe("owner");
  });

  it("defineApp({ limits }) applies to the engine, as in the Worker; an explicit `limits` wins key by key", async () => {
    using t = convexTest(schema, { notes }, { app: defineApp({ limits: { rowsWritten: 5 } }) });
    await t.mutation(api.notes.many, { n: 3 });
    await expect(t.mutation(api.notes.many, { n: 10 })).rejects.toMatchObject({ code: "TooManyWrites" });
    using e = emberTest({ schema, modules: { notes }, app: defineApp({ limits: { rowsWritten: 5 } }), limits: { rowsWritten: 50 } });
    await e.mutation(api.notes.many, { n: 10 });
    await expect(e.mutation(api.notes.many, { n: 60 })).rejects.toMatchObject({ code: "TooManyWrites" });
  });

  it("limits", async () => {
    using t = convexTest(schema, { notes }, { limits: { rowsWritten: 5 } });
    await t.mutation(api.notes.many, { n: 3 });
    await expect(t.mutation(api.notes.many, { n: 10 })).rejects.toMatchObject({ code: "TooManyWrites" });
  });
});
