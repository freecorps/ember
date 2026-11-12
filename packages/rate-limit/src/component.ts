// The rateLimit component (PLAN §12): one table of (name, key) → tokens, in the caller's shard. `lib:limit` is a
// mutation, so inside an app mutation it runs in the same transaction: if the app mutation fails afterwards, the
// tokens are given back (nothing was consumed). Refused calls write nothing.

import { componentBuilders, defineComponent, defineSchema, defineTable, EmberError, v, type ComponentCtx, type GenericId } from "@freecorps/ember-server";
import { check, checkConfig, consume, refill, type RateLimitConfig, type RateLimitState } from "./algorithms.ts";

const schema = defineSchema({
  tables: {
    /** One row per (name, key) that has been limited; `key` "" is the global limit of `name`. */
    rateLimits: defineTable({ name: v.string(), key: v.string(), value: v.number(), ts: v.number() }).index("by_name_key", ["name", "key"]),
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

/** Install config: named limits (so calls can pass only the name) and an optional Cloudflare binding. */
export const installConfigValidator = v.object({
  limits: v.optional(v.record(rateLimitConfigValidator)),
  /**
   * A Workers Rate Limiting binding `ember deploy` creates (period 10 or 60 s). Approximate and per location
   * (Cloudflare docs): for cheap abuse protection in actions/HTTP before touching a shard, not exact quotas.
   */
  binding: v.optional(v.object({ name: v.string(), limit: v.number(), period: v.union(v.literal(10), v.literal(60)) })),
});

export type RateLimitInstallConfig = {
  limits?: Record<string, RateLimitConfig>;
  binding?: { name: string; limit: number; period: 10 | 60 };
};

const { query, mutation } = componentBuilders<typeof schema, RateLimitInstallConfig | undefined>();

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
  ctx.db.query("rateLimits").withIndex("by_name_key", (q) => q.eq("name", name).eq("key", key)).unique() as
    | (RateLimitState & { _id: GenericId<"rateLimits">; name: string; key: string })
    | null;

/** Thrown by `limit({ throws: true })` (and `RateLimiter.limit(..., { throws: true })`): `data = { name, retryAfter }`. */
export const RATE_LIMITED = "RateLimited";

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
      handler: (ctx, a) => {
        const config = configFor(ctx, a.name, a.config as RateLimitConfig | undefined);
        const key = a.key ?? "";
        const cur = row(ctx, a.name, key);
        let decision;
        try {
          decision = consume(config, cur, ctx.now, a.count ?? 1, a.reserve ?? false);
        } catch (e) {
          throw new EmberError("ValidationError", (e as Error).message);
        }
        const { result, state } = decision;
        if (!result.ok) {
          if (a.throws) {
            throw new EmberError(RATE_LIMITED, `Rate limit ${a.name} exceeded; retry in ${result.retryAfter} ms`, { name: a.name, retryAfter: result.retryAfter });
          }
          return { ok: false, retryAfter: result.retryAfter };
        }
        if (state) {
          if (cur) ctx.db.patch(cur._id, { value: state.value, ts: state.ts });
          else ctx.db.insert("rateLimits", { name: a.name, key, value: state.value, ts: state.ts });
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
          r = check(config, row(ctx, a.name, a.key ?? ""), ctx.now, a.count ?? 1);
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
  },
};

export const rateLimit = defineComponent({
  name: "rateLimit",
  schema,
  functions,
  config: v.optional(installConfigValidator),
  bindings: (config) => (config?.binding ? [{ type: "ratelimit" as const, name: config.binding.name, limit: config.binding.limit, period: config.binding.period }] : []),
});
