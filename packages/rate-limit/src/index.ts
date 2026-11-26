/**
 * `@freecorps/ember-rate-limit`: rate limiting as an Ember component (PLAN §12), like Convex's rate-limiter.
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(rateLimit);
 *
 *   // ember/limits.ts
 *   export const limiter = new RateLimiter(components.rateLimit, {
 *     sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
 *     signUp: { kind: "fixed window", rate: 100, period: HOUR },
 *   });
 *
 *   // in a mutation (synchronous, same transaction: a later failure gives the tokens back)
 *   const { ok, retryAfter } = limiter.limit(ctx, "sendMessage", { key: userId });
 *   // in an action (a separate transaction on the action's shard)
 *   await limiter.limit(ctx, "signUp");
 *
 * State lives in the caller's shard: a limit is exact per shard. For a limit across shards, call it on one shard
 * from an action (`ctx.onShard("global:main")`), or use the Cloudflare binding (approximate, per location).
 */
import { EmberError, type ErrorSpec, type FunctionReference } from "@freecorps/ember-server";
import type { RateLimitConfig, ReserveResult } from "./algorithms.ts";
import { rateLimitErrors } from "./component.ts";

// Not `export *`: `consumeChecked`/`checkChecked` are the component's (they skip `checkConfig`).
export { check, checkConfig, consume, fullAt, refill, SECOND, MINUTE, HOUR, DAY } from "./algorithms.ts";
export type { FixedWindow, RateLimitConfig, RateLimitResult, RateLimitState, ReserveResult, TokenBucket } from "./algorithms.ts";
export {
  rateLimit,
  functions as rateLimitFunctions,
  rateLimitConfigValidator,
  installConfigValidator,
  rateLimitErrors,
  edgeBindingsOf,
  RATE_LIMITED,
  DEFAULT_GC_BATCH,
  DEFAULT_GC_INTERVAL_MS,
  MAX_GC_BATCH,
  type RateLimitEdgeBinding,
  type RateLimitGcConfig,
  type RateLimitInstallConfig,
} from "./component.ts";

type LimitArgs = { name: string; key?: string; count?: number; config?: RateLimitConfig; reserve?: boolean; throws?: boolean };
type CheckArgs = { name: string; key?: string; count?: number; config?: RateLimitConfig };
type Result = { ok: boolean; retryAfter?: number };

/** What `components.<name>` of the rateLimit component looks like (structural: any install name works). */
export interface RateLimitComponentApi {
  lib: {
    limit: FunctionReference<"mutation", "public", LimitArgs, Result, ErrorSpec<"RateLimited", { name: string; retryAfter: number }>>;
    check: FunctionReference<"query", "public", CheckArgs, Result>;
    getValue: FunctionReference<"query", "public", { name: string; key?: string; config?: RateLimitConfig }, { value: number; capacity: number; ts: number }>;
    reset: FunctionReference<"mutation", "public", { name: string; key?: string }, boolean>;
  };
}

// Method syntax: any ctx's typed `runQuery`/`runMutation`/`runAction` fits (parameters are compared bivariantly);
// results are typed by the overloads below.
/** Mutation/query ctx: `ctx.run*` returns values (same transaction). */
type SyncCtx = { db: unknown; runQuery(fn: unknown, args?: unknown): unknown; runMutation?(fn: unknown, args?: unknown): unknown };
/** Action ctx: `ctx.run*` returns Promises (own transaction on the action's shard). */
type AsyncCtx = { runAction(fn: unknown, args?: unknown): Promise<unknown>; runQuery(fn: unknown, args?: unknown): Promise<unknown>; runMutation(fn: unknown, args?: unknown): Promise<unknown> };

export type LimitOptions = { key?: string; count?: number; reserve?: boolean; throws?: boolean };

/**
 * Throws `RateLimited` (`rateLimitErrors.RateLimited`, an app error: `isError(e, rateLimitErrors.RateLimited)`) for a
 * refused result: what `throws: true` does inside the component.
 */
export function assertAllowed(name: string, r: Result): void {
  if (!r.ok) throw rateLimitErrors.RateLimited({ name, retryAfter: r.retryAfter ?? 0 });
}

/**
 * Typed helper over an installed rateLimit component: limits are declared once here and sent with each call,
 * so they can change without redeploying the component's config. Works in mutations (sync) and actions (async).
 */
export class RateLimiter<Limits extends Record<string, RateLimitConfig>> {
  constructor(
    readonly component: RateLimitComponentApi,
    readonly limits: Limits,
  ) {}

  private args(name: keyof Limits & string, o: LimitOptions = {}): LimitArgs {
    const config = this.limits[name];
    if (!config) throw new Error(`RateLimiter: unknown limit ${JSON.stringify(name)}`);
    const a: LimitArgs = { name, config };
    if (o.key !== undefined) a.key = o.key;
    if (o.count !== undefined) a.count = o.count;
    if (o.reserve) a.reserve = true;
    if (o.throws) a.throws = true;
    return a;
  }

  /** Takes tokens. In a mutation: synchronous, same transaction. In an action: a Promise. */
  limit(ctx: SyncCtx, name: keyof Limits & string, opts?: LimitOptions): ReserveResult;
  limit(ctx: AsyncCtx, name: keyof Limits & string, opts?: LimitOptions): Promise<ReserveResult>;
  limit(ctx: SyncCtx | AsyncCtx, name: keyof Limits & string, opts?: LimitOptions): ReserveResult | Promise<ReserveResult> {
    if (!ctx.runMutation) throw new Error("RateLimiter.limit needs a mutation or action ctx (queries cannot take tokens: use check)");
    return ctx.runMutation(this.component.lib.limit, this.args(name, opts)) as ReserveResult | Promise<ReserveResult>;
  }

  /** Checks without taking tokens. Reactive inside queries. */
  check(ctx: SyncCtx, name: keyof Limits & string, opts?: Pick<LimitOptions, "key" | "count">): Result;
  check(ctx: AsyncCtx, name: keyof Limits & string, opts?: Pick<LimitOptions, "key" | "count">): Promise<Result>;
  check(ctx: SyncCtx | AsyncCtx, name: keyof Limits & string, opts: Pick<LimitOptions, "key" | "count"> = {}): Result | Promise<Result> {
    const { reserve: _r, throws: _t, ...a } = this.args(name, opts);
    return ctx.runQuery(this.component.lib.check, a) as Result | Promise<Result>;
  }

  /** Tokens left (and capacity), e.g. for a UI. */
  getValue(ctx: SyncCtx, name: keyof Limits & string, opts?: { key?: string }): { value: number; capacity: number; ts: number };
  getValue(ctx: AsyncCtx, name: keyof Limits & string, opts?: { key?: string }): Promise<{ value: number; capacity: number; ts: number }>;
  getValue(ctx: SyncCtx | AsyncCtx, name: keyof Limits & string, opts: { key?: string } = {}) {
    const { name: n, config, key } = this.args(name, opts);
    return ctx.runQuery(this.component.lib.getValue, key !== undefined ? { name: n, config, key } : { name: n, config });
  }

  /** Back to a full bucket. */
  reset(ctx: SyncCtx, name: keyof Limits & string, opts?: { key?: string }): boolean;
  reset(ctx: AsyncCtx, name: keyof Limits & string, opts?: { key?: string }): Promise<boolean>;
  reset(ctx: SyncCtx | AsyncCtx, name: keyof Limits & string, opts: { key?: string } = {}) {
    if (!ctx.runMutation) throw new Error("RateLimiter.reset needs a mutation or action ctx");
    return ctx.runMutation(this.component.lib.reset, opts.key !== undefined ? { name, key: opts.key } : { name });
  }
}

/** The Workers Rate Limiting binding (`env.<name>.limit({ key })`). */
export interface RateLimitBinding {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Action/HTTP-side check against the Cloudflare Rate Limiting binding the component asked for
 * (`app.use(rateLimit, { config: { binding: { name, limit, period } } })`). Approximate and per Cloudflare
 * location: use it to shed abusive traffic before it reaches a shard; use `RateLimiter` for exact quotas.
 */
export async function edgeLimit(ctx: { env: Record<string, unknown> }, binding: string, key: string): Promise<{ ok: boolean }> {
  const b = ctx.env[binding] as RateLimitBinding | undefined;
  if (!b || typeof b.limit !== "function") {
    throw new EmberError("ValidationError", `edgeLimit: no Rate Limiting binding ${binding} (install rateLimit with { binding } and deploy)`);
  }
  const r = await b.limit({ key });
  return { ok: !!r.success };
}
