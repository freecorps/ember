// External indexes in the runtime (PLAN §6): delivering the shard outbox to Vectorize / AI Search, and the
// action-side searches `ctx.vectorSearch` / `ctx.aiSearch`.
//
//   mutation ──(same transaction)──► _ember_ext_outbox ──► Queue EMBER_INDEXING ──► Worker queue() ──► indexer
//                                                       └─(no queue: dev, tests)──► indexer in the shard's turn
//   indexer: extFetch (current state, from the shard) → [Workers AI embed] → Vectorize upsert/delete or AI Search
//            items.upload/delete → extAck (the shard deletes the outbox rows, or re-sends rows written meanwhile)
//   Every message carries the claim token of its outbox rows: a delivery superseded by a re-send skips documents
//   it no longer owns, and a superseded ack re-enqueues them (fencing, see `outboxAck` in ember-server).
//
// Bindings (provisioned by `ember deploy`, names derived from table and index so code and CLI agree):
//   EMBER_VEC__<table>__<index>   Vectorize index        (one per index; namespace = shard, or the `_shard`
//                                                         metadata filter with shardIsolation "filter")
//   EMBER_AIS__<table>__<index>   AI Search instance     (default namespace; shard = item folder)
//   EMBER_AI                      Workers AI (only when some vectorIndex has `embed`)
//   EMBER_INDEXING                Queue `ember-<project>-<env>-indexing` (producer + this Worker as consumer)
//
// Local fallback (explicit): with EMBER_AI_INDEXES = "local" (set by `ember dev` and the runtime tests) an index
// whose binding is missing is stored in the shard's own SQLite (`_ember_ext_local`) and searched by brute force:
// exact nearest neighbours for vectors (same metrics and filter semantics as Vectorize), BM25 keyword search for AI
// Search (no vectors, no chunking). Embeddings come from EMBER_AI when bound, else from `hashEmbedding` (shared
// words only — not semantic). Without the flag a missing binding is an `IndexNotConfigured` error, never a silent
// fallback.

import {
  aiSearchConfig,
  betterScore,
  hashEmbedding,
  normalizeFilter,
  sha256Hex,
  tokenize,
  vectorConfig,
  vectorScore,
  AI_SEARCH_MAX_LIMIT,
  VECTOR_MAX_LIMIT,
  VECTOR_SHARD_KEY,
  type ExternalDocument,
  type FetchedItem,
  type IndexSpec,
  type MetadataFilter,
  type MetadataValue,
  type SchemaManifest,
  type VectorMetric,
} from "@freecorps/ember-server";

// ------------------------------------------------------------------------------------------------ bindings

/** Minimal Vectorize binding surface (Cloudflare `VectorizeIndex` satisfies it). */
export interface VectorizeLike {
  upsert(vectors: Array<{ id: string; values: number[]; namespace?: string; metadata?: Record<string, MetadataValue> }>): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(
    vector: number[],
    opts: { topK?: number; namespace?: string; filter?: MetadataFilter; returnValues?: boolean; returnMetadata?: "none" | "indexed" | "all" },
  ): Promise<{ matches: Array<{ id: string; score: number }> }>;
}

/** Minimal AI Search instance binding surface (`ai_search` instance binding). */
export interface AiSearchLike {
  items: {
    upload(name: string, content: string | Blob, opts?: { metadata?: Record<string, string> }): Promise<{ id: string; key: string }>;
    list(opts?: { search?: string; per_page?: number; page?: number }): Promise<{ result: Array<{ id: string; key: string }> }>;
    delete(itemId: string): Promise<unknown>;
  };
  search(req: { query: string; ai_search_options?: Record<string, unknown> }): Promise<{
    chunks: Array<{ score: number; text: string; item: { key: string; metadata?: Record<string, unknown> } }>;
  }>;
}

/** Workers AI binding surface. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Binding names are identifiers: a component table's `$` (`rl$items`) becomes `_S_`. */
const bindingPart = (table: string) => table.replace(/\$/g, "_S_");
export const vectorBinding = (table: string, index: string) => `EMBER_VEC__${bindingPart(table)}__${index}`;
export const aiSearchBinding = (table: string, index: string) => `EMBER_AIS__${bindingPart(table)}__${index}`;
export const AI_BINDING = "EMBER_AI";
export const INDEXING_QUEUE_BINDING = "EMBER_INDEXING";

/** Vectorize namespace of a shard (max 64 bytes: longer shard names are hashed). */
export function vectorNamespace(shard: string): string {
  return new TextEncoder().encode(shard).length <= 64 ? shard : `h:${sha256Hex(shard).slice(0, 40)}`;
}

/** AI Search folder of a shard (the `folder` filter isolates shards inside one instance). */
export const aiSearchFolder = (shard: string) => `s${sha256Hex(shard).slice(0, 32)}/`;
/** AI Search item key of a document (max 128 chars). */
export const aiSearchItemKey = (shard: string, id: string) => `${aiSearchFolder(shard)}${id}.md`;
const idOfItemKey = (key: string) => key.slice(key.lastIndexOf("/") + 1).replace(/\.md$/, "");

export class IndexNotConfigured extends Error {
  readonly code = "IndexNotConfigured";
}

type Env = Record<string, unknown>;
export const localMode = (env: Env) => env.EMBER_AI_INDEXES === "local";

function bindingOf<T>(env: Env, name: string, check: (x: any) => boolean, what: string, table: string, index: string): T | null {
  const b = env[name] as T | undefined;
  if (b && check(b)) return b;
  if (localMode(env)) return null;
  throw new IndexNotConfigured(
    `${what} ${table}.${index}: no ${name} binding (deploy with \`ember deploy\`, or set EMBER_AI_INDEXES=local for the local fallback)`,
  );
}

const vectorize = (env: Env, table: string, index: string) =>
  bindingOf<VectorizeLike>(env, vectorBinding(table, index), (b) => typeof b.upsert === "function" && typeof b.query === "function", "vectorIndex", table, index);
const aiSearchInstance = (env: Env, table: string, index: string) =>
  bindingOf<AiSearchLike>(env, aiSearchBinding(table, index), (b) => typeof b.search === "function" && typeof b.items?.upload === "function", "aiSearchIndex", table, index);

// ------------------------------------------------------------------------------------------------ embeddings

/**
 * Embeds texts with Workers AI (EMBER_AI), using each model's documented input form: qwen3-embedding takes
 * `queries` (with its retrieval instruction) / `documents`; embeddinggemma expects its search prompts; the others
 * take `text`. Locally without the binding: `hashEmbedding` (not semantic).
 */
export async function embedTexts(env: Env, model: string, dims: number, texts: string[], role: "query" | "document"): Promise<number[][]> {
  const ai = env[AI_BINDING] as AiLike | undefined;
  if (!ai || typeof ai.run !== "function") {
    if (localMode(env)) return texts.map((t) => hashEmbedding(t, dims));
    throw new IndexNotConfigured(`embedding with ${model}: no ${AI_BINDING} (Workers AI) binding`);
  }
  const qwen = model.startsWith("@cf/qwen/qwen3-embedding");
  const gemma = model.startsWith("@cf/google/embeddinggemma");
  const max = qwen ? 32 : 100;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += max) {
    const part = texts.slice(i, i + max);
    const input = qwen
      ? role === "query"
        ? { queries: part }
        : { documents: part }
      : gemma
        ? { text: part.map((t) => (role === "query" ? `task: search result | query: ${t}` : `title: none | text: ${t}`)) }
        : { text: part };
    const r = (await ai.run(model, input)) as { data?: number[][]; response?: number[][] };
    const data = r?.data ?? r?.response;
    if (!Array.isArray(data) || data.length !== part.length) throw new Error(`${model}: unexpected embedding response`);
    out.push(...data);
  }
  for (const v of out) if (v.length !== dims) throw new Error(`${model} returned ${v.length} dimensions, the index has ${dims}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ shard surface

export interface IndexMessage {
  t: "ember.index";
  shard: string;
  table: string;
  index: string;
  ids: string[];
  /** Claim token of the outbox rows (fencing). Absent on messages from older versions: treated as superseded. */
  claim?: number;
}

export const isIndexMessage = (x: unknown): x is IndexMessage =>
  !!x && typeof x === "object" && (x as { t?: unknown }).t === "ember.index" && typeof (x as IndexMessage).shard === "string" && Array.isArray((x as IndexMessage).ids);

export type LocalOp = { id: string; values?: number[]; text?: string; metadata?: Record<string, MetadataValue>; delete?: true };
export type LocalSearch =
  | { kind: "vector"; vector: number[]; metric: VectorMetric; topK: number; filter?: MetadataFilter }
  | { kind: "text"; query: string; topK: number; filter?: MetadataFilter };
export type LocalHit = { id: string; score: number; text?: string };

/** The Shard RPCs the indexer and the searches use (the Shard DO implements them). */
export interface ExternalIndexRpc {
  /** `spec: null` when the index no longer exists (its outbox rows are dropped): the message is acknowledged. */
  extFetch(shard: string, table: string, index: string, ids: string[], claim?: number | null): Promise<{ spec: IndexSpec | null; items: FetchedItem[] }>;
  extAck(shard: string, table: string, index: string, acks: Array<{ id: string; seq: number | null }>, claim?: number | null): Promise<number>;
  extLocalApply(shard: string, table: string, index: string, ops: LocalOp[]): Promise<void>;
  extLocalSearch(shard: string, table: string, index: string, q: LocalSearch): Promise<LocalHit[]>;
}

// ------------------------------------------------------------------------------------------------ indexer

export interface IndexerDeps {
  env: Env;
  rpc(shard: string): ExternalIndexRpc;
}

/**
 * AI Search item metadata is `Record<string, string>` on upload (Items API / `items.upload`, like R2 `x-amz-meta-*`
 * headers): AI Search casts each value to the field's `data_type` from the instance's `custom_metadata` when it
 * indexes ("number: parsed as float"; boolean accepts true/false/1/0/yes/no). Query filters, by contrast, take typed
 * JSON values (`{ version: { $gte: 2.0 } }` in the docs), so `ctx.aiSearch` forwards numbers and booleans as they
 * are. Declaring every field `text` and stringifying filters instead would make ranges lexicographic ("10" < "9").
 */
const metaStrings = (m: Record<string, MetadataValue>) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, String(x)]));

async function inParallel<T>(xs: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) await f(xs[i++]!);
  }));
}

/**
 * Delivers one outbox message: reads the documents' current state from the shard, writes it to the service and
 * acknowledges. Throws on failure (the queue retries; without a queue the shard re-sends later).
 *
 * `retried`: this is a redelivery of a message whose earlier attempt may have written to the service before failing
 * (e.g. before its ack). Its documents that were re-sent under a newer claim meanwhile are then acknowledged under
 * the old claim anyway, which takes the fencing "superseded" path: that earlier write may have landed after the
 * newer delivery's, so the document is sent once more and the index converges.
 */
export async function deliverIndexBatch(
  deps: IndexerDeps,
  msg: IndexMessage,
  opts: { retried?: boolean } = {},
): Promise<{ upserted: number; deleted: number }> {
  const api = deps.rpc(msg.shard);
  const claim = typeof msg.claim === "number" ? msg.claim : null;
  const fetched = await api.extFetch(msg.shard, msg.table, msg.index, msg.ids, claim);
  const spec = fetched.spec;
  // Documents re-sent under a newer claim (or already acknowledged) belong to another delivery: no write, no ack.
  const items = fetched.items.filter((i) => i.current);
  if (spec && claim !== null && opts.retried) {
    const superseded = fetched.items.filter((i) => !i.current);
    if (superseded.length) await api.extAck(msg.shard, msg.table, msg.index, superseded.map((i) => ({ id: i.id, seq: i.seq })), claim);
  }
  if (!spec || !items.length) return { upserted: 0, deleted: 0 };
  let ups = items.filter((i): i is FetchedItem & { doc: ExternalDocument } => i.doc !== null);
  const dels = items.filter((i) => i.doc === null).map((i) => i.id);
  if (spec.kind === "vector") {
    // Vectorize ids are at most 64 bytes. A longer one can never be indexed: skip it (it is still acknowledged
    // below, so it is not retried) instead of failing the other documents in the batch.
    const tooLong = ups.filter((u) => new TextEncoder().encode(u.id).length > 64);
    if (tooLong.length) {
      console.error(`ember: vectorIndex ${msg.table}.${msg.index}: skipping ${tooLong.length} id(s) longer than Vectorize's 64 bytes (e.g. ${tooLong[0]!.id})`);
      ups = ups.filter((u) => !tooLong.includes(u));
    }
    const c = vectorConfig(spec);
    let vectors = ups.map((u) => u.doc.values ?? []);
    if (c.embed && ups.length) vectors = await embedTexts(deps.env, c.embed.model, c.dimensions, ups.map((u) => u.doc.text ?? ""), "document");
    const vz = vectorize(deps.env, msg.table, msg.index);
    if (vz) {
      if (ups.length) {
        const namespace = vectorNamespace(msg.shard);
        // shardIsolation "filter": no namespace (50k per index); the shard is an indexed metadata value instead.
        await vz.upsert(
          c.shardIsolation === "filter"
            ? ups.map((u, i) => ({ id: u.id, values: vectors[i]!, metadata: { ...u.doc.metadata, [VECTOR_SHARD_KEY]: namespace } }))
            : ups.map((u, i) => ({ id: u.id, values: vectors[i]!, namespace, metadata: u.doc.metadata })),
        );
      }
      if (dels.length) await vz.deleteByIds(dels);
    } else {
      await api.extLocalApply(msg.shard, msg.table, msg.index, [
        ...ups.map((u, i): LocalOp => ({ id: u.id, values: vectors[i]!, metadata: u.doc.metadata })),
        ...dels.map((id): LocalOp => ({ id, delete: true })),
      ]);
    }
  } else if (spec.kind === "aiSearch") {
    const inst = aiSearchInstance(deps.env, msg.table, msg.index);
    if (inst) {
      // Re-uploading a key replaces the item (measured: same item id). Deletes look the item id up by key.
      await inParallel(ups, 4, async (u) => {
        await inst.items.upload(aiSearchItemKey(msg.shard, u.id), u.doc.text ?? "", { metadata: metaStrings(u.doc.metadata) });
      });
      await inParallel(dels, 4, async (id) => {
        const key = aiSearchItemKey(msg.shard, id);
        const found = await inst.items.list({ search: key, per_page: 50 });
        for (const it of found.result ?? []) if (it.key === key) await inst.items.delete(it.id);
      });
    } else {
      await api.extLocalApply(msg.shard, msg.table, msg.index, [
        ...ups.map((u): LocalOp => ({ id: u.id, text: u.doc.text ?? "", metadata: u.doc.metadata })),
        ...dels.map((id): LocalOp => ({ id, delete: true })),
      ]);
    }
  } else throw new Error(`Unknown external index kind ${spec.kind}`);
  await api.extAck(msg.shard, msg.table, msg.index, items.map((i) => ({ id: i.id, seq: i.seq })), claim);
  return { upserted: ups.length, deleted: dels.length };
}

// ------------------------------------------------------------------------------------------------ searches

function specOf(manifest: SchemaManifest, table: string, index: string, kind: string, what: string): IndexSpec {
  const spec = manifest.tables[table]?.indexes.find((i) => i.name === index);
  if (!spec || spec.kind !== kind) throw Object.assign(new Error(`${what}: no ${kind === "vector" ? "vectorIndex" : "aiSearchIndex"} ${table}.${index}`), { code: "IndexNotFound" });
  return spec;
}

const clampLimit = (limit: unknown, max: number, where: string) => {
  const n = limit === undefined ? 10 : Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > max) throw Object.assign(new Error(`${where}: limit must be an integer between 1 and ${max}`), { code: "ValidationError" });
  return n;
};

export interface SearchDeps {
  env: Env;
  manifest: SchemaManifest;
  rpc(shard: string): ExternalIndexRpc;
}

export async function vectorSearch(
  deps: SearchDeps,
  defaultShard: string,
  table: string,
  index: string,
  q: { vector?: number[]; text?: string; limit?: number; filter?: unknown; shard?: string },
): Promise<Array<{ _id: string; _score: number }>> {
  const where = `vectorSearch(${table}, ${index})`;
  const spec = specOf(deps.manifest, table, index, "vector", where);
  const c = vectorConfig(spec);
  const topK = clampLimit(q?.limit, VECTOR_MAX_LIMIT, where);
  const filter = normalizeFilter(q?.filter, Object.fromEntries(Object.entries(c.metadata).map(([f, m]) => [f, m.key])), where);
  let vector = q?.vector;
  if (vector === undefined) {
    if (typeof q?.text !== "string") throw Object.assign(new Error(`${where}: pass { vector }${c.embed ? " or { text }" : ""}`), { code: "ValidationError" });
    if (!c.embed) throw Object.assign(new Error(`${where}: { text } needs an index with embed`), { code: "ValidationError" });
    vector = (await embedTexts(deps.env, c.embed.model, c.dimensions, [q.text], "query"))[0]!;
  }
  if (!Array.isArray(vector) || vector.length !== c.dimensions || !vector.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw Object.assign(new Error(`${where}: vector must be ${c.dimensions} finite numbers`), { code: "ValidationError" });
  }
  const shard = q?.shard ?? defaultShard;
  const vz = vectorize(deps.env, table, index);
  if (vz) {
    const ns = vectorNamespace(shard);
    const scope =
      c.shardIsolation === "filter"
        ? { filter: { ...(filter ?? {}), [VECTOR_SHARD_KEY]: { $eq: ns } } as MetadataFilter }
        : { namespace: ns, ...(filter ? { filter } : {}) };
    const r = await vz.query(vector, { topK, returnValues: false, returnMetadata: "none", ...scope });
    return (r.matches ?? []).map((m) => ({ _id: m.id, _score: m.score }));
  }
  const hits = await deps.rpc(shard).extLocalSearch(shard, table, index, { kind: "vector", vector, metric: c.metric, topK, ...(filter ? { filter } : {}) });
  return hits.map((h) => ({ _id: h.id, _score: h.score }));
}

export async function aiSearch(
  deps: SearchDeps,
  defaultShard: string,
  table: string,
  index: string,
  q: { query: string; limit?: number; filter?: unknown; mode?: "hybrid" | "vector" | "keyword"; fusion?: "rrf" | "max"; shard?: string },
): Promise<Array<{ _id: string; _score: number; text: string }>> {
  const where = `aiSearch(${table}, ${index})`;
  const spec = specOf(deps.manifest, table, index, "aiSearch", where);
  const c = aiSearchConfig(spec);
  if (typeof q?.query !== "string" || !q.query.trim()) throw Object.assign(new Error(`${where}: query must be a non-empty string`), { code: "ValidationError" });
  const limit = clampLimit(q.limit, AI_SEARCH_MAX_LIMIT, where);
  const filter = normalizeFilter(q.filter, Object.fromEntries(Object.entries(c.metadata).map(([f, m]) => [f, m.key])), where);
  const mode = q.mode ?? c.defaultMode ?? "hybrid";
  if (!["hybrid", "vector", "keyword"].includes(mode)) throw Object.assign(new Error(`${where}: mode must be hybrid, vector or keyword`), { code: "ValidationError" });
  if (q.fusion !== undefined && q.fusion !== "rrf" && q.fusion !== "max") throw Object.assign(new Error(`${where}: fusion must be rrf or max`), { code: "ValidationError" });
  const shard = q.shard ?? defaultShard;
  const inst = aiSearchInstance(deps.env, table, index);
  if (inst) {
    const r = await inst.search({
      query: q.query,
      ai_search_options: {
        // The similarity cache (on by default, 48 h) would serve results from before later writes.
        cache: { enabled: false },
        retrieval: {
          retrieval_type: mode,
          ...(q.fusion ? { fusion_method: q.fusion } : {}),
          // `and` (the default) misses natural pt-BR questions whose words are not all in one chunk.
          keyword_match_mode: "or",
          max_num_results: Math.min(AI_SEARCH_MAX_LIMIT, limit * 2),
          filters: { folder: aiSearchFolder(shard), ...(filter ?? {}) },
        },
      },
    });
    const best = new Map<string, { _id: string; _score: number; text: string }>();
    for (const ch of r.chunks ?? []) {
      const id = idOfItemKey(ch.item.key);
      const cur = best.get(id);
      if (!cur || ch.score > cur._score) best.set(id, { _id: id, _score: ch.score, text: ch.text });
    }
    return [...best.values()].sort((a, b) => b._score - a._score).slice(0, limit);
  }
  const hits = await deps.rpc(shard).extLocalSearch(shard, table, index, { kind: "text", query: q.query, topK: limit, ...(filter ? { filter } : {}) });
  return hits.map((h) => ({ _id: h.id, _score: h.score, text: h.text ?? "" }));
}

// ------------------------------------------------------------------------------------------------ local store

export const LOCAL_DDL = `CREATE TABLE IF NOT EXISTS _ember_ext_local (
  tbl TEXT NOT NULL, idx TEXT NOT NULL, id TEXT NOT NULL, vec BLOB, text TEXT, meta TEXT NOT NULL,
  PRIMARY KEY (tbl, idx, id)
) STRICT, WITHOUT ROWID`;

/** Brute-force search over the shard-local fallback rows (exact; meant for dev and tests). */
export function localSearch(
  rows: Array<{ id: string; vec: Uint8Array | null; text: string | null; meta: Record<string, MetadataValue> }>,
  q: LocalSearch,
  matches: (meta: Record<string, MetadataValue>, f: MetadataFilter | undefined) => boolean,
): LocalHit[] {
  const pool = rows.filter((r) => matches(r.meta, q.filter));
  if (q.kind === "vector") {
    const scored = pool
      .filter((r) => r.vec)
      .map((r) => ({ id: r.id, score: vectorScore(q.metric, q.vector, new Float32Array(r.vec!.buffer, r.vec!.byteOffset, r.vec!.byteLength / 4)) }));
    const order = betterScore(q.metric);
    return scored.sort((a, b) => order(a.score, b.score)).slice(0, q.topK);
  }
  // BM25 (k1 1.2, b 0.75), OR of the query terms, scores normalized to (0, 1] by the best hit.
  const terms = [...new Set(tokenize(q.query))];
  const docs = pool.map((r) => ({ r, toks: tokenize(r.text ?? "") }));
  const avg = docs.reduce((s, d) => s + d.toks.length, 0) / Math.max(1, docs.length);
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.toks.includes(t)).length]));
  const scored = docs
    .map(({ r, toks }) => {
      let s = 0;
      for (const t of terms) {
        const f = toks.filter((x) => x === t).length;
        if (!f) continue;
        const n = df.get(t)!;
        s += Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)) * ((f * 2.2) / (f + 1.2 * (0.25 + (0.75 * toks.length) / (avg || 1))));
      }
      return { id: r.id, score: s, text: r.text ?? "" };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, q.topK);
  const top = scored[0]?.score ?? 1;
  return scored.map((x) => ({ ...x, score: x.score / top }));
}
