// Exchange rates: reference data written centrally and read inside every organization's mutations (PLAN §22 L5).
// `fxRates` is `.replicated()` (ember/schema.ts): the writes below run in global:main, and each org shard holds a
// read-only copy (eventual: `ctx.db.replicaStatus("fxRates")` says how far it is).
import { v } from "@freecorps/ember-server";
import { internal } from "./_generated/api";
import { action, internalQuery, mutation, query } from "./_generated/server";

/** Sets a rate (global:main: the only shard that writes `fxRates`). */
export const setRate = mutation({
  args: { base: v.string(), quote: v.string(), rate: v.number() },
  handler: (ctx, { base, quote, rate }) => {
    const cur = ctx.db.query("fxRates").withIndex("by_pair", (q) => q.eq("base", base).eq("quote", quote)).first();
    if (cur) {
      ctx.db.patch(cur._id, { rate });
      return cur._id;
    }
    return ctx.db.insert("fxRates", { base, quote, rate });
  },
});

/** A rate as an org shard sees it (a local read of its copy), with how fresh the copy is. */
export const rate = query({
  shard: "org",
  args: { base: v.string(), quote: v.string() },
  handler: (ctx, { base, quote }) => ({
    rate: ctx.db.query("fxRates").withIndex("by_pair", (q) => q.eq("base", base).eq("quote", quote)).first(),
    status: ctx.db.replicaStatus("fxRates"),
  }),
});

/** Converts an amount with a rate, inside the org's own transaction; the quote keeps the rate's id. */
export const convert = mutation({
  shard: { org: "org" },
  args: { org: v.string(), rateId: v.id("fxRates"), amount: v.number() },
  handler: (ctx, { org, rateId, amount }) => {
    const r = ctx.db.get(rateId);
    if (!r) throw new Error(`rate ${rateId} has not reached this shard yet`);
    return ctx.db.insert("quotes", { org, rateId, amount, converted: amount * r.rate });
  },
});

/** Refused outside global:main (`ReadOnlyTable`): a copy is never written by app code. */
export const setRateHere = mutation({
  shard: "org",
  args: {},
  handler: (ctx) => ctx.db.insert("fxRates", { base: "XXX", quote: "YYY", rate: 1 }),
});

/** How many quotes an org has, and its copy's state (run on every org by `report`). */
export const orgSummary = internalQuery({
  shard: "org",
  args: { failFor: v.optional(v.string()) },
  handler: (ctx, { failFor }) => {
    const quotes = ctx.db.query("quotes").collect();
    if (failFor && quotes.some((q) => q.org === failFor)) throw new Error("this org is broken");
    return { quotes: quotes.length, status: ctx.db.replicaStatus("fxRates").state };
  },
});

/** Platform console: every org shard from the catalog, and one summary per org (bounded fan-out). */
export const report = action({
  args: { failFor: v.optional(v.string()), concurrency: v.optional(v.number()) },
  handler: async (ctx, { failFor, concurrency }) => {
    const { shards } = await ctx.shards.list("org", { limit: 1000 });
    const results = await ctx.shards.fanOut("org", internal.rates.orgSummary, failFor ? { failFor } : {}, concurrency ? { concurrency } : {});
    return { orgs: shards.map((s) => s.shard), results };
  },
});
