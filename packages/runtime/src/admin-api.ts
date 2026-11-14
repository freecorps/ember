// Admin API extensions for the Ember Dashboard (docs/design/contracts.md "Dashboard"). The Worker checks the admin
// token (`EMBER_ADMIN_TOKEN`) before handing a request here; everything below runs as the project's administrator.
//
// `GET /api/_ember/capabilities` tells the dashboard which admin endpoints this runtime has, so a newer dashboard in
// front of an older runtime shows "update the runtime" instead of failing on a 404. A runtime without this endpoint
// is level 1 (the endpoints listed in `LEGACY_ADMIN_FEATURES` of the dashboard).

import type { EmberConfig, EmberEnv } from "./config.ts";
import { ADMIN_MODULE, schemaSummary } from "./admin-data.ts";
import { parse } from "./wire.ts";

/** Bumped whenever an admin endpoint is added or changes shape. */
export const ADMIN_API_LEVEL = 3;

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
] as const;

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
  query(shard: string, fn: string, args: unknown, identity: null, internal: boolean): Promise<AdminOutcome>;
  mutation(shard: string, fn: string, args: unknown, identity: null, internal: boolean): Promise<AdminOutcome>;
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
