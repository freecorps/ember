// `ember shards ls` (the account registry's catalog: what every shard last reported) and `ember shards inspect
// <shard>` (one shard, live, through the existing admin endpoints: `status` for versions and size, `data` without a
// table for the tables and their row counts, `inspect` for jobs, subscriptions and counters). No endpoint of its own.

import { apiUrl, checkCredentialUrl } from "./secure-url.ts";

/** An admin endpoint target: the Worker's URL and the project's admin token (EMBER_ADMIN_TOKEN). */
export interface AdminTarget {
  url: string;
  adminToken: string;
  fetch?: typeof fetch;
  /** Deadline of one call, response body included (default `ADMIN_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/** How long one admin call may take before it fails (a stalled Worker never hangs the CLI or `ember mcp`). */
export const ADMIN_TIMEOUT_MS = 20_000;

/** An admin endpoint's error: `code` is the runtime's (`bad_shard`, `RuntimeSchemaTooNew`...) or the HTTP status. */
export class AdminApiError extends Error {
  override name = "AdminApiError";
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** One admin call (JSON in, JSON out); a non-2xx answer or `{ ok: false }` throws `AdminApiError`. */
export async function adminRequest<T>(t: AdminTarget, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const url = apiUrl(checkCredentialUrl(t.url), path);
  const ms = t.timeoutMs ?? ADMIN_TIMEOUT_MS;
  // One deadline for the request and its body: the signal aborts a stalled body read too.
  const signal = AbortSignal.timeout(ms);
  let res: Response;
  let text: string;
  try {
    res = await abortable(
      (t.fetch ?? fetch)(url, {
        method,
        headers: { authorization: `Bearer ${t.adminToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      }),
      signal,
    );
    text = await abortable(res.text(), signal);
  } catch (e) {
    if (signal.aborted) throw new AdminApiError(`${method} ${path}: no answer within ${ms / 1000} s`, "timeout", 0);
    throw e;
  }
  let parsed: { ok?: boolean; error?: { code?: string; message?: string } } & Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new AdminApiError(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, String(res.status), res.status);
  }
  if (!res.ok || parsed.ok === false) {
    const code = parsed.error?.code ?? String(res.status);
    throw new AdminApiError(`${method} ${path}: ${code}: ${parsed.error?.message ?? text.slice(0, 200)}`, code, res.status);
  }
  return parsed as T;
}

/** `p`, or a rejection when `signal` aborts first (a fetch that ignores its signal still cannot outlive the deadline). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener("abort", onAbort), reject(e as Error)),
    );
  });
}

/** A shard as the registry catalog has it (the shard reports itself after writes: PLAN §21). */
export interface CatalogShard {
  shard: string;
  kind: string;
  key: string;
  schemaVersion: string | null;
  /** Bytes of its SQLite database at the last report. */
  dbSize: number;
  lastWrite: number | null;
  reportedAt: number;
}

type Row = Record<string, unknown>;
const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));

/** The catalog of one environment (sorted by shard), optionally one kind only. */
export async function listShards(exec: (sql: string, ...params: unknown[]) => Promise<Row[]>, project: string, env: string, o: { kind?: string } = {}): Promise<CatalogShard[]> {
  const rows = await exec(
    `SELECT shard, kind, key, schema_version, db_size, last_write, reported_at FROM shards WHERE project = ? AND env = ?${o.kind ? " AND kind = ?" : ""} ORDER BY shard`,
    project,
    env,
    ...(o.kind ? [o.kind] : []),
  );
  return rows.map((r) => ({
    shard: String(r.shard),
    kind: String(r.kind),
    key: String(r.key),
    schemaVersion: r.schema_version === null || r.schema_version === undefined ? null : String(r.schema_version),
    dbSize: Number(r.db_size ?? 0),
    lastWrite: num(r.last_write),
    reportedAt: Number(r.reported_at ?? 0),
  }));
}

/** The registry catalog cannot be read: the account has no registry yet, or it predates the shard catalog. */
export class CatalogUnavailableError extends Error {
  override name = "CatalogUnavailableError";
}

/**
 * `listShards` on a registry opened on demand, with a readable error when there is nothing to read: no `ember-registry`
 * D1 in the account (never deployed with the registry on) or no `shards` table in it (nothing reported yet).
 */
export async function catalogShards(
  open: () => Promise<{ exec(sql: string, ...params: unknown[]): Promise<Row[]> }>,
  project: string,
  env: string,
  o: { kind?: string; registry?: string } = {},
): Promise<CatalogShard[]> {
  const name = o.registry ?? "ember-registry";
  let reg: { exec(sql: string, ...params: unknown[]): Promise<Row[]> };
  try {
    reg = await open();
  } catch (e) {
    if (/registry D1 database .* not found/.test((e as Error).message)) {
      throw new CatalogUnavailableError(`the account has no registry (${name}) yet, so there is no shard catalog: \`ember deploy --env ${env}\` creates it, and each shard reports itself after its first writes`);
    }
    throw e;
  }
  try {
    return await listShards((sql, ...p) => reg.exec(sql, ...p), project, env, o.kind ? { kind: o.kind } : {});
  } catch (e) {
    if (/no such table: shards/.test((e as Error).message)) {
      throw new CatalogUnavailableError(`the registry ${name} has no shard catalog yet (it was created by an older ember): \`ember deploy --env ${env}\` adds it, and each shard reports itself after its first writes`);
    }
    throw e;
  }
}

/** `12.3 KiB`. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "-");

/** Columns padded to their widest cell. */
export function table(head: string[], rows: string[][], right: number[] = []): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => (right.includes(i) ? c.padStart(w[i]!) : c.padEnd(w[i]!))).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

export function formatShardList(shards: CatalogShard[]): string {
  if (!shards.length) return "No shards in the registry catalog for this environment yet (a shard reports itself after its first writes).";
  const out = table(
    ["SHARD", "KIND", "SIZE", "SCHEMA", "LAST WRITE", "REPORTED"],
    shards.map((s) => [s.shard, s.kind, bytes(s.dbSize), s.schemaVersion?.slice(0, 12) ?? "-", when(s.lastWrite), when(s.reportedAt)]),
    [2],
  );
  const total = shards.reduce((a, s) => a + s.dbSize, 0);
  return `${out}\n\n${shards.length} shard${shards.length === 1 ? "" : "s"}, ${bytes(total)}`;
}

/** What `ember shards inspect` reads (the admin endpoints' own shapes, trimmed to what it shows). */
export interface ShardReport {
  shard: string;
  status: {
    expectedVersion: string;
    schemaVersion: string | null;
    ready: boolean;
    databaseSize: number;
    /** The shard's commit version (one per transaction). */
    version: number;
    staged: Array<{ table: string; index: string; kind: string; cursor: number; until: number }>;
    migrationError: { code?: string; message?: string } | null;
  };
  /** Tables with their row counts (`kind`: schema or internal); null when the shard refused to list them. */
  tables: Array<{ name: string; kind: string; rows: number }> | null;
  tablesError?: string;
  live: {
    epoch: string;
    subs: number;
    queries: number;
    dormant: number;
    /** Jobs still to run, and failed ones, by state. */
    jobs: Record<string, number>;
    finishedJobs: number;
    nextJobs: Array<{ fn: string; state: string; runAt: number; attempts: number; lastError: string | null }>;
    alarm: number | null;
    backfilling: boolean;
    bookmarks: number;
    files: Record<string, number>;
    outbox: Record<string, number>;
  } | null;
  liveError?: string;
  /** Pending restores of this shard (System DO journal). */
  restores: unknown[];
}

type RawInspection = {
  epoch: string;
  subs: number;
  queries: number;
  dormant: number;
  jobs: Array<{ fn: string; state: string; run_at: number; attempts: number; last_error: string | null }>;
  finishedJobs: number;
  alarm: number | null;
  backfilling: boolean;
  bookmarks: number;
  files: Record<string, number>;
  outbox: Record<string, number>;
};

/** One shard, live: three admin GETs at once; the status is required, tables and counters are best effort. */
export async function inspectShard(t: AdminTarget, shard: string): Promise<ShardReport> {
  const q = encodeURIComponent(shard);
  const [status, data, live] = await Promise.allSettled([
    adminRequest<{ shards: Array<ShardReport["status"] & { shard: string }>; restores: unknown[] }>(t, "GET", `/api/_ember/status?shard=${q}`),
    adminRequest<{ tables: Array<{ name: string; kind: string; rows: number }> }>(t, "GET", `/api/_ember/data?shard=${q}`),
    adminRequest<{ shard: RawInspection }>(t, "GET", `/api/_ember/inspect?shard=${q}`),
  ]);
  if (status.status === "rejected") throw status.reason;
  // Only the requested shard's entry: never another shard's versions under this name.
  const s = status.value.shards.find((x) => x.shard === shard);
  if (!s) throw new AdminApiError(`GET /api/_ember/status: no status for ${shard}`, "not_found", 404);
  const err = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? (r.reason as Error).message : undefined);
  const i = live.status === "fulfilled" ? live.value.shard : null;
  const jobs: Record<string, number> = {};
  for (const j of i?.jobs ?? []) jobs[j.state] = (jobs[j.state] ?? 0) + 1;
  return {
    shard,
    status: { expectedVersion: s.expectedVersion, schemaVersion: s.schemaVersion, ready: s.ready, databaseSize: s.databaseSize, version: s.version, staged: s.staged ?? [], migrationError: s.migrationError ?? null },
    tables: data.status === "fulfilled" ? data.value.tables : null,
    ...(err(data) ? { tablesError: err(data)! } : {}),
    live: i
      ? {
          epoch: i.epoch,
          subs: i.subs,
          queries: i.queries,
          dormant: i.dormant,
          jobs,
          finishedJobs: i.finishedJobs,
          nextJobs: i.jobs.slice(0, 10).map((j) => ({ fn: j.fn, state: j.state, runAt: j.run_at, attempts: j.attempts, lastError: j.last_error })),
          alarm: i.alarm,
          backfilling: i.backfilling,
          bookmarks: i.bookmarks,
          files: i.files,
          outbox: i.outbox,
        }
      : null,
    ...(err(live) ? { liveError: err(live)! } : {}),
    restores: status.value.restores ?? [],
  };
}

export function formatShardReport(r: ShardReport): string {
  const s = r.status;
  const out: string[] = [];
  out.push(`shard ${r.shard}`);
  out.push(`  size        ${bytes(s.databaseSize)}`);
  out.push(`  schema      ${s.schemaVersion?.slice(0, 12) ?? "never migrated"}${s.schemaVersion === s.expectedVersion ? " (current)" : ` (deployed code expects ${s.expectedVersion.slice(0, 12)})`}${s.ready ? "" : ", not ready"}`);
  out.push(`  version     ${s.version} (commits)`);
  if (s.migrationError) out.push(`  migration   REFUSED: ${s.migrationError.code ?? ""} ${s.migrationError.message ?? ""}`.trimEnd());
  for (const x of s.staged) out.push(`  backfill    ${x.table}.${x.index} (${x.kind}): ${x.until - x.cursor} rows left`);
  if (r.live) {
    const l = r.live;
    out.push(`  live        ${l.subs} subscription${l.subs === 1 ? "" : "s"}, ${l.queries} cached quer${l.queries === 1 ? "y" : "ies"}, ${l.dormant} dormant; epoch ${l.epoch}`);
    const open = Object.entries(l.jobs).map(([k, n]) => `${n} ${k}`).join(", ");
    out.push(`  jobs        ${open || "none open"}; ${l.finishedJobs} finished${l.alarm ? `; next alarm ${new Date(l.alarm).toISOString()}` : ""}`);
    const f = l.files;
    if (f.total) out.push(`  files       ${f.total} (${f.ready ?? 0} ready, ${f.pending ?? 0} pending, ${f.unreferenced ?? 0} unreferenced)`);
    const o = l.outbox;
    if ((o.pending ?? 0) + (o.inFlight ?? 0) + (o.parked ?? 0)) out.push(`  outbox      ${o.pending ?? 0} pending, ${o.inFlight ?? 0} in flight, ${o.parked ?? 0} parked`);
    out.push(`  bookmarks   ${l.bookmarks}${l.backfilling ? "; backfilling" : ""}`);
  } else if (r.liveError) out.push(`  live        unavailable (${r.liveError})`);
  if (r.restores.length) out.push(`  restores    ${r.restores.length} pending (ember restore --list)`);
  if (r.tables) {
    out.push("", table(["TABLE", "KIND", "ROWS"], r.tables.map((x) => [x.name, x.kind, String(x.rows)]), [2]).replace(/^/gm, "  "));
  } else if (r.tablesError) out.push(`  tables      unavailable (${r.tablesError})`);
  if (r.live?.nextJobs.length) {
    out.push("", table(["JOB", "STATE", "RUN AT", "ATTEMPTS", "LAST ERROR"], r.live.nextJobs.map((j) => [j.fn, j.state, when(j.runAt), String(j.attempts), (j.lastError ?? "").slice(0, 60)]), [3]).replace(/^/gm, "  "));
  }
  return out.join("\n");
}
