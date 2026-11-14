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

export async function environment(db: D1Like, project: string, name: string): Promise<Target | null> {
  const r = await db.prepare("SELECT project, env, worker, url FROM environments WHERE project = ? AND env = ?").bind(project, name).all<Target>();
  return r.results[0] ?? null;
}

/** `path` on a project's Worker with its admin token (service binding first, else the public URL). */
export async function projectAdmin(
  env: ProjectEnv,
  target: Target,
  path: string,
  fetchImpl: typeof fetch = fetch,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<Response> {
  const token = parseMap(env.EMBER_ADMIN_TOKENS)[target.worker] ?? env.EMBER_ADMIN_TOKEN;
  if (!token) return err(412, "no_admin_token", `no admin token for ${target.worker}: set EMBER_ADMIN_TOKEN (or EMBER_ADMIN_TOKENS) on the dashboard`);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const method = init.method ?? "GET";
  let body: string | undefined;
  if (init.body !== undefined) {
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
  files: boolean | null;
  system: boolean | null;
}

const capCache = new Map<string, { at: number; caps: Capabilities | null }>();
const CAP_TTL_MS = 60_000;

/** The runtime's capabilities (cached a minute per Worker); null when the project could not be asked. */
export async function capabilities(env: ProjectEnv, target: Target, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<Capabilities | null> {
  const hit = capCache.get(target.worker);
  if (hit && now - hit.at < CAP_TTL_MS) return hit.caps;
  let caps: Capabilities | null = null;
  try {
    const res = await projectAdmin(env, target, "/api/_ember/capabilities", fetchImpl);
    if (res.ok) {
      const b = (await res.json()) as Partial<Capabilities>;
      caps = {
        level: Number(b.level) || 2,
        features: Array.isArray(b.features) ? b.features.filter((f): f is string => typeof f === "string") : [...LEGACY_ADMIN_FEATURES],
        auth: typeof b.auth === "boolean" ? b.auth : null,
        files: typeof b.files === "boolean" ? b.files : null,
        system: typeof b.system === "boolean" ? b.system : null,
      };
    } else if (res.status === 404) {
      caps = { level: 1, features: [...LEGACY_ADMIN_FEATURES], auth: null, files: null, system: null };
    } else {
      await res.body?.cancel();
    }
  } catch {
    caps = null;
  }
  // Only answers are cached: an unreachable project is asked again next time.
  if (caps) capCache.set(target.worker, { at: now, caps });
  return caps;
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
    return new Response(text, { status: 404, headers: { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  // Only JSON is passed on: anything else from a project is not rendered by the dashboard.
  if (!type.includes("json")) {
    await res.body?.cancel();
    return err(502, "bad_upstream", `${target.worker} answered ${res.status} with ${type || "no content type"}`);
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
