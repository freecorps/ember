// Calls to a project's admin endpoints (`/api/_ember/*` of @freecorps/ember-runtime) with its admin token: through a
// service binding when the dashboard has one for that Worker, else over its public URL. Plus runtime capability
// detection, so a newer dashboard in front of an older runtime says "update the runtime" instead of breaking.

import type { D1Like } from "./audit.ts";
import { err } from "./http.ts";

export interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface ProjectEnv {
  EMBER_ADMIN_TOKEN?: string;
  EMBER_ADMIN_TOKENS?: string;
  EMBER_SERVICES?: string;
  [k: string]: unknown;
}

export interface Target {
  project?: string;
  env?: string;
  worker: string;
  url: string | null;
}

function parseMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const m: unknown = JSON.parse(raw);
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Registry rows by binding, then `project\nenv`. Short-lived and per isolate: a redeploy that moves an environment
 * shows up within `ENV_TTL_MS`. Only resolved rows are kept (never a promise, which workerd cannot share across
 * requests), and only found ones: a new environment is visible at once. The registry is the whole account's, the
 * same for every signed-in caller, and this runs after authentication, so the cache holds no per-user data.
 */
const envCache = new WeakMap<D1Like, Map<string, { at: number; target: Target }>>();
export const ENV_TTL_MS = 10_000;
/** Entries per binding (oldest dropped first). */
const ENV_CACHE_MAX = 256;

export async function environment(db: D1Like, project: string, name: string, now = Date.now()): Promise<Target | null> {
  const key = `${project}\n${name}`;
  let cache = envCache.get(db);
  const hit = cache?.get(key);
  if (hit && now - hit.at < ENV_TTL_MS) return { ...hit.target };
  const r = await db.prepare("SELECT project, env, worker, url FROM environments WHERE project = ? AND env = ?").bind(project, name).all<Target>();
  const row = r.results[0];
  if (!row) {
    cache?.delete(key);
    return null;
  }
  const target: Target = { ...row, url: row.url ?? null };
  if (!cache) envCache.set(db, (cache = new Map()));
  cache.delete(key);
  cache.set(key, { at: now, target });
  while (cache.size > ENV_CACHE_MAX) cache.delete(cache.keys().next().value!);
  return { ...target };
}

/** Forget cached registry rows (tests). */
export function clearEnvironments(db?: D1Like): void {
  if (db) envCache.delete(db);
}

/**
 * Name of the dashboard secret holding `worker`'s admin token (`ember deploy` writes it next to the project's
 * EMBER_ADMIN_TOKEN_DASHBOARD): `EMBER_ADMIN_TOKEN__` + the Worker name upper-cased, `-` as `_`.
 */
export const adminTokenKey = (worker: string) => `EMBER_ADMIN_TOKEN__${worker.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** The admin token the dashboard uses for `worker`: EMBER_ADMIN_TOKENS[worker], its own secret, else EMBER_ADMIN_TOKEN. */
export function adminTokenFor(env: ProjectEnv, worker: string): string | undefined {
  const own = env[adminTokenKey(worker)];
  return parseMap(env.EMBER_ADMIN_TOKENS)[worker] ?? (typeof own === "string" && own ? own : undefined) ?? env.EMBER_ADMIN_TOKEN;
}

/** `path` on a project's Worker with its admin token (service binding first, else the public URL). */
export async function projectAdmin(
  env: ProjectEnv,
  target: Target,
  path: string,
  fetchImpl: typeof fetch = fetch,
  init: { method?: "GET" | "POST"; body?: unknown; raw?: ArrayBuffer } = {},
): Promise<Response> {
  const token = adminTokenFor(env, target.worker);
  if (!token) return err(412, "no_admin_token", `no admin token for ${target.worker}: set EMBER_ADMIN_TOKEN (or EMBER_ADMIN_TOKENS) on the dashboard`);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const method = init.method ?? "GET";
  let body: string | ArrayBuffer | undefined;
  if (init.raw !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = init.raw;
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const reqInit: RequestInit = { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual" };
  const binding = parseMap(env.EMBER_SERVICES)[target.worker];
  const svc = binding ? (env[binding] as FetcherLike | undefined) : undefined;
  if (svc && typeof svc.fetch === "function") return svc.fetch(new Request(`https://${target.worker}.internal${path}`, reqInit));
  if (!target.url) return err(412, "no_url", `${target.worker} has no known URL; redeploy the dashboard to bind it`);
  return fetchImpl(`${target.url.replace(/\/+$/, "")}${path}`, reqInit);
}

// ------------------------------------------------------------------------------------------- capabilities

/** Admin endpoints of runtimes from before `GET /api/_ember/capabilities` (admin API level 1). */
export const LEGACY_ADMIN_FEATURES = ["status", "data", "crons", "inspect", "bookmarks", "bookmark", "restore", "keys/rotate", "env/reveal"];

export interface Capabilities {
  level: number;
  features: string[];
  auth: boolean | null;
  /** Remote auth (SSO, or the backend the app is moving from): where users, sessions and keys live. */
  authFrom: string | null;
  files: boolean | null;
  system: boolean | null;
}

/**
 * Answers by Worker and how it is reached (URL), per isolate. Resolved values only: workerd does not let a request
 * await another request's I/O, so concurrent misses each ask (one probe per request at most). Capabilities say what a
 * runtime has, not who may use it: authorization stays in the dashboard's routes and the project's admin token.
 */
const capCache = new Map<string, { at: number; caps: Capabilities }>();
const CAP_TTL_MS = 60_000;
const CAP_CACHE_MAX = 256;
const capKey = (target: Target) => `${target.worker}\n${target.url ?? ""}`;

/** The runtime's capabilities (cached a minute per Worker); null when the project could not be asked. */
export async function capabilities(env: ProjectEnv, target: Target, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<Capabilities | null> {
  const r = await probeCapabilities(env, target, fetchImpl, now);
  return "caps" in r ? r.caps : null;
}

/** Like `capabilities`, but says why the project could not be asked (its refusal, e.g. 412 no_admin_token). */
export async function probeCapabilities(env: ProjectEnv, target: Target, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ caps: Capabilities } | { error: Response }> {
  const key = capKey(target);
  const hit = capCache.get(key);
  if (hit && now - hit.at < CAP_TTL_MS) return { caps: hit.caps };
  let caps: Capabilities | null = null;
  let error: Response | null = null;
  try {
    const res = await projectAdmin(env, target, "/api/_ember/capabilities", fetchImpl);
    if (res.ok) {
      const b = (await res.json()) as Partial<Capabilities>;
      caps = {
        level: Number(b.level) || 2,
        features: Array.isArray(b.features) ? b.features.filter((f): f is string => typeof f === "string") : [...LEGACY_ADMIN_FEATURES],
        auth: typeof b.auth === "boolean" ? b.auth : null,
        authFrom: typeof b.authFrom === "string" && b.authFrom ? b.authFrom : null,
        files: typeof b.files === "boolean" ? b.files : null,
        system: typeof b.system === "boolean" ? b.system : null,
      };
    } else if (res.status === 404) {
      caps = { level: 1, features: [...LEGACY_ADMIN_FEATURES], auth: null, authFrom: null, files: null, system: null };
    } else {
      error = await pass(res, target, "capabilities");
    }
  } catch (e) {
    error = err(502, "unreachable", `could not reach ${target.worker} (${(e as Error).message})`);
  }
  // Only answers are cached: an unreachable project is asked again next time.
  if (caps) {
    capCache.delete(key);
    capCache.set(key, { at: now, caps });
    while (capCache.size > CAP_CACHE_MAX) capCache.delete(capCache.keys().next().value!);
    return { caps };
  }
  return { error: error ?? err(502, "unreachable", `could not ask ${target.worker} for its capabilities`) };
}

/** Forget cached capabilities (tests; a redeploy shows up within a minute anyway). */
export function clearCapabilities(): void {
  capCache.clear();
}

export const outdated = (target: Target, feature: string) =>
  err(501, "runtime_outdated", `${target.worker} runs an @freecorps/ember-runtime without /api/_ember/${feature}: update the runtime and redeploy the project`, { feature });

/** null when the runtime has `feature` (or could not be asked: the call itself then reports the problem). */
export async function requireFeature(env: ProjectEnv, target: Target, feature: string, fetchImpl: typeof fetch = fetch): Promise<Response | null> {
  const caps = await capabilities(env, target, fetchImpl);
  if (caps && !caps.features.includes(feature)) return outdated(target, feature);
  return null;
}

/**
 * A project's response passed through. The runtime's generic `404 not_found "not found"` (an admin path it does not
 * know) becomes `runtime_outdated`, in case the capability check could not run.
 */
export async function pass(res: Response, target: Target, feature: string): Promise<Response> {
  const type = res.headers.get("content-type") ?? "application/json";
  if (res.status === 404 && type.includes("json")) {
    const text = await res.text();
    try {
      const b = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (b.error?.code === "not_found" && b.error.message === "not found") return outdated(target, feature);
    } catch {
      // not ours: pass it on
    }
    // Always declared JSON (a `text/html; x=json` would otherwise be rendered under the dashboard's origin).
    return new Response(text, { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  // Only JSON is passed on: anything else from a project is not rendered by the dashboard.
  if (!type.includes("json")) {
    await res.body?.cancel();
    return err(502, "bad_upstream", `${target.worker} answered ${res.status} with ${type || "no content type"}`);
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** POST raw bytes (a file upload) to a project's admin endpoint. */
export function projectAdminRaw(env: ProjectEnv, target: Target, path: string, fetchImpl: typeof fetch, bytes: ArrayBuffer): Promise<Response> {
  return projectAdmin(env, target, path, fetchImpl, { method: "POST", raw: bytes });
}
