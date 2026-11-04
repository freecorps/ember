// Ember Dashboard Worker (PLAN §21): deployed by `ember dashboard deploy` into the user's own account. Serves the SPA
// and a small JSON API over the account registry (D1 binding REGISTRY), Analytics Engine (SQL API) and each project's
// admin endpoints (`/api/_ember/status|data|crons`, through service bindings when present, else the public URL).
//
// Auth (every /api route):
//   1. Cloudflare Access (recommended): with ACCESS_TEAM_DOMAIN + ACCESS_AUD set, a valid `Cf-Access-Jwt-Assertion`
//      (RS256, team certs, audience, expiry) is required.
//   2. Admin token fallback: `Authorization: Bearer <DASHBOARD_TOKEN>` (secret).
//   Neither configured → 403. Access configured and a token sent → either passes.

import { functionStatsSql, parseFunctionStats, analyticsSql } from "./metrics-sql.ts";

export interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> } };
}

export interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DashboardEnv {
  REGISTRY?: D1Like;
  DASHBOARD_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Analytics Engine SQL (Account Analytics: Read). */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  METRICS_DATASET?: string;
  /** Admin token shared by the projects (their EMBER_ADMIN_TOKEN), or per Worker in EMBER_ADMIN_TOKENS. */
  EMBER_ADMIN_TOKEN?: string;
  /** JSON {"<worker>": "<token>"}. */
  EMBER_ADMIN_TOKENS?: string;
  /** JSON {"<worker>": "<binding name>"}: service bindings to project Workers (set by `ember dashboard deploy`). */
  EMBER_SERVICES?: string;
  [k: string]: unknown;
}

export interface Assets {
  html: string;
  js: string;
  css?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, code: string, message: string) => json({ ok: false, error: { code, message } }, status);

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ------------------------------------------------------------------------------------------- Cloudflare Access

type Jwk = JsonWebKey & { kid?: string };
const certCache = new Map<string, { at: number; keys: Jwk[] }>();

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function verifyAccessJwt(
  token: string,
  o: { teamDomain: string; aud: string; now?: number; fetch?: typeof fetch },
): Promise<{ email?: string; sub?: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string; sub?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0]!)));
    payload = JSON.parse(new TextDecoder().decode(b64url(parts[1]!)));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const now = (o.now ?? Date.now()) / 1000;
  const team = o.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(o.aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (payload.iss && payload.iss.replace(/\/+$/, "") !== `https://${team}`) return null;
  let cached = certCache.get(team);
  if (!cached || Date.now() - cached.at > 10 * 60_000 || !cached.keys.some((k) => k.kid === header.kid)) {
    const res = await (o.fetch ?? fetch)(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    cached = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys ?? [] };
    certCache.set(team, cached);
  }
  const jwk = cached.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  return { ...(payload.email ? { email: payload.email } : {}), ...(payload.sub ? { sub: payload.sub } : {}) };
}

export async function authorize(request: Request, env: DashboardEnv, fetchImpl?: typeof fetch): Promise<{ via: "access" | "token"; who?: string } | Response> {
  const accessOn = !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
  const tokenOn = typeof env.DASHBOARD_TOKEN === "string" && env.DASHBOARD_TOKEN.length > 0;
  if (!accessOn && !tokenOn) return err(403, "dashboard_locked", "configure Cloudflare Access (ACCESS_TEAM_DOMAIN + ACCESS_AUD) or the DASHBOARD_TOKEN secret");
  const bearer = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim();
  if (tokenOn && bearer && sameSecret(bearer, env.DASHBOARD_TOKEN!)) return { via: "token" };
  if (accessOn) {
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (jwt) {
      const who = await verifyAccessJwt(jwt, { teamDomain: env.ACCESS_TEAM_DOMAIN!, aud: env.ACCESS_AUD!, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
      if (who) return { via: "access", ...(who.email ? { who: who.email } : {}) };
    }
  }
  return err(401, "unauthenticated", accessOn ? "Cloudflare Access login or dashboard token required" : "dashboard token required");
}

// ------------------------------------------------------------------------------------------- project admin calls

function parseMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const m = JSON.parse(raw);
    return m && typeof m === "object" ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function environment(env: DashboardEnv, project: string, name: string) {
  const r = await env.REGISTRY!.prepare("SELECT project, env, worker, url FROM environments WHERE project = ? AND env = ?").bind(project, name).all<{ worker: string; url: string | null }>();
  return r.results[0] ?? null;
}

/** GET `path` on a project's Worker with its admin token (service binding first, else the public URL). */
export async function projectAdmin(env: DashboardEnv, target: { worker: string; url: string | null }, path: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const token = parseMap(env.EMBER_ADMIN_TOKENS)[target.worker] ?? env.EMBER_ADMIN_TOKEN;
  if (!token) return err(412, "no_admin_token", `no admin token for ${target.worker}: set EMBER_ADMIN_TOKEN (or EMBER_ADMIN_TOKENS) on the dashboard`);
  const headers = { authorization: `Bearer ${token}` };
  const binding = parseMap(env.EMBER_SERVICES)[target.worker];
  const svc = binding ? (env[binding] as FetcherLike | undefined) : undefined;
  if (svc && typeof svc.fetch === "function") return svc.fetch(new Request(`https://${target.worker}.internal${path}`, { headers }));
  if (!target.url) return err(412, "no_url", `${target.worker} has no known URL; redeploy the dashboard to bind it`);
  return fetchImpl(`${target.url.replace(/\/+$/, "")}${path}`, { headers });
}

const pass = async (res: Response) => new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });

// ------------------------------------------------------------------------------------------- API

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

export async function handleApi(request: Request, env: DashboardEnv, url: URL, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (request.method !== "GET") return err(405, "method_not_allowed", "read-only API");
  const auth = await authorize(request, env, fetchImpl);
  if (auth instanceof Response) return auth;
  if (url.pathname === "/api/me") return json({ ok: true, via: auth.via, who: auth.who ?? null, metrics: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID) });
  if (!env.REGISTRY) return err(500, "no_registry", "the REGISTRY binding is missing");
  const db = env.REGISTRY;
  const q = url.searchParams;
  const project = q.get("project");
  const envName = q.get("env");
  const needEnv = () => {
    if (!project || !NAME.test(project) || !envName || !NAME.test(envName)) return err(400, "bad_request", "?project=&env= required");
    return null;
  };

  switch (url.pathname) {
    case "/api/projects": {
      const projects = (await db.prepare("SELECT name, repo, created_at, updated_at FROM projects ORDER BY name").bind().all()).results;
      const envs = (
        await db
          .prepare(
            "SELECT e.project, e.env, e.worker, e.url, e.schema_version, e.version_id, e.updated_at, " +
              "(SELECT MAX(at) FROM deployments d WHERE d.project = e.project AND d.env = e.env) AS last_deploy, " +
              "(SELECT COUNT(*) FROM shards s WHERE s.project = e.project AND s.env = e.env) AS shards " +
              "FROM environments e ORDER BY e.project, e.env",
          )
          .bind()
          .all()
      ).results;
      const domains = (await db.prepare("SELECT host, project, env, kind FROM domains ORDER BY host").bind().all()).results;
      return json({ ok: true, projects: projects.map((p) => ({ ...p, envs: envs.filter((e) => e.project === p.name), domains: domains.filter((d) => d.project === p.name) })) });
    }
    case "/api/deployments": {
      const where = project ? (envName ? "WHERE project = ? AND env = ?" : "WHERE project = ?") : "";
      const params = [project, envName].filter((x): x is string => !!x);
      const rows = (await db.prepare(`SELECT * FROM deployments ${where} ORDER BY at DESC LIMIT 100`).bind(...params).all()).results;
      return json({ ok: true, deployments: rows });
    }
    case "/api/shards": {
      const bad = needEnv();
      if (bad) return bad;
      const rows = (await db.prepare("SELECT * FROM shards WHERE project = ? AND env = ? ORDER BY db_size DESC LIMIT 500").bind(project, envName).all<Record<string, unknown> & { shard: string }>()).results;
      let status: unknown = null;
      if (q.get("status") === "1" && rows.length) {
        const target = await environment(env, project!, envName!);
        if (target) {
          const qs = new URLSearchParams();
          for (const r of rows.slice(0, 50)) qs.append("shard", r.shard);
          const res = await projectAdmin(env, target, `/api/_ember/status?${qs}`, fetchImpl);
          status = res.ok ? await res.json() : { ok: false, status: res.status, error: await res.text() };
        }
      }
      return json({ ok: true, shards: rows, status });
    }
    case "/api/status":
    case "/api/crons":
    case "/api/data": {
      const bad = needEnv();
      if (bad) return bad;
      const target = await environment(env, project!, envName!);
      if (!target) return err(404, "not_found", `${project}/${envName} is not in the registry`);
      const fwd = new URLSearchParams();
      for (const k of ["shard", "table", "cursor", "limit"]) for (const v of q.getAll(k)) fwd.append(k, v);
      const path = url.pathname === "/api/status" ? "/api/_ember/status" : url.pathname === "/api/crons" ? "/api/_ember/crons" : "/api/_ember/data";
      return pass(await projectAdmin(env, target, `${path}${fwd.size ? `?${fwd}` : ""}`, fetchImpl));
    }
    case "/api/functions": {
      if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return err(412, "metrics_unavailable", "set the CF_API_TOKEN secret (Account Analytics: Read) to query Analytics Engine");
      const hours = Number(q.get("hours") ?? 24);
      try {
        const sql = functionStatsSql({
          dataset: env.METRICS_DATASET ?? "ember_metrics",
          ...(project ? { project } : {}),
          ...(envName ? { env: envName } : {}),
          sinceHours: Number.isFinite(hours) ? hours : 24,
        });
        const r = await analyticsSql({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, sql, fetch: fetchImpl });
        return json({ ok: true, functions: parseFunctionStats(r) });
      } catch (e) {
        return err(502, "analytics_failed", (e as Error).message);
      }
    }
  }
  return err(404, "not_found", "not found");
}

export function createDashboard(assets: Assets) {
  return {
    async fetch(request: Request, env: DashboardEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
      const sec = {
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
      };
      if (url.pathname === "/app.js") return new Response(assets.js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", ...sec } });
      if (url.pathname === "/app.css" && assets.css) return new Response(assets.css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache", ...sec } });
      return new Response(assets.html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          ...sec,
        },
      });
    },
  };
}
