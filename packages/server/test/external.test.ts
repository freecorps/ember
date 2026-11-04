// External index kinds (PLAN §6): `.vectorIndex()` / `.aiSearchIndex()` parse, the outbox written in the mutation
// transaction (coalescing, field-change detection, staged backfill), delivery bookkeeping (claim / fetch / ack,
// re-send, parking), filters and the local-fallback math. The services themselves are exercised in the runtime
// (workerd) tests with fake bindings.

import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  aiSearchConfig,
  betterScore,
  createEngine,
  defineSchema,
  defineTable,
  externalIndexes,
  hashEmbedding,
  matchesFilter,
  mutationGeneric,
  normalizeFilter,
  outboxAck,
  outboxClaim,
  outboxFetch,
  outboxNextAt,
  outboxStats,
  prepareLocalDatabase,
  vectorConfig,
  vectorScore,
  v,
  type ActionCtx,
  type DataModelFromSchema,
  type MutationCtx,
} from "../src/index.ts";

const docFields = {
  shop: v.string(),
  title: v.string(),
  body: v.optional(v.string()),
  embedding: v.optional(v.array(v.number())),
  lang: v.string(),
  stars: v.number(),
  meta: v.optional(v.object({ public: v.boolean() })),
};
const schema = defineSchema({
  shards: {},
  tables: {
    docs: defineTable(docFields)
      .index("by_shop", ["shop"])
      .vectorIndex("by_vec", { vectorField: "embedding", dimensions: 32, filterFields: ["lang", "meta.public"] })
      .vectorIndex("semantic", { embed: "title", filterFields: ["stars"] })
      .aiSearchIndex("hybrid", { fields: ["title", "body"], filterFields: ["lang", "stars"] }),
  },
});

const P = (...x: number[]) => [...x, ...new Array<number>(32 - x.length).fill(0)];

function fresh(s = schema) {
  const driver = createNodeSqliteDriver();
  let clock = 1_700_000_000_000;
  const engine = createEngine({ schema: s, driver, now: () => (clock += 1) });
  engine.migrate();
  const tx = <R>(fn: (db: any) => R) => engine.runMutation(mutationGeneric({ handler: (ctx: MutationCtx) => fn(ctx.db) as any }) as any, {}).value as R;
  const outbox = () => driver.exec(`SELECT "tbl", "idx", "doc_id", "sent" FROM "_ember_ext_outbox" ORDER BY "idx", "doc_id"`).rows;
  return { driver, engine, tx, outbox };
}

describe("parse", () => {
  test("stores config, dimensions from the embedding model, metadata keys and types", () => {
    const t = schema.manifest.tables.docs!;
    const vec = t.indexes.find((i) => i.name === "by_vec")!;
    expect(vec.kind).toBe("vector");
    expect(vec.fields).toEqual(["embedding", "lang", "meta.public"]);
    expect(vectorConfig(vec)).toEqual({
      vectorField: "embedding",
      embed: null,
      dimensions: 32,
      metric: "cosine",
      filterFields: ["lang", "meta.public"],
      metadata: { lang: { key: "lang", type: "string" }, "meta.public": { key: "meta_public", type: "boolean" } },
    });
    const sem = vectorConfig(t.indexes.find((i) => i.name === "semantic")!);
    expect(sem.embed).toEqual({ field: "title", model: "@cf/baai/bge-m3" });
    expect(sem.dimensions).toBe(1024);
    const ais = t.indexes.find((i) => i.name === "hybrid")!;
    expect(ais.kind).toBe("aiSearch");
    expect(aiSearchConfig(ais).metadata).toEqual({ lang: { key: "lang", type: "string" }, stars: { key: "stars", type: "number" } });
    expect(externalIndexes(schema.manifest, schema.indexKinds).map((x) => `${x.table}.${x.spec.name}:${x.kind.external.service}`)).toEqual([
      "docs.by_vec:vectorize",
      "docs.semantic:vectorize",
      "docs.hybrid:aiSearch",
    ]);
  });

  test.each([
    [{ dimensions: 32 }, /exactly one of vectorField or embed/],
    [{ vectorField: "title", dimensions: 32 }, /must be v.array\(v.number\(\)\)/],
    [{ vectorField: "embedding" }, /dimensions must be an integer/],
    [{ vectorField: "embedding", dimensions: 4000 }, /between 32 and 1536/],
    [{ vectorField: "embedding", dimensions: 3 }, /between 32 and 1536/],
    [{ embed: "stars" }, /must be a string field/],
    [{ embed: { field: "title", model: "@cf/baai/bge-m3" }, dimensions: 768 }, /produces 1024 dimensions/],
    [{ embed: { field: "title", model: "@cf/x/unknown" } }, /set dimensions/],
    [{ vectorField: "embedding", dimensions: 32, metric: "manhattan" }, /unknown metric/],
    [{ vectorField: "embedding", dimensions: 32, filterFields: ["embedding"] }, /must be a string, number, boolean or id/],
    [{ vectorField: "embedding", dimensions: 32, filterFields: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] }, /at most 10/],
  ])("vectorIndex rejects %j", (cfg, err) => {
    expect(() => defineSchema({ docs: (defineTable(docFields) as any).vectorIndex("x", cfg) })).toThrow(err);
  });

  test("aiSearchIndex limits: string fields, 5 filter fields, reserved names", () => {
    const def = (cfg: unknown) => defineSchema({ t: (defineTable({ a: v.string(), n: v.number(), folder: v.string(), b: v.string(), c: v.string(), d: v.string(), e: v.string() }) as any).aiSearchIndex("x", cfg) });
    expect(() => def({ fields: [] })).toThrow(/at least one/);
    expect(() => def({ fields: ["n"] })).toThrow(/must be a string field/);
    expect(() => def({ fields: ["a"], filterFields: ["folder"] })).toThrow(/reserved/);
    expect(() => def({ fields: ["a"], filterFields: ["a", "b", "c", "d", "e", "n"] })).toThrow(/at most 5/);
    expect(() => def({ fields: ["a"], filterFields: ["a", "b", "c", "d", "n"] })).not.toThrow();
  });

  test("documents: vectors, embed text, markdown, metadata; null when not indexable", () => {
    const t = schema.manifest.tables.docs!;
    const kinds = schema.indexKinds;
    const doc = { _id: "docs_1", _creationTime: 1, shop: "s", title: "Olá", body: "corpo", embedding: P(1, 2, 3), lang: "pt", stars: 4, meta: { public: true } };
    const ext = (name: string) => {
      const spec = t.indexes.find((i) => i.name === name)!;
      return kinds.get(spec.kind)!.external!.document(spec, doc as any);
    };
    expect(ext("by_vec")).toEqual({ values: P(1, 2, 3), metadata: { lang: "pt", meta_public: true } });
    expect(ext("semantic")).toEqual({ text: "Olá", metadata: { stars: 4 } });
    expect(ext("hybrid")).toEqual({ text: "## title\n\nOlá\n\n## body\n\ncorpo\n", metadata: { lang: "pt", stars: 4 } });
    const spec = t.indexes.find((i) => i.name === "by_vec")!;
    expect(kinds.get("vector")!.external!.document(spec, { ...doc, embedding: [1, 2] } as any)).toBeNull();
  });
});

describe("outbox", () => {
  test("written in the mutation: inserts, relevant patches, deletes; coalesced per document", () => {
    const { tx, outbox, driver } = fresh();
    const id = tx((db) => db.insert("docs", { shop: "a", title: "t", embedding: P(1, 0, 0), lang: "pt", stars: 1 }));
    expect(outbox().map((r) => r.idx)).toEqual(["by_vec", "hybrid", "semantic"]);
    driver.exec(`DELETE FROM "_ember_ext_outbox"`);
    tx((db) => db.patch(id, { shop: "b" })); // no indexed field
    expect(outbox()).toEqual([]);
    tx((db) => db.patch(id, { stars: 2 })); // filter field of semantic + hybrid
    expect(outbox().map((r) => r.idx)).toEqual(["hybrid", "semantic"]);
    tx((db) => db.patch(id, { stars: 3 }));
    expect(outbox()).toHaveLength(2); // coalesced
    tx((db) => db.patch(id, { meta: { public: true } })); // nested filter field of by_vec
    expect(outbox().map((r) => r.idx)).toEqual(["by_vec", "hybrid", "semantic"]);
    driver.exec(`DELETE FROM "_ember_ext_outbox"`);
    tx((db) => db.delete(id));
    expect(outbox()).toHaveLength(3);
  });

  test("a failed mutation writes nothing", () => {
    const { engine, outbox } = fresh();
    expect(() =>
      engine.runMutation(
        mutationGeneric({
          handler: (ctx: MutationCtx): null => {
            ctx.db.insert("docs", { shop: "a", title: "t", lang: "pt", stars: 1 } as any);
            throw new Error("boom");
          },
        }) as any,
        {},
      ),
    ).toThrow("boom");
    expect(outbox()).toEqual([]);
  });

  test("claim → fetch → ack; a write while in flight is delivered again; deletes fetch as null", () => {
    const { tx, driver, engine } = fresh();
    const m = engine.manifest;
    const kinds = schema.indexKinds;
    const a = tx((db) => db.insert("docs", { shop: "a", title: "one", embedding: P(1, 0, 0), lang: "pt", stars: 1 }));
    const b = tx((db) => db.insert("docs", { shop: "a", title: "two", embedding: P(0, 1, 0), lang: "en", stars: 2 }));
    expect(outboxNextAt(driver, 1000)).toBe(1000);
    const now = 1_000_000;
    const { batches } = driver.transaction(() => outboxClaim(driver, m, kinds, now));
    expect(batches.map((x) => `${x.index}:${x.ids.length}`).sort()).toEqual(["by_vec:2", "hybrid:2", "semantic:2"]);
    expect(outboxStats(driver)).toEqual({ pending: 0, inFlight: 6, parked: 0 });
    // Nothing more to claim while in flight; the next attention is the re-send time.
    expect(outboxClaim(driver, m, kinds, now + 1).batches).toEqual([]);
    expect(outboxNextAt(driver, now + 1)).toBe(now + 10 * 60_000);

    const vec = batches.find((x) => x.index === "by_vec")!;
    const fetched = outboxFetch(driver, m, kinds, "docs", "by_vec", vec.ids);
    expect(fetched.items.map((i) => i.doc?.values)).toEqual([P(1, 0, 0), P(0, 1, 0)]);
    // `a` changes after the consumer read it: its ack must not drop the row.
    tx((db) => db.patch(a, { embedding: P(0, 0, 1) }));
    tx((db) => db.delete(b));
    expect(outboxAck(driver, "docs", "by_vec", fetched.items)).toBe(2);
    const again = outboxClaim(driver, m, kinds, now + 2).batches.find((x) => x.index === "by_vec")!;
    expect(again.ids.sort()).toEqual([a, b].sort());
    const f2 = outboxFetch(driver, m, kinds, "docs", "by_vec", again.ids);
    expect(Object.fromEntries(f2.items.map((i) => [i.id, i.doc?.values ?? null]))).toEqual({ [a]: P(0, 0, 1), [b]: null });
    outboxAck(driver, "docs", "by_vec", f2.items);
    expect(driver.exec(`SELECT count(*) AS n FROM "_ember_ext_outbox" WHERE "idx" = 'by_vec'`).rows[0]!.n).toBe(0);
  });

  test("unacknowledged rows are re-sent after resendMs and parked after maxAttempts; a new write revives them", () => {
    const { tx, driver, engine } = fresh();
    const id = tx((db) => db.insert("docs", { shop: "a", title: "x", embedding: P(1, 1, 1), lang: "pt", stars: 1 }));
    const o = { resendMs: 100, maxAttempts: 3 };
    let t = 0;
    const claim = () => outboxClaim(driver, engine.manifest, schema.indexKinds, (t += 101), o);
    expect(claim().batches).toHaveLength(3);
    expect(claim().batches).toHaveLength(3);
    expect(claim().batches).toHaveLength(3);
    const r = claim();
    expect(r.batches).toHaveLength(0);
    expect(r.parked).toHaveLength(3);
    expect(outboxStats(driver)).toEqual({ pending: 0, inFlight: 0, parked: 3 });
    expect(outboxNextAt(driver, t)).toBeNull();
    tx((db) => db.patch(id, { stars: 5 }));
    expect(outboxStats(driver).pending).toBe(2); // semantic + hybrid revived; by_vec stays parked
  });

  test("rows of an index removed from the schema are dropped on claim", () => {
    const { tx, driver } = fresh();
    tx((db) => db.insert("docs", { shop: "a", title: "x", embedding: P(1, 1, 1), lang: "pt", stars: 1 }));
    const other = defineSchema({ shards: {}, tables: { docs: defineTable(docFields).vectorIndex("by_vec", { vectorField: "embedding", dimensions: 32, filterFields: ["lang", "meta.public"] }) } });
    const { batches } = outboxClaim(driver, other.manifest, other.indexKinds, 1);
    expect(batches.map((b) => b.index)).toEqual(["by_vec"]);
    expect(outboxStats(driver)).toEqual({ pending: 0, inFlight: 1, parked: 0 });
  });

  test("a new external index on a table with data is staged and backfilled through the outbox", () => {
    const base = defineSchema({ shards: {}, tables: { docs: defineTable(docFields).index("by_shop", ["shop"]) } });
    const driver = createNodeSqliteDriver();
    const e1 = createEngine({ schema: base, driver });
    e1.migrate();
    for (let i = 0; i < 7; i++) e1.runMutation(mutationGeneric({ handler: (ctx: MutationCtx) => ctx.db.insert("docs", { shop: "a", title: `t${i}`, lang: "pt", stars: i } as any) }) as any, {});
    const e2 = createEngine({ schema, driver });
    const report = e2.migrate();
    expect(report.staged.map((s) => s.index).sort()).toEqual(["by_vec", "hybrid", "semantic"]);
    // A live write to a row inside the window is left to the backfill (no double entry, no gap).
    e2.runMutation(mutationGeneric({ handler: (ctx: MutationCtx) => ctx.db.insert("docs", { shop: "b", title: "new", lang: "en", stars: 9 } as any) }) as any, {});
    expect(outboxStats(driver).pending).toBe(3);
    let p;
    do p = e2.backfillStep(3);
    while (!p.done);
    expect(outboxStats(driver).pending).toBe(3 * 8);
  });

  test("local replicas (offline) never fill the outbox", () => {
    const driver = createNodeSqliteDriver();
    prepareLocalDatabase(driver, schema);
    expect(driver.exec(`SELECT count(*) AS n FROM "_ember_ext_outbox"`).rows[0]!.n).toBe(0);
  });
});

describe("filters and local fallback", () => {
  const allowed = { lang: "lang", "meta.public": "meta_public", stars: "stars" };
  test("normalizeFilter maps fields to metadata keys and validates operators", () => {
    expect(normalizeFilter({ lang: "pt", "meta.public": true, stars: { $gte: 2, $lt: 5 } }, allowed, "q")).toEqual({ lang: "pt", meta_public: true, stars: { $gte: 2, $lt: 5 } });
    expect(() => normalizeFilter({ title: "x" }, allowed, "q")).toThrow(/not a filter field/);
    expect(() => normalizeFilter({ lang: { $like: "x" } }, allowed, "q")).toThrow(/unknown operator/);
    expect(() => normalizeFilter({ lang: { $in: "x" } }, allowed, "q")).toThrow(/needs an array/);
    expect(() => normalizeFilter({ lang: [1] }, allowed, "q")).toThrow(/strings, numbers or booleans/);
  });

  test("matchesFilter has Vectorize semantics", () => {
    const m = { lang: "pt", stars: 3, meta_public: true };
    expect(matchesFilter(m, { lang: "pt" })).toBe(true);
    expect(matchesFilter(m, { lang: { $ne: "pt" } })).toBe(false);
    expect(matchesFilter(m, { lang: { $in: ["en", "pt"] }, stars: { $gt: 2, $lte: 3 } })).toBe(true);
    expect(matchesFilter(m, { stars: { $nin: [3] } })).toBe(false);
    expect(matchesFilter(m, { missing: "x" } as any)).toBe(false);
    expect(matchesFilter(m, { stars: "3" })).toBe(false); // no type coercion
  });

  test("scores and order per metric", () => {
    expect(vectorScore("cosine", [1, 0], [1, 0])).toBeCloseTo(1);
    expect(vectorScore("cosine", [1, 0], [0, 1])).toBeCloseTo(0);
    expect(vectorScore("euclidean", [0, 0], [3, 4])).toBeCloseTo(5);
    expect(vectorScore("dot-product", [1, 2], [3, 4])).toBe(11);
    expect([0.1, 0.9, 0.5].sort(betterScore("cosine"))).toEqual([0.9, 0.5, 0.1]);
    expect([0.1, 0.9, 0.5].sort(betterScore("euclidean"))).toEqual([0.1, 0.5, 0.9]);
  });

  test("hashEmbedding: deterministic, normalized, accent-insensitive, shared words score higher", () => {
    const a = hashEmbedding("Reembolso da compra", 64);
    expect(a).toEqual(hashEmbedding("reembolso da COMPRA", 64));
    expect(Math.hypot(...a)).toBeCloseTo(1);
    expect(hashEmbedding("ação", 16)).toEqual(hashEmbedding("acao", 16));
    expect(vectorScore("cosine", a, hashEmbedding("reembolso", 64))).toBeGreaterThan(vectorScore("cosine", a, hashEmbedding("entrega atrasada", 64)));
  });
});

describe("typing", () => {
  type DM = DataModelFromSchema<typeof schema>;
  test("ctx.vectorSearch / ctx.aiSearch are typed by table, index, filter fields and embed", () => {
    const check = async (ctx: ActionCtx<DM>) => {
      const r = await ctx.vectorSearch("docs", "by_vec", { vector: [1, 2, 3], limit: 5, filter: { lang: "pt", "meta.public": true } });
      const id: string = r[0]!._id;
      const score: number = r[0]!._score;
      await ctx.vectorSearch("docs", "semantic", { text: "olá", filter: { stars: { $gte: 3 } } });
      // @ts-expect-error by_vec has no embed: text queries are not allowed
      await ctx.vectorSearch("docs", "by_vec", { text: "x" });
      // @ts-expect-error unknown index
      await ctx.vectorSearch("docs", "nope", { vector: [] });
      // @ts-expect-error title is not a filter field
      await ctx.vectorSearch("docs", "by_vec", { vector: [1], filter: { title: "x" } });
      const s = await ctx.aiSearch("docs", "hybrid", { query: "reembolso", filter: { stars: { $gt: 1 } }, mode: "hybrid" });
      const text: string = s[0]!.text;
      // @ts-expect-error filter value type follows the field
      await ctx.aiSearch("docs", "hybrid", { query: "x", filter: { lang: 1 } });
      return [id, score, text];
    };
    // Untyped ctx (no codegen): any table / index name.
    const untyped = async (ctx: ActionCtx) => [await ctx.vectorSearch("t", "anything", { vector: [1] }), await ctx.aiSearch("t", "x", { query: "q" })];
    expect(typeof check).toBe("function");
    expect(typeof untyped).toBe("function");
  });
});
