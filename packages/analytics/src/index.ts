/**
 * `@freecorps/ember-analytics`: product analytics as an Ember component (PLAN §12), on Workers Analytics Engine.
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(analytics, { config: { dimensions: ["plan"], archive: true } });
 *
 *   // browser (`@freecorps/ember-analytics/client`): batched, beacons on pagehide, text/plain (no preflight)
 *   const a = createAnalytics({ url: "https://my-app.example.com" });
 *   a.track("signed_up", { plan: "pro" });
 *
 *   // ember/billing.ts (an action): server side, the caller's identity is the user
 *   const analytics = new Analytics(components.analytics);
 *   await analytics.track(ctx, "checkout_completed", { amount: 49 });
 *   const f = await analytics.funnel(ctx, { steps: ["viewed_pricing", "started_checkout", "checkout_completed"] });
 *
 * Each event is one Analytics Engine data point written by the action that received it: no Durable Object is woken
 * or written per event. Queries go to the Analytics Engine SQL API (account id and token from the env, server side
 * only) and are cached briefly.
 */
import type { ErrorSpec, FunctionReference } from "@freecorps/ember-server";
import type { CountRow, IngestResult, TopEvent } from "./component.ts";
import type { EventInput, Props } from "./events.ts";
import type { Bucket, FunnelResult, Period, RetentionResult } from "./sql.ts";

export {
  analytics,
  functions as analyticsFunctions,
  dashboardFunctions as analyticsDashboardFunctions,
  analyticsErrors,
  installConfigValidator,
  bindingsOf,
  handleTrack,
  ingest,
  DEFAULT_ACCOUNT_ENV,
  DEFAULT_ARCHIVE_PREFIX,
  DEFAULT_BINDING,
  DEFAULT_CACHE_SECONDS,
  DEFAULT_DATASET,
  DEFAULT_SUMMARY_MINUTES,
  DEFAULT_TOKEN_ENV,
  type AnalyticsInstallConfig,
  type CountRow,
  type IngestResult,
  type Overview,
  type TopEvent,
} from "./component.ts";
export * from "./events.ts";
export {
  cachedSql,
  checkBase,
  clearSqlCache,
  countsSql,
  funnelSql,
  int,
  lit,
  overviewSql,
  parseFunnel,
  parseRetention,
  retentionSql,
  retentionStart,
  runSql,
  sqlCacheSize,
  topEventsSql,
  DATASET,
  INSTALL,
  NEVER,
  MAX_COUNT_ROWS,
  MAX_PERIODS,
  PERIOD_SECONDS,
  SQL_API_BASE,
  SqlApiError,
  SqlInputError,
  type Bucket,
  type CacheLike,
  type CountsOptions,
  type FunnelOptions,
  type FunnelResult,
  type FunnelStep,
  type Period,
  type RetentionCohort,
  type RetentionOptions,
  type RetentionResult,
  type Scope,
  type SqlApi,
  type SqlResponse,
} from "./sql.ts";
export { archiveBatch, archiveKey, gunzipNdjson, gzipNdjson, type ArchivedEvent, type R2BucketLike } from "./archive.ts";

type TrackArgs = { events: EventInput[]; userId?: string; anonymousId?: string };
/** What the query functions declare (`isError(e, analyticsErrors.AnalyticsNotConfigured)`). */
type QueryErrors = ErrorSpec<"AnalyticsNotConfigured", { missing: string[] }> | ErrorSpec<"AnalyticsQueryFailed", { status: number }>;

/** What `components.<name>` of the analytics component looks like (structural: any install name works). */
export interface AnalyticsComponentApi {
  lib: {
    track: FunctionReference<"action", "public", TrackArgs, IngestResult>;
    counts: FunctionReference<"action", "public", { names?: string[]; sinceHours?: number; bucket?: Bucket }, CountRow[], QueryErrors>;
    topEvents: FunctionReference<"action", "public", { sinceHours?: number; limit?: number }, TopEvent[], QueryErrors>;
    funnel: FunctionReference<"action", "public", { steps: string[]; windowHours?: number; days?: number }, FunnelResult, QueryErrors>;
    retention: FunctionReference<"action", "public", { period?: Period; periods?: number; event?: string }, RetentionResult, QueryErrors>;
  };
}

/** An action's ctx (`ctx.runAction`); queries and mutations cannot do I/O (PLAN D6): schedule an action from them. */
export interface ActionCtxLike {
  runAction(fn: FunctionReference<"action", "public">, args: Record<string, unknown>): Promise<unknown>;
}

export interface TrackOptions {
  /** When it happened (ms). Default: now. */
  ts?: number;
  /** The user, when the action runs without an identity (a webhook, a job). The caller's identity always wins. */
  userId?: string;
  anonymousId?: string;
}

/** Typed helper over an installed analytics component, for app actions. */
export class Analytics {
  constructor(readonly component: AnalyticsComponentApi) {}

  /** One event (one data point; no row). */
  track(ctx: ActionCtxLike, name: string, props?: Props, opts: TrackOptions = {}): Promise<IngestResult> {
    const e: EventInput = { name, ...(props ? { props } : {}), ...(opts.ts !== undefined ? { ts: opts.ts } : {}) };
    return this.trackMany(ctx, [e], opts);
  }

  /** Up to 50 events in one call. */
  trackMany(ctx: ActionCtxLike, events: EventInput[], opts: Pick<TrackOptions, "userId" | "anonymousId"> = {}): Promise<IngestResult> {
    const args: TrackArgs = { events, ...(opts.userId !== undefined ? { userId: opts.userId } : {}), ...(opts.anonymousId !== undefined ? { anonymousId: opts.anonymousId } : {}) };
    return ctx.runAction(this.component.lib.track, args) as Promise<IngestResult>;
  }

  /** Events per bucket and name. */
  counts(ctx: ActionCtxLike, o: { names?: string[]; sinceHours?: number; bucket?: Bucket } = {}): Promise<CountRow[]> {
    return ctx.runAction(this.component.lib.counts, o) as Promise<CountRow[]>;
  }

  topEvents(ctx: ActionCtxLike, o: { sinceHours?: number; limit?: number } = {}): Promise<TopEvent[]> {
    return ctx.runAction(this.component.lib.topEvents, o) as Promise<TopEvent[]>;
  }

  /** Ordered steps, within `windowHours` of each user's first step. */
  funnel(ctx: ActionCtxLike, o: { steps: string[]; windowHours?: number; days?: number }): Promise<FunnelResult> {
    return ctx.runAction(this.component.lib.funnel, o) as Promise<FunnelResult>;
  }

  /** Cohorts by first-seen period and their returns. */
  retention(ctx: ActionCtxLike, o: { period?: Period; periods?: number; event?: string } = {}): Promise<RetentionResult> {
    return ctx.runAction(this.component.lib.retention, o) as Promise<RetentionResult>;
  }
}
