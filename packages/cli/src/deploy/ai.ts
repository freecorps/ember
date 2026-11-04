// External index resources for `ember deploy` / `ember destroy` (PLAN §6, §13). All idempotent; a re-run converges.
//
//   .vectorIndex()     Vectorize index `ember-<project>-<env>-<table>-<index>-<hash>` (+ one metadata index per
//                      filter field) bound as EMBER_VEC__<table>__<index>. The hash covers dimensions, metric and
//                      embedding model: Vectorize cannot change them, so a change is a *new* index (the shard's staged
//                      backfill re-sends every document) and the old one is deleted after the new version is live.
//                      Ownership: the index description `ember:<project>/<env> <table>.<index>` (never matched by
//                      name prefix alone: "ember-a-b-..." could be project "a", env "b" or project "a-b").
//   .aiSearchIndex()   AI Search instance `ember-<project>-<env>__<table>_<index>_<hash>` in the `default` namespace
//                      (instance binding EMBER_AIS__<table>__<index>; no namespace used — 100 per account).
//                      Ownership: the `ember-<project>-<env>__` prefix (project/env names have no `_`). Created with
//                      the similarity cache off (it served stale results for minutes in the probe), keyword match
//                      `or`, bge-m3 embeddings by default, and `custom_metadata` = the filter fields.
//   embed              Workers AI binding EMBER_AI.
//   any of them        Queue `ember-<project>-<env>-indexing` (EMBER_INDEXING) with this Worker as consumer.

import { createHash } from "node:crypto";
import { CloudflareApiError, type CfClient } from "./cf.ts";

type IndexSpecLike = { kind: string; name: string; fields: string[]; config?: unknown };
export type SchemaManifestLike = { tables: Record<string, { indexes: IndexSpecLike[] }> };

export interface VectorizeResource {
  table: string;
  index: string;
  name: string;
  binding: string;
  dimensions: number;
  metric: "cosine" | "euclidean" | "dot-product";
  description: string;
  metadata: Array<{ propertyName: string; indexType: "string" | "number" | "boolean" }>;
}

export interface AiSearchResource {
  table: string;
  index: string;
  name: string;
  binding: string;
  embeddingModel: string;
  customMetadata: Array<{ field_name: string; data_type: "text" | "number" | "boolean" }>;
}

export interface AiResources {
  vectorize: VectorizeResource[];
  aiSearch: AiSearchResource[];
  /** Some vectorIndex embeds text: bind Workers AI as EMBER_AI. */
  ai: boolean;
  /** The indexing queue, when there is any external index. */
  queue: string | null;
}

const hash = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);
const slug = (s: string, sep: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^\\${sep}+|\\${sep}+$`, "g"), "");

export const indexingQueueName = (project: string, env: string) => `ember-${project}-${env}-indexing`;
export const vectorizeOwner = (project: string, env: string) => `ember:${project}/${env}`;
export const aiSearchPrefix = (project: string, env: string) => `ember-${project}-${env}__`;

export function vectorizeIndexName(project: string, env: string, table: string, index: string, identity: string): string {
  const head = `ember-${project}-${env}-`;
  const tail = `-${hash(`${table}/${index}/${identity}`, 8)}`;
  const room = 64 - head.length - tail.length;
  if (room < 4) throw new Error(`vectorIndex ${table}.${index}: project + env names are too long for a Vectorize index name`);
  return `${head}${slug(`${table}-${index}`, "-").slice(0, room).replace(/-+$/, "")}${tail}`;
}

export function aiSearchInstanceName(project: string, env: string, table: string, index: string): string {
  const head = aiSearchPrefix(project, env);
  const tail = `_${hash(`${table}/${index}`, 6)}`;
  const room = 64 - head.length - tail.length;
  if (room < 4) throw new Error(`aiSearchIndex ${table}.${index}: project + env names are too long for an AI Search instance id`);
  return `${head}${slug(`${table}_${index}`, "_").slice(0, room).replace(/_+$/, "")}${tail}`;
}

/** What the schema needs (no API calls). */
export function planAiResources(manifest: SchemaManifestLike, project: string, env: string): AiResources {
  const out: AiResources = { vectorize: [], aiSearch: [], ai: false, queue: null };
  for (const [table, t] of Object.entries(manifest.tables)) {
    for (const spec of t.indexes) {
      if (spec.kind === "vector") {
        const c = spec.config as {
          dimensions: number;
          metric: VectorizeResource["metric"];
          embed: { model: string } | null;
          metadata: Record<string, { key: string; type: "string" | "number" | "boolean" }>;
        };
        if (c.embed) out.ai = true;
        const identity = `${c.dimensions}/${c.metric}/${c.embed?.model ?? ""}`;
        out.vectorize.push({
          table,
          index: spec.name,
          name: vectorizeIndexName(project, env, table, spec.name, identity),
          binding: `EMBER_VEC__${table}__${spec.name}`,
          dimensions: c.dimensions,
          metric: c.metric,
          description: `${vectorizeOwner(project, env)} ${table}.${spec.name} (${identity})`,
          metadata: Object.values(c.metadata).map((m) => ({ propertyName: m.key, indexType: m.type })),
        });
      } else if (spec.kind === "aiSearch") {
        const c = spec.config as { embeddingModel?: string; metadata: Record<string, { key: string; type: "string" | "number" | "boolean" }> };
        out.aiSearch.push({
          table,
          index: spec.name,
          name: aiSearchInstanceName(project, env, table, spec.name),
          binding: `EMBER_AIS__${table}__${spec.name}`,
          embeddingModel: c.embeddingModel ?? "@cf/baai/bge-m3",
          customMetadata: Object.values(c.metadata).map((m) => ({ field_name: m.key, data_type: m.type === "string" ? "text" : m.type })),
        });
      }
    }
  }
  if (out.vectorize.length || out.aiSearch.length) out.queue = indexingQueueName(project, env);
  return out;
}

export type AiBinding =
  | { type: "vectorize"; name: string; index_name: string }
  | { type: "ai_search"; name: string; instance_name: string }
  | { type: "ai"; name: string }
  | { type: "queue"; name: string; queue_name: string };

/** Worker bindings for the resources (sent on every deploy, so code-only redeploys keep them). */
export function aiBindings(r: AiResources): AiBinding[] {
  return [
    ...r.vectorize.map((v): AiBinding => ({ type: "vectorize", name: v.binding, index_name: v.name })),
    ...r.aiSearch.map((a): AiBinding => ({ type: "ai_search", name: a.binding, instance_name: a.name })),
    ...(r.ai ? [{ type: "ai", name: "EMBER_AI" } as AiBinding] : []),
    ...(r.queue ? [{ type: "queue", name: "EMBER_INDEXING", queue_name: r.queue } as AiBinding] : []),
  ];
}

const isConflict = (e: unknown) => e instanceof CloudflareApiError && (e.status === 409 || /already exists|duplicate/i.test(e.message));

const AIS = "/ai-search/namespaces/default/instances";

export interface AiState {
  queueId: string | null;
  created: string[];
}

/** Before the Worker upload (bindings must point at existing resources): indexes, metadata indexes, instances, queue. */
export async function ensureAiResources(client: CfClient, r: AiResources, log: (l: string) => void): Promise<AiState> {
  const created: string[] = [];
  if (r.vectorize.length) {
    const existing = new Set((await listVectorize(client)).map((x) => x.name));
    for (const v of r.vectorize) {
      if (!existing.has(v.name)) {
        try {
          await client.call("POST", "/vectorize/v2/indexes", { name: v.name, description: v.description, config: { dimensions: v.dimensions, metric: v.metric } });
          created.push(`vectorize ${v.name}`);
        } catch (e) {
          if (!isConflict(e)) throw e;
        }
      }
      // Metadata indexes must exist before vectors are inserted (vectors upserted earlier are not indexed for a
      // property created later; the staged backfill re-upserts after a filterFields change).
      const have = await client.call<{ metadataIndexes?: Array<{ propertyName: string; indexType: string }> }>("GET", `/vectorize/v2/indexes/${v.name}/metadata_index/list`);
      const props = new Map((have?.metadataIndexes ?? []).map((m) => [m.propertyName, m.indexType]));
      for (const m of v.metadata) {
        const t = props.get(m.propertyName);
        if (t === m.indexType) continue;
        if (t !== undefined) await client.call("POST", `/vectorize/v2/indexes/${v.name}/metadata_index/delete`, { propertyName: m.propertyName });
        await client.call("POST", `/vectorize/v2/indexes/${v.name}/metadata_index/create`, m);
        created.push(`vectorize ${v.name} metadata ${m.propertyName}:${m.indexType}`);
      }
    }
  }
  for (const a of r.aiSearch) {
    const want = {
      embedding_model: a.embeddingModel,
      cache: false,
      custom_metadata: a.customMetadata,
      index_method: { vector: true, keyword: true },
      retrieval_options: { keyword_match_mode: "or" },
    };
    const cur = await client.request<Record<string, unknown>>("GET", `${AIS}/${a.name}`);
    if (!cur.success) {
      try {
        await client.call("POST", AIS, { id: a.name, ...want });
        created.push(`ai-search ${a.name}`);
      } catch (e) {
        if (!isConflict(e)) throw e;
      }
    } else {
      const c = cur.result ?? {};
      const meta = JSON.stringify(((c.custom_metadata as unknown[]) ?? []).map((m: any) => [m.field_name, m.data_type]).sort());
      const wantMeta = JSON.stringify(a.customMetadata.map((m) => [m.field_name, m.data_type]).sort());
      if (c.cache !== false || meta !== wantMeta || c.embedding_model !== a.embeddingModel) {
        // custom_metadata or model changes make AI Search re-index the instance on its side.
        await client.call("PUT", `${AIS}/${a.name}`, want);
        created.push(`ai-search ${a.name} (updated)`);
      }
    }
  }
  let queueId: string | null = null;
  if (r.queue) {
    queueId = await findQueue(client, r.queue);
    if (!queueId) {
      try {
        queueId = (await client.call<{ queue_id: string }>("POST", "/queues", { queue_name: r.queue })).queue_id;
        created.push(`queue ${r.queue}`);
      } catch (e) {
        if (!isConflict(e)) throw e;
        queueId = await findQueue(client, r.queue);
      }
    }
    if (!queueId) throw new Error(`queue ${r.queue}: could not be created or found`);
  }
  const names = [...r.vectorize.map((v) => v.name), ...r.aiSearch.map((a) => a.name), ...(r.queue ? [r.queue] : [])];
  log(`  ai indexes: ${names.join(", ")}${created.length ? ` (${created.join("; ")})` : " (ok)"}`);
  return { queueId, created };
}

/** After the upload: this Worker consumes the indexing queue. */
export async function wireIndexingQueue(client: CfClient, worker: string, state: AiState, log: (l: string) => void): Promise<boolean> {
  if (!state.queueId) return false;
  const consumers = await client.call<Array<{ script?: string; script_name?: string; service?: string }>>("GET", `/queues/${state.queueId}/consumers`);
  if ((consumers ?? []).some((c) => (c.script ?? c.script_name ?? c.service) === worker)) return false;
  await client.call("POST", `/queues/${state.queueId}/consumers`, {
    type: "worker",
    script_name: worker,
    // Retries with the consumer's own backoff (msg.retry({ delaySeconds })); after them the shard re-sends.
    settings: { batch_size: 10, max_retries: 10, max_wait_time_ms: 500 },
  });
  log("  ai indexes: indexing queue consumer added");
  return true;
}

/**
 * After the new version is live: deletes this project/env's Vectorize indexes and AI Search instances that the
 * schema no longer uses (an index removed, or recreated with other dimensions / metric / model). `keep` = the
 * current resources; `all` = delete everything owned (ember destroy).
 */
export async function pruneAiResources(
  client: CfClient,
  project: string,
  env: string,
  keep: AiResources | null,
  log: (l: string) => void,
): Promise<string[]> {
  const deleted: string[] = [];
  const owner = `${vectorizeOwner(project, env)} `;
  const keepVec = new Set(keep?.vectorize.map((v) => v.name) ?? []);
  for (const ix of await listVectorize(client)) {
    if (!ix.description?.startsWith(owner) || keepVec.has(ix.name)) continue;
    await client.call("DELETE", `/vectorize/v2/indexes/${ix.name}`);
    deleted.push(`vectorize ${ix.name}`);
  }
  const prefix = aiSearchPrefix(project, env);
  const keepAis = new Set(keep?.aiSearch.map((a) => a.name) ?? []);
  for (const id of await listAiSearch(client, prefix)) {
    if (!id.startsWith(prefix) || keepAis.has(id)) continue;
    await client.call("DELETE", `${AIS}/${id}`);
    deleted.push(`ai-search ${id}`);
  }
  if (!keep?.queue) {
    const q = await findQueue(client, indexingQueueName(project, env));
    if (q) {
      await client.call("DELETE", `/queues/${q}`);
      deleted.push(`queue ${indexingQueueName(project, env)}`);
    }
  }
  if (deleted.length) log(`  ai indexes: deleted ${deleted.join(", ")}`);
  return deleted;
}

async function listVectorize(client: CfClient): Promise<Array<{ name: string; description?: string }>> {
  return (await client.call<Array<{ name: string; description?: string }>>("GET", "/vectorize/v2/indexes")) ?? [];
}

async function listAiSearch(client: CfClient, search: string): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await client.request<Array<{ id: string }>>("GET", `${AIS}?search=${encodeURIComponent(search)}&per_page=100&page=${page}`);
    if (!r.success) break;
    out.push(...(r.result ?? []).map((x) => x.id));
    if ((r.result ?? []).length < 100) break;
  }
  return out;
}

async function findQueue(client: CfClient, name: string): Promise<string | null> {
  const list = await client.call<Array<{ queue_id: string; queue_name: string }>>("GET", `/queues?name=${encodeURIComponent(name)}&per_page=100`);
  return (list ?? []).find((q) => q.queue_name === name)?.queue_id ?? null;
}
