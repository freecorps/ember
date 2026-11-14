// Analytics Engine SQL for Ember execution metrics (layout: @freecorps/ember-runtime metrics.ts). Pure module (no Node APIs):
// the Ember Dashboard Worker and the CLI (`@freecorps/ember-dashboard/metrics-sql`) both use it.
//
//   POST https://api.cloudflare.com/client/v4/accounts/<account>/analytics_engine/sql   (body: the SQL text)
//   needs a token with "Account Analytics: Read".
//
// Counts are weighted by `_sample_interval` (Analytics Engine's own sampling) times double5 (Ember's sample weight).

export interface FunctionStats {
  project: string;
  env: string;
  fn: string;
  kind: string;
  /**
   * What p50/p95 measure (blob9, see @freecorps/ember-runtime metrics.ts `Timing`): "rpc" (Worker around the DO RPC),
   * "commit" (DO: receipt → durable write), "wall" (actions), "none" (not measurable in production: 0), "" (older
   * points: 0 for queries/mutations in production).
   */
  timing: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50: number;
  p95: number;
  rowsRead: number;
  rowsWritten: number;
  /** Mean rows read per call. */
  avgRowsRead: number;
  bytesOut: number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function functionStatsSql(o: { dataset: string; project?: string; env?: string; sinceHours?: number; limit?: number }): string {
  if (!IDENT.test(o.dataset)) throw new Error(`invalid dataset name ${JSON.stringify(o.dataset)}`);
  const where = scopeWhere(o);
  const w = "_sample_interval * double5";
  return [
    "SELECT blob1 AS project, blob2 AS env, blob4 AS fn, blob5 AS kind, blob9 AS timing,",
    `  SUM(${w}) AS calls,`,
    `  SUM(IF(blob6 = 'error', ${w}, 0.0)) AS errors,`,
    "  quantileExactWeighted(0.5)(double1, _sample_interval) AS p50,",
    "  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,",
    `  SUM(double2 * ${w}) AS rows_read,`,
    `  SUM(double3 * ${w}) AS rows_written,`,
    `  SUM(double4 * ${w}) AS bytes_out`,
    `FROM ${o.dataset}`,
    `WHERE ${where.join(" AND ")}`,
    "GROUP BY project, env, fn, kind, timing",
    "ORDER BY calls DESC",
    `LIMIT ${Math.max(1, Math.min(1000, Math.floor(o.limit ?? 200)))}`,
  ].join("\n");
}

export function parseFunctionStats(body: { data?: Array<Record<string, unknown>> }): FunctionStats[] {
  return (body.data ?? []).map((r) => {
    const calls = Number(r.calls) || 0;
    const errors = Number(r.errors) || 0;
    const rowsRead = Number(r.rows_read) || 0;
    return {
      project: String(r.project ?? ""),
      env: String(r.env ?? ""),
      fn: String(r.fn ?? ""),
      kind: String(r.kind ?? ""),
      timing: String(r.timing ?? ""),
      calls,
      errors,
      errorRate: calls ? errors / calls : 0,
      p50: Number(r.p50) || 0,
      p95: Number(r.p95) || 0,
      rowsRead,
      rowsWritten: Number(r.rows_written) || 0,
      avgRowsRead: calls ? rowsRead / calls : 0,
      bytesOut: Number(r.bytes_out) || 0,
    };
  });
}

export interface ShardStats {
  shard: string;
  calls: number;
  errors: number;
  rowsRead: number;
  rowsWritten: number;
}

function scopeWhere(o: { project?: string; env?: string; sinceHours?: number }): string[] {
  const where = [`timestamp > NOW() - INTERVAL '${Math.max(1, Math.floor(o.sinceHours ?? 24))}' HOUR`];
  if (o.project !== undefined) {
    if (!NAME.test(o.project)) throw new Error("invalid project name");
    where.push(`blob1 = ${lit(o.project)}`);
  }
  if (o.env !== undefined) {
    if (!NAME.test(o.env)) throw new Error("invalid environment name");
    where.push(`blob2 = ${lit(o.env)}`);
  }
  return where;
}

/** Busiest shards (blob8) of a project/env: calls, errors, rows read and written. */
export function shardStatsSql(o: { dataset: string; project?: string; env?: string; sinceHours?: number; limit?: number }): string {
  if (!IDENT.test(o.dataset)) throw new Error(`invalid dataset name ${JSON.stringify(o.dataset)}`);
  const where = [...scopeWhere(o), "blob8 != ''"];
  const w = "_sample_interval * double5";
  return [
    "SELECT blob8 AS shard,",
    `  SUM(${w}) AS calls,`,
    `  SUM(IF(blob6 = 'error', ${w}, 0.0)) AS errors,`,
    `  SUM(double2 * ${w}) AS rows_read,`,
    `  SUM(double3 * ${w}) AS rows_written`,
    `FROM ${o.dataset}`,
    `WHERE ${where.join(" AND ")}`,
    "GROUP BY shard",
    "ORDER BY calls DESC",
    `LIMIT ${Math.max(1, Math.min(200, Math.floor(o.limit ?? 20)))}`,
  ].join("\n");
}

export function parseShardStats(body: { data?: Array<Record<string, unknown>> }): ShardStats[] {
  return (body.data ?? []).map((r) => ({
    shard: String(r.shard ?? ""),
    calls: Number(r.calls) || 0,
    errors: Number(r.errors) || 0,
    rowsRead: Number(r.rows_read) || 0,
    rowsWritten: Number(r.rows_written) || 0,
  }));
}

const FN = /^[A-Za-z0-9_$./:-]{1,200}$/;

/** Bucket size for a window: about 50–100 points whatever the window. */
export function bucketMinutes(hours: number): number {
  return hours <= 1 ? 1 : hours <= 6 ? 5 : hours <= 24 ? 15 : hours <= 72 ? 60 : 240;
}

export interface FunctionPoint {
  /** Bucket start, ms since epoch. */
  t: number;
  calls: number;
  errors: number;
  p50: number;
  p95: number;
  rowsRead: number;
  rowsWritten: number;
}

/** One function over time: calls, errors, p50/p95, rows read and written per bucket. */
export function functionSeriesSql(o: { dataset: string; project: string; env: string; fn: string; sinceHours: number }): string {
  if (!IDENT.test(o.dataset)) throw new Error(`invalid dataset name ${JSON.stringify(o.dataset)}`);
  if (!FN.test(o.fn)) throw new Error("invalid function name");
  const where = [...scopeWhere(o), `blob4 = ${lit(o.fn)}`];
  const w = "_sample_interval * double5";
  return [
    `SELECT toStartOfInterval(timestamp, INTERVAL '${bucketMinutes(o.sinceHours)}' MINUTE) AS t,`,
    `  SUM(${w}) AS calls,`,
    `  SUM(IF(blob6 = 'error', ${w}, 0.0)) AS errors,`,
    "  quantileExactWeighted(0.5)(double1, _sample_interval) AS p50,",
    "  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,",
    `  SUM(double2 * ${w}) AS rows_read,`,
    `  SUM(double3 * ${w}) AS rows_written`,
    `FROM ${o.dataset}`,
    `WHERE ${where.join(" AND ")}`,
    "GROUP BY t",
    "ORDER BY t",
  ].join("\n");
}

const toMs = (t: unknown) => {
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
  const s = String(t ?? "");
  // Analytics Engine answers "YYYY-MM-DD HH:MM:SS" in UTC.
  const ms = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : 0;
};

export function parseFunctionSeries(body: { data?: Array<Record<string, unknown>> }): FunctionPoint[] {
  return (body.data ?? []).map((r) => ({
    t: toMs(r.t),
    calls: Number(r.calls) || 0,
    errors: Number(r.errors) || 0,
    p50: Number(r.p50) || 0,
    p95: Number(r.p95) || 0,
    rowsRead: Number(r.rows_read) || 0,
    rowsWritten: Number(r.rows_written) || 0,
  }));
}

/** The last errors of one function (Analytics Engine keeps the error code and shard; messages are in the logs). */
export function functionErrorsSql(o: { dataset: string; project: string; env: string; fn: string; sinceHours: number; limit?: number }): string {
  if (!IDENT.test(o.dataset)) throw new Error(`invalid dataset name ${JSON.stringify(o.dataset)}`);
  if (!FN.test(o.fn)) throw new Error("invalid function name");
  const where = [...scopeWhere(o), `blob4 = ${lit(o.fn)}`, "blob6 = 'error'"];
  return [
    "SELECT timestamp AS t, blob7 AS code, blob8 AS shard, blob5 AS kind, double1 AS ms",
    `FROM ${o.dataset}`,
    `WHERE ${where.join(" AND ")}`,
    "ORDER BY t DESC",
    `LIMIT ${Math.max(1, Math.min(200, Math.floor(o.limit ?? 50)))}`,
  ].join("\n");
}

export function parseFunctionErrors(body: { data?: Array<Record<string, unknown>> }): Array<{ t: number; code: string; shard: string; kind: string; ms: number }> {
  return (body.data ?? []).map((r) => ({ t: toMs(r.t), code: String(r.code ?? ""), shard: String(r.shard ?? ""), kind: String(r.kind ?? ""), ms: Number(r.ms) || 0 }));
}

/** Runs one Analytics Engine SQL statement. `fetchImpl` lets the dashboard Worker and tests inject fetch. */
export async function analyticsSql(o: { accountId: string; token: string; sql: string; fetch?: typeof fetch }): Promise<{ data: Array<Record<string, unknown>>; rows: number }> {
  const res = await (o.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${o.accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.token}` },
    body: o.sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Analytics Engine SQL → ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { data?: Array<Record<string, unknown>>; rows?: number };
  return { data: body.data ?? [], rows: body.rows ?? body.data?.length ?? 0 };
}

export async function queryFunctionStats(o: { accountId: string; token: string; dataset: string; project?: string; env?: string; sinceHours?: number; fetch?: typeof fetch }): Promise<FunctionStats[]> {
  const sql = functionStatsSql(o);
  return parseFunctionStats(await analyticsSql({ accountId: o.accountId, token: o.token, sql, ...(o.fetch ? { fetch: o.fetch } : {}) }));
}
