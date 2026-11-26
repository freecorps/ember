// The rateLimit component (PLAN §12): one table of (name, key) → tokens, in the caller's shard. `lib:limit` is a
// mutation, so inside an app mutation it runs in the same transaction: if the app mutation fails afterwards, the
// tokens are given back (nothing was consumed). Refused calls write nothing.
//
// GC: each row records `expiresAt`, when its bucket is full again (the same as no row). A job per shard (`lib:gc`,
// ensured by every write, at most one pending) deletes expired rows in batches, so a limiter keyed by user or IP does
// not grow without bound.

import { componentBuilders, defineComponent, defineErrors, defineSchema, defineTable, EmberError, paginationOptsValidator, v, type ComponentCtx, type GenericId } from "@freecorps/ember-server";
import { checkChecked, checkConfig, consumeChecked, fullAt, refill, HOUR, type RateLimitConfig, type RateLimitState } from "./algorithms.ts";

const schema = defineSchema({
  tables: {
    /**
     * One row per (name, key) that has been limited; `key` "" is the global limit of `name`. `expiresAt`: when the
     * bucket is full again (absent on rows written before the GC existed: they get it on their next write).
     */
    rateLimits: defineTable({ name: v.string(), key: v.string(), value: v.number(), ts: v.number(), expiresAt: v.optional(v.number()) })
      .index("by_name_key", ["name", "key"])
      .index("by_expires", ["expiresAt"]),
    /** One row while a GC job is scheduled in this shard: when it runs and its job id. */
    gc: defineTable({ at: v.number(), job: v.string() }),
  },
});

/** The component's application errors (`isError(e, rateLimitErrors.RateLimited)` narrows `e.data`). */
export const rateLimitErrors = defineErrors({
  RateLimited: {
    data: v.object({ name: v.string(), retryAfter: v.number() }),
    status: 429,
    message: (d: { name: string; retryAfter: number }) => `Rate limit ${d.name} exceeded; retry in ${d.retryAfter} ms`,
  },
});

export const rateLimitConfigValidator = v.union(
  v.object({
    kind: v.literal("token bucket"),
    rate: v.number(),
    period: v.number(),
    capacity: v.optional(v.number()),
    maxReserved: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("fixed window"),
    rate: v.number(),
    period: v.number(),
    capacity: v.optional(v.number()),
    start: v.optional(v.number()),
    maxReserved: v.optional(v.number()),
  }),
);

const edgeBindingValidator = v.object({ limit: v.number(), period: v.union(v.literal(10), v.literal(60)) });

/** Install config: named limits (so calls can pass only the name), Cloudflare bindings and the GC. */
export const installConfigValidator = v.object({
  limits: v.optional(v.record(rateLimitConfigValidator)),
  /**
   * A Workers Rate Limiting binding `ember deploy` creates (period 10 or 60 s). Approximate and per location
   * (Cloudflare docs): for cheap abuse protection in actions/HTTP before touching a shard, not exact quotas.
   */
  binding: v.optional(v.object({ name: v.string(), limit: v.number(), period: v.union(v.literal(10), v.literal(60)) })),
  /** Several bindings, by name: `{ RL_LOGIN: { limit: 5, period: 60 }, RL_API: { limit: 100, period: 10 } }`. */
  bindings: v.optional(v.record(edgeBindingValidator)),
  /**
   * GC of expired buckets (on by default; `false` turns it off). `ttlMs`: how long a bucket is kept after it is full
   * again (default 0); `batchSize`: rows deleted per job (default 500); `intervalMs`: the least time before a GC job
   * that waits for the next expiry (default 1 hour), so a busy limiter costs one job per interval, not one per key.
   * A job whose batch was full continues at once: a backlog costs one job per `batchSize` rows.
   */
  gc: v.optional(
    v.union(v.literal(false), v.object({ ttlMs: v.optional(v.number()), batchSize: v.optional(v.number()), intervalMs: v.optional(v.number()) })),
  ),
});

export type RateLimitEdgeBinding = { limit: number; period: 10 | 60 };
export type RateLimitGcConfig = { ttlMs?: number; batchSize?: number; intervalMs?: number };
export type RateLimitInstallConfig = {
  limits?: Record<string, RateLimitConfig>;
  binding?: { name: string } & RateLimitEdgeBinding;
  bindings?: Record<string, RateLimitEdgeBinding>;
  gc?: false | RateLimitGcConfig;
};

export const DEFAULT_GC_BATCH = 500;
export const DEFAULT_GC_INTERVAL_MS = HOUR;
/** Most rows one GC job deletes (a job stays well under the shard's write limits). */
export const MAX_GC_BATCH = 4000;

const { query, mutation, internalMutation, internalQuery } = componentBuilders<typeof schema, RateLimitInstallConfig | undefined>();

const callArgs = {
  /** Limit name ("sendEmail"). */
  name: v.string(),
  /** Per-user/tenant/... key; omitted = one global bucket for `name`. */
  key: v.optional(v.string()),
  /** Tokens to take (default 1). */
  count: v.optional(v.number()),
  /** The limit's config; omitted = the install config's `limits[name]`. */
  config: v.optional(rateLimitConfigValidator),
};

type Ctx = ComponentCtx<typeof schema, RateLimitInstallConfig | undefined>["mutation"];
type ReadCtx = ComponentCtx<typeof schema, RateLimitInstallConfig | undefined>["query"];

/** The limit's config, checked once here: the algorithms below take it as checked (`consumeChecked`/`checkChecked`). */
function configFor(ctx: ReadCtx, name: string, given: RateLimitConfig | undefined): RateLimitConfig {
  const c = given ?? ctx.component.config?.limits?.[name];
  if (!c) throw new EmberError("ValidationError", `rateLimit: no config for limit ${JSON.stringify(name)} (pass config, or install it with { limits })`);
  try {
    checkConfig(c);
  } catch (e) {
    throw new EmberError("ValidationError", (e as Error).message);
  }
  return c;
}

const row = (ctx: ReadCtx, name: string, key: string) =>
  // `.first()`: one row read (a limiter writes a single row per name/key; `.unique()` would read a second to check).
  ctx.db.query("rateLimits").withIndex("by_name_key", (q) => q.eq("name", name).eq("key", key)).first() as
    | (RateLimitState & { _id: GenericId<"rateLimits">; name: string; key: string; expiresAt?: number })
    | null;

/** The code of `rateLimitErrors.RateLimited`, thrown by `limit({ throws: true })`: `data = { name, retryAfter }`. */
export const RATE_LIMITED = rateLimitErrors.RateLimited.code;

type Gc = { ttlMs: number; batchSize: number; intervalMs: number };

/** The install's GC settings (null: off). Read at use time, so a redeploy with a new config applies. */
function gcOf(ctx: ReadCtx): Gc | null {
  const g = ctx.component.config?.gc;
  if (g === false) return null;
  const n = (x: number | undefined, d: number, min: number) => (x !== undefined && Number.isFinite(x) ? Math.max(min, x) : d);
  return { ttlMs: n(g?.ttlMs, 0, 0), batchSize: Math.min(MAX_GC_BATCH, Math.floor(n(g?.batchSize, DEFAULT_GC_BATCH, 1))), intervalMs: n(g?.intervalMs, DEFAULT_GC_INTERVAL_MS, 1000) };
}

/** Whether the job a `gc` row names may still run (only checked once it is overdue; the job rewrites the row). */
function gcAlive(ctx: Ctx, row: { at: number; job: string }): boolean {
  if (row.at > ctx.now) return true;
  const job = ctx.scheduler.get(row.job);
  return !!job && (job.state.kind === "pending" || job.state.kind === "inProgress");
}

/**
 * Keeps one GC job in this shard due no later than when a row expiring at `expiresAt` can go (never sooner than
 * `intervalMs` from now). A job due later is moved up to `want`; one due sooner stays, so once a job is due about
 * `intervalMs` out, a stream of new keys does not move it again.
 */
function ensureGc(ctx: Ctx, gc: Gc, expiresAt: number) {
  const want = Math.max(expiresAt + gc.ttlMs, ctx.now + gc.intervalMs);
  const cur = ctx.db.query("gc").first();
  if (cur && cur.at <= want && gcAlive(ctx, cur)) return;
  if (cur) ctx.scheduler.cancel(cur.job);
  const job = ctx.scheduler.runAt(want, "lib:gc", {});
  if (cur) ctx.db.patch(cur._id, { at: want, job });
  else ctx.db.insert("gc", { at: want, job });
}

/** When `r` is full under the install's config for its name, if that is later than its `expiresAt` (else null). */
function currentExpiry(ctx: ReadCtx, r: RateLimitState & { name: string; expiresAt?: number }): number | null {
  const c = ctx.component.config?.limits?.[r.name];
  if (!c) return null;
  try {
    checkConfig(c);
  } catch {
    return null;
  }
  const at = fullAt(c, r);
  return r.expiresAt === undefined || at > r.expiresAt ? at : null;
}

const refused = (name: string, retryAfter: number) => rateLimitErrors.RateLimited({ name, retryAfter });

export const functions = {
  lib: {
    /**
     * Takes `count` tokens of `name`/`key`. `{ ok: true }` or `{ ok: false, retryAfter }` (ms). With `reserve`,
     * takes them anyway (going negative) and says when the reservation is valid. With `throws`, a refusal
     * throws `RateLimited` instead (an app mutation can let it propagate to the client).
     */
    limit: mutation({
      args: { ...callArgs, reserve: v.optional(v.boolean()), throws: v.optional(v.boolean()) },
      returns: v.object({ ok: v.boolean(), retryAfter: v.optional(v.number()) }),
      errors: [rateLimitErrors.RateLimited],
      handler: (ctx, a) => {
        const config = configFor(ctx, a.name, a.config as RateLimitConfig | undefined);
        const key = a.key ?? "";
        const cur = row(ctx, a.name, key);
        let decision;
        try {
          decision = consumeChecked(config, cur, ctx.now, a.count ?? 1, a.reserve ?? false);
        } catch (e) {
          throw new EmberError("ValidationError", (e as Error).message);
        }
        const { result, state } = decision;
        if (!result.ok) {
          if (a.throws) throw refused(a.name, result.retryAfter);
          return { ok: false, retryAfter: result.retryAfter };
        }
        // An unchanged state (e.g. `count: 0` with nothing to refill) writes nothing.
        if (state && !(cur && cur.value === state.value && cur.ts === state.ts)) {
          const expiresAt = fullAt(config, state);
          if (cur) ctx.db.patch(cur._id, { value: state.value, ts: state.ts, expiresAt });
          else ctx.db.insert("rateLimits", { name: a.name, key, value: state.value, ts: state.ts, expiresAt });
          // Every write makes sure this shard has a GC job (one row read when it does): rows written while the GC
          // was off, or before it existed, are collected once it is on.
          const gc = gcOf(ctx);
          if (gc) ensureGc(ctx, gc, expiresAt);
        }
        return result.retryAfter !== undefined ? { ok: true, retryAfter: result.retryAfter } : { ok: true };
      },
    }),
    /** Whether `count` tokens are available now, without taking them (reactive in queries). */
    check: query({
      args: callArgs,
      returns: v.object({ ok: v.boolean(), retryAfter: v.optional(v.number()) }),
      handler: (ctx, a) => {
        const config = configFor(ctx, a.name, a.config as RateLimitConfig | undefined);
        let r;
        try {
          r = checkChecked(config, row(ctx, a.name, a.key ?? ""), ctx.now, a.count ?? 1);
        } catch (e) {
          throw new EmberError("ValidationError", (e as Error).message);
        }
        return r.ok ? { ok: true } : { ok: false, retryAfter: r.retryAfter };
      },
    }),
    /** Tokens available now (may be negative after reservations) and the capacity, e.g. for a UI meter. */
    getValue: query({
      args: { name: v.string(), key: v.optional(v.string()), config: v.optional(rateLimitConfigValidator) },
      returns: v.object({ value: v.number(), capacity: v.number(), ts: v.number() }),
      handler: (ctx, a) => {
        const config = configFor(ctx, a.name, a.config as RateLimitConfig | undefined);
        const s = refill(config, row(ctx, a.name, a.key ?? ""), ctx.now);
        return { value: s.value, capacity: config.capacity ?? config.rate, ts: s.ts };
      },
    }),
    /** Forgets `name`/`key` (back to a full bucket). Returns whether a row existed. */
    reset: mutation({
      args: { name: v.string(), key: v.optional(v.string()) },
      returns: v.boolean(),
      handler: (ctx, a) => {
        const cur = row(ctx, a.name, a.key ?? "");
        if (cur) ctx.db.delete(cur._id);
        return !!cur;
      },
    }),
    /**
     * Deletes up to `batchSize` buckets that are full again (plus `ttlMs`), oldest first (a limit named in the install
   * config is checked with its current config: still in debt under it, the row stays with a later expiry), then
   * schedules the next run:
     * soon if the batch was full, else when the next row expires (at least `intervalMs` later), none when the table
     * is empty. Returns the rows deleted.
     */
    gc: internalMutation({
      args: {},
      returns: v.number(),
      handler: (ctx) => {
        const cur = ctx.db.query("gc").first();
        const gc = gcOf(ctx);
        if (!gc) {
          if (cur) ctx.db.delete(cur._id);
          return 0;
        }
        const cutoff = ctx.now - gc.ttlMs;
        // `gte(0)`: rows without `expiresAt` (written before the GC) sort first and are skipped, not deleted.
        const old = ctx.db.query("rateLimits").withIndex("by_expires", (q) => q.gte("expiresAt", 0).lte("expiresAt", cutoff)).take(gc.batchSize);
        let deleted = 0;
        for (const r of old) {
          // `expiresAt` is from the config of the row's last write. A limit installed by name is checked again with
          // the install's config now: after a redeploy with a slower one, a bucket still in debt under it is kept
          // (its expiry moved), not deleted into a full one. (A config sent per call is only known to its calls.)
          const later = currentExpiry(ctx, r);
          if (later !== null && later + gc.ttlMs > ctx.now) ctx.db.patch(r._id, { expiresAt: later });
          else {
            ctx.db.delete(r._id);
            deleted++;
          }
        }
        const next = old.length >= gc.batchSize ? ctx.now : ctx.db.query("rateLimits").withIndex("by_expires", (q) => q.gte("expiresAt", 0)).first()?.expiresAt;
        if (next === undefined) {
          if (cur) ctx.db.delete(cur._id);
          return deleted;
        }
        // A full batch continues right away (one job per batch); otherwise wait for the next expiry.
        const at = old.length >= gc.batchSize ? ctx.now : Math.max(next + gc.ttlMs, ctx.now + gc.intervalMs);
        const job = ctx.scheduler.runAt(at, "lib:gc", {});
        if (cur) ctx.db.patch(cur._id, { at, job });
        else ctx.db.insert("gc", { at, job });
        return deleted;
      },
    }),
  },
};

/** The Rate Limiting bindings an install asks `ember deploy` for (`binding` and `bindings`; one name, one binding). */
export function edgeBindingsOf(config: RateLimitInstallConfig | undefined): Array<{ type: "ratelimit"; name: string; limit: number; period: 10 | 60 }> {
  const out: Array<{ type: "ratelimit"; name: string; limit: number; period: 10 | 60 }> = [];
  const add = (name: string, b: RateLimitEdgeBinding) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`rateLimit: binding name ${JSON.stringify(name)} must be a JS identifier (it is env.${name})`);
    if (out.some((x) => x.name === name)) throw new Error(`rateLimit: binding ${name} is declared twice`);
    out.push({ type: "ratelimit", name, limit: b.limit, period: b.period });
  };
  if (config?.binding) add(config.binding.name, config.binding);
  for (const [name, b] of Object.entries(config?.bindings ?? {})) add(name, b);
  return out;
}

// ------------------------------------------------------------------------------------------------ dashboard

/** What the dashboard's screen reads (module `dashboard`, internal: never part of the component's API). */
const dashboardFunctions = {
  /**
   * Buckets in this shard by limit and key, a page of `by_name_key` at a time: all, one limit's (a prefix of the
   * index) or one key of a limit. A key alone is refused (it would scan every limit's buckets). A row is a bucket not
   * full again yet.
   */
  buckets: internalQuery({
    args: { name: v.optional(v.string()), key: v.optional(v.string()), paginationOpts: paginationOptsValidator },
    handler: (ctx, { name, key, paginationOpts }) => {
      if (key !== undefined && name === undefined) throw new EmberError("ValidationError", "rateLimit: pick the limit (name) to look up a key");
      const q = name !== undefined ? ctx.db.query("rateLimits").withIndex("by_name_key", (r) => (key !== undefined ? r.eq("name", name).eq("key", key) : r.eq("name", name))) : ctx.db.query("rateLimits").withIndex("by_name_key");
      const page = q.paginate(paginationOpts);
      // `value`: the tokens available now under the install's config for that limit (as `getValue` computes them);
      // null for a limit the install does not name (its config comes with each call). `stored`: the row as written.
      const now = (r: { name: string; value: number; ts: number }): number | null => {
        const c = ctx.component.config?.limits?.[r.name];
        if (!c) return null;
        try {
          checkConfig(c);
          return refill(c, { value: r.value, ts: r.ts }, ctx.now).value;
        } catch {
          return null;
        }
      };
      return { ...page, page: page.page.map((r) => ({ _id: r._id, name: r.name, key: r.key, value: now(r), stored: r.value, updatedAt: r.ts, expiresAt: r.expiresAt ?? null, named: !!ctx.component.config?.limits?.[r.name] })) };
    },
  }),
  /** The limits named in the install config, and the GC's state. */
  config: internalQuery({
    args: {},
    handler: (ctx) => {
      const gc = ctx.db.query("gc").first();
      return {
        limits: Object.entries(ctx.component.config?.limits ?? {}).map(([name, c]) => ({ name, ...c })),
        gc: ctx.component.config?.gc === false ? "off" : gc ? "scheduled" : "idle",
        gcAt: gc?.at ?? null,
        // Counted up to 1000 (at most 1001 rows read); past that, "1000+".
        buckets: ((n) => (n > 1000 ? "1000+" : n))(ctx.db.query("rateLimits").take(1001).length),
      };
    },
  }),
};

export const rateLimit = defineComponent({
  name: "rateLimit",
  schema,
  functions: { ...functions, dashboard: dashboardFunctions },
  config: v.optional(installConfigValidator),
  bindings: (config) => edgeBindingsOf(config),
  // The limiter's screen in the Ember Dashboard (contracts.md "Telas declarativas"): buckets live per shard.
  dashboard: {
    label: "Rate limits",
    icon: "gauge",
    description: "Buckets not full again yet in this shard (a missing one is a full bucket); reset one to give its key a full bucket now.",
    tabs: [
      {
        id: "buckets",
        label: "Buckets",
        blocks: [
          {
            kind: "table",
            id: "buckets",
            query: dashboardFunctions.buckets,
            columns: [
              { label: "Limit", path: "name", format: "code" },
              { label: "Key", path: "key", format: "code" },
              { label: "Tokens now", path: "value", format: "number" },
              { label: "Stored", path: "stored", format: "number" },
              { label: "Updated", path: "updatedAt", format: "ago" },
              { label: "Full again", path: "expiresAt", format: "date" },
            ],
            rowActions: [{ id: "reset", label: "Reset", fn: functions.lib.reset, fromRow: { name: "name", key: "key" }, destructive: true, description: "Deletes the bucket: the key gets a full bucket now." }],
          },
          { kind: "actions", id: "manual", label: "Reset a key", actions: [{ id: "resetKey", label: "Reset…", fn: functions.lib.reset, destructive: true }] },
        ],
      },
      {
        id: "config",
        label: "Configuration",
        blocks: [
          { kind: "stats", id: "state", query: dashboardFunctions.config, items: [{ label: "Buckets", path: "buckets", format: "number" }, { label: "GC", path: "gc", format: "badge" }, { label: "Next GC", path: "gcAt", format: "date" }] },
          { kind: "table", id: "limits", label: "Limits named in the install config", query: dashboardFunctions.config, rows: "limits", rowKey: "name", columns: [{ label: "Limit", path: "name", format: "code" }, { label: "Kind", path: "kind" }, { label: "Rate", path: "rate", format: "number" }, { label: "Period", path: "period", format: "ms" }, { label: "Capacity", path: "capacity", format: "number" }] },
        ],
      },
    ],
  },
});
