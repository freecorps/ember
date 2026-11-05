// `ember dev --remote` (opt-in): the local Worker (Miniflare/workerd, local Durable Objects) with its Cloudflare-only
// bindings proxied to real resources of one environment, through wrangler's remote bindings
// (`startRemoteProxySession`, the same machinery as `remote: true` in wrangler.jsonc).
//
//   EMBER_AI                      Workers AI (embeddings for vectorIndex `embed`, and `ctx.env.EMBER_AI` in actions)
//   EMBER_VEC__<table>__<index>   the env's Vectorize indexes      (created with their metadata indexes when missing)
//   EMBER_BROWSER                 Browser Rendering (`ctx.browser`; resources.browser)
//   EMBER_IMAGES                  Images (resources.images)
//
// Everything else stays local: shards, auth, scheduler, R2 files (Miniflare), and the indexing queue (without one,
// the shard delivers to the remote index in its own turn).
//
// AI Search stays on the local fallback (shard SQLite, BM25): wrangler's remote proxy does not carry the AI Search
// instance binding (measured 2026-11-05 with wrangler 4.157: `items.upload` → "The RPC receiver does not implement
// the method upload", `search()` → "internal error"; AI Search is not in Cloudflare's remote-bindings list either). Trade-offs are in docs (PLAN §11, contracts.md):
// remote calls are billed and slower (each crosses the network), and dev writes land in the env's real indexes.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Project } from "./config.ts";
import { workerName } from "./config.ts";
import { ensureAiResources, planAiResources, type SchemaManifestLike } from "./deploy/ai.ts";
import { CfClient, resolveToken } from "./deploy/cf.ts";
import { CLI_ROOT } from "./source.ts";

/** What `miniflareOptions` binds remotely (binding name → resource). */
export interface RemoteBindings {
  connection: URL;
  ai: boolean;
  vectorize: Record<string, string>;
  aiSearch: Record<string, string>;
  browser: boolean;
  images: boolean;
}

/** wrangler `StartDevWorkerInput["bindings"]` for the proxy session. */
export type ProxyBindings = Record<string, { type: string; index_name?: string; instance_name?: string }>;

export interface RemotePlan {
  env: string;
  bindings: ProxyBindings;
  names: Omit<RemoteBindings, "connection">;
  /** External index resources to create when missing (Vectorize only; no queue: dev delivers in the shard's turn). */
  ai: ReturnType<typeof planAiResources>;
  /** aiSearchIndexes left on the local fallback (the remote proxy cannot carry AI Search). */
  localAiSearch: string[];
}

/** Remote bindings for `env` (pure: no API calls). */
export function planRemote(project: Project, env: string, schema: SchemaManifestLike): RemotePlan {
  const ai = planAiResources(schema, project.config.project, env);
  const r = project.config.resources ?? {};
  const bindings: ProxyBindings = { EMBER_AI: { type: "ai" } };
  const vectorize: Record<string, string> = {};
  const aiSearch: Record<string, string> = {};
  for (const v of ai.vectorize) {
    bindings[v.binding] = { type: "vectorize", index_name: v.name };
    vectorize[v.binding] = v.name;
  }
  if (r.browser) bindings.EMBER_BROWSER = { type: "browser" };
  if (r.images) bindings.EMBER_IMAGES = { type: "images" };
  return {
    env,
    bindings,
    names: { ai: true, vectorize, aiSearch, browser: !!r.browser, images: !!r.images },
    ai: { ...ai, aiSearch: [], queue: null },
    localAiSearch: ai.aiSearch.map((a) => `${a.table}.${a.index}`),
  };
}

/**
 * What the proxy session is bound to: binding names *and* the resources they point at. A schema change that keeps a
 * binding name but changes its index (shardIsolation, dimensions, metric, embed model → a new Vectorize index name)
 * changes this too, so `ember dev` can tell the session is stale.
 */
export function remoteFingerprint(plan: Pick<RemotePlan, "bindings">): string {
  return JSON.stringify(Object.entries(plan.bindings).sort(([a], [b]) => a.localeCompare(b)));
}

const MAX_WORKER_NAME = 63;
const PROXY_SUFFIX = "-dev-proxy";

/**
 * Name of the wrangler proxy Worker for `env`: `<worker>-dev-proxy`, or, when that would pass Cloudflare's 63-character
 * limit (a legal `ember-<project>-<env>` can be 63 itself), the worker name cut short plus a hash of the full one, so it
 * stays deterministic and distinct per project/env.
 */
export function devProxyName(project: string, env: string): string {
  const worker = workerName(project, env);
  const plain = `${worker}${PROXY_SUFFIX}`;
  if (plain.length <= MAX_WORKER_NAME) return plain;
  const hash = createHash("sha256").update(worker).digest("hex").slice(0, 8);
  const keep = MAX_WORKER_NAME - PROXY_SUFFIX.length - hash.length - 1;
  return `${worker.slice(0, keep).replace(/-+$/, "")}-${hash}${PROXY_SUFFIX}`;
}

/** Which env `--remote` binds to: `--env`, else `dev` when declared. Never silently prod. */
export function remoteEnv(project: Project, env: string | undefined): string {
  const envs = project.config.environments;
  if (env) {
    if (!envs[env]) throw new Error(`Unknown environment "${env}". Known: ${Object.keys(envs).join(", ")}`);
    return env;
  }
  if (envs.dev) return "dev";
  throw new Error(`ember dev --remote binds the resources of one environment: pass --env <name> (no "dev" environment in ember.json)`);
}

type Wrangler = {
  startRemoteProxySession(
    bindings: ProxyBindings,
    opts?: { workerName?: string; auth?: () => Promise<{ accountId: string; apiToken: { apiToken: string } }> },
  ): Promise<{ remoteProxyConnectionString: URL; ready: Promise<void>; dispose(): Promise<void> }>;
};

/** wrangler from the project (its devDependency), else the CLI's own resolution. */
async function loadWrangler(project: Project): Promise<Wrangler> {
  const spec = "wrangler";
  for (const from of [join(project.root, "package.json"), join(CLI_ROOT, "package.json")]) {
    try {
      const path = createRequire(from).resolve(spec);
      return (await import(pathToFileURL(path).href)) as Wrangler;
    } catch {
      // next
    }
  }
  throw new Error("ember dev --remote uses wrangler's remote bindings: install it (npm i -D wrangler, >= 4.40)");
}

export interface RemoteSession {
  bindings: RemoteBindings;
  plan: RemotePlan;
  dispose(): Promise<void>;
}

/**
 * Provisions the env's index resources if missing, then opens the proxy session. `auth` uses the same token as every
 * other command (CLOUDFLARE_API_TOKEN or the wrangler OAuth login), never printed.
 */
export async function startRemote(project: Project, env: string, schema: SchemaManifestLike, log: (l: string) => void): Promise<RemoteSession> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    throw new Error("ember dev --remote needs Node.js (wrangler's remote bindings do not work under Bun): run it with node / npx");
  }
  const accountId = project.config.environments[env]?.account ?? project.config.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error(`ember dev --remote: no Cloudflare account (set "account" in ember.json or CLOUDFLARE_ACCOUNT_ID)`);
  const token = resolveToken();
  const plan = planRemote(project, env, schema);
  if (plan.localAiSearch.length) log(`ember dev --remote: AI Search stays local (BM25 fallback) for ${plan.localAiSearch.join(", ")}: wrangler's remote proxy cannot carry AI Search bindings`);
  if (plan.ai.vectorize.length) {
    const client = new CfClient({ accountId, token });
    await ensureAiResources(client, plan.ai, log);
  }
  const wrangler = await loadWrangler(project);
  const session = await wrangler.startRemoteProxySession(plan.bindings, {
    workerName: devProxyName(project.config.project, env),
    auth: async () => ({ accountId, apiToken: { apiToken: token } }),
  });
  await session.ready;
  log(`remote bindings (${env}): ${Object.keys(plan.bindings).join(", ")}`);
  return { bindings: { connection: session.remoteProxyConnectionString, ...plan.names }, plan, dispose: () => session.dispose() };
}
