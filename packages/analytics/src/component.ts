// The analytics component (contracts.md "Analytics"). Events go to Workers Analytics Engine, one data point each, from
// the action that received them (the HTTP route `POST <mount>/track`, or `lib:track` from an app action): no Durable
// Object is woken or written per event. The only rows the component writes are its dashboard reports (one per
// refresh, funnel or retention run), never per event.

import {
  componentBuilders,
  cronJobs,
  defineComponent,
  defineErrors,
  defineSchema,
  defineTable,
  EmberError,
  httpRouter,
  readLimitedText,
  unsafeRef,
  v,
  type ComponentBinding,
  type ComponentCtx,
} from "@freecorps/ember-server";
import { edgeLimit } from "@freecorps/ember-rate-limit";
import { archiveBatch, type ArchivedEvent, type R2BucketLike } from "./archive.ts";
import { BatchError, checkBatch, checkLayout, MAX_BODY_BYTES, MAX_EVENTS, parseBatch, toDataPoint, type AnalyticsEngineDataset, type TrackedEvent } from "./events.ts";
import {
  cachedSql,
  countsSql,
  deploymentOf,
  funnelSql,
  installKey,
  MAX_PERIODS,
  overviewSql,
  parseFunnel,
  parseRetention,
  retentionSql,
  SqlApiError,
  SqlInputError,
  topEventsSql,
  type Bucket,
  type FunnelResult,
  type Period,
  type RetentionResult,
  type SqlApi,
  type SqlResponse,
} from "./sql.ts";

export const DEFAULT_BINDING = "EMBER_ANALYTICS";
export const DEFAULT_DATASET = "ember_analytics";
export const DEFAULT_ACCOUNT_ENV = "EMBER_ANALYTICS_ACCOUNT_ID";
export const DEFAULT_TOKEN_ENV = "EMBER_ANALYTICS_API_TOKEN";
export const DEFAULT_CACHE_SECONDS = 60;
export const DEFAULT_SUMMARY_MINUTES = 60;
export const DEFAULT_ARCHIVE_PREFIX = "analytics";

const schema = defineSchema({
  tables: {
    /** The dashboard's last results (`overview`, `funnel`, `retention`): one row per key, replaced by each run. */
    reports: defineTable({ key: v.string(), at: v.number(), value: v.any() }).index("by_key", ["key"]),
  },
});

export const analyticsErrors = defineErrors({
  AnalyticsNotConfigured: {
    data: v.object({ missing: v.array(v.string()) }),
    status: 503,
    message: (d: { missing: string[] }) => `analytics: queries need ${d.missing.join(" and ")} in the env (Analytics Engine SQL API)`,
  },
  AnalyticsQueryFailed: {
    data: v.object({ status: v.number() }),
    status: 502,
    message: (d: { status: number }) => `analytics: the Analytics Engine SQL API answered ${d.status}`,
  },
});

const vMinutes = v.object({ everyMinutes: v.optional(v.number()) });

export const installConfigValidator = v.object({
  /** The Analytics Engine binding (default `EMBER_ANALYTICS`); `ember deploy` creates it on `dataset`. */
  binding: v.optional(v.string()),
  /** The dataset (default `ember_analytics`): what the SQL queries read. */
  dataset: v.optional(v.string()),
  /** String props with a column of their own (blob8..blob20), queryable by name. */
  dimensions: v.optional(v.array(v.string())),
  /** Number props with a column of their own (double2..double20). */
  measures: v.optional(v.array(v.string())),
  /** Keep a `userId` sent by the client when there is no signed-in identity (default false: dropped). */
  trustClientUserId: v.optional(v.boolean()),
  /** Events per batch (1..50, default 50). */
  maxEvents: v.optional(v.number()),
  /**
   * A Workers Rate Limiting binding checked per batch, by a key the client cannot pick: the IP (`cf-connecting-ip`,
   * set by Cloudflare), or with `key: "user"` the signed-in user (the IP when anonymous). With `limit` and
   * `period` the component asks `ember deploy` for the binding itself; without, it uses one declared elsewhere (the
   * rateLimit component's `bindings`). Without `rateLimit`, only the size caps apply.
   */
  rateLimit: v.optional(
    v.object({ binding: v.string(), key: v.optional(v.union(v.literal("ip"), v.literal("user"))), limit: v.optional(v.number()), period: v.optional(v.union(v.literal(10), v.literal(60))) }),
  ),
  /** Also write each batch to R2 as gzip NDJSON (`true`: the files bucket `EMBER_FILES`, prefix `analytics`). */
  archive: v.optional(v.union(v.boolean(), v.object({ bucket: v.optional(v.string()), prefix: v.optional(v.string()) }))),
  /** The SQL API: env names of the account id and the API token (server side only), cache, base URL (tests). */
  sql: v.optional(v.object({ accountIdEnv: v.optional(v.string()), tokenEnv: v.optional(v.string()), base: v.optional(v.string()), cacheSeconds: v.optional(v.number()) })),
  /** The dashboard summary cron (default every 60 minutes; only runs queries with the SQL API configured). */
  summary: v.optional(v.union(v.literal(false), vMinutes)),
});

export type AnalyticsInstallConfig = {
  binding?: string;
  dataset?: string;
  dimensions?: string[];
  measures?: string[];
  trustClientUserId?: boolean;
  maxEvents?: number;
  rateLimit?: { binding: string; key?: "ip" | "user"; limit?: number; period?: 10 | 60 };
  archive?: boolean | { bucket?: string; prefix?: string };
  sql?: { accountIdEnv?: string; tokenEnv?: string; base?: string; cacheSeconds?: number };
  summary?: false | { everyMinutes?: number };
};

type Config = AnalyticsInstallConfig | undefined;
const { action, internalAction, internalMutation, internalQuery, httpAction } = componentBuilders<typeof schema, Config>();
type ActCtx = ComponentCtx<typeof schema, Config>["action"];

const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The deploy bindings an install asks for: its Analytics Engine dataset, and a Rate Limiting binding if it says so. */
export function bindingsOf(config: Config): ComponentBinding[] {
  const binding = config?.binding ?? DEFAULT_BINDING;
  const dataset = config?.dataset ?? DEFAULT_DATASET;
  if (!BINDING.test(binding)) throw new Error(`analytics: invalid binding name ${JSON.stringify(binding)}`);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(dataset)) throw new Error(`analytics: invalid dataset name ${JSON.stringify(dataset)}`);
  checkLayout(config ?? {});
  const out: ComponentBinding[] = [{ type: "analytics_engine", name: binding, dataset }];
  const rl = config?.rateLimit;
  if (rl?.limit !== undefined || rl?.period !== undefined) {
    if (rl.limit === undefined || rl.period === undefined) throw new Error("analytics: rateLimit needs both limit and period to create its binding");
    out.push({ type: "ratelimit", name: rl.binding, limit: rl.limit, period: rl.period });
  }
  return out;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** The install's dataset binding, or null (events are then dropped, as RUM does without its binding). */
function datasetOf(ctx: ActCtx): AnalyticsEngineDataset | null {
  const name = ctx.component.config?.binding ?? DEFAULT_BINDING;
  const d = ctx.env[name] as AnalyticsEngineDataset | undefined;
  if (d && typeof d.writeDataPoint === "function") return d;
  warnOnce(`ds:${name}`, `ember-analytics: no Analytics Engine binding ${name}: events are dropped (ember deploy creates it)`);
  return null;
}

export interface IngestResult {
  /** Events checked and taken. */
  accepted: number;
  /** Whether they went to Analytics Engine (false without the binding). */
  written: boolean;
  /** The R2 key of the batch, with `archive`. */
  archived: string | null;
}

/** Writes checked events: one data point each, then (with `archive`) one R2 object for the batch. */
export async function ingest(ctx: ActCtx, events: TrackedEvent[], source: "client" | "server", country: string): Promise<IngestResult> {
  const cfg = ctx.component.config ?? {};
  const ds = datasetOf(ctx);
  // blob6 carries the deployment too: staging and production sharing the account's default dataset stay apart.
  const point = { install: installKey(ctx.component.name, deploymentOf(ctx.env)), source, country, dimensions: cfg.dimensions ?? [], measures: cfg.measures ?? [] };
  if (ds) for (const e of events) ds.writeDataPoint(toDataPoint(e, point));
  let archived: string | null = null;
  if (cfg.archive) {
    const a = cfg.archive === true ? {} : cfg.archive;
    const name = a.bucket ?? "EMBER_FILES";
    const bucket = ctx.env[name] as R2BucketLike | undefined;
    if (!bucket || typeof bucket.put !== "function") warnOnce(`r2:${name}`, `ember-analytics: archive is on but there is no R2 bucket ${name}`);
    else {
      try {
        const lines: ArchivedEvent[] = events.map((e) => ({ ...e, install: ctx.component.name, source, country }));
        archived = await archiveBatch(bucket, lines, { prefix: a.prefix ?? DEFAULT_ARCHIVE_PREFIX, now: events[0]?.receivedAt ?? Date.now() });
      } catch (e) {
        // The events are in Analytics Engine already; the archive is best effort (at most once per batch).
        console.error(`ember-analytics: archive failed: ${(e as Error).message}`);
      }
    }
  }
  return { accepted: events.length, written: !!ds, archived };
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};
const reply = (status: number, code?: string, message?: string) =>
  code
    ? new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { ...CORS, "content-type": "application/json" } })
    : new Response(null, { status, headers: CORS });

/** `POST <mount>/track`: a batch from a browser or app (text/plain JSON, no preflight). 204 when taken. */
export async function handleTrack(ctx: ActCtx, request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return reply(204);
  const cfg = ctx.component.config ?? {};
  const text = await readLimitedText(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, "too_large", `a batch is at most ${MAX_BODY_BYTES} bytes`);
  const identity = await ctx.auth.getUserIdentity();
  let events: TrackedEvent[];
  try {
    events = parseBatch(text, { now: Date.now(), identity: identity?.subject ?? null, trustUserId: !!cfg.trustClientUserId, maxEvents: maxEventsOf(cfg) });
  } catch (e) {
    if (e instanceof BatchError) return reply(400, "bad_batch", e.message);
    throw e;
  }
  if (cfg.rateLimit) {
    // Never a value from the body (an anonymousId is the client's to pick: a fresh one per batch would be a fresh
    // bucket) nor a header the client sets: Cloudflare writes cf-connecting-ip on every request it proxies.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const key = cfg.rateLimit.key === "user" && identity ? `user:${identity.subject}` : `ip:${ip}`;
    const binding = ctx.env[cfg.rateLimit.binding] as { limit?: unknown } | undefined;
    if (!binding || typeof binding.limit !== "function") {
      // A missing binding (not deployed yet) must not drop the app's analytics: size caps still apply.
      warnOnce(`rl:${cfg.rateLimit.binding}`, `ember-analytics: rate limit skipped: no Rate Limiting binding ${cfg.rateLimit.binding}`);
    } else {
      let ok: boolean;
      try {
        ({ ok } = await edgeLimit(ctx, cfg.rateLimit.binding, `analytics:${key}`));
      } catch (e) {
        // A deployed limiter that fails: the limit is not skipped (fail closed). 503 + Retry-After: the client keeps
        // the batch and sends it again later.
        console.error(`ember-analytics: rate limit check failed: ${(e as Error).message}`);
        return new Response(JSON.stringify({ ok: false, error: { code: "rate_limit_unavailable", message: "the rate limiter failed; retry later" } }), { status: 503, headers: { ...CORS, "content-type": "application/json", "retry-after": "10" } });
      }
      if (!ok) return new Response(JSON.stringify({ ok: false, error: { code: "rate_limited", message: "too many events; retry later" } }), { status: 429, headers: { ...CORS, "content-type": "application/json", "retry-after": "10" } });
    }
  }
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === "string" ? cf.country : (request.headers.get("cf-ipcountry") ?? "");
  await ingest(ctx, events, "client", /^[A-Z]{2}$/.test(country) ? country : "");
  return reply(204);
}

const maxEventsOf = (cfg: AnalyticsInstallConfig) => Math.max(1, Math.min(MAX_EVENTS, Math.floor(cfg.maxEvents ?? MAX_EVENTS)));

const trackHttp = httpAction((ctx, request) => handleTrack(ctx, request));

// ------------------------------------------------------------------------------------------------ queries

function sqlApi(ctx: ActCtx): SqlApi {
  const s = ctx.component.config?.sql ?? {};
  const accEnv = s.accountIdEnv ?? DEFAULT_ACCOUNT_ENV;
  const tokEnv = s.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const accountId = ctx.env[accEnv] ?? (s.accountIdEnv ? undefined : ctx.env.EMBER_R2_ACCOUNT_ID);
  const token = ctx.env[tokEnv];
  const missing = [...(typeof accountId === "string" && accountId ? [] : [accEnv]), ...(typeof token === "string" && token ? [] : [tokEnv])];
  if (missing.length) throw analyticsErrors.AnalyticsNotConfigured({ missing });
  return { accountId: accountId as string, token: token as string, ...(s.base ? { base: s.base } : {}) };
}

const configured = (ctx: ActCtx) => {
  try {
    sqlApi(ctx);
    return true;
  } catch {
    return false;
  }
};

const scopeOf = (ctx: ActCtx) => ({ dataset: ctx.component.config?.dataset ?? DEFAULT_DATASET, install: ctx.component.name, deployment: deploymentOf(ctx.env) });

/** Builds (checked: `SqlInputError` → `ValidationError`) and runs one statement through the cache. */
async function query(ctx: ActCtx, build: () => string): Promise<SqlResponse> {
  let sql: string;
  try {
    sql = build();
  } catch (e) {
    if (e instanceof SqlInputError) throw new EmberError("ValidationError", e.message);
    throw e;
  }
  const api = sqlApi(ctx);
  try {
    return await cachedSql(api, sql, { ttlSeconds: ctx.component.config?.sql?.cacheSeconds ?? DEFAULT_CACHE_SECONDS });
  } catch (e) {
    if (e instanceof SqlApiError) {
      console.error(`ember-analytics: ${e.message}`);
      throw analyticsErrors.AnalyticsQueryFailed({ status: e.status });
    }
    throw e;
  }
}

const n = (x: unknown) => {
  const y = typeof x === "number" ? x : Number(x);
  return Number.isFinite(y) ? y : 0;
};

export type CountRow = { t: string; name: string; events: number };
export type TopEvent = { name: string; events: number; users: number };
export type Overview = { eventsToday: number; usersToday: number; top: TopEvent[]; at: number | null; configured: boolean };

const vBucket = v.union(v.literal("minute"), v.literal("hour"), v.literal("day"));
const vPeriod = v.union(v.literal("day"), v.literal("week"));
const vProps = v.record(v.union(v.string(), v.number(), v.boolean()));
const vEvent = v.object({ name: v.string(), props: v.optional(vProps), ts: v.optional(v.number()), anonymousId: v.optional(v.string()), userId: v.optional(v.string()) });

/** Oldest first; at most `MAX_COUNT_ROWS` rows, the newest buckets of the range (a longer range loses its oldest). */
const counts = (ctx: ActCtx, a: { names?: string[]; sinceHours?: number; bucket?: Bucket }) =>
  query(ctx, () => countsSql(scopeOf(ctx), a)).then((r) =>
    (r.data ?? [])
      .map((x): CountRow => ({ t: String(x.t ?? ""), name: String(x.name ?? ""), events: n(x.events) }))
      .sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.name < y.name ? -1 : x.name > y.name ? 1 : 0)),
  );
const topEvents = (ctx: ActCtx, a: { sinceHours?: number; limit?: number }) =>
  query(ctx, () => topEventsSql(scopeOf(ctx), a)).then((r) => (r.data ?? []).map((x): TopEvent => ({ name: String(x.name ?? ""), events: n(x.events), users: n(x.users) })));
const funnelOpts = (a: { steps: string[]; windowHours?: number; days?: number }) => ({
  steps: a.steps,
  ...(a.windowHours !== undefined ? { windowSeconds: a.windowHours * 3600 } : {}),
  ...(a.days !== undefined ? { sinceDays: a.days } : {}),
});
const funnel = async (ctx: ActCtx, a: { steps: string[]; windowHours?: number; days?: number }): Promise<FunnelResult> => {
  const o = funnelOpts(a);
  return parseFunnel(await query(ctx, () => funnelSql(scopeOf(ctx), o)), o);
};
const retention = async (ctx: ActCtx, a: { period?: Period; periods?: number; event?: string }): Promise<RetentionResult> => {
  const o = { ...a, now: ctx.now };
  return parseRetention(await query(ctx, () => retentionSql(scopeOf(ctx), o)), o);
};

const saveReport = unsafeRef<"mutation">("lib:saveReport");

/** Today's events and users, and the top events of the last 24 h: what the dashboard's overview shows. */
async function refresh(ctx: ActCtx): Promise<Overview> {
  if (!configured(ctx)) {
    const value: Overview = { eventsToday: 0, usersToday: 0, top: [], at: null, configured: false };
    // The credentials went away: the saved overview must not keep showing the old numbers as configured. Only an
    // existing report is replaced (an install that never had one still writes nothing).
    await ctx.runMutation(saveReport, { key: "overview", value, onlyIfExists: true });
    return value;
  }
  const [today, top] = await Promise.all([query(ctx, () => overviewSql(scopeOf(ctx), { now: ctx.now })), topEvents(ctx, { sinceHours: 24, limit: 20 })]);
  const row = today.data?.[0] ?? {};
  const value: Overview = { eventsToday: n(row.events), usersToday: n(row.users), top, at: ctx.now, configured: true };
  await ctx.runMutation(saveReport, { key: "overview", value });
  return value;
}

export const functions = {
  lib: {
    /**
     * Tracks events from server code (an app action): one data point each, no row. `userId` comes from the caller's
     * identity when there is one; otherwise the one given (server code is trusted; clients never call this).
     */
    track: action({
      args: { events: v.array(vEvent), userId: v.optional(v.string()), anonymousId: v.optional(v.string()) },
      handler: async (ctx, a): Promise<IngestResult> => {
        const identity = await ctx.auth.getUserIdentity();
        const withIds = a.events.map((e) => ({ ...e, ...(a.userId !== undefined && e.userId === undefined ? { userId: a.userId } : {}), ...(a.anonymousId !== undefined && e.anonymousId === undefined ? { anonymousId: a.anonymousId } : {}) }));
        let events: TrackedEvent[];
        try {
          events = checkBatch({ events: withIds }, { now: Date.now(), identity: identity?.subject ?? null, trustUserId: true, maxEvents: MAX_EVENTS });
        } catch (e) {
          if (e instanceof BatchError) throw new EmberError("ValidationError", e.message);
          throw e;
        }
        return ingest(ctx, events, "server", "");
      },
    }),
    /** Events per time bucket and name over the last `sinceHours` (Analytics Engine SQL, cached briefly). */
    counts: action({
      args: { names: v.optional(v.array(v.string())), sinceHours: v.optional(v.number()), bucket: v.optional(vBucket) },
      errors: [analyticsErrors.AnalyticsNotConfigured, analyticsErrors.AnalyticsQueryFailed],
      handler: (ctx, a) => counts(ctx, a),
    }),
    /** The most frequent events, with distinct users. */
    topEvents: action({
      args: { sinceHours: v.optional(v.number()), limit: v.optional(v.number()) },
      errors: [analyticsErrors.AnalyticsNotConfigured, analyticsErrors.AnalyticsQueryFailed],
      handler: (ctx, a) => topEvents(ctx, a),
    }),
    /** Ordered steps within `windowHours` (default 24) of each user's first step, over the last `days` (default 7). */
    funnel: action({
      args: { steps: v.array(v.string()), windowHours: v.optional(v.number()), days: v.optional(v.number()) },
      errors: [analyticsErrors.AnalyticsNotConfigured, analyticsErrors.AnalyticsQueryFailed],
      handler: (ctx, a) => funnel(ctx, a),
    }),
    /** Cohorts by first-seen day or week, and how many came back in each later period. */
    retention: action({
      args: { period: v.optional(vPeriod), periods: v.optional(v.number()), event: v.optional(v.string()) },
      errors: [analyticsErrors.AnalyticsNotConfigured, analyticsErrors.AnalyticsQueryFailed],
      handler: (ctx, a) => retention(ctx, a),
    }),
    /** Recomputes the dashboard overview (the summary cron). Without the SQL API configured: nothing, no write. */
    refresh: internalAction({ args: {}, handler: (ctx) => refresh(ctx) }),
    saveReport: internalMutation({
      args: { key: v.string(), value: v.any(), onlyIfExists: v.optional(v.boolean()) },
      handler: (ctx, a) => {
        const row = ctx.db.query("reports").withIndex("by_key", (q) => q.eq("key", a.key)).first();
        if (!row && a.onlyIfExists) return;
        if (row) ctx.db.replace(row._id, { key: a.key, at: ctx.now, value: a.value });
        else ctx.db.insert("reports", { key: a.key, at: ctx.now, value: a.value });
      },
    }),
  },
};

const report = (ctx: ComponentCtx<typeof schema, Config>["query"], key: string) => ctx.db.query("reports").withIndex("by_key", (q) => q.eq("key", key)).first();

/** What only the dashboard reads and runs (`@<install>/dashboard:*`, internal). */
export const dashboardFunctions = {
  overview: internalQuery({
    args: {},
    handler: (ctx): Overview => (report(ctx, "overview")?.value as Overview | undefined) ?? { eventsToday: 0, usersToday: 0, top: [], at: null, configured: false },
  }),
  refresh: internalAction({ args: {}, handler: (ctx) => refresh(ctx) }),
  funnel: internalAction({
    args: { steps: v.array(v.string()), windowHours: v.optional(v.number()), days: v.optional(v.number()) },
    handler: async (ctx, a) => {
      const value = await funnel(ctx, a);
      await ctx.runMutation(saveReport, { key: "funnel", value });
      return `${value.steps.at(-1)?.users ?? 0} of ${value.steps[0]?.users ?? 0} users finished`;
    },
  }),
  lastFunnel: internalQuery({
    args: {},
    handler: (ctx) => {
      const r = report(ctx, "funnel");
      return r ? { at: r.at, ...(r.value as FunnelResult) } : { at: null, steps: [] };
    },
  }),
  retention: internalAction({
    args: { period: v.optional(vPeriod), periods: v.optional(v.number()), event: v.optional(v.string()) },
    handler: async (ctx, a) => {
      const value = await retention(ctx, a);
      await ctx.runMutation(saveReport, { key: "retention", value });
      return `${value.cohorts.length} cohorts`;
    },
  }),
  lastRetention: internalQuery({
    args: {},
    handler: (ctx) => {
      const r = report(ctx, "retention");
      return r ? { at: r.at, ...(r.value as RetentionResult) } : { at: null, cohorts: [] };
    },
  }),
};

const http = httpRouter().route({ path: "/track", method: "POST", handler: trackHttp }).route({ path: "/track", method: "OPTIONS", handler: trackHttp });

// Every return a retention run can have (`MAX_PERIODS - 1`); a cohort without one leaves the column blank.
const PERIOD_COLUMNS = Array.from({ length: MAX_PERIODS - 1 }, (_, i) => ({ label: `+${i + 1}`, path: `rates.${i}`, format: "percent" as const }));

export const analytics = defineComponent({
  name: "analytics",
  schema,
  functions: { ...functions, dashboard: dashboardFunctions },
  config: v.optional(installConfigValidator),
  http,
  bindings: (config) => bindingsOf(config),
  crons: (config) => {
    // The screen is global (it reads global:main): the reports and the cron live there.
    const c = cronJobs({ shard: "global:main" });
    if (config?.summary === false) return c;
    const every = Math.max(5, Math.min(24 * 60, Math.floor(config?.summary?.everyMinutes ?? DEFAULT_SUMMARY_MINUTES)));
    return every % 60 === 0 ? c.interval("summary", { hours: every / 60 }, "lib:refresh") : c.interval("summary", { minutes: every }, "lib:refresh");
  },
  dashboard: {
    label: "Analytics",
    icon: "chart",
    scope: "global",
    description: "Product events in Workers Analytics Engine (no row per event). The overview refreshes on the summary cron; funnels and retention run on demand.",
    tabs: [
      {
        id: "overview",
        label: "Overview",
        blocks: [
          {
            kind: "stats",
            id: "today",
            query: dashboardFunctions.overview,
            items: [
              { label: "Events today", path: "eventsToday", format: "number" },
              { label: "Active users today", path: "usersToday", format: "number" },
              { label: "Updated", path: "at", format: "ago" },
              { label: "SQL API", path: "configured", format: "boolean" },
            ],
          },
          {
            kind: "table",
            id: "top",
            label: "Top events (24 h)",
            query: dashboardFunctions.overview,
            rows: "top",
            rowKey: "name",
            columns: [
              { label: "Event", path: "name", format: "code" },
              { label: "Events", path: "events", format: "number" },
              { label: "Users", path: "users", format: "number" },
            ],
          },
          { kind: "actions", id: "refresh", actions: [{ id: "refresh", label: "Refresh now", fn: dashboardFunctions.refresh, description: "Runs the overview queries now (one SQL API call each, one row written)." }] },
        ],
      },
      {
        id: "funnel",
        label: "Funnel",
        blocks: [
          {
            kind: "actions",
            id: "run",
            actions: [{ id: "funnel", label: "Run a funnel…", fn: dashboardFunctions.funnel, description: "steps: the event names in order; windowHours: time from the first step (default 24); days: how far back (default 7)." }],
          },
          {
            kind: "table",
            id: "steps",
            label: "Last funnel",
            query: dashboardFunctions.lastFunnel,
            rows: "steps",
            rowKey: "step",
            columns: [
              { label: "Step", path: "step", format: "number" },
              { label: "Event", path: "name", format: "code" },
              { label: "Users", path: "users", format: "number" },
              { label: "Conversion", path: "conversion", format: "percent" },
              { label: "From previous", path: "fromPrevious", format: "percent" },
            ],
          },
        ],
      },
      {
        id: "retention",
        label: "Retention",
        blocks: [
          {
            kind: "actions",
            id: "run",
            actions: [{ id: "retention", label: "Run retention…", fn: dashboardFunctions.retention, description: "period: day or week (default week); periods: 2..13 (default 8); event: the event that counts (default any)." }],
          },
          {
            kind: "table",
            id: "cohorts",
            label: "Last retention",
            query: dashboardFunctions.lastRetention,
            rows: "cohorts",
            rowKey: "start",
            columns: [{ label: "Cohort", path: "start", format: "date" }, { label: "Users", path: "users", format: "number" }, ...PERIOD_COLUMNS],
          },
        ],
      },
    ],
  },
});
