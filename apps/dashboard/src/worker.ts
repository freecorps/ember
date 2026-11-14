// Ember Dashboard Worker (PLAN §21): deployed by `ember dashboard deploy` into the user's own account. Serves the SPA
// and a JSON API over the account registry (D1 binding REGISTRY), Analytics Engine (SQL API) and each project's
// admin endpoints (`/api/_ember/*`, through service bindings when present, else the public URL).
//
// The contract (roles, endpoints, what each requires) is docs/design/contracts.md "Dashboard"; `ROUTES` below is the
// same table in code. In short:
//   - every /api route needs a login (auth.ts): Cloudflare Access or a dashboard token; roles `read` and `admin`;
//   - GET routes need `read`; every other method is a write: `admin`, Origin + CSRF token (security.ts), audited
//     before it runs (audit.ts), and a typed confirmation for destructive ones on protected environments;
//   - an admin endpoint the project's runtime does not have answers 501 `runtime_outdated` (projects.ts).

import { auditBegin, auditDenied, auditFinish, ensureTables, listAudit, type AuditEntry, type D1Like } from "./audit.ts";
import { accessConfigured, authenticate, type AuthEnv, type Principal, type Role } from "./auth.ts";
import { err, json, readJsonObject } from "./http.ts";
import {
  analyticsSql,
  functionErrorsSql,
  functionSeriesSql,
  functionStatsSql,
  parseFunctionErrors,
  parseFunctionSeries,
  parseFunctionStats,
  parseShardStats,
  shardStatsSql,
  bucketMinutes,
} from "./metrics-sql.ts";
import { environment, pass, probeCapabilities, projectAdmin, requireFeature, type ProjectEnv, type Target } from "./projects.ts";
import { checkConfirmation, checkWriteRequest, csrfToken, protectedEnvs } from "./security.ts";

export { verifyAccessJwt, authenticate, isAdminEmail, type Principal, type Role } from "./auth.ts";
export { projectAdmin, capabilities, clearCapabilities, adminTokenKey, LEGACY_ADMIN_FEATURES, type FetcherLike } from "./projects.ts";
export { summarizeArgs, DASHBOARD_DDL, type D1Like, type AuditRow } from "./audit.ts";
export { CSRF_HEADER } from "./security.ts";

export interface DashboardEnv extends AuthEnv, ProjectEnv {
  REGISTRY?: D1Like;
  /** Analytics Engine SQL (Account Analytics: Read). */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  METRICS_DATASET?: string;
  /** Origins allowed to write (comma-separated); default: the dashboard's own. */
  DASHBOARD_ORIGIN?: string;
  /** Environments whose destructive actions need the typed confirmation; default "prod,production". */
  DASHBOARD_PROTECTED_ENVS?: string;
  [k: string]: unknown;
}

export interface Assets {
  html: string;
  js: string;
  css?: string;
}

/** Back-compat name: who the caller is, or the refusal. */
export async function authorize(request: Request, env: DashboardEnv, fetchImpl?: typeof fetch): Promise<{ via: "access" | "token"; who?: string; role: Role } | Response> {
  const p = await authenticate(request, env, fetchImpl);
  if (p instanceof Response) return p;
  return { via: p.via, role: p.role, ...(p.via === "access" ? { who: p.actor } : {}) };
}

// ------------------------------------------------------------------------------------------- routes

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** Same rule as the runtime's `isValidShardName`. */
const SHARD = /^[A-Za-z][A-Za-z0-9_]{0,63}:[^\s]{1,190}$/;
const LABEL = /^[\w.:@-]{1,80}$/;
const BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{16,}$/i;
/** An app table the dashboard may edit: not internal (`_jobs`...) nor a component's (`rl$buckets`). */
const TABLE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DOC_ID = /^[A-Za-z0-9_-]{1,200}$/;

interface Ctx {
  request: Request;
  env: DashboardEnv;
  url: URL;
  q: URLSearchParams;
  who: Principal;
  fetch: typeof fetch;
}

interface ReadRoute {
  method: "GET";
  path: string;
  role: Role;
  /** Admin endpoint of the project this route needs (checked against its capabilities). */
  feature?: string;
  summary: string;
  run(c: Ctx): Promise<Response>;
}

/** A validated write: where it lands, what the audit log says, what to type to confirm it. */
interface WritePlan {
  /** Overrides the route's audit action (e.g. `function.run_as`). */
  action?: string;
  project: string;
  env: string;
  shard?: string;
  target: string;
  args: unknown;
  /** Text the caller types to confirm (destructive actions on protected environments). */
  confirm: string;
  run(c: Ctx, target: Target): Promise<Response>;
}

interface WriteRoute {
  method: "POST";
  path: string;
  role: "admin";
  /** Audit action name. */
  action: string;
  destructive: boolean;
  feature: string;
  summary: string;
  plan(body: Record<string, unknown>): WritePlan | Response;
}

export type Route = ReadRoute | WriteRoute;

const str = (v: unknown) => (typeof v === "string" ? v : "");

function scope(q: URLSearchParams): { project: string; env: string } | Response {
  const project = q.get("project") ?? "";
  const envName = q.get("env") ?? "";
  if (!NAME.test(project) || !NAME.test(envName)) return err(400, "bad_request", "?project=&env= required");
  return { project, env: envName };
}

function bodyScope(b: Record<string, unknown>, needShard: boolean): { project: string; env: string; shard: string } | Response {
  const project = str(b.project);
  const envName = str(b.env);
  const shard = str(b.shard);
  if (!NAME.test(project) || !NAME.test(envName)) return err(400, "bad_request", "body needs project and env");
  if (needShard && !SHARD.test(shard)) return err(400, "bad_shard", `invalid shard ${JSON.stringify(b.shard)}`);
  return { project, env: envName, shard };
}

/** Resolves ?project&env to its registry entry (404 when unknown) and checks the runtime has `feature`. */
async function targetOf(c: Ctx, feature: string): Promise<{ target: Target } | Response> {
  const s = scope(c.q);
  if (s instanceof Response) return s;
  if (!c.env.REGISTRY) return err(500, "no_registry", "the REGISTRY binding is missing");
  const target = await environment(c.env.REGISTRY, s.project, s.env);
  if (!target) return err(404, "not_found", `${s.project}/${s.env} is not in the registry`);
  const old = await requireFeature(c.env, target, feature, c.fetch);
  return old ?? { target };
}

/** GET passthrough to a runtime admin endpoint, forwarding only the listed query parameters. */
function adminGet(path: string, feature: string, params: string[], summary: string): ReadRoute {
  return {
    method: "GET",
    path,
    role: "read",
    feature,
    summary,
    async run(c) {
      const t = await targetOf(c, feature);
      if (t instanceof Response) return t;
      const fwd = new URLSearchParams();
      for (const k of params) for (const v of c.q.getAll(k)) fwd.append(k, v);
      return pass(await projectAdmin(c.env, t.target, `/api/_ember/${feature}${fwd.size ? `?${fwd}` : ""}`, c.fetch), t.target, feature);
    },
  };
}

async function analytics(c: Ctx, sql: () => string): Promise<{ data: Array<Record<string, unknown>> } | Response> {
  if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) return err(412, "metrics_unavailable", "set the CF_API_TOKEN secret (Account Analytics: Read) to query Analytics Engine");
  let text: string;
  try {
    text = sql();
  } catch (e) {
    return err(400, "bad_request", (e as Error).message);
  }
  try {
    return await analyticsSql({ accountId: c.env.CF_ACCOUNT_ID, token: c.env.CF_API_TOKEN, sql: text, fetch: c.fetch });
  } catch (e) {
    return err(502, "analytics_failed", (e as Error).message);
  }
}

const hoursOf = (q: URLSearchParams) => {
  const h = Number(q.get("hours") ?? 24);
  return Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 90) : 24;
};

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Document writes (`POST /api/doc/<op>`): forwarded to the runtime's `/api/_ember/data/<op>`, which runs them as
 * mutations. The audit log keeps the table, the ids and the field names, never the values (they are user data).
 */
function docWrite(op: "insert" | "patch" | "replace" | "delete", action: string, destructive: boolean, summary: string): WriteRoute {
  return {
    method: "POST",
    path: `/api/doc/${op}`,
    role: "admin",
    action,
    destructive,
    feature: `data/${op}`,
    summary,
    plan(b) {
      const s = bodyScope(b, true);
      if (s instanceof Response) return s;
      const table = str(b.table);
      if (!TABLE.test(table)) return err(400, "bad_request", "table: an app table (internal and component tables are read-only)");
      const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
      let forward: Record<string, unknown>;
      let args: Record<string, unknown>;
      let target: string;
      if (op === "delete") {
        const ids = Array.isArray(b.ids) ? b.ids : [];
        if (!ids.length || ids.length > 100 || !ids.every((i): i is string => typeof i === "string" && DOC_ID.test(i))) return err(400, "bad_request", "ids: 1 to 100 document ids");
        forward = { table, ids };
        args = { table, ids };
        target = ids.length === 1 ? ids[0]! : `${ids.length} documents of ${table}`;
      } else {
        const id = str(b.id);
        if (op !== "insert" && !DOC_ID.test(id)) return err(400, "bad_request", "id: a document id");
        const value = obj(op === "patch" ? b.fields : b.doc);
        if (!value) return err(400, "bad_request", `${op === "patch" ? "fields" : "doc"} must be an object`);
        forward = { table, ...(op === "insert" ? {} : { id }), [op === "patch" ? "fields" : "doc"]: value };
        args = { table, ...(op === "insert" ? {} : { id }), fields: Object.keys(value).slice(0, 50) };
        target = op === "insert" ? table : id;
      }
      return {
        ...s,
        target,
        args,
        confirm: table,
        run: async (c, t) => pass(await projectAdmin(c.env, t, `/api/_ember/data/${op}`, c.fetch, { method: "POST", body: { shard: s.shard, ...forward } }), t, `data/${op}`),
      };
    },
  };
}

export const ROUTES: Route[] = [
  {
    method: "GET",
    path: "/api/me",
    role: "read",
    summary: "who is signed in, their role, the CSRF token for writes, what is configured",
    async run(c) {
      const csrf = c.env.REGISTRY ? await csrfToken(c.env.REGISTRY, c.who).catch(() => null) : null;
      return json({
        ok: true,
        via: c.who.via,
        who: c.who.via === "access" ? c.who.actor : null,
        actor: c.who.actor,
        role: c.who.role,
        csrf,
        metrics: !!(c.env.CF_API_TOKEN && c.env.CF_ACCOUNT_ID),
        access: accessConfigured(c.env),
        protectedEnvs: protectedEnvs(c.env),
      });
    },
  },
  {
    method: "GET",
    path: "/api/projects",
    role: "read",
    summary: "projects, environments and domains of the registry",
    async run(c) {
      const db = c.env.REGISTRY!;
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
    },
  },
  {
    method: "GET",
    path: "/api/deployments",
    role: "read",
    summary: "deployments (?project&env optional)",
    async run(c) {
      const project = c.q.get("project");
      const envName = c.q.get("env");
      if ((project && !NAME.test(project)) || (envName && !NAME.test(envName))) return err(400, "bad_request", "invalid project or env");
      const where = project ? (envName ? "WHERE project = ? AND env = ?" : "WHERE project = ?") : "";
      const params = [project, envName].filter((x): x is string => !!x);
      const rows = (await c.env.REGISTRY!.prepare(`SELECT * FROM deployments ${where} ORDER BY at DESC LIMIT 100`).bind(...params).all()).results;
      return json({ ok: true, deployments: rows });
    },
  },
  {
    method: "GET",
    path: "/api/shards",
    role: "read",
    summary: "the shard catalog (?q= filters by name; &status=1 adds the live status of the first 50)",
    async run(c) {
      const s = scope(c.q);
      if (s instanceof Response) return s;
      const term = (c.q.get("q") ?? "").trim().slice(0, 100);
      const filter = term ? " AND shard LIKE ? ESCAPE '\\'" : "";
      const params: unknown[] = [s.project, s.env, ...(term ? [`%${likeEscape(term)}%`] : [])];
      const rows = (await c.env.REGISTRY!.prepare(`SELECT * FROM shards WHERE project = ? AND env = ?${filter} ORDER BY db_size DESC LIMIT 500`).bind(...params).all<Record<string, unknown> & { shard: string }>())
        .results;
      let status: unknown = null;
      if (c.q.get("status") === "1" && rows.length) {
        const target = await environment(c.env.REGISTRY!, s.project, s.env);
        if (target) {
          const qs = new URLSearchParams();
          for (const r of rows.slice(0, 50)) qs.append("shard", r.shard);
          const res = await projectAdmin(c.env, target, `/api/_ember/status?${qs}`, c.fetch);
          status = res.ok ? await res.json() : { ok: false, status: res.status, error: (await res.text()).slice(0, 500) };
        }
      }
      return json({ ok: true, shards: rows, status });
    },
  },
  adminGet("/api/status", "status", ["shard"], "live shard status: schema version, migrations, staged indexes"),
  adminGet("/api/crons", "crons", [], "crons and their System state"),
  adminGet("/api/data", "data", ["shard", "table", "cursor", "limit"], "tables of a shard, or a page of one (read-only)"),
  adminGet("/api/inspect", "inspect", ["shard"], "one shard's live counters (re-runs, subscriptions, SQL)"),
  adminGet("/api/bookmarks", "bookmarks", ["shard"], "point-in-time bookmarks of a shard"),
  adminGet("/api/schema", "schema", [], "the app's tables: document shape and indexes"),
  adminGet("/api/fn/list", "functions", [], "the app's functions: type, visibility, args shape, shard, sensitive"),
  adminGet("/api/reactivity", "reactivity", ["shard"], "live subscriptions, shared vs per-user results, re-runs per commit"),
  adminGet("/api/reactivity/profile", "reactivity/profile", ["shard", "key"], "one profiled run of a cached query: rows read vs returned, ember dev advice"),
  {
    method: "GET",
    path: "/api/fn/series",
    role: "read",
    summary: "one function over time: calls, errors, p50/p95, rows (Analytics Engine)",
    async run(c) {
      const s = scope(c.q);
      if (s instanceof Response) return s;
      const hours = hoursOf(c.q);
      const r = await analytics(c, () => functionSeriesSql({ dataset: c.env.METRICS_DATASET ?? "ember_metrics", ...s, fn: c.q.get("fn") ?? "", sinceHours: hours }));
      return r instanceof Response ? r : json({ ok: true, points: parseFunctionSeries(r), bucketMinutes: bucketMinutes(hours) });
    },
  },
  {
    method: "GET",
    path: "/api/fn/errors",
    role: "read",
    summary: "one function's last errors: time, code, shard (Analytics Engine)",
    async run(c) {
      const s = scope(c.q);
      if (s instanceof Response) return s;
      const r = await analytics(c, () => functionErrorsSql({ dataset: c.env.METRICS_DATASET ?? "ember_metrics", ...s, fn: c.q.get("fn") ?? "", sinceHours: hoursOf(c.q) }));
      return r instanceof Response ? r : json({ ok: true, errors: parseFunctionErrors(r) });
    },
  },
  {
    method: "POST",
    path: "/api/fn/run",
    role: "admin",
    action: "function.run",
    destructive: false,
    feature: "run",
    summary: "run a query, mutation or action (internal ones too); `as: { subject, claims? }` runs it as that user (audited as function.run_as)",
    plan(b) {
      const s = bodyScope(b, true);
      if (s instanceof Response) return s;
      const fn = str(b.fn);
      if (!/^[A-Za-z0-9_$./:-]{1,200}$/.test(fn) || fn.startsWith("_ember:")) return err(400, "bad_request", "fn: a function name (module:name)");
      const args = b.args === undefined ? {} : b.args;
      if (!args || typeof args !== "object" || Array.isArray(args)) return err(400, "bad_request", "args must be an object");
      let as: { subject: string; claims?: Record<string, unknown> } | null = null;
      if (b.as !== undefined && b.as !== null) {
        const a = b.as as { subject?: unknown; claims?: unknown };
        if (typeof a !== "object" || typeof a.subject !== "string" || !a.subject || a.subject.length > 200) return err(400, "bad_request", "as: { subject, claims? }");
        if (a.claims !== undefined && (!a.claims || typeof a.claims !== "object" || Array.isArray(a.claims))) return err(400, "bad_request", "as.claims must be an object");
        as = { subject: a.subject, ...(a.claims ? { claims: a.claims as Record<string, unknown> } : {}) };
      }
      return {
        ...s,
        target: fn,
        // Argument values are user data (a message, an email): the log keeps their names only, like document writes.
        args: { fn, fields: Object.keys(args as Record<string, unknown>).slice(0, 50), as: as?.subject ?? null },
        confirm: fn,
        // Acting as someone is its own audit action: easy to find, easy to alert on.
        ...(as ? { action: "function.run_as" } : {}),
        run: async (c, t) => pass(await projectAdmin(c.env, t, "/api/_ember/run", c.fetch, { method: "POST", body: { shard: s.shard, fn, args, ...(as ? { as } : {}) } }), t, "run"),
      };
    },
  },
  adminGet("/api/rows", "data/list", ["shard", "table", "index", "eq", "order", "cursor", "limit"], "a page of an app table through an index (eq on a prefix of its fields), asc or desc"),
  docWrite("insert", "doc.insert", false, "insert a document (validated by the engine)"),
  docWrite("patch", "doc.patch", false, "change fields of a document"),
  docWrite("replace", "doc.replace", false, "replace a document"),
  docWrite("delete", "doc.delete", true, "delete up to 100 documents (all or nothing; confirm with the table name)"),
  {
    method: "GET",
    path: "/api/capabilities",
    role: "read",
    summary: "admin endpoints the project's runtime has (level 1 = before capabilities existed)",
    async run(c) {
      const s = scope(c.q);
      if (s instanceof Response) return s;
      const target = await environment(c.env.REGISTRY!, s.project, s.env);
      if (!target) return err(404, "not_found", `${s.project}/${s.env} is not in the registry`);
      // The project's own refusal passes through (412 no_admin_token, 403 admin_disabled, 401, ...).
      const r = await probeCapabilities(c.env, target, c.fetch);
      return "caps" in r ? json({ ok: true, ...r.caps }) : r.error;
    },
  },
  {
    method: "GET",
    path: "/api/functions",
    role: "read",
    summary: "per-function calls, errors, p50/p95, rows (Analytics Engine)",
    async run(c) {
      const project = c.q.get("project") ?? undefined;
      const envName = c.q.get("env") ?? undefined;
      const r = await analytics(c, () =>
        functionStatsSql({ dataset: c.env.METRICS_DATASET ?? "ember_metrics", ...(project ? { project } : {}), ...(envName ? { env: envName } : {}), sinceHours: hoursOf(c.q) }),
      );
      return r instanceof Response ? r : json({ ok: true, functions: parseFunctionStats(r) });
    },
  },
  {
    method: "GET",
    path: "/api/hot-shards",
    role: "read",
    summary: "busiest shards by calls (Analytics Engine)",
    async run(c) {
      const s = scope(c.q);
      if (s instanceof Response) return s;
      const r = await analytics(c, () => shardStatsSql({ dataset: c.env.METRICS_DATASET ?? "ember_metrics", project: s.project, env: s.env, sinceHours: hoursOf(c.q) }));
      return r instanceof Response ? r : json({ ok: true, shards: parseShardStats(r) });
    },
  },
  {
    method: "GET",
    path: "/api/audit",
    role: "read",
    summary: "the audit log (?project&env optional, ?before=<id> pages)",
    async run(c) {
      const project = c.q.get("project");
      const envName = c.q.get("env");
      if ((project && !NAME.test(project)) || (envName && !NAME.test(envName))) return err(400, "bad_request", "invalid project or env");
      const before = Number(c.q.get("before") ?? 0);
      const limit = Number(c.q.get("limit") ?? 100);
      const rows = await listAudit(c.env.REGISTRY!, { project, env: envName, before: Number.isSafeInteger(before) && before > 0 ? before : null, limit: Number.isFinite(limit) ? limit : 100 });
      return json({ ok: true, entries: rows, next: rows.length ? rows[rows.length - 1]!.id : null });
    },
  },
  {
    method: "POST",
    path: "/api/bookmark",
    role: "admin",
    action: "bookmark.create",
    destructive: false,
    feature: "bookmark",
    summary: "record a point-in-time bookmark of a shard now",
    plan(b) {
      const s = bodyScope(b, true);
      if (s instanceof Response) return s;
      const label = b.label === undefined || b.label === "" ? "" : str(b.label);
      if (label && !LABEL.test(label)) return err(400, "bad_request", "label: up to 80 of [A-Za-z0-9_.:@-]");
      return {
        ...s,
        target: s.shard,
        args: { label: label || null },
        confirm: s.shard,
        run: async (c, target) => pass(await projectAdmin(c.env, target, "/api/_ember/bookmark", c.fetch, { method: "POST", body: { shard: s.shard, ...(label ? { label } : {}) } }), target, "bookmark"),
      };
    },
  },
  {
    method: "POST",
    path: "/api/restore",
    role: "admin",
    action: "shard.restore",
    destructive: true,
    feature: "restore",
    summary: "restore a shard to a bookmark (undoable: the answer carries the undo bookmark)",
    plan(b) {
      const s = bodyScope(b, true);
      if (s instanceof Response) return s;
      const bookmark = str(b.bookmark).trim();
      if (!BOOKMARK.test(bookmark)) return err(400, "bad_bookmark", "bookmark must look like 0000000a-0000000b-0000000c-<hash>");
      const label = b.label === undefined || b.label === "" ? "" : str(b.label);
      if (label && !LABEL.test(label)) return err(400, "bad_request", "label: up to 80 of [A-Za-z0-9_.:@-]");
      return {
        ...s,
        target: s.shard,
        args: { bookmark, label: label || null },
        confirm: s.shard,
        run: async (c, target) =>
          pass(await projectAdmin(c.env, target, "/api/_ember/restore", c.fetch, { method: "POST", body: { shard: s.shard, bookmark, ...(label ? { label } : {}) } }), target, "restore"),
      };
    },
  },
];

const byPath = new Map<string, Route[]>();
for (const r of ROUTES) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);

/** Runs a write: role, Origin/CSRF, body, capability, confirmation, then audited execution. */
/** Where a refused write was aimed (from its body, best effort), for the audit log. */
async function attemptOf(route: WriteRoute, request: Request): Promise<AuditEntry> {
  try {
    const b = (await request.clone().json()) as Record<string, unknown>;
    const pick = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
    // A refused attempt to act as someone is logged as such (the case worth alerting on), like an accepted one.
    const action = route.path === "/api/fn/run" && b.as && typeof b.as === "object" ? "function.run_as" : route.action;
    return { action, project: pick(b.project, NAME), env: pick(b.env, NAME), shard: pick(b.shard, SHARD) };
  } catch {
    return { action: route.action };
  }
}

async function write(route: WriteRoute, c: Ctx): Promise<Response> {
  const db = c.env.REGISTRY;
  const attempt = await attemptOf(route, c.request);
  if (c.who.role !== "admin") {
    await auditDenied(db, c.who, attempt, 403, "forbidden");
    return err(403, "forbidden", `${attempt.action} needs the admin role (signed in as ${c.who.actor}, role ${c.who.role})`);
  }
  if (!db) return err(500, "no_registry", "the REGISTRY binding is missing (writes are audited there)");
  const bad = await checkWriteRequest(c.request, c.url, c.env, db, c.who);
  if (bad) {
    await auditDenied(db, c.who, attempt, bad.res.status, bad.code);
    return bad.res;
  }
  const body = await readJsonObject(c.request);
  if (body instanceof Response) return body;
  const plan = route.plan(body);
  if (plan instanceof Response) return plan;
  const target = await environment(db, plan.project, plan.env);
  if (!target) return err(404, "not_found", `${plan.project}/${plan.env} is not in the registry`);
  const old = await requireFeature(c.env, target, route.feature, c.fetch);
  if (old) return old;
  const unconfirmed = checkConfirmation({ destructive: route.destructive, envName: plan.env, protectedEnvs: protectedEnvs(c.env), expected: plan.confirm, sent: body.confirm });
  if (unconfirmed) return unconfirmed;
  const entry: AuditEntry = { action: plan.action ?? route.action, project: plan.project, env: plan.env, shard: plan.shard ?? null, target: plan.target, args: plan.args };
  let id: number;
  try {
    id = await auditBegin(db, c.who, entry);
  } catch (e) {
    return err(503, "audit_unavailable", `the audit log could not be written, so nothing was done (${(e as Error).message})`);
  }
  let res: Response;
  try {
    res = await plan.run(c, target);
  } catch (e) {
    await auditFinish(db, id, "error", 502, (e as Error).message).catch(() => undefined);
    return err(502, "project_unreachable", (e as Error).message);
  }
  let error: string | null = null;
  if (!res.ok) {
    const text = await res.clone().text();
    try {
      const b = JSON.parse(text) as { error?: { code?: string; message?: string } };
      error = b.error ? `${b.error.code ?? "error"}: ${b.error.message ?? ""}` : text;
    } catch {
      error = text;
    }
  }
  await auditFinish(db, id, res.ok ? "ok" : "error", res.status, error).catch(() => undefined);
  const headers = new Headers(res.headers);
  headers.set("x-ember-audit-id", String(id));
  return new Response(res.body, { status: res.status, headers });
}

export async function handleApi(request: Request, env: DashboardEnv, url: URL, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const routes = byPath.get(url.pathname);
  // No CORS: preflights and unknown methods get a plain refusal.
  const route = routes?.find((r) => r.method === request.method);
  if (routes && !route) return err(405, "method_not_allowed", `use ${routes.map((r) => r.method).join(" or ")}`);
  if (!route && request.method !== "GET") return err(405, "method_not_allowed", "method not allowed");
  const who = await authenticate(request, env, fetchImpl);
  if (who instanceof Response) return who;
  if (!route) return err(404, "not_found", "not found");
  if (!env.REGISTRY && route.path !== "/api/me") return err(500, "no_registry", "the REGISTRY binding is missing");
  if (env.REGISTRY) {
    try {
      await ensureTables(env.REGISTRY);
    } catch (e) {
      if (route.method !== "GET") return err(503, "audit_unavailable", `the dashboard tables could not be created (${(e as Error).message})`);
    }
  }
  const c: Ctx = { request, env, url, q: url.searchParams, who, fetch: fetchImpl };
  if (route.method === "POST") return write(route, c);
  if (route.role === "admin" && who.role !== "admin") return err(403, "forbidden", "needs the admin role");
  return route.run(c);
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

/** The SPA's CSP: own scripts and styles only, no inline code, no framing, API calls to the same origin. */
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function createDashboard(assets: Assets) {
  return {
    async fetch(request: Request, env: DashboardEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: SECURITY_HEADERS });
      if (url.pathname === "/app.js") return new Response(assets.js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", ...SECURITY_HEADERS } });
      if (url.pathname === "/app.css" && assets.css) return new Response(assets.css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache", ...SECURITY_HEADERS } });
      return new Response(assets.html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-security-policy": CSP, ...SECURITY_HEADERS },
      });
    },
  };
}
