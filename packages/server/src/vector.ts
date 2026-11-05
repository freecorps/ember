// `.vectorIndex()` (PLAN §6): a Cloudflare Vectorize index, kept in sync through the shard outbox (external.ts) and
// queried from actions with `ctx.vectorSearch(table, index, { vector | text, limit, filter })` → `{ _id, _score }[]`.
//
//   defineTable({ ..., embedding: v.array(v.number()), lang: v.string() })
//     .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1024, filterFields: ["lang"] })
//   defineTable({ ..., body: v.string() })
//     .vectorIndex("semantic", { embed: "body", filterFields: ["lang"] })      // Workers AI, default @cf/baai/bge-m3
//
// - One Vectorize index per (project, env, table, index, dimensions, metric, model): dimensions and metric are
//   immutable in Vectorize, so changing them (or the embedding model) means a new index, filled by the staged
//   backfill. The namespace is the shard (`vectorNamespace`), so a search only sees its shard's documents.
// - Vectorize allows 50,000 namespaces per index. Past that (or when the shard count is unbounded), set
//   `shardIsolation: "filter"`: the shard goes into a metadata field (`_shard`, indexed) and every search filters on
//   it. That takes one of the 10 metadata slots (9 filter fields left) and is part of the index identity, so
//   switching modes builds a new index through the staged backfill (contracts.md, "Índices externos").
// - Up to 10 filter fields (Vectorize metadata indexes; strings/numbers/booleans, first 64 bytes of a string).
// - With `embed`, the consumer embeds the text field with Workers AI and `ctx.vectorSearch` accepts `{ text }`.
// - Not reactive and not readable from queries/mutations (it is an external service: actions only).

import { type GenericValidator, type JSONValue, type ObjectShape, type Shape, shapeAtPath } from "@freecorps/ember-values";
import { externalBackfill, metadataOf, type ExternalDocument, type MetadataValue, type MetadataFilter } from "./external.ts";
import { defineIndexKind } from "./indexKinds.ts";
import { fieldOf } from "./layout.ts";
import type { FieldPathsOf, GenericExt, GenericIndexes, TableDefinition } from "./schema.ts";
import type { IndexSpec } from "./types.ts";
import type { FieldTypeFromPath } from "./query.ts";

export type VectorMetric = "cosine" | "euclidean" | "dot-product";
export type MetadataType = "string" | "number" | "boolean";

/** Workers AI embedding models with known output sizes (PLAN §6, docs/spikes/ai-embeddings). */
export const EMBEDDING_MODELS: Record<string, number> = {
  "@cf/baai/bge-m3": 1024,
  "@cf/qwen/qwen3-embedding-0.6b": 1024,
  "@cf/google/embeddinggemma-300m": 768,
  "@cf/baai/bge-large-en-v1.5": 1024,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-small-en-v1.5": 384,
};
/** Default `embed` model: best pt-BR retrieval in the comparison (tied with embeddinggemma, which is beta), GA. */
export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";

/** Vectorize accepts 32..1536 dimensions (measured: 3 → error 3003 "Dimensions must be in range: [32, 1536]"). */
export const VECTOR_MIN_DIMENSIONS = 32;
export const VECTOR_MAX_DIMENSIONS = 1536;
export const VECTOR_MAX_FILTER_FIELDS = 10;
/** Vectorize namespaces per index (documented limit): the ceiling of `shardIsolation: "namespace"`. */
export const VECTOR_MAX_NAMESPACES = 50_000;
/** Metadata property holding the shard with `shardIsolation: "filter"` (indexed as a string; never a user key). */
export const VECTOR_SHARD_KEY = "_shard";
/** How a vectorIndex keeps shards apart inside its Vectorize index. */
export type VectorShardIsolation = "namespace" | "filter";
/** Vectorize topK limit without values/metadata. */
export const VECTOR_MAX_LIMIT = 100;

export type VectorIndexConfig = {
  /** Array-of-numbers field with the vector (omit with `embed`). */
  vectorField?: string;
  /** Vector size (32..1536, Vectorize's range); optional with `embed` and a known model. */
  dimensions?: number;
  /** Fields usable in `filter` (max 10). */
  filterFields?: string[];
  /** Distance metric (default cosine). */
  metric?: VectorMetric;
  /** Compute the vector with Workers AI from a string field: `"body"` or `{ field: "body", model }`. */
  embed?: string | { field: string; model?: string };
  /**
   * `"namespace"` (default): one Vectorize namespace per shard (≤ 50,000 shards per index). `"filter"`: the shard is
   * a metadata filter (`_shard`) instead, for any number of shards; uses one of the 10 metadata slots.
   */
  shardIsolation?: VectorShardIsolation;
};

export type VectorStoredConfig = {
  vectorField: string | null;
  embed: { field: string; model: string } | null;
  dimensions: number;
  metric: VectorMetric;
  filterFields: string[];
  /** Vectorize metadata property per filter field (dots become `_`) and its metadata index type. */
  metadata: Record<string, { key: string; type: MetadataType }>;
  /** Present only for `"filter"` (absent = namespace), so existing indexes keep their spec and identity. */
  shardIsolation?: "filter";
};

export const vectorConfig = (spec: IndexSpec) => spec.config as unknown as VectorStoredConfig;

/** The filterable type of a field shape, or null when it cannot be a Vectorize / AI Search filter. */
export function metadataTypeOf(shape: Shape): MetadataType | null {
  switch (shape.kind) {
    case "string":
    case "id":
      return "string";
    case "number":
    case "int64":
      return "number";
    case "boolean":
      return "boolean";
    case "literal":
      return typeof shape.value === "string" ? "string" : typeof shape.value === "boolean" ? "boolean" : "number";
    case "union": {
      const ts = new Set(shape.members.filter((m) => m.kind !== "null").map(metadataTypeOf));
      return ts.size === 1 && !ts.has(null) ? [...ts][0]! : null;
    }
    default:
      return null;
  }
}

const isStringShape = (s: Shape): boolean =>
  s.kind === "string" || (s.kind === "union" && s.members.every((m) => m.kind === "null" || isStringShape(m)));

export function parseFilterFields(where: string, document: ObjectShape, fields: string[], max: number, key: (f: string) => string, reserved: string[] = []) {
  if (!Array.isArray(fields)) throw new Error(`${where}: filterFields must be an array`);
  if (fields.length > max) throw new Error(`${where}: at most ${max} filter fields`);
  const metadata: Record<string, { key: string; type: MetadataType }> = {};
  const keys = new Set<string>();
  for (const f of fields) {
    const s = shapeAtPath(document, f);
    if (!s) throw new Error(`${where}: unknown filter field ${f}`);
    const type = metadataTypeOf(s.shape);
    if (!type) throw new Error(`${where}: filter field ${f} must be a string, number, boolean or id`);
    const k = key(f);
    if (keys.has(k) || reserved.includes(k)) throw new Error(`${where}: filter field ${f} maps to metadata key ${k}, which is ${keys.has(k) ? "taken" : "reserved"}`);
    keys.add(k);
    metadata[f] = { key: k, type };
  }
  return metadata;
}

export const vectorIndexKind = defineIndexKind<VectorIndexConfig>({
  kind: "vector",
  method: "vectorIndex",

  parse(name, cfg, document) {
    const where = `vectorIndex ${name}`;
    if (!cfg || typeof cfg !== "object") throw new Error(`${where}: missing config`);
    const embed = typeof cfg.embed === "string" ? { field: cfg.embed } : cfg.embed;
    if (!!cfg.vectorField === !!embed) throw new Error(`${where}: set exactly one of vectorField or embed`);
    let dimensions = cfg.dimensions;
    let stored: VectorStoredConfig["embed"] = null;
    if (embed) {
      const s = shapeAtPath(document, embed.field);
      if (!s || !isStringShape(s.shape)) throw new Error(`${where}: embed field ${embed.field} must be a string field`);
      const model = embed.model ?? DEFAULT_EMBEDDING_MODEL;
      const known = EMBEDDING_MODELS[model];
      if (dimensions === undefined) {
        if (!known) throw new Error(`${where}: set dimensions for embedding model ${model}`);
        dimensions = known;
      } else if (known && known !== dimensions) throw new Error(`${where}: ${model} produces ${known} dimensions, not ${dimensions}`);
      stored = { field: embed.field, model };
    } else {
      const s = shapeAtPath(document, cfg.vectorField!);
      if (!s || s.shape.kind !== "array" || s.shape.item.kind !== "number") throw new Error(`${where}: vectorField ${cfg.vectorField} must be v.array(v.number())`);
    }
    if (!Number.isInteger(dimensions) || dimensions! < VECTOR_MIN_DIMENSIONS || dimensions! > VECTOR_MAX_DIMENSIONS) {
      throw new Error(`${where}: dimensions must be an integer between ${VECTOR_MIN_DIMENSIONS} and ${VECTOR_MAX_DIMENSIONS}`);
    }
    const metric = cfg.metric ?? "cosine";
    if (!["cosine", "euclidean", "dot-product"].includes(metric)) throw new Error(`${where}: unknown metric ${metric}`);
    const isolation = cfg.shardIsolation ?? "namespace";
    if (isolation !== "namespace" && isolation !== "filter") throw new Error(`${where}: shardIsolation must be "namespace" or "filter"`);
    const byFilter = isolation === "filter";
    const filterFields = cfg.filterFields ?? [];
    const metadata = parseFilterFields(
      where + (byFilter ? ' (shardIsolation "filter" uses one metadata slot)' : ""),
      document,
      filterFields,
      VECTOR_MAX_FILTER_FIELDS - (byFilter ? 1 : 0),
      (f) => f.replace(/\./g, "_"),
      [VECTOR_SHARD_KEY],
    );
    const config: VectorStoredConfig = { vectorField: cfg.vectorField ?? null, embed: stored, dimensions: dimensions!, metric, filterFields, metadata, ...(byFilter ? { shardIsolation: "filter" as const } : {}) };
    const source = cfg.vectorField ?? embed!.field;
    return { kind: "vector", name, fields: [source, ...filterFields.filter((f) => f !== source)], config: config as unknown as JSONValue };
  },

  // Nothing in SQLite: the data lives in Vectorize; the outbox (external.ts) is shared by every external kind.
  ddl: () => [],
  backfill: externalBackfill,

  external: {
    service: "vectorize",
    fields: (spec) => spec.fields,
    document(spec, doc): ExternalDocument | null {
      const c = vectorConfig(spec);
      const metadata = metadataOf(doc, c.filterFields, (f) => c.metadata[f]!.key);
      if (c.embed) {
        const text = fieldOf(doc, c.embed.field);
        return typeof text === "string" && text.trim() ? { text, metadata } : null;
      }
      const values = fieldOf(doc, c.vectorField!);
      if (!Array.isArray(values) || values.length !== c.dimensions || !values.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
      return { values: values as number[], metadata };
    },
  },
});

// ------------------------------------------------------------------------------------------------ local fallback

/** Score like Vectorize: cosine similarity, euclidean distance (lower is closer) or dot product. */
export function vectorScore(metric: VectorMetric, a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0, sq = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
    sq += (x - y) * (x - y);
  }
  if (metric === "euclidean") return Math.sqrt(sq);
  if (metric === "dot-product") return dot;
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Best first: euclidean ascending, the others descending (Vectorize's order). */
export const betterScore = (metric: VectorMetric) => (a: number, b: number) => (metric === "euclidean" ? a - b : b - a);

/**
 * Deterministic offline "embedding" for the local fallback when there is no Workers AI binding (`ember dev`
 * without network, tests): feature hashing of the `.searchIndex()` tokens into `dims` buckets, L2-normalized.
 * It only captures shared words, not meaning; use a remote AI binding in dev for real semantics.
 */
export function hashEmbedding(text: string, dims: number): number[] {
  const out = new Array<number>(dims).fill(0);
  const toks = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (const t of toks) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    const sign = h & 1 ? 1 : -1;
    out[(h >>> 1) % dims]! += sign;
  }
  const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  return n ? out.map((x) => x / n) : out;
}

// ------------------------------------------------------------------------------------------------ typing

export type VectorIndexTypeInfo<F extends string, Embed extends boolean> = { filterFields: F; embed: Embed };

declare module "./schema.ts" {
  interface IndexKindMethods<V extends GenericValidator, Indexes extends GenericIndexes, Ext extends GenericExt> {
    vectorIndex<N extends string, const VF extends FieldPathsOf<V> = never, const EF extends FieldPathsOf<V> = never, const F extends FieldPathsOf<V> = never>(
      name: N,
      config: {
        vectorField?: VF;
        dimensions?: number;
        filterFields?: F[];
        metric?: VectorMetric;
        embed?: EF | { field: EF; model?: string };
        shardIsolation?: VectorShardIsolation;
      },
    ): TableDefinition<V, Indexes, Ext & { vector: Record<N, VectorIndexTypeInfo<F, [EF] extends [never] ? false : true>> }>;
  }
}

/** `filter` of a search: field → value or `{ $eq, $ne, $in, $nin, $lt, $lte, $gt, $gte }`. */
export type SearchFilterOf<D, F extends string> = {
  [P in F]?: FilterValue<NonNullable<FieldTypeFromPath<D, P>>>;
};
type Scalar<T> = T extends bigint ? number : T;
type FilterValue<T> =
  | Scalar<T>
  | { $eq?: Scalar<T>; $ne?: Scalar<T>; $in?: Scalar<T>[]; $nin?: Scalar<T>[]; $lt?: Scalar<T>; $lte?: Scalar<T>; $gt?: Scalar<T>; $gte?: Scalar<T> };

export type VectorSearchQuery<D, I> = (I extends { embed: true } ? { vector: number[]; text?: never } | { text: string; vector?: never } : { vector: number[]; text?: never }) & {
  /** Max results (default 10, max 100). */
  limit?: number;
  filter?: SearchFilterOf<D, I extends { filterFields: infer F extends string } ? F : never>;
  /** Shard to search (default: the action's shard). */
  shard?: string;
};
export type VectorSearchResult<Id> = { _id: Id; _score: number };

export type { MetadataFilter, MetadataValue };
