// Analytics Engine SQL for Ember execution metrics (layout: @ember/runtime metrics.ts). Pure module (no Node APIs):
// the Ember Dashboard Worker and the CLI (`@ember/dashboard/metrics-sql`) both use it.
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
  const where = [`timestamp > NOW() - INTERVAL '${Math.max(1, Math.floor(o.sinceHours ?? 24))}' HOUR`];
  if (o.project !== undefined) {
    if (!NAME.test(o.project)) throw new Error("invalid project name");
    where.push(`blob1 = ${lit(o.project)}`);
  }
  if (o.env !== undefined) {
    if (!NAME.test(o.env)) throw new Error("invalid environment name");
    where.push(`blob2 = ${lit(o.env)}`);
  }
  const w = "_sample_interval * double5";
  return [
    "SELECT blob1 AS project, blob2 AS env, blob4 AS fn, blob5 AS kind,",
    `  SUM(${w}) AS calls,`,
    `  SUM(IF(blob6 = 'error', ${w}, 0)) AS errors,`,
    "  quantileExactWeighted(0.5)(double1, _sample_interval) AS p50,",
    "  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,",
    `  SUM(double2 * ${w}) AS rows_read,`,
    `  SUM(double3 * ${w}) AS rows_written,`,
    `  SUM(double4 * ${w}) AS bytes_out`,
    `FROM ${o.dataset}`,
    `WHERE ${where.join(" AND ")}`,
    "GROUP BY project, env, fn, kind",
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
