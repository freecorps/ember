// Telemetry (PLAN §14, §21): per-execution metrics to Workers Analytics Engine and the shard catalog in the account
// registry. Both are optional: with no binding every call here is a cheap no-op, and nothing here ever throws into
// the caller (telemetry must not fail a query or a mutation).
//
// Analytics Engine data point (dataset bound as EMBER_METRICS; one dataset per account, default `ember_metrics`):
//   index1  = "<project>/<env>"                                 (sampling key)
//   blob1   = project      blob2 = env       blob3 = shard kind   blob4 = fn
//   blob5   = kind ("query" | "subscription" | "mutation" | "job" | "action")
//   blob6   = status ("ok" | "error")       blob7 = error code ("" when ok)        blob8 = shard name
//   double1 = durationMs   double2 = rowsRead   double3 = rowsWritten   double4 = bytesOut
//   double5 = weight (1 / sample rate: SUM(_sample_interval * double5) estimates the execution count)
//
// Sampling: EMBER_METRICS_SAMPLE (Worker var, 0..1, default 1). Errors are always written.
// EMBER_TRACE = "1" also logs one `ember:exec {json}` line per execution (what `ember logs --fn/--shard` filters on).
//
// Shard catalog: each shard upserts {kind, key, schemaVersion, dbSize, lastWrite} into the `shards` table of the
// account registry (D1 `ember-registry`) through the EMBER_REGISTRY binding — after a migration and from the hourly
// maintenance alarm, at most once per CATALOG_MIN_INTERVAL_MS otherwise. A direct D1 binding was chosen over a Queue:
// one tiny upsert per shard per hour needs no consumer, no extra queue per account, and the DO can await it in its
// alarm (failures are logged and retried on the next report).

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point?: { indexes?: (string | null)[]; blobs?: (string | null)[]; doubles?: number[] }): void;
}

/** Subset of `D1Database` used for the catalog (lets tests pass a fake). */
export interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

export type ExecutionKind = "query" | "subscription" | "mutation" | "job" | "action";

export interface Execution {
  fn: string;
  kind: ExecutionKind;
  /** `<kind>:<key>`; null when unknown (e.g. before the shard learned its name). */
  shard: string | null;
  status: "ok" | "error";
  errorCode?: string;
  durationMs: number;
  rowsRead?: number;
  rowsWritten?: number;
  /** Serialized result size. A function so it is only computed for sampled points. */
  bytesOut?: number | (() => number);
}

interface TelemetryEnv {
  EMBER_METRICS?: unknown;
  EMBER_METRICS_SAMPLE?: unknown;
  EMBER_TRACE?: unknown;
  EMBER_PROJECT?: unknown;
  EMBER_ENV?: unknown;
  EMBER_REGISTRY?: unknown;
  [k: string]: unknown;
}

const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);

/** EMBER_METRICS_SAMPLE as a rate in (0, 1]; 0 disables ok points (errors are still written). */
export function sampleRate(env: TelemetryEnv): number {
  const raw = env.EMBER_METRICS_SAMPLE;
  if (raw === undefined || raw === null || raw === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

let sinkOverride: AnalyticsEngineDatasetLike | null = null;

/** Replace the EMBER_METRICS binding in this isolate (tests, local dev). `null` restores the binding. */
export function setMetricsSink(sink: AnalyticsEngineDatasetLike | null): void {
  sinkOverride = sink;
}

function dataset(env: TelemetryEnv): AnalyticsEngineDatasetLike | null {
  if (sinkOverride) return sinkOverride;
  const d = env.EMBER_METRICS as AnalyticsEngineDatasetLike | undefined;
  return d && typeof d.writeDataPoint === "function" ? d : null;
}

/** True when an execution would produce any output (lets callers skip measuring entirely). */
export function metricsEnabled(env: TelemetryEnv): boolean {
  return dataset(env) !== null || env.EMBER_TRACE === "1";
}

/**
 * Record one execution. Returns true when a data point was written. Never throws.
 * `random` is injectable for tests.
 */
export function recordExecution(env: TelemetryEnv, e: Execution, random: () => number = Math.random): boolean {
  try {
    const ds = dataset(env);
    const trace = env.EMBER_TRACE === "1";
    if (!ds && !trace) return false;
    const project = str(env.EMBER_PROJECT, "unknown");
    const envName = str(env.EMBER_ENV, "unknown");
    const shard = e.shard ?? "";
    const shardKind = shard.includes(":") ? shard.slice(0, shard.indexOf(":")) : "";
    const rate = sampleRate(env);
    const sampled = e.status === "error" || (rate > 0 && random() < rate);
    if (!sampled && !trace) return false;
    const bytesOut = typeof e.bytesOut === "function" ? safe(e.bytesOut) : (e.bytesOut ?? 0);
    const row = {
      project,
      env: envName,
      shard,
      fn: e.fn,
      kind: e.kind,
      status: e.status,
      errorCode: e.errorCode ?? "",
      durationMs: round(e.durationMs),
      rowsRead: e.rowsRead ?? 0,
      rowsWritten: e.rowsWritten ?? 0,
      bytesOut,
    };
    if (trace) console.log(`ember:exec ${JSON.stringify(row)}`);
    if (!ds || !sampled) return false;
    const weight = e.status === "error" || rate === 0 ? 1 : 1 / rate;
    ds.writeDataPoint({
      indexes: [`${project}/${envName}`],
      blobs: [project, envName, shardKind, e.fn, e.kind, e.status, row.errorCode, shard],
      doubles: [row.durationMs, row.rowsRead, row.rowsWritten, bytesOut, weight],
    });
    return true;
  } catch (err) {
    console.error("ember: metrics write failed", err);
    return false;
  }
}

const round = (ms: number) => Math.round(ms * 1000) / 1000;

function safe(f: () => number): number {
  try {
    return f();
  } catch {
    return 0;
  }
}

/** Split a group-committed batch's totals across its items (the engine runs them in one transaction). */
export function share(total: number, n: number): number {
  return n > 0 ? total / n : total;
}

// ---------------------------------------------------------------------------------------------- shard catalog

export const CATALOG_MIN_INTERVAL_MS = 50 * 60_000;

/** Registry DDL for the catalog table (the CLI creates the rest of the registry; see @freecorps/ember-cli registry.ts). */
export const SHARDS_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS shards (project TEXT NOT NULL, env TEXT NOT NULL, shard TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, " +
  "schema_version TEXT, db_size INTEGER NOT NULL DEFAULT 0, last_write INTEGER, reported_at INTEGER NOT NULL, PRIMARY KEY (project, env, shard))";

export interface ShardReport {
  shard: string;
  schemaVersion: string | null;
  dbSize: number;
  lastWrite: number | null;
}

/** Whether a report is due: forced (migration), never reported, or the last one is older than the interval. */
export function catalogDue(lastReportedAt: number | null, now: number, force = false): boolean {
  return force || lastReportedAt === null || now - lastReportedAt >= CATALOG_MIN_INTERVAL_MS;
}

/** Upsert one shard row in the registry. False when there is no registry binding or the write failed. */
export async function reportShard(env: TelemetryEnv, r: ShardReport, now = Date.now()): Promise<boolean> {
  const db = env.EMBER_REGISTRY as D1Like | undefined;
  if (!db || typeof db.prepare !== "function") return false;
  const i = r.shard.indexOf(":");
  try {
    // Self-healing: the CLI creates the registry with this table, but a report must not depend on that order.
    await db.prepare(SHARDS_TABLE_DDL).bind().run();
    await db
      .prepare(
        "INSERT INTO shards (project, env, shard, kind, key, schema_version, db_size, last_write, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (project, env, shard) DO UPDATE SET schema_version = excluded.schema_version, db_size = excluded.db_size, " +
          "last_write = COALESCE(excluded.last_write, shards.last_write), reported_at = excluded.reported_at",
      )
      .bind(str(env.EMBER_PROJECT, "unknown"), str(env.EMBER_ENV, "unknown"), r.shard, r.shard.slice(0, i), r.shard.slice(i + 1), r.schemaVersion, r.dbSize, r.lastWrite, now)
      .run();
    return true;
  } catch (e) {
    console.error("ember: shard catalog report failed", e);
    return false;
  }
}
