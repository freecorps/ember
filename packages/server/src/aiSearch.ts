// `.aiSearchIndex()` (PLAN §6): Cloudflare AI Search (hybrid BM25 + vector, chunking and embedding managed by the
// service) over the Items API, kept in sync through the shard outbox (external.ts) and queried from actions with
// `ctx.aiSearch(table, index, { query, limit, filter })` → `{ _id, _score, text }[]`.
//
//   defineTable({ subject: v.string(), body: v.string(), status: v.string() })
//     .aiSearchIndex("semantic", { fields: ["subject", "body"], filterFields: ["status"] })
//
// - One AI Search instance per (project, env, table, index) in the account's `default` namespace (instance binding,
//   so no namespace is used: an account has 100). Every shard of the table's kind shares the instance; the shard is
//   the item's folder (`aiSearchItemKey`), so `folder` — a built-in filter — isolates shards and all 5 custom
//   metadata fields stay available for `filterFields`.
// - Each document is one item `<shard folder>/<_id>.md`: the `fields` as markdown sections. Re-uploading a key
//   replaces the item (same item id, measured); deletes look the item up by key.
// - Not reactive; indexing is asynchronous on Cloudflare's side (seconds to minutes after the upload).
// - Billing (Cloudflare, from 2026-12-01): ingestion tokens, storage, $0.75 / 1k semantic/hybrid queries beyond
//   the monthly allowance (docs/design/contracts.md, "Índices externos").

import { shapeAtPath, type GenericValidator, type JSONValue, type Shape } from "@freecorps/ember-values";
import { externalBackfill, metadataOf, type ExternalDocument } from "./external.ts";
import { defineIndexKind } from "./indexKinds.ts";
import { fieldOf } from "./layout.ts";
import type { FieldPathsOf, GenericExt, GenericIndexes, TableDefinition } from "./schema.ts";
import type { IndexSpec } from "./types.ts";
import { DEFAULT_EMBEDDING_MODEL, parseFilterFields, type MetadataType, type SearchFilterOf } from "./vector.ts";

export const AI_SEARCH_MAX_FILTER_FIELDS = 5;
export const AI_SEARCH_MAX_FIELDS = 16;
/** AI Search `max_num_results` limit. */
export const AI_SEARCH_MAX_LIMIT = 50;
/** Built-in metadata names a custom field may not use. */
export const AI_SEARCH_RESERVED = ["timestamp", "folder", "filename"];

export type AiSearchIndexConfig = {
  /** String fields indexed as the item's text (markdown sections, in order). */
  fields: string[];
  /** Fields usable in `filter` (max 5: AI Search custom metadata). */
  filterFields?: string[];
  /** AI Search embedding model (default `@cf/baai/bge-m3`: best pt-BR retrieval in docs/spikes/ai-embeddings). */
  embeddingModel?: string;
};

export type AiSearchStoredConfig = {
  fields: string[];
  embeddingModel: string;
  filterFields: string[];
  /** AI Search custom metadata name (lowercase, dots → `_`) and data type per filter field. */
  metadata: Record<string, { key: string; type: MetadataType }>;
};

export const aiSearchConfig = (spec: IndexSpec) => spec.config as unknown as AiSearchStoredConfig;

/** AI Search `custom_metadata` data type of a filter field. */
export const aiSearchDataType = (t: MetadataType): "text" | "number" | "boolean" => (t === "string" ? "text" : t);

const isTextShape = (s: Shape): boolean => s.kind === "string" || (s.kind === "union" && s.members.every((m) => m.kind === "null" || isTextShape(m)));

export const aiSearchIndexKind = defineIndexKind<AiSearchIndexConfig>({
  kind: "aiSearch",
  method: "aiSearchIndex",

  parse(name, cfg, document) {
    const where = `aiSearchIndex ${name}`;
    if (!cfg || !Array.isArray(cfg.fields) || cfg.fields.length === 0) throw new Error(`${where}: fields must list at least one string field`);
    if (cfg.fields.length > AI_SEARCH_MAX_FIELDS) throw new Error(`${where}: at most ${AI_SEARCH_MAX_FIELDS} fields`);
    for (const f of cfg.fields) {
      const s = shapeAtPath(document, f);
      if (!s || !isTextShape(s.shape)) throw new Error(`${where}: field ${f} must be a string field`);
    }
    const filterFields = cfg.filterFields ?? [];
    const metadata = parseFilterFields(where, document, filterFields, AI_SEARCH_MAX_FILTER_FIELDS, (f) => f.replace(/\./g, "_").toLowerCase(), AI_SEARCH_RESERVED);
    const embeddingModel = cfg.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    if (typeof embeddingModel !== "string" || !embeddingModel) throw new Error(`${where}: embeddingModel must be a model name`);
    const config: AiSearchStoredConfig = { fields: [...cfg.fields], embeddingModel, filterFields, metadata };
    return { kind: "aiSearch", name, fields: [...new Set([...cfg.fields, ...filterFields])], config: config as unknown as JSONValue };
  },

  ddl: () => [],
  backfill: externalBackfill,

  external: {
    service: "aiSearch",
    fields: (spec) => spec.fields,
    document(spec, doc): ExternalDocument | null {
      const c = aiSearchConfig(spec);
      const parts: string[] = [];
      for (const f of c.fields) {
        const x = fieldOf(doc, f);
        if (typeof x === "string" && x.trim()) parts.push(`## ${f}\n\n${x.trim()}`);
      }
      if (!parts.length) return null;
      return { text: parts.join("\n\n") + "\n", metadata: metadataOf(doc, c.filterFields, (f) => c.metadata[f]!.key) };
    },
  },
});

// ------------------------------------------------------------------------------------------------ typing

export type AiSearchIndexTypeInfo<F extends string> = { filterFields: F };

declare module "./schema.ts" {
  interface IndexKindMethods<V extends GenericValidator, Indexes extends GenericIndexes, Ext extends GenericExt> {
    aiSearchIndex<N extends string, const S extends FieldPathsOf<V>, const F extends FieldPathsOf<V> = never>(
      name: N,
      config: { fields: S[]; filterFields?: F[]; embeddingModel?: string },
    ): TableDefinition<V, Indexes, Ext & { aiSearch: Record<N, AiSearchIndexTypeInfo<F>> }>;
  }
}

export type AiSearchQuery<D, I> = {
  query: string;
  /** Max documents (default 10, max 50). */
  limit?: number;
  filter?: SearchFilterOf<D, I extends { filterFields: infer F extends string } ? F : never>;
  /** `hybrid` (default), `vector` or `keyword`. */
  mode?: "hybrid" | "vector" | "keyword";
  /** How hybrid combines the vector and keyword rankings: `rrf` (AI Search's default) or `max`. */
  fusion?: "rrf" | "max";
  /** Shard to search (default: the action's shard). */
  shard?: string;
};
/** One document: its best chunk's score and text (AI Search returns chunks; Ember groups them by document). */
export type AiSearchResult<Id> = { _id: Id; _score: number; text: string };
