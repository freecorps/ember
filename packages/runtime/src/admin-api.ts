// Admin API extensions for the Ember Dashboard (docs/design/contracts.md "Dashboard"). The Worker checks the admin
// token (`EMBER_ADMIN_TOKEN`) before handing a request here; everything below runs as the project's administrator.
//
// `GET /api/_ember/capabilities` tells the dashboard which admin endpoints this runtime has, so a newer dashboard in
// front of an older runtime shows "update the runtime" instead of failing on a 404. A runtime without this endpoint
// is level 1 (the endpoints listed in `LEGACY_ADMIN_FEATURES` of the dashboard).

import { flattenFunctions, type ActionStorage, type Identity } from "@freecorps/ember-server";
import { resolvedCrons, type EmberConfig, type EmberEnv } from "./config.ts";
import { ADMIN_MODULE, schemaSummary } from "./admin-data.ts";
import type { ProfileResult, ReactivityReport } from "./reactivity.ts";
import { parse } from "./wire.ts";

/** Bumped whenever an admin endpoint is added or changes shape. */
export const ADMIN_API_LEVEL = 6;

/** Issuer of the identities the dashboard runs functions as ("act as user"): functions can tell them apart. */
export const DASHBOARD_ISSUER = "ember-dashboard";

/** Admin endpoints (paths under `/api/_ember/`) this runtime serves. */
export const ADMIN_FEATURES = [
  "capabilities",
  "status",
  "data",
  "crons",
  "inspect",
  "bookmarks",
  "bookmark",
  "restore",
  "keys/rotate",
  "env/reveal",
  // level 3: schema and data editing through the engine (admin-data.ts)
  "schema",
  "data/list",
  "data/insert",
  "data/patch",
  "data/replace",
  "data/delete",
  // level 4: function runner (act as a user), reactivity
  "functions",
  "run",
  "reactivity",
  "reactivity/profile",
  // level 5: schedules and files
  "jobs/run",
  "jobs/cancel",
  "crons/run",
  "files/content",
  "files/upload",
  "files/delete",
  // level 6: settings and users
  "env",
  "auth/users",
  "auth/sessions",
  "auth/revoke",
] as const;

/** Variables the reveal endpoint refuses besides EMBER_*: listed as managed. */
const MANAGED = new Set(["BETTER_AUTH_SECRET"]);

/** Largest upload through the admin endpoint (the dashboard's own limit is the same). */
export const ADMIN_UPLOAD_MAX = 25 * 1024 * 1024;

export type AdminFeature = (typeof ADMIN_FEATURES)[number];

export interface AdminCapabilities {
  ok: true;
  /** `ADMIN_API_LEVEL` of the runtime. */
  level: number;
  features: string[];
  /** Whether the deployment has a local Auth DO (users, sessions, key rotation). */
  auth: boolean;
  /** Whether files (R2) are bound. */
  files: boolean;
  /** Whether the system DO (crons, restore journal) is bound. */
  system: boolean;
}

/** The Shard RPCs these endpoints use (internal calls of the `_ember` functions). */
export interface AdminShardRpc {
  query(shard: string, fn: string, args: unknown, identity: Identity | null, internal: boolean): Promise<AdminOutcome>;
  mutation(shard: string, fn: string, args: unknown, identity: Identity | null, internal: boolean): Promise<AdminOutcome>;
  reactivity(shard: string): Promise<ReactivityReport>;
  profileQuery(shard: string, key: string): Promise<ProfileResult | null>;
}

type AdminOutcome = { ok: true; value?: unknown } | { ok: false; error: { code: string; message: string; data?: unknown } };

export interface AdminDeps {
  config: EmberConfig;
  env: EmberEnv;
  json: (body: unknown, status?: number) => Response;
  error: (status: number, code: string, message: string) => Response;
  /** The shard's stub (only for valid shard names). */
  stub: (shard: string) => AdminShardRpc;
  validShard: (shard: string) => boolean;
  /** Runs an action in this Worker (ActionRunner.run). */
  runAction: (fn: string, args: unknown, shard: string, identity: Identity | null) => Promise<AdminOutcome>;
  /** The shard's file storage (null without an EMBER_FILES bucket). */
  files: (shard: string) => ActionStorage | null;
  /** Ends an identity's live sockets on a shard (`Shard.revokeSockets`). */
  revokeSockets: (shard: string, match: { subject: string } | { claim: "sid"; value: string }) => Promise<{ sockets: number }>;
}

let fnCache: { config: EmberConfig; list: FunctionListing[] } | null = null;

export interface FunctionListing {
  name: string;
  type: "query" | "mutation" | "action";
  visibility: "public" | "internal";
  /** Args shape (`ObjectShape` of @freecorps/ember-values): the dashboard builds a form from it. */
  args: unknown;
  returns: unknown;
  shard: unknown;
  sensitive: boolean;
  authorize: boolean;
  errors: string[];
}

/** The app's functions (components included; not the dashboard's own `_ember` module, nor HTTP actions). */
export function functionListing(config: EmberConfig): FunctionListing[] {
  if (fnCache?.config === config) return fnCache.list;
  const list: FunctionListing[] = [];
  for (const [name, f] of flattenFunctions(config.functions)) {
    if (name.startsWith(`${ADMIN_MODULE}:`) || f.type === "httpAction") continue;
    const fn = f as unknown as { type: FunctionListing["type"]; visibility: FunctionListing["visibility"]; args: unknown; returns?: unknown; shard?: unknown; sensitive?: true; authorize?: unknown; errors?: ReadonlyArray<{ code?: string }> };
    list.push({
      name,
      type: fn.type,
      visibility: fn.visibility,
      args: fn.args,
      returns: fn.returns ?? null,
      shard: fn.shard ?? null,
      sensitive: fn.sensitive === true,
      authorize: typeof fn.authorize === "function",
      errors: (fn.errors ?? []).map((e) => String(e.code ?? "")).filter(Boolean),
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  fnCache = { config, list };
  return list;
}

/**
 * The identity a dashboard run uses: `{ subject }` plus the given claims, issuer `ember-dashboard`. Built here, in the
 * project's Worker, and handed to the function in-process: no token is minted, so nothing usable leaves the call.
 */
function actAs(raw: unknown): Identity | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "as must be { subject, claims? }" };
  const r = raw as { subject?: unknown; claims?: unknown };
  if (typeof r.subject !== "string" || !r.subject || r.subject.length > 200) return { error: "as.subject must be a non-empty string" };
  if (r.claims !== undefined && (typeof r.claims !== "object" || r.claims === null || Array.isArray(r.claims))) return { error: "as.claims must be an object" };
  const now = Math.floor(Date.now() / 1000);
  return { subject: r.subject, issuer: DASHBOARD_ISSUER, iat: now, exp: now + 60, ...(r.claims ? { claims: r.claims as Record<string, unknown> } : {}) };
}

/** HTTP status of an engine error from a dashboard data call. */
function statusOf(code: string): number {
  if (code === "NotFound" || code === "FunctionNotFound") return 404;
  if (code === "Forbidden") return 403;
  if (code === "ValidationError" || code === "QueryError" || code === "InvalidCursor" || code === "SchemaError" || code === "DocumentTooLarge") return 400;
  if (code === "IndexNotReady" || code === "MigrationRefused") return 409;
  return 500;
}

const DATA_WRITES: Record<string, string> = {
  "/api/_ember/data/insert": "dataInsert",
  "/api/_ember/data/patch": "dataPatch",
  "/api/_ember/data/replace": "dataReplace",
  "/api/_ember/data/delete": "dataDelete",
};

/**
 * Handles the admin endpoints added for the dashboard; null hands the request back to the Worker (the older ones live
 * there and in restore.ts). The caller has checked the admin token.
 */
export async function handleAdminApi(request: Request, url: URL, deps: AdminDeps): Promise<Response | null> {
  if (url.pathname === "/api/_ember/capabilities") {
    if (request.method !== "GET") return deps.error(405, "method_not_allowed", "use GET");
    const body: AdminCapabilities = {
      ok: true,
      level: ADMIN_API_LEVEL,
      features: [...ADMIN_FEATURES],
      auth: !!deps.config.auth?.rotateKeys,
      files: !!deps.env.EMBER_FILES,
      system: !!deps.env.SYSTEM,
    };
    return deps.json(body);
  }
  if (url.pathname === "/api/_ember/schema") {
    if (request.method !== "GET") return deps.error(405, "method_not_allowed", "use GET");
    return deps.json({ ok: true, ...schemaSummary(deps.config.schema.manifest) });
  }
  const reply = (r: AdminOutcome) =>
    r.ok ? deps.json({ ok: true, value: r.value ?? null }) : deps.json({ ok: false, error: r.error }, statusOf(r.error.code));
  if (url.pathname === "/api/_ember/data/list") {
    if (request.method !== "GET") return deps.error(405, "method_not_allowed", "use GET");
    const q = url.searchParams;
    const shard = q.get("shard") ?? "global:main";
    if (!deps.validShard(shard)) return deps.error(400, "bad_shard", `invalid shard ${JSON.stringify(shard)}`);
    let eq: unknown;
    try {
      eq = q.has("eq") ? parse(q.get("eq")!) : undefined;
    } catch {
      return deps.error(400, "bad_request", "eq must be a JSON array");
    }
    if (eq !== undefined && !Array.isArray(eq)) return deps.error(400, "bad_request", "eq must be a JSON array");
    const order = q.get("order");
    const args = {
      table: q.get("table") ?? "",
      ...(q.get("index") ? { index: q.get("index")! } : {}),
      ...(eq !== undefined ? { eq } : {}),
      ...(order === "asc" || order === "desc" ? { order } : {}),
      ...(q.get("cursor") ? { cursor: q.get("cursor")! } : {}),
      ...(q.has("limit") ? { limit: Number(q.get("limit")) || 50 } : {}),
    };
    return reply(await deps.stub(shard).query(shard, `${ADMIN_MODULE}:dataList`, args, null, true));
  }
  if (url.pathname === "/api/_ember/functions") {
    if (request.method !== "GET") return deps.error(405, "method_not_allowed", "use GET");
    return deps.json({ ok: true, functions: functionListing(deps.config) });
  }
  if (url.pathname === "/api/_ember/reactivity" || url.pathname === "/api/_ember/reactivity/profile") {
    if (request.method !== "GET") return deps.error(405, "method_not_allowed", "use GET");
    const shard = url.searchParams.get("shard") ?? "global:main";
    if (!deps.validShard(shard)) return deps.error(400, "bad_shard", `invalid shard ${JSON.stringify(shard)}`);
    if (url.pathname === "/api/_ember/reactivity") return deps.json({ ok: true, report: await deps.stub(shard).reactivity(shard) });
    const key = url.searchParams.get("key") ?? "";
    const r = await deps.stub(shard).profileQuery(shard, key);
    return r ? deps.json({ ok: true, profile: r }) : deps.error(404, "not_found_entry", "that query is no longer cached on the shard (no subscriber left)");
  }
  if (url.pathname === "/api/_ember/run") {
    if (request.method !== "POST") return deps.error(405, "method_not_allowed", "use POST");
    let body: Record<string, unknown>;
    try {
      const b = parse(await request.text());
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
      body = b as Record<string, unknown>;
    } catch {
      return deps.error(400, "bad_request", "body must be a JSON object { fn, args, shard, as? }");
    }
    const name = typeof body.fn === "string" ? body.fn : "";
    const info = functionListing(deps.config).find((f) => f.name === name);
    if (!info) return deps.error(404, "FunctionNotFound", `Function ${JSON.stringify(name)} not found`);
    const shard = typeof body.shard === "string" ? body.shard : "global:main";
    if (!deps.validShard(shard)) return deps.error(400, "bad_shard", `invalid shard ${JSON.stringify(body.shard)}`);
    const args = body.args ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) return deps.error(400, "bad_request", "args must be an object");
    const identity = actAs(body.as);
    if (identity && "error" in identity) return deps.error(400, "bad_request", identity.error);
    // A sensitive function checks the caller's live session on every call: there is none to check when acting.
    if (identity && info.sensitive) return deps.error(403, "sensitive_refused", `${name} is sensitive (it checks the user's live session): it cannot run as another user`);
    const t0 = performance.now();
    const out =
      info.type === "action"
        ? await deps.runAction(name, args, shard, identity)
        : info.type === "query"
          ? await deps.stub(shard).query(shard, name, args, identity, true)
          : await deps.stub(shard).mutation(shard, name, args, identity, true);
    const ms = performance.now() - t0;
    const { metrics: _m, ...reply } = out as AdminOutcome & { metrics?: unknown };
    return deps.json({ ...reply, ms, type: info.type, as: identity ? identity.subject : null }, reply.ok ? 200 : 400);
  }
  const ops = await handleOps(request, url, deps, reply);
  if (ops) return ops;
  const settings = await handleSettings(request, url, deps);
  if (settings) return settings;
  const fn = DATA_WRITES[url.pathname];
  if (fn) {
    if (request.method !== "POST") return deps.error(405, "method_not_allowed", "use POST");
    let body: Record<string, unknown>;
    try {
      const b = parse(await request.text());
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
      body = b as Record<string, unknown>;
    } catch {
      return deps.error(400, "bad_request", "body must be a JSON object");
    }
    const shard = typeof body.shard === "string" ? body.shard : "";
    if (!deps.validShard(shard)) return deps.error(400, "bad_shard", `invalid shard ${JSON.stringify(body.shard)}`);
    const { shard: _s, ...args } = body;
    return reply(await deps.stub(shard).mutation(shard, `${ADMIN_MODULE}:${fn}`, args, null, true));
  }
  return null;
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = parse(await request.text());
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Schedules (jobs, crons) and files. */
async function handleOps(request: Request, url: URL, deps: AdminDeps, reply: (r: AdminOutcome) => Response): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/api/_ember/jobs/run" || p === "/api/_ember/jobs/cancel") {
    if (request.method !== "POST") return deps.error(405, "method_not_allowed", "use POST");
    const b = await jsonBody(request);
    if (!b) return deps.error(400, "bad_request", "body must be a JSON object");
    const shard = typeof b.shard === "string" ? b.shard : "";
    if (!deps.validShard(shard)) return deps.error(400, "bad_shard", `invalid shard ${JSON.stringify(b.shard)}`);
    if (p.endsWith("/cancel")) {
      if (typeof b.id !== "string" || !b.id) return deps.error(400, "bad_request", "id: the job id");
      return reply(await deps.stub(shard).mutation(shard, `${ADMIN_MODULE}:jobCancel`, { id: b.id }, null, true));
    }
    const name = typeof b.fn === "string" ? b.fn : "";
    const info = functionListing(deps.config).find((f) => f.name === name);
    if (!info || info.type === "query") return deps.error(404, "FunctionNotFound", `${JSON.stringify(name)} is not a mutation or action of this app`);
    return reply(await deps.stub(shard).mutation(shard, `${ADMIN_MODULE}:jobRun`, { fn: name, args: b.args ?? {} }, null, true));
  }
  if (p === "/api/_ember/crons/run") {
    if (request.method !== "POST") return deps.error(405, "method_not_allowed", "use POST");
    const b = await jsonBody(request);
    if (!b || typeof b.name !== "string" || !b.name) return deps.error(400, "bad_request", "body must be { name } (the cron's name)");
    const cron = resolvedCrons(deps.config).find((c) => c.name === b.name);
    if (!cron) return deps.error(404, "not_found", `no cron ${JSON.stringify(b.name)}`);
    // The same job the System DO would dispatch at its time, scheduled now on its shard.
    return reply(await deps.stub(cron.shard).mutation(cron.shard, `${ADMIN_MODULE}:jobRun`, { fn: cron.fn, args: cron.args ?? {} }, null, true));
  }
  if (p === "/api/_ember/files/content" || p === "/api/_ember/files/upload" || p === "/api/_ember/files/delete") {
    const shard = url.searchParams.get("shard") ?? "";
    if (!deps.validShard(shard)) return deps.error(400, "bad_shard", `invalid shard ${JSON.stringify(shard)}`);
    const storage = deps.files(shard);
    if (!storage) return deps.error(501, "files_unavailable", "this deployment has no files bucket (resources.files in ember.json)");
    try {
      if (p.endsWith("/content")) {
        if (request.method !== "GET") return deps.error(405, "method_not_allowed", "use GET");
        const f = await storage.get(url.searchParams.get("id") ?? "");
        if (!f) return deps.error(404, "FileNotFound", "no such ready file on this shard");
        // Never rendered by anyone: bytes as an attachment, the real type in a header the dashboard checks.
        return new Response(f.body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": "attachment",
            "content-length": String(f.size),
            "x-ember-content-type": f.contentType ?? "",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          },
        });
      }
      if (request.method !== "POST") return deps.error(405, "method_not_allowed", "use POST");
      if (p.endsWith("/delete")) {
        const id = url.searchParams.get("id") ?? "";
        await storage.delete(id);
        return deps.json({ ok: true, value: { deleted: id } });
      }
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > ADMIN_UPLOAD_MAX) return deps.error(413, "too_large", `uploads through the admin endpoint are at most ${ADMIN_UPLOAD_MAX} bytes`);
      const bytes = await readLimited(request.body, ADMIN_UPLOAD_MAX);
      if (!bytes) return deps.error(413, "too_large", `uploads through the admin endpoint are at most ${ADMIN_UPLOAD_MAX} bytes`);
      const type = url.searchParams.get("contentType");
      const id = await storage.store(bytes, type ? { contentType: type } : {});
      return deps.json({ ok: true, value: { id, size: bytes.byteLength } });
    } catch (e) {
      const code = (e as { code?: string }).code ?? "StorageError";
      return deps.json({ ok: false, error: { code, message: (e as Error).message } }, code === "FileInUse" ? 409 : code === "FileNotFound" ? 404 : 500);
    }
  }
  return null;
}

/** Reads a body up to `max` bytes, stopping (and cancelling it) as soon as it passes the limit. Null: too large. */
async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Environment variable names, and users / sessions of the Auth DO. */
async function handleSettings(request: Request, url: URL, deps: AdminDeps): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/api/_ember/env") {
    if (request.method !== "GET") return deps.error(405, "method_not_allowed", "use GET");
    // Names only: values are read one at a time through env/reveal (audited by the dashboard), never listed.
    const names = Object.keys(deps.env)
      .filter((k) => typeof (deps.env as Record<string, unknown>)[k] === "string")
      .sort()
      .map((name) => ({ name, managed: name.startsWith("EMBER_") || MANAGED.has(name) }));
    return deps.json({ ok: true, vars: names });
  }
  if (!p.startsWith("/api/_ember/auth/")) return null;
  const admin = deps.config.auth?.admin;
  if (!admin) return deps.error(404, "no_local_auth", "this deployment has no local Auth DO (SSO or no auth): no users here");
  try {
    if (p === "/api/_ember/auth/users") {
      if (request.method !== "GET") return deps.error(405, "method_not_allowed", "use GET");
      const q = url.searchParams;
      const r = await admin.users(deps.env, { ...(q.get("q") ? { q: q.get("q")! } : {}), cursor: Number(q.get("cursor") ?? 0) || 0, limit: Number(q.get("limit") ?? 50) || 50 });
      return deps.json({ ok: true, ...r });
    }
    if (p === "/api/_ember/auth/sessions") {
      if (request.method !== "GET") return deps.error(405, "method_not_allowed", "use GET");
      const user = url.searchParams.get("user") ?? "";
      if (!user) return deps.error(400, "bad_request", "?user= required");
      return deps.json({ ok: true, sessions: await admin.sessions(deps.env, user) });
    }
    if (p === "/api/_ember/auth/revoke") {
      if (request.method !== "POST") return deps.error(405, "method_not_allowed", "use POST");
      const b = await jsonBody(request);
      const userId = typeof b?.userId === "string" ? b.userId : "";
      if (!userId) return deps.error(400, "bad_request", "body must be { userId, sessionId?, shards? }");
      const given = b?.sessionId !== undefined && b?.sessionId !== null;
      if (given && (typeof b!.sessionId !== "string" || !b!.sessionId)) return deps.error(400, "bad_request", "sessionId, when given, must be a session id (absent = every session)");
      const sessionId = given ? (b!.sessionId as string) : undefined;
      const shards = Array.isArray(b?.shards) ? (b!.shards as unknown[]).filter((s): s is string => typeof s === "string" && deps.validShard(s)).slice(0, 50) : [];
      const r = await admin.revoke(deps.env, { userId, ...(sessionId ? { sessionId } : {}) });
      // JWTs already issued last a few minutes: cut the identity off the shards it may be connected to now. One
      // session: only when the delete (scoped by userId AND sessionId) found it, which proves the sid is this user's.
      // Every session: by subject, which is this user whatever the delete found.
      const match = sessionId ? ({ claim: "sid", value: sessionId } as const) : { subject: userId };
      const cut = sessionId ? r.revoked > 0 : true;
      let sockets = 0;
      if (cut) for (const s of shards) sockets += (await deps.revokeSockets(s, match).catch(() => ({ sockets: 0 }))).sockets;
      return deps.json({ ok: true, value: { revoked: r.revoked, sockets, shards: shards.length } });
    }
  } catch (e) {
    return deps.json({ ok: false, error: { code: (e as { code?: string }).code ?? "AuthError", message: (e as Error).message } }, 500);
  }
  return deps.error(404, "not_found", "not found");
}
