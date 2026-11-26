// Analytics Engine SQL for the events this component writes (layout: events.ts `toDataPoint`). Pure builders and
// parsers, plus the SQL API call. The SQL API has no bind parameters, so nothing reaches the text unchecked:
//
//   - names (events, dataset, install) must match a closed alphabet that has no quote and no backslash, and are then
//     written as escaped literals anyway (`lit`); anything else is refused with `SqlInputError`;
//   - numbers are integers clamped to a range, written by `int`;
//   - columns come from the layout (`blobN`/`doubleN`), never from input.
//
//   POST https://api.cloudflare.com/client/v4/accounts/<account>/analytics_engine/sql   (body: the SQL text)
//   needs a token with "Account Analytics: Read". Counts are weighted by `_sample_interval` (Analytics Engine's own
//   sampling); distinct users and per-user funnels/retention count the users of the rows kept by sampling, so on a
//   sampled dataset they are estimates.

import { EVENT_NAME } from "./events.ts";

export class SqlInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlInputError";
  }
}

/** Dataset names (`[A-Za-z_][A-Za-z0-9_]*`, as the deploy and Analytics Engine take them). */
export const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Install paths (`analytics`, `app/analytics`): what `ctx.component.name` holds. */
export const INSTALL = /^[A-Za-z][A-Za-z0-9_]{0,63}(?:\/[A-Za-z][A-Za-z0-9_]{0,63}){0,7}$/;

/** A string literal. Inputs are checked first; the escaping is a second wall. */
export const lit = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** An integer in [min, max] (a non-number is refused, never written). */
export function int(x: unknown, min: number, max: number, what: string): number {
  if (typeof x !== "number" || !Number.isFinite(x)) throw new SqlInputError(`${what} must be a number`);
  return Math.max(min, Math.min(max, Math.floor(x)));
}

export function eventName(x: unknown, what = "event"): string {
  if (typeof x !== "string" || !EVENT_NAME.test(x)) throw new SqlInputError(`${what}: invalid event name ${JSON.stringify(typeof x === "string" ? x.slice(0, 70) : x)}`);
  return x;
}

export interface Scope {
  dataset: string;
  install: string;
}

function from(s: Scope): { table: string; where: string[] } {
  if (typeof s.dataset !== "string" || !DATASET.test(s.dataset)) throw new SqlInputError(`invalid dataset name ${JSON.stringify(s.dataset)}`);
  if (typeof s.install !== "string" || !INSTALL.test(s.install)) throw new SqlInputError(`invalid install name ${JSON.stringify(s.install)}`);
  return { table: s.dataset, where: [`blob6 = ${lit(s.install)}`] };
}

/** The user a row counts for: its userId, else its anonymous id. */
const UID = "if(blob2 != '', blob2, blob3)";
const HAS_UID = "(blob2 != '' OR blob3 != '')";
/** Sentinel time past any event (2100-01-01): "the user never did this step". */
export const NEVER = 4102444800;

const names = (xs: readonly string[]) => xs.map((n) => lit(n)).join(", ");

function uniqueNames(xs: unknown, what: string, min: number, max: number): string[] {
  if (!Array.isArray(xs)) throw new SqlInputError(`${what} must be a list of event names`);
  if (xs.length < min || xs.length > max) throw new SqlInputError(`${what}: ${min} to ${max} events`);
  const out = xs.map((x, i) => eventName(x, `${what}[${i}]`));
  if (new Set(out).size !== out.length) throw new SqlInputError(`${what}: an event appears twice`);
  return out;
}

// ------------------------------------------------------------------------------------------------ counts

export type Bucket = "minute" | "hour" | "day";
const BUCKET_UNIT: Record<Bucket, string> = { minute: "MINUTE", hour: "HOUR", day: "DAY" };

export interface CountsOptions {
  /** Events to count (default: every event). Up to 20. */
  names?: readonly string[];
  /** How far back, in hours (1..2160, default 24). */
  sinceHours?: number;
  /** Bucket size (default `hour`). */
  bucket?: Bucket;
}

/** Events per bucket and name: `t` (bucket start), `name`, `events`. */
export function countsSql(s: Scope, o: CountsOptions = {}): string {
  const { table, where } = from(s);
  const since = int(o.sinceHours ?? 24, 1, 2160, "sinceHours");
  const bucket = o.bucket ?? "hour";
  if (typeof bucket !== "string" || !Object.hasOwn(BUCKET_UNIT, bucket)) throw new SqlInputError(`bucket must be minute, hour or day`);
  where.push(`timestamp > NOW() - INTERVAL '${since}' HOUR`);
  if (o.names !== undefined) {
    const ns = uniqueNames(o.names, "names", 1, 20);
    where.push(`index1 IN (${names(ns)})`);
  }
  return [
    `SELECT toStartOfInterval(timestamp, INTERVAL '1' ${BUCKET_UNIT[bucket]}) AS t, blob1 AS name, SUM(_sample_interval) AS events`,
    `FROM ${table}`,
    `WHERE ${where.join(" AND ")}`,
    "GROUP BY t, name",
    "ORDER BY t, name",
    "LIMIT 10000",
  ].join("\n");
}

/** The most frequent events: `name`, `events`, `users`. */
export function topEventsSql(s: Scope, o: { sinceHours?: number; limit?: number } = {}): string {
  const { table, where } = from(s);
  where.push(`timestamp > NOW() - INTERVAL '${int(o.sinceHours ?? 24, 1, 2160, "sinceHours")}' HOUR`);
  return [
    `SELECT blob1 AS name, SUM(_sample_interval) AS events, count(DISTINCT ${UID}) AS users`,
    `FROM ${table}`,
    `WHERE ${where.join(" AND ")}`,
    "GROUP BY name",
    "ORDER BY events DESC",
    `LIMIT ${int(o.limit ?? 20, 1, 1000, "limit")}`,
  ].join("\n");
}

/** Events and distinct users since the start of today (UTC): `events`, `users`. */
export function overviewSql(s: Scope): string {
  const { table, where } = from(s);
  where.push("timestamp >= toStartOfDay(NOW())");
  return [`SELECT SUM(_sample_interval) AS events, count(DISTINCT ${UID}) AS users`, `FROM ${table}`, `WHERE ${where.join(" AND ")}`].join("\n");
}

// ------------------------------------------------------------------------------------------------ funnel

export interface FunnelOptions {
  /** The steps, in order (2..8 distinct events). */
  steps: readonly string[];
  /** Each user has this long, from their first step, to finish (seconds; 60..2592000, default 1 day). */
  windowSeconds?: number;
  /** How far back users are looked at, in days (1..90, default 7). */
  sinceDays?: number;
}

/**
 * Users who did step 1, and of them those who went on through each later step in order within the window.
 *
 * The inner query takes, per user, the first time of each step; the outer one counts a user at step k when the first
 * times of steps 1..k are in order and step k is within `windowSeconds` of step 1. Analytics Engine SQL has no JOIN or
 * window function, so a user's first time of each step is what counts: a step done once before step 1 and again
 * after it is not seen (documented in contracts.md).
 */
export function funnelSql(s: Scope, o: FunnelOptions): string {
  const { table, where } = from(s);
  const steps = uniqueNames(o.steps, "steps", 2, 8);
  const win = int(o.windowSeconds ?? 86400, 60, 30 * 86400, "windowSeconds");
  const days = int(o.sinceDays ?? 7, 1, 90, "sinceDays");
  where.push(`timestamp > NOW() - INTERVAL '${days}' DAY`, `index1 IN (${names(steps)})`, HAS_UID);
  const inner = steps.map((n, i) => `    min(if(blob1 = ${lit(n)}, toUnixTimestamp(timestamp), ${NEVER})) AS t${i}`);
  const outer = steps.map((_, k) => {
    if (k === 0) return `  countIf(t0 < ${NEVER}) AS step0`;
    const conds = [`t0 < ${NEVER}`];
    for (let j = 1; j <= k; j++) conds.push(`t${j} >= t${j - 1}`);
    conds.push(`t${k} - t0 <= ${win}`);
    return `  countIf(${conds.join(" AND ")}) AS step${k}`;
  });
  return [
    "SELECT",
    outer.join(",\n"),
    "FROM (",
    `  SELECT ${UID} AS uid,`,
    inner.join(",\n"),
    `  FROM ${table}`,
    `  WHERE ${where.join(" AND ")}`,
    "  GROUP BY uid",
    ")",
  ].join("\n");
}

export interface FunnelStep {
  step: number;
  name: string;
  users: number;
  /** Of the users of step 1. */
  conversion: number;
  /** Of the users of the step before. */
  fromPrevious: number;
}
export interface FunnelResult {
  steps: FunnelStep[];
  windowSeconds: number;
  sinceDays: number;
}

const num = (x: unknown): number => {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : 0;
};

export function parseFunnel(body: SqlResponse, o: FunnelOptions): FunnelResult {
  const row = body.data?.[0] ?? {};
  const counts = o.steps.map((_, i) => num(row[`step${i}`]));
  const first = counts[0] ?? 0;
  return {
    steps: o.steps.map((name, i) => ({
      step: i + 1,
      name,
      users: counts[i]!,
      conversion: first ? counts[i]! / first : 0,
      fromPrevious: i === 0 ? (first ? 1 : 0) : counts[i - 1] ? counts[i]! / counts[i - 1]! : 0,
    })),
    windowSeconds: int(o.windowSeconds ?? 86400, 60, 30 * 86400, "windowSeconds"),
    sinceDays: int(o.sinceDays ?? 7, 1, 90, "sinceDays"),
  };
}

// ------------------------------------------------------------------------------------------------ retention

export type Period = "day" | "week";
export const PERIOD_SECONDS: Record<Period, number> = { day: 86400, week: 7 * 86400 };

export interface RetentionOptions {
  /** Cohort and return period (default `week`). */
  period?: Period;
  /** Periods looked at, the current one included (2..13, default 8). */
  periods?: number;
  /** The event that puts a user in a cohort and counts as a return (default: any event). */
  event?: string;
  /** Now (ms), for the start of the range (tests). Default `Date.now()`. */
  now?: number;
}

/** Start (unix seconds) of the first period: UTC midnight, or the UTC Monday for weeks, `periods - 1` periods ago. */
export function retentionStart(o: RetentionOptions): number {
  const period = o.period ?? "week";
  checkPeriod(period);
  const n = int(o.periods ?? 8, 2, 13, "periods");
  const nowS = Math.floor((o.now ?? Date.now()) / 1000);
  const day = Math.floor(nowS / 86400) * 86400;
  // 1970-01-01 (day 0) was a Thursday: day d is (d + 3) % 7 days after a Monday.
  const current = period === "day" ? day : day - ((Math.floor(day / 86400) + 3) % 7) * 86400;
  return current - (n - 1) * PERIOD_SECONDS[period];
}

/** `day` or `week` (an own key: `toString` and other `Object.prototype` names are refused). */
function checkPeriod(period: unknown): asserts period is Period {
  if (typeof period !== "string" || !Object.hasOwn(PERIOD_SECONDS, period)) throw new SqlInputError("period must be day or week");
}

/**
 * Cohorts by the period of each user's first event in the range, and how many of them came back in each later period.
 * The inner query gives, per user, the first period (`cohort`) and a count per period (`a0`..); the outer one counts,
 * per cohort, the users active `k` periods after it (`r1`..). Users active before the range start in the cohort of
 * its first period (the range is the cohort horizon; Analytics Engine keeps three months).
 */
export function retentionSql(s: Scope, o: RetentionOptions = {}): string {
  const { table, where } = from(s);
  const period = o.period ?? "week";
  checkPeriod(period);
  const n = int(o.periods ?? 8, 2, 13, "periods");
  const p = PERIOD_SECONDS[period];
  const start = retentionStart(o);
  where.push(`toUnixTimestamp(timestamp) >= ${start}`, HAS_UID);
  if (o.event !== undefined) where.push(`index1 = ${lit(eventName(o.event))}`);
  const idx = `intDiv(toUnixTimestamp(timestamp) - ${start}, ${p})`;
  const actives = Array.from({ length: n }, (_, j) => `    countIf(${idx} = ${j}) AS a${j}`);
  const returns = Array.from({ length: n - 1 }, (_, i) => {
    const k = i + 1;
    const ors = Array.from({ length: n - k }, (_, c) => `(cohort = ${c} AND a${c + k} > 0)`);
    return `  countIf(${ors.join(" OR ")}) AS r${k}`;
  });
  return [
    "SELECT cohort, count() AS users,",
    returns.join(",\n"),
    "FROM (",
    `  SELECT ${UID} AS uid,`,
    `    min(${idx}) AS cohort,`,
    actives.join(",\n"),
    `  FROM ${table}`,
    `  WHERE ${where.join(" AND ")}`,
    "  GROUP BY uid",
    ")",
    "GROUP BY cohort",
    "ORDER BY cohort",
  ].join("\n");
}

export interface RetentionCohort {
  /** Start of the cohort's period (ms). */
  start: number;
  users: number;
  /** Users back 1, 2, ... periods later (only the periods that have happened). */
  retained: number[];
  /** `retained / users`. */
  rates: number[];
}
export interface RetentionResult {
  period: Period;
  periods: number;
  start: number;
  cohorts: RetentionCohort[];
}

export function parseRetention(body: SqlResponse, o: RetentionOptions = {}): RetentionResult {
  const period = o.period ?? "week";
  checkPeriod(period);
  const n = int(o.periods ?? 8, 2, 13, "periods");
  const start = retentionStart(o);
  const p = PERIOD_SECONDS[period];
  const cohorts: RetentionCohort[] = [];
  for (const r of body.data ?? []) {
    const c = num(r.cohort);
    if (c < 0 || c >= n) continue;
    const users = num(r.users);
    const retained = Array.from({ length: n - 1 - c }, (_, i) => num(r[`r${i + 1}`]));
    cohorts.push({ start: (start + c * p) * 1000, users, retained, rates: retained.map((x) => (users ? x / users : 0)) });
  }
  return { period, periods: n, start: start * 1000, cohorts };
}

// ------------------------------------------------------------------------------------------------ the SQL API

/** The SQL API's JSON (`FORMAT JSON`, the default). */
export interface SqlResponse {
  meta?: Array<{ name: string; type: string }>;
  data?: Array<Record<string, unknown>>;
  rows?: number;
}

export interface SqlApi {
  accountId: string;
  token: string;
  /** Default `https://api.cloudflare.com/client/v4`. */
  base?: string;
  fetch?: typeof fetch;
}

export class SqlApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SqlApiError";
  }
}

export const SQL_API_BASE = "https://api.cloudflare.com/client/v4";

/** Runs one statement. Throws `SqlApiError` on a non-2xx (with the API's text, cut) or a body that is not JSON. */
export async function runSql(api: SqlApi, sql: string): Promise<SqlResponse> {
  const f = api.fetch ?? fetch;
  const url = `${(api.base ?? SQL_API_BASE).replace(/\/$/, "")}/accounts/${encodeURIComponent(api.accountId)}/analytics_engine/sql`;
  const res = await f(url, { method: "POST", headers: { authorization: `Bearer ${api.token}`, "content-type": "text/plain" }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new SqlApiError(`Analytics Engine SQL API: ${res.status} ${text.slice(0, 300)}`, res.status);
  try {
    return JSON.parse(text) as SqlResponse;
  } catch {
    throw new SqlApiError(`Analytics Engine SQL API: the answer is not JSON (${text.slice(0, 100)})`, 502);
  }
}

// ------------------------------------------------------------------------------------------------ cache

/** The Workers Cache API, structurally (`caches.default`). */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

const memo = new Map<string, { at: number; body: SqlResponse }>();
const MEMO_MAX = 200;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultCache(): CacheLike | null {
  const c = (globalThis as { caches?: { default?: CacheLike } }).caches;
  return c?.default && typeof c.default.match === "function" ? c.default : null;
}

/**
 * `runSql` behind a short cache: the isolate's memory, then the data center's Cache API (`caches.default`, when there
 * is one), keyed by the account and a hash of the credential, the base URL and the SQL text (the token never appears
 * in the key itself): a rotated token or another base never reads a cached answer. `ttlSeconds` 0 turns it off.
 */
export async function cachedSql(api: SqlApi, sql: string, o: { ttlSeconds: number; now?: number; cache?: CacheLike | null }): Promise<SqlResponse & { cached?: boolean }> {
  const ttl = Math.max(0, Math.floor(o.ttlSeconds));
  if (!ttl) return runSql(api, sql);
  const now = o.now ?? Date.now();
  const key = `https://ember-analytics.cache/${encodeURIComponent(api.accountId)}/${await sha256Hex(`${api.token}\n${api.base ?? SQL_API_BASE}\n${sql}`)}`;
  const hit = memo.get(key);
  if (hit && now - hit.at < ttl * 1000) return { ...hit.body, cached: true };
  const cache = o.cache === undefined ? defaultCache() : o.cache;
  if (cache) {
    try {
      const r = await cache.match(key);
      const at = Number(r?.headers.get("x-ember-cached-at"));
      if (r && Number.isFinite(at) && now - at < ttl * 1000) {
        const body = (await r.json()) as SqlResponse;
        memo.set(key, { at, body });
        return { ...body, cached: true };
      }
    } catch {
      // the cache is an optimization: a failure is a miss
    }
  }
  const body = await runSql(api, sql);
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
  memo.set(key, { at: now, body });
  if (cache) {
    try {
      await cache.put(key, new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}`, "x-ember-cached-at": String(now) } }));
    } catch {
      // ignore
    }
  }
  return body;
}

/** Empties the in-isolate cache (tests). */
export function clearSqlCache(): void {
  memo.clear();
}
