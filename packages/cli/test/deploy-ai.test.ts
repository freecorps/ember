// `ember deploy` with external indexes against a mocked Cloudflare API (PLAN §6): Vectorize indexes + metadata
// indexes, AI Search instances, the indexing queue + consumer, bindings on every deploy, a new index when dimensions
// change (the old one deleted only after the new version is live), ownership-safe pruning, and teardown.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defineSchema, defineTable, v } from "@freecorps/ember-server";
import { projectFrom, type EmberConfigFile } from "../src/config.ts";
import { aiSearchInstanceName, deploy, planAiResources, vectorizeIndexName, type DeployOptions } from "../src/deploy/index.ts";
import { destroy } from "../src/destroy.ts";
import { miniflareOptions } from "../src/local.ts";
import { TMP } from "./helpers.ts";

const root = join(TMP, `deploy-ai-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const config: EmberConfigFile = { project: "kb", account: "acc123", compatibilityDate: "2026-10-01", environments: { prod: {} } };
const project = projectFrom(root, config);
const CODE = "export default {}";

const schemaWith = (dims: number, withAi = true) =>
  defineSchema({
    tables: withAi
      ? {
          notes: defineTable({ title: v.string(), body: v.string(), lang: v.string(), stars: v.number(), vec: v.array(v.number()) })
            .vectorIndex("by_vec", { vectorField: "vec", dimensions: dims, filterFields: ["lang", "stars"] })
            .vectorIndex("semantic", { embed: "body" })
            .aiSearchIndex("hybrid", { fields: ["title", "body"], filterFields: ["lang"] }),
        }
      : { notes: defineTable({ title: v.string() }) },
  }).manifest;

const prebuilt = (schema: ReturnType<typeof schemaWith>): NonNullable<DeployOptions["prebuilt"]> => ({
  build: { code: CODE, entry: "entry.mjs", outFile: "index.js", bytes: CODE.length, sha256: "f".repeat(64), auth: null },
  hasCrons: false,
  schemaVersion: schema.version,
  schema,
});

type Call = { method: string; path: string; json?: any; metadata?: any };

/** In-memory Cloudflare: Workers, Vectorize, AI Search, Queues. */
function fakeCloudflare() {
  const state = {
    workerExists: false,
    vectorize: new Map<string, { description?: string; config: any; meta: Map<string, string> }>(),
    ais: new Map<string, any>(),
    queues: new Map<string, { id: string; consumers: string[] }>(),
  };
  // Another project whose names share the prefix "ember-kb-prod-" must never be touched.
  state.vectorize.set("ember-kb-prod-x-other-12345678", { description: "ember:kb-prod/x other.idx (3/cosine/)", config: { dimensions: 3, metric: "cosine" }, meta: new Map() });
  state.ais.set("ember-kb-prod-x__other_idx_abcdef", { id: "ember-kb-prod-x__other_idx_abcdef" });
  const calls: Call[] = [];
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const no = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });
  const W = "/workers/scripts/ember-kb-prod";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4/accounts/acc123", "");
    const call: Call = { method: init?.method ?? "GET", path: path + url.search };
    if (init?.body instanceof FormData) call.metadata = JSON.parse(await (init.body.get("metadata") as Blob).text());
    else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
    calls.push(call);
    const m = `${call.method} ${path}`;
    if (m === `GET ${W}/deployments`) return state.workerExists ? ok({ deployments: [{ versions: [{ version_id: "v1", percentage: 100 }] }] }) : no(404, 10007, "no worker");
    if (m.startsWith("GET /workers/durable_objects/namespaces")) return ok(state.workerExists ? [{ script: "ember-kb-prod", class: "Shard" }, { script: "ember-kb-prod", class: "System" }] : []);
    if (m === `GET ${W}/secrets`) return ok([]);
    if (m === `PUT ${W}` || m === `POST ${W}/versions`) {
      state.workerExists = true;
      return ok({ id: "v2" });
    }
    if (m === `POST ${W}/deployments` || m === `PUT ${W}/schedules` || m === `POST ${W}/subdomain`) return ok({});
    if (m === `DELETE ${W}`) {
      state.workerExists = false;
      return ok({});
    }
    if (m === "GET /workers/subdomain") return ok({ subdomain: "acme" });
    // Vectorize
    if (m === "GET /vectorize/v2/indexes") return ok([...state.vectorize].map(([name, x]) => ({ name, description: x.description, config: x.config })));
    if (m === "POST /vectorize/v2/indexes") {
      state.vectorize.set(call.json.name, { description: call.json.description, config: call.json.config, meta: new Map() });
      return ok({ name: call.json.name });
    }
    let r = /^(GET|POST|DELETE) \/vectorize\/v2\/indexes\/([^/]+)(\/metadata_index\/(list|create|delete))?$/.exec(m);
    if (r) {
      const ix = state.vectorize.get(r[2]!);
      if (!ix) return no(404, 3000, "index not found");
      if (r[1] === "DELETE" && !r[3]) {
        state.vectorize.delete(r[2]!);
        return ok({});
      }
      if (r[4] === "list") return ok({ metadataIndexes: [...ix.meta].map(([propertyName, indexType]) => ({ propertyName, indexType })) });
      if (r[4] === "create") ix.meta.set(call.json.propertyName, call.json.indexType);
      if (r[4] === "delete") ix.meta.delete(call.json.propertyName);
      return ok({});
    }
    // AI Search (default namespace)
    if (m === "GET /ai-search/namespaces/default/instances") {
      const search = url.searchParams.get("search") ?? "";
      return ok([...state.ais.keys()].filter((id) => id.includes(search)).map((id) => ({ id })));
    }
    if (m === "POST /ai-search/namespaces/default/instances") {
      state.ais.set(call.json.id, { ...call.json });
      return ok(call.json);
    }
    r = /^(GET|PUT|DELETE) \/ai-search\/namespaces\/default\/instances\/([^/]+)$/.exec(m);
    if (r) {
      const inst = state.ais.get(r[2]!);
      if (!inst) return no(404, 7002, "instance not found");
      if (r[1] === "PUT") Object.assign(inst, call.json);
      if (r[1] === "DELETE") state.ais.delete(r[2]!);
      return ok(inst);
    }
    // Queues
    if (m === "GET /queues") return ok([...state.queues].filter(([n]) => n === url.searchParams.get("name")).map(([queue_name, q]) => ({ queue_id: q.id, queue_name })));
    if (m === "POST /queues") {
      state.queues.set(call.json.queue_name, { id: "q1", consumers: [] });
      return ok({ queue_id: "q1", queue_name: call.json.queue_name });
    }
    if (m === "GET /queues/q1/consumers") return ok([...state.queues.values()][0]!.consumers.map((script) => ({ script })));
    if (m === "POST /queues/q1/consumers") {
      [...state.queues.values()][0]!.consumers.push(call.json.script_name);
      return ok({});
    }
    if (m === "DELETE /queues/q1") {
      for (const [n, q] of state.queues) if (q.id === "q1") state.queues.delete(n);
      return ok({});
    }
    return no(500, 0, `unexpected ${m}`);
  }) as typeof fetch;
  return { state, calls, fetchImpl };
}

const run = (cf: ReturnType<typeof fakeCloudflare>, schema: ReturnType<typeof schemaWith>, extra: Partial<DeployOptions> = {}) => {
  const log: string[] = [];
  return deploy(project, { env: "prod", prebuilt: prebuilt(schema), fetch: cf.fetchImpl, token: "t", registry: false, sleep: async () => {}, log: (l) => log.push(l), ...extra }).then((r) => ({ r, log }));
};

describe("deploy: external index resources", () => {
  const cf = fakeCloudflare();
  const s3 = schemaWith(3);
  const plan3 = planAiResources(s3, "kb", "prod");
  const vecName = plan3.vectorize[0]!.name;
  const aisName = aiSearchInstanceName("kb", "prod", "notes", "hybrid");

  it("names are deterministic, valid and owned", () => {
    expect(vecName).toMatch(/^ember-kb-prod-notes-by-vec-[0-9a-f]{8}$/);
    expect(vecName).toBe(vectorizeIndexName("kb", "prod", "notes", "by_vec", "3/cosine/"));
    expect(plan3.vectorize[1]!.name).not.toBe(vectorizeIndexName("kb", "prod", "notes", "semantic", "1024/cosine/"));
    expect(aisName).toMatch(/^ember-kb-prod__notes_hybrid_[0-9a-f]{6}$/);
    expect(aisName).toMatch(/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/);
    expect(aisName.length).toBeLessThanOrEqual(64);
    expect(plan3).toMatchObject({ ai: true, queue: "ember-kb-prod-indexing" });
  });

  it("first deploy: indexes (+ metadata indexes), instance, queue + consumer, bindings", async () => {
    const { r, log } = await run(cf, s3);
    expect(cf.state.vectorize.get(vecName)).toMatchObject({ description: `ember:kb/prod notes.by_vec (3/cosine/)`, config: { dimensions: 3, metric: "cosine" } });
    expect(Object.fromEntries(cf.state.vectorize.get(vecName)!.meta)).toEqual({ lang: "string", stars: "number" });
    expect(cf.state.vectorize.get(plan3.vectorize[1]!.name)!.config).toEqual({ dimensions: 1024, metric: "cosine" });
    expect(cf.state.ais.get(aisName)).toMatchObject({
      id: aisName,
      cache: false,
      embedding_model: "@cf/baai/bge-m3",
      custom_metadata: [{ field_name: "lang", data_type: "text" }],
      retrieval_options: { keyword_match_mode: "or" },
    });
    expect(cf.state.queues.get("ember-kb-prod-indexing")!.consumers).toEqual(["ember-kb-prod"]);
    const upload = cf.calls.find((c) => c.metadata)!;
    expect(upload.metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: "vectorize", name: "EMBER_VEC__notes__by_vec", index_name: vecName },
        { type: "vectorize", name: "EMBER_VEC__notes__semantic", index_name: plan3.vectorize[1]!.name },
        { type: "ai_search", name: "EMBER_AIS__notes__hybrid", instance_name: aisName },
        { type: "ai", name: "EMBER_AI" },
        { type: "queue", name: "EMBER_INDEXING", queue_name: "ember-kb-prod-indexing" },
      ]),
    );
    // Resources exist before the upload that binds them.
    const firstUpload = cf.calls.findIndex((c) => c.metadata);
    expect(cf.calls.findIndex((c) => c.method === "POST" && c.path === "/vectorize/v2/indexes")).toBeLessThan(firstUpload);
    expect(cf.calls.findIndex((c) => c.method === "POST" && c.path === "/ai-search/namespaces/default/instances")).toBeLessThan(firstUpload);
    expect(r.ai!.created.length).toBeGreaterThan(0);
    expect(r.ai!.deleted).toEqual([]);
    expect(log.join("\n")).toContain("ai indexes:");
  });

  it("code-only redeploy: nothing created or deleted, bindings sent again", async () => {
    cf.calls.length = 0;
    const { r } = await run(cf, s3);
    expect(r.plan.strategy).toBe("code-only");
    expect(r.ai).toMatchObject({ created: [], deleted: [] });
    expect(cf.calls.filter((c) => c.method !== "GET" && /vectorize|ai-search|queues/.test(c.path))).toEqual([]);
    const meta = cf.calls.find((c) => c.metadata)!.metadata;
    expect(meta.bindings.filter((b: any) => ["vectorize", "ai_search", "ai"].includes(b.type))).toHaveLength(4);
  });

  it("dimensions change: a new Vectorize index; the old one is deleted after the deploy, other projects untouched", async () => {
    cf.calls.length = 0;
    const s4 = schemaWith(4);
    const newName = planAiResources(s4, "kb", "prod").vectorize[0]!.name;
    expect(newName).not.toBe(vecName);
    const { r } = await run(cf, s4);
    expect(cf.state.vectorize.has(newName)).toBe(true);
    expect(cf.state.vectorize.has(vecName)).toBe(false);
    expect(r.ai!.deleted).toEqual([`vectorize ${vecName}`]);
    const del = cf.calls.findIndex((c) => c.method === "DELETE" && c.path === `/vectorize/v2/indexes/${vecName}`);
    expect(del).toBeGreaterThan(cf.calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/deployments")));
    expect(cf.state.vectorize.has("ember-kb-prod-x-other-12345678")).toBe(true);
    expect(cf.state.ais.has("ember-kb-prod-x__other_idx_abcdef")).toBe(true);
  });

  it("gradual deploys never prune (the previous version still binds the old resources)", async () => {
    const { log } = await run(cf, schemaWith(5), { gradual: 10 });
    expect(log.join("\n")).toContain("prune skipped");
    expect([...cf.state.vectorize.keys()].filter((n) => n.startsWith("ember-kb-prod-notes-by-vec-"))).toHaveLength(2);
    await run(cf, schemaWith(5)); // 100%: prunes the 4-dimension index
    expect([...cf.state.vectorize.keys()].filter((n) => n.startsWith("ember-kb-prod-notes-by-vec-"))).toHaveLength(1);
  });

  it("removing every external index deletes the env's resources and the queue", async () => {
    const { r } = await run(cf, schemaWith(3, false));
    expect(r.ai!.deleted.sort()).toEqual(expect.arrayContaining([`ai-search ${aisName}`, "queue ember-kb-prod-indexing"]));
    expect([...cf.state.vectorize.keys()]).toEqual(["ember-kb-prod-x-other-12345678"]);
    expect([...cf.state.ais.keys()]).toEqual(["ember-kb-prod-x__other_idx_abcdef"]);
    expect(cf.state.queues.size).toBe(0);
    // Nothing left to prune: later deploys make no AI calls at all.
    cf.calls.length = 0;
    const again = await run(cf, schemaWith(3, false));
    expect(again.r.ai).toBeUndefined();
    expect(cf.calls.some((c) => /vectorize|ai-search/.test(c.path))).toBe(false);
  });

  it("ember destroy: deletes the Worker and everything the env owns (and nothing else)", async () => {
    await run(cf, s3);
    const log: string[] = [];
    await expect(destroy(project, { env: "prod", fetch: cf.fetchImpl, token: "t", log: (l) => log.push(l) })).rejects.toThrow(/--yes/);
    const r = await destroy(project, { env: "prod", yes: true, fetch: cf.fetchImpl, token: "t", log: (l) => log.push(l) });
    expect(r.deleted).toEqual(expect.arrayContaining(["worker ember-kb-prod", `ai-search ${aisName}`, "queue ember-kb-prod-indexing"]));
    expect(cf.state.workerExists).toBe(false);
    expect([...cf.state.vectorize.keys()]).toEqual(["ember-kb-prod-x-other-12345678"]);
    expect([...cf.state.ais.keys()]).toEqual(["ember-kb-prod-x__other_idx_abcdef"]);
    expect(cf.state.queues.size).toBe(0);
  });

  it("ember dev: the local fallback is explicit (EMBER_AI_INDEXES=local)", () => {
    const o = miniflareOptions(project, prebuilt(s3).build, { persist: false }) as any;
    expect(o.workers[0].config.env.EMBER_AI_INDEXES).toEqual({ type: "text", value: "local" });
  });
});
