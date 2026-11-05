// External indexes in workerd (PLAN §6): mutation → outbox (same transaction) → queue (fake EMBER_INDEXING) →
// consumer (`worker.queue`) → fake Vectorize / AI Search bindings → ack; retries and in-flight writes; the
// action-side searches; the explicit local fallback (EMBER_AI_INDEXES=local) with in-process delivery.

import { env } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { action, defineSchema, defineTable, mutation, v, type ActionCtx, type MutationCtx } from "@freecorps/ember-server";
import {
  ActionRunner,
  aiSearchFolder,
  aiSearchItemKey,
  createEmberWorker,
  vectorNamespace,
  type AiSearchLike,
  type EmberConfig,
  type IndexMessage,
  type ShardApi,
  type VectorizeLike,
} from "../src/index.ts";
import { setEmberConfig } from "../src/config.ts";
import { config as baseConfig } from "./worker.ts";
import { shardStub, sleep } from "./helpers.ts";

const schema = defineSchema({
  tables: {
    notes: defineTable({ title: v.string(), body: v.string(), lang: v.string(), stars: v.number(), vec: v.optional(v.array(v.number())) })
      .vectorIndex("by_vec", { vectorField: "vec", dimensions: 32, filterFields: ["lang"] })
      .vectorIndex("semantic", { embed: "title", filterFields: ["stars"] })
      .aiSearchIndex("hybrid", { fields: ["title", "body"], filterFields: ["lang", "stars"] }),
    // More shards than Vectorize namespaces: the shard is the `_shard` metadata filter instead.
    wide: defineTable({ lang: v.string(), vec: v.array(v.number()) }).vectorIndex("by_vec", { vectorField: "vec", dimensions: 32, filterFields: ["lang"], shardIsolation: "filter" }),
    // pt-BR: vector retrieval unless a search asks for another mode.
    faq: defineTable({ q: v.string() }).aiSearchIndex("kb", { fields: ["q"], defaultMode: "vector", keywordTokenizer: "trigram" }),
  },
});

const functions = {
  notes: {
    add: mutation({
      args: { title: v.string(), body: v.string(), lang: v.string(), stars: v.number(), vec: v.optional(v.array(v.number())) },
      handler: (ctx: MutationCtx, a: any) => ctx.db.insert("notes", a),
    }),
    patch: mutation({ args: { id: v.string(), fields: v.any() }, handler: (ctx: MutationCtx, a: any) => ctx.db.patch(a.id, a.fields) }),
    remove: mutation({ args: { id: v.string() }, handler: (ctx: MutationCtx, a: any) => ctx.db.delete(a.id) }),
    wide: mutation({ args: { lang: v.string(), vec: v.array(v.number()) }, handler: (ctx: MutationCtx, a: any) => ctx.db.insert("wide", a) }),
    find: action({ args: { vector: v.array(v.number()) }, handler: (ctx: ActionCtx, a: any) => ctx.vectorSearch("notes", "by_vec", { vector: a.vector, limit: 3 }) }),
  },
};

const P = (...x: number[]) => [...x, ...new Array<number>(32 - x.length).fill(0)];

// ---------------------------------------------------------------------------------------------- fakes

type Vec = { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> };
const fake = {
  mode: "service" as "service" | "local",
  queue: [] as IndexMessage[],
  vectors: new Map<string, Map<string, Vec>>(), // binding -> id -> vector
  queries: [] as Array<{ binding: string; vector: number[]; opts: Record<string, unknown> }>,
  items: new Map<string, { id: string; key: string; text: string; metadata: Record<string, string> }>(),
  searches: [] as Array<Record<string, unknown>>,
  ai: [] as Array<{ model: string; input: Record<string, unknown> }>,
  failUpserts: 0,
};

function fakeVectorize(binding: string): VectorizeLike {
  const store = () => {
    let m = fake.vectors.get(binding);
    if (!m) fake.vectors.set(binding, (m = new Map()));
    return m;
  };
  return {
    async upsert(vs) {
      if (fake.failUpserts > 0) {
        fake.failUpserts--;
        throw new Error("vectorize unavailable");
      }
      for (const x of vs) store().set(x.id, { ...x, values: [...x.values] });
      return { mutationId: "m" };
    },
    async deleteByIds(ids) {
      for (const id of ids) store().delete(id);
      return { mutationId: "d" };
    },
    async query(vector, opts) {
      fake.queries.push({ binding, vector, opts: opts as Record<string, unknown> });
      const f = (opts.filter ?? {}) as Record<string, unknown>;
      const eq = (c: unknown) => (c !== null && typeof c === "object" ? (c as { $eq?: unknown }).$eq : c);
      const hits = [...store().values()]
        .filter((x) => x.namespace === opts.namespace)
        .filter((x) => Object.entries(f).every(([k, c]) => eq(c) === undefined || x.metadata?.[k] === eq(c)))
        .map((x) => ({ id: x.id, score: x.values.reduce((s, y, i) => s + y * vector[i]!, 0) }))
        .sort((a, b) => b.score - a.score);
      return { matches: hits.slice(0, opts.topK ?? 5) };
    },
  };
}

const fakeAiSearch: AiSearchLike = {
  items: {
    async upload(name, content, opts) {
      const existing = fake.items.get(name);
      const id = existing?.id ?? `item${fake.items.size + 1}`;
      fake.items.set(name, { id, key: name, text: String(content), metadata: opts?.metadata ?? {} });
      return { id, key: name };
    },
    async list(o) {
      return { result: [...fake.items.values()].filter((i) => !o?.search || i.key.includes(o.search)).map(({ id, key }) => ({ id, key })) };
    },
    async delete(itemId) {
      for (const [k, i] of fake.items) if (i.id === itemId) fake.items.delete(k);
    },
  },
  async search(req) {
    fake.searches.push(req as Record<string, unknown>);
    const filters = ((req.ai_search_options as any)?.retrieval?.filters ?? {}) as Record<string, unknown>;
    const words = req.query.toLowerCase().split(/\s+/);
    const chunks = [...fake.items.values()]
      .filter((i) => i.key.startsWith(String(filters.folder)) && (filters.lang === undefined || i.metadata.lang === filters.lang))
      .flatMap((i) => i.text.split("\n\n").map((t) => ({ score: words.filter((w) => t.toLowerCase().includes(w)).length / words.length, text: t, item: { key: i.key } })))
      .filter((c) => c.score > 0);
    return { chunks };
  },
};

const { crons: _noCrons, ...base } = baseConfig;
const aiConfig: EmberConfig = {
  ...base,
  schema,
  functions,
  externalIndexes: {
    env: () =>
      fake.mode === "local"
        ? { EMBER_AI_INDEXES: "local" }
        : {
            EMBER_INDEXING: { sendBatch: async (ms: Array<{ body: IndexMessage }>) => void fake.queue.push(...ms.map((m) => m.body)) },
            EMBER_VEC__notes__by_vec: fakeVectorize("EMBER_VEC__notes__by_vec"),
            EMBER_VEC__notes__semantic: fakeVectorize("EMBER_VEC__notes__semantic"),
            EMBER_VEC__wide__by_vec: fakeVectorize("EMBER_VEC__wide__by_vec"),
            EMBER_AIS__notes__hybrid: fakeAiSearch,
            EMBER_AIS__faq__kb: fakeAiSearch,
            EMBER_AI: {
              async run(model: string, input: Record<string, unknown>) {
                fake.ai.push({ model, input });
                const texts = (input.text ?? input.documents ?? input.queries) as string[];
                return { shape: [texts.length, 1024], data: texts.map((t) => Array.from({ length: 1024 }, (_, i) => (i === t.length % 1024 ? 1 : 0))) };
              },
            },
          },
  },
};

const worker = createEmberWorker(aiConfig); // also makes aiConfig the config of shards constructed from here on
afterAll(() => setEmberConfig(baseConfig));

let n = 0;
const newShard = () => `notes:t${Date.now()}-${n++}`;
const stub = (s: string) => shardStub(s) as unknown as ShardApi & ReturnType<typeof shardStub>;
const runner = () => new ActionRunner(aiConfig, env as any, (s) => stub(s));
const mutate = async (shard: string, fn: string, args: unknown) => {
  const out = await stub(shard).mutation(shard, fn, args, null, true);
  if (!out.ok) throw new Error(`${fn}: ${out.error.code} ${out.error.message}`);
  return out.value as string;
};
/** Runs the captured queue messages through the Worker's consumer; returns acked / retried counts. */
async function consume(attempts = 1) {
  const msgs = fake.queue.splice(0);
  const r = { acked: 0, retried: 0 };
  await worker.queue(
    {
      queue: "ember-test-indexing",
      messages: msgs.map((body, i) => ({ id: String(i), timestamp: new Date(), attempts, body, ack: () => void r.acked++, retry: () => void r.retried++ })),
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<IndexMessage>,
    env as any,
    {} as ExecutionContext,
  );
  return r;
}
async function until<T>(f: () => Promise<T> | T, ok: (x: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const x = await f();
    if (ok(x) || Date.now() > end) return x;
    await sleep(20);
  }
}

beforeEach(() => {
  fake.mode = "service";
  fake.queue.length = 0;
  fake.vectors.clear();
  fake.queries.length = 0;
  fake.items.clear();
  fake.searches.length = 0;
  fake.ai.length = 0;
  fake.failUpserts = 0;
});

describe("outbox → queue → consumer → Vectorize / AI Search", () => {
  it("delivers inserts, embeds text with Workers AI, uploads AI Search items under the shard folder", async () => {
    const shard = newShard();
    const id = await mutate(shard, "notes:add", { title: "Reembolso", body: "dinheiro de volta", lang: "pt", stars: 4, vec: P(1, 0, 0) });
    const msgs = await until(() => fake.queue, (q) => q.length >= 3);
    expect(msgs.map((m) => `${m.table}.${m.index}:${m.ids.join(",")}`).sort()).toEqual([`notes.by_vec:${id}`, `notes.hybrid:${id}`, `notes.semantic:${id}`]);
    expect(msgs.every((m) => m.t === "ember.index" && m.shard === shard)).toBe(true);
    expect((await stub(shard).inspect()).outbox).toEqual({ pending: 0, inFlight: 3, parked: 0 });

    expect(await consume()).toEqual({ acked: 3, retried: 0 });
    expect(fake.vectors.get("EMBER_VEC__notes__by_vec")!.get(id)).toEqual({ id, values: P(1, 0, 0), namespace: vectorNamespace(shard), metadata: { lang: "pt" } });
    expect(fake.vectors.get("EMBER_VEC__notes__semantic")!.get(id)!.metadata).toEqual({ stars: 4 });
    expect(fake.ai).toEqual([{ model: "@cf/baai/bge-m3", input: { text: ["Reembolso"] } }]);
    // Upload metadata is strings (the Items API type; AI Search casts to each field's data_type when indexing).
    expect(fake.items.get(aiSearchItemKey(shard, id))).toMatchObject({ text: "## title\n\nReembolso\n\n## body\n\ndinheiro de volta\n", metadata: { lang: "pt", stars: "4" } });
    expect((await stub(shard).inspect()).outbox).toEqual({ pending: 0, inFlight: 0, parked: 0 });
  });

  it("a write while a delivery is in flight is delivered again (never an older state last)", async () => {
    const shard = newShard();
    const id = await mutate(shard, "notes:add", { title: "a", body: "b", lang: "pt", stars: 1, vec: P(1, 0, 0) });
    await until(() => fake.queue, (q) => q.length >= 3);
    const first = fake.queue.splice(0);
    // Consumer of `first` has not run yet; the document changes twice.
    await mutate(shard, "notes:patch", { id, fields: { vec: P(0, 1, 0) } });
    await mutate(shard, "notes:patch", { id, fields: { vec: P(0, 0, 1), lang: "en" } });
    await sleep(50);
    expect(fake.queue).toEqual([]); // no second delivery while one is in flight (until resendMs)
    fake.queue.push(...first);
    await consume(); // the consumer reads the state current when it runs
    expect(fake.vectors.get("EMBER_VEC__notes__by_vec")!.get(id)).toMatchObject({ values: P(0, 0, 1), metadata: { lang: "en" } });
    await until(async () => (await stub(shard).inspect()).outbox, (o) => o.pending + o.inFlight === 0);
    expect(fake.queue).toEqual([]);

    // A write between the consumer's read and its ack: the ack keeps the row, which is sent again.
    await mutate(shard, "notes:patch", { id, fields: { vec: P(1, 1, 1) } });
    const pending = await until(() => fake.queue, (q) => q.some((m) => m.index === "by_vec"));
    const claim = pending.find((m) => m.index === "by_vec")!.claim!;
    expect(typeof claim).toBe("number");
    fake.queue.length = 0;
    const read = await (stub(shard) as unknown as ShardApi).extFetch(shard, "notes", "by_vec", [id], claim);
    await mutate(shard, "notes:patch", { id, fields: { vec: P(2, 2, 2) } });
    expect(await stub(shard).extAck(shard, "notes", "by_vec", read.items, claim)).toBe(1);
    const again = await until(() => fake.queue, (q) => q.some((m) => m.index === "by_vec"));
    expect(again.find((m) => m.index === "by_vec")!.ids).toEqual([id]);
    await consume();
    expect(fake.vectors.get("EMBER_VEC__notes__by_vec")!.get(id)!.values).toEqual(P(2, 2, 2));
    await until(async () => (await stub(shard).inspect()).outbox, (o) => o.pending + o.inFlight === 0);
    expect((await stub(shard).inspect()).outbox).toEqual({ pending: 0, inFlight: 0, parked: 0 });
  });

  it("deletes remove the vector and the AI Search item; a failing service is retried by the queue", async () => {
    const shard = newShard();
    const id = await mutate(shard, "notes:add", { title: "x", body: "y", lang: "pt", stars: 1, vec: P(1, 1, 0) });
    const sent = [...(await until(() => fake.queue, (q) => q.length >= 3))];
    fake.failUpserts = 1;
    const r1 = await consume();
    expect(r1.retried).toBe(1); // by_vec failed; the queue redelivers the same message
    expect((await stub(shard).inspect()).outbox.inFlight).toBe(1);
    await mutate(shard, "notes:remove", { id });
    await sleep(30);
    // Redelivery of the failed message: the document is gone now, so it becomes a delete.
    fake.queue.push(sent.find((m) => m.index === "by_vec")!);
    await until(() => fake.queue, (q) => q.length >= 3); // hybrid + semantic deletes from the outbox
    await consume();
    await until(async () => (await stub(shard).inspect()).outbox, (o) => o.pending + o.inFlight === 0);
    expect(fake.vectors.get("EMBER_VEC__notes__by_vec")!.has(id)).toBe(false);
    expect(fake.vectors.get("EMBER_VEC__notes__semantic")!.has(id)).toBe(false);
    expect(fake.items.has(aiSearchItemKey(shard, id))).toBe(false);
  });

  it("a superseded or pre-fencing message writes nothing (the current delivery owns the document)", async () => {
    const shard = newShard();
    const id = await mutate(shard, "notes:add", { title: "a", body: "b", lang: "pt", stars: 1, vec: P(1, 0, 0) });
    const sent = [...(await until(() => fake.queue, (q) => q.length >= 3))];
    fake.queue.length = 0;
    const real = sent.find((m) => m.index === "by_vec")!;
    fake.queue.push({ ...real, claim: real.claim! + 1 }, { t: "ember.index", shard, table: "notes", index: "by_vec", ids: [id] });
    expect(await consume()).toEqual({ acked: 2, retried: 0 });
    expect(fake.vectors.get("EMBER_VEC__notes__by_vec")?.has(id) ?? false).toBe(false);
    expect((await stub(shard).inspect()).outbox).toEqual({ pending: 0, inFlight: 3, parked: 0 });
    fake.queue.push(...sent);
    await consume();
    expect(fake.vectors.get("EMBER_VEC__notes__by_vec")!.get(id)!.values).toEqual(P(1, 0, 0));
    expect((await stub(shard).inspect()).outbox).toEqual({ pending: 0, inFlight: 0, parked: 0 });
    // A duplicate of an acknowledged message (queues are at-least-once) is a no-op too.
    fake.queue.push(real);
    await consume();
    await sleep(30);
    expect(fake.queue).toEqual([]);
    expect((await stub(shard).inspect()).outbox).toEqual({ pending: 0, inFlight: 0, parked: 0 });
  });

  it("a redelivered message whose documents were re-sent meanwhile fences its earlier write (one more delivery)", async () => {
    const shard = newShard();
    const id = await mutate(shard, "notes:add", { title: "a", body: "b", lang: "pt", stars: 1, vec: P(1, 0, 0) });
    const sent = [...(await until(() => fake.queue, (q) => q.length >= 3))];
    fake.queue.length = 0;
    const real = sent.find((m) => m.index === "by_vec")!;
    fake.queue.push(...sent);
    await consume();
    expect((await stub(shard).inspect()).outbox).toEqual({ pending: 0, inFlight: 0, parked: 0 });
    // The queue redelivers the same message (its first attempt may have written, then failed before its ack, while
    // another delivery took over): the old write may be the last one, so the document is delivered once more.
    fake.queue.push(real);
    expect(await consume(2)).toEqual({ acked: 1, retried: 0 });
    const again = await until(() => fake.queue, (q) => q.some((m) => m.index === "by_vec"));
    expect(again.find((m) => m.index === "by_vec")!.ids).toEqual([id]);
    await consume();
    await until(async () => (await stub(shard).inspect()).outbox, (o) => o.pending + o.inFlight === 0);
    expect(fake.vectors.get("EMBER_VEC__notes__by_vec")!.get(id)!.values).toEqual(P(1, 0, 0));
  });

  it("a message for an index that no longer exists is acknowledged, not retried forever", async () => {
    const shard = newShard();
    fake.queue.push({ t: "ember.index", shard, table: "notes", index: "gone", ids: ["notes_x"] });
    fake.queue.push({ t: "ember.index", shard, table: "nope", index: "by_vec", ids: ["nope_x"] });
    expect(await consume()).toEqual({ acked: 2, retried: 0 });
  });

  it("ctx.vectorSearch / ctx.aiSearch query the shard's namespace / folder with filters", async () => {
    const shard = newShard();
    const a = await mutate(shard, "notes:add", { title: "entrega atrasada", body: "chuva na estrada", lang: "pt", stars: 2, vec: P(1, 0, 0) });
    const b = await mutate(shard, "notes:add", { title: "refund", body: "money back", lang: "en", stars: 5, vec: P(0.9, 0.1, 0) });
    const other = newShard();
    await mutate(other, "notes:add", { title: "entrega", body: "outro shard", lang: "pt", stars: 2, vec: P(1, 0, 0) });
    await until(() => fake.queue, (q) => q.length >= 6);
    await consume();
    const ctx = runner().ctx(shard, null);
    const hits = await ctx.vectorSearch("notes", "by_vec", { vector: P(1, 0, 0), limit: 5 });
    expect(hits.map((h) => h._id)).toEqual([a, b]);
    expect(fake.queries.at(-1)!.opts).toMatchObject({ topK: 5, namespace: vectorNamespace(shard), returnMetadata: "none" });
    await ctx.vectorSearch("notes", "by_vec", { vector: P(1, 0, 0), filter: { lang: { $in: ["en"] } } });
    expect(fake.queries.at(-1)!.opts.filter).toEqual({ lang: { $in: ["en"] } });
    await expect(ctx.vectorSearch("notes", "by_vec", { vector: [1, 0] })).rejects.toThrow(/32 finite numbers/);
    await expect(ctx.vectorSearch("notes", "by_vec", { text: "x" } as any)).rejects.toThrow(/needs an index with embed/);
    await expect(ctx.vectorSearch("notes", "by_vec", { vector: P(1, 0, 0), filter: { title: "x" } } as any)).rejects.toThrow(/not a filter field/);
    // embed: the query text is embedded with the same model (role "query").
    await ctx.vectorSearch("notes", "semantic", { text: "devolução", filter: { stars: { $gte: 3 } } });
    expect(fake.ai.at(-1)).toEqual({ model: "@cf/baai/bge-m3", input: { text: ["devolução"] } });

    const found = await ctx.aiSearch("notes", "hybrid", { query: "entrega chuva", limit: 3 });
    expect(found.map((x) => x._id)).toEqual([a]);
    expect(found[0]!.text).toMatch(/entrega|chuva/);
    const req = fake.searches.at(-1) as any;
    expect(req.ai_search_options.cache).toEqual({ enabled: false });
    expect(req.ai_search_options.retrieval).toMatchObject({ retrieval_type: "hybrid", keyword_match_mode: "or", max_num_results: 6, filters: { folder: aiSearchFolder(shard) } });
    expect(await ctx.aiSearch("notes", "hybrid", { query: "refund", filter: { lang: "pt" } })).toEqual([]);
    // Query filters stay typed (number fields compare numerically on AI Search's side).
    await ctx.aiSearch("notes", "hybrid", { query: "refund", filter: { stars: { $gte: 3 } } });
    expect((fake.searches.at(-1) as any).ai_search_options.retrieval.filters).toEqual({ folder: aiSearchFolder(shard), stars: { $gte: 3 } });
    await ctx.aiSearch("notes", "hybrid", { query: "x", mode: "hybrid", fusion: "max" });
    expect((fake.searches.at(-1) as any).ai_search_options.retrieval).toMatchObject({ retrieval_type: "hybrid", fusion_method: "max" });
    await expect(ctx.aiSearch("notes", "hybrid", { query: "x", fusion: "avg" } as any)).rejects.toThrow(/fusion must be rrf or max/);
    // Typed action through the runner (as a client would call it).
    const out = await runner().run("notes:find", { vector: P(0, 0, 1) }, shard, null);
    expect(out.ok).toBe(true);
  });

  it('shardIsolation "filter": vectors carry the shard as `_shard` metadata (no namespace) and searches filter on it', async () => {
    const a = newShard();
    const b = newShard();
    const ia = await mutate(a, "notes:wide", { lang: "pt", vec: P(1, 0, 0) });
    const ib = await mutate(b, "notes:wide", { lang: "pt", vec: P(1, 0, 0) });
    await until(() => fake.queue, (q) => q.length >= 2);
    expect(await consume()).toEqual({ acked: 2, retried: 0 });
    const stored = fake.vectors.get("EMBER_VEC__wide__by_vec")!;
    expect(stored.get(ia)).toMatchObject({ metadata: { lang: "pt", _shard: vectorNamespace(a) } });
    expect(stored.get(ia)!.namespace).toBeUndefined();
    expect(stored.get(ib)!.metadata).toMatchObject({ _shard: vectorNamespace(b) });
    const ctx = runner().ctx(a, null);
    expect((await ctx.vectorSearch("wide", "by_vec", { vector: P(1, 0, 0) })).map((h) => h._id)).toEqual([ia]);
    expect(fake.queries.at(-1)!.opts).toMatchObject({ filter: { _shard: { $eq: vectorNamespace(a) } } });
    expect(fake.queries.at(-1)!.opts.namespace).toBeUndefined();
    // User filters are kept next to the shard filter; another shard is reachable with `shard`.
    await ctx.vectorSearch("wide", "by_vec", { vector: P(1, 0, 0), filter: { lang: "pt" }, shard: b });
    expect(fake.queries.at(-1)!.opts.filter).toEqual({ lang: "pt", _shard: { $eq: vectorNamespace(b) } });
  });

  it("aiSearchIndex defaultMode applies when a search passes no mode", async () => {
    const ctx = runner().ctx(newShard(), null);
    await ctx.aiSearch("faq", "kb", { query: "reembolso" });
    expect((fake.searches.at(-1) as any).ai_search_options.retrieval.retrieval_type).toBe("vector");
    await ctx.aiSearch("faq", "kb", { query: "reembolso", mode: "hybrid" });
    expect((fake.searches.at(-1) as any).ai_search_options.retrieval.retrieval_type).toBe("hybrid");
    await ctx.aiSearch("notes", "hybrid", { query: "x" });
    expect((fake.searches.at(-1) as any).ai_search_options.retrieval.retrieval_type).toBe("hybrid");
  });

  it("a missing binding is an explicit error, never a silent fallback", async () => {
    const shard = newShard();
    const ctx = new ActionRunner({ ...aiConfig, externalIndexes: { env: () => ({}) } }, env as any, (s) => stub(s)).ctx(shard, null);
    await expect(ctx.vectorSearch("notes", "by_vec", { vector: P(1, 0, 0) })).rejects.toThrow(/no EMBER_VEC__notes__by_vec binding.*EMBER_AI_INDEXES=local/);
    await expect(ctx.aiSearch("notes", "hybrid", { query: "x" })).rejects.toThrow(/no EMBER_AIS__notes__hybrid binding/);
  });
});

describe("local fallback (EMBER_AI_INDEXES=local, no queue: delivered in the shard's turn)", () => {
  it("brute-force vectors, hash embeddings and BM25 text search, kept in sync with writes", async () => {
    fake.mode = "local";
    const shard = newShard();
    const a = await mutate(shard, "notes:add", { title: "reembolso da compra", body: "o dinheiro volta em 10 dias", lang: "pt", stars: 4, vec: P(1, 0, 0) });
    const b = await mutate(shard, "notes:add", { title: "entrega atrasada", body: "a chuva atrasou a encomenda", lang: "pt", stars: 2, vec: P(0, 1, 0) });
    const c = await mutate(shard, "notes:add", { title: "refund", body: "money back", lang: "en", stars: 5, vec: P(0.8, 0.2, 0) });
    await until(async () => (await stub(shard).inspect()).outbox, (o) => o.pending + o.inFlight === 0);
    const ctx = runner().ctx(shard, null);
    expect((await ctx.vectorSearch("notes", "by_vec", { vector: P(1, 0, 0) })).map((h) => h._id)).toEqual([a, c, b]);
    expect((await ctx.vectorSearch("notes", "by_vec", { vector: P(1, 0, 0), filter: { lang: "pt" } })).map((h) => h._id)).toEqual([a, b]);
    const top = await ctx.vectorSearch("notes", "by_vec", { vector: P(1, 0, 0), limit: 1 });
    expect(top).toHaveLength(1);
    expect(top[0]!._score).toBeCloseTo(1);
    // embed without EMBER_AI: hash embeddings (shared words only).
    expect((await ctx.vectorSearch("notes", "semantic", { text: "entrega", limit: 1 }))[0]!._id).toBe(b);
    expect((await ctx.vectorSearch("notes", "semantic", { text: "entrega", filter: { stars: { $gte: 4 } } })).map((h) => h._id)).not.toContain(b);
    const s = await ctx.aiSearch("notes", "hybrid", { query: "chuva na encomenda" });
    expect(s[0]).toMatchObject({ _id: b, _score: 1 });
    expect(s[0]!.text).toContain("chuva");
    // Writes follow: patch moves a vector, delete removes it.
    await mutate(shard, "notes:patch", { id: b, fields: { vec: P(1, 0, 0), lang: "en" } });
    await mutate(shard, "notes:remove", { id: a });
    await until(async () => (await stub(shard).inspect()).outbox, (o) => o.pending + o.inFlight === 0);
    expect((await ctx.vectorSearch("notes", "by_vec", { vector: P(1, 0, 0) })).map((h) => h._id)).toEqual([b, c]);
    expect((await ctx.aiSearch("notes", "hybrid", { query: "reembolso" })).map((h) => h._id)).toEqual([]);
    // Another shard sees nothing of this one (namespace = shard).
    expect(await runner().ctx(newShard(), null).vectorSearch("notes", "by_vec", { vector: P(1, 0, 0) })).toEqual([]);
  });
});
