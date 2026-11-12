// Same functions as the Ember bench app (EMBER_BENCH in ../bench.ts). Local copy of ../../remote/convex-bench/convex,
// plus `noop` (per-call overhead) and `getById` (point read).
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";

export const put = mutation({
  args: { n: v.number(), sentAt: v.number(), body: v.string() },
  handler: (ctx, a) => ctx.db.insert("items", a),
});

export const noop = mutation({ args: {}, handler: async () => null });

export const incr = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const c = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
    if (!c) {
      await ctx.db.insert("counters", { name, value: 1 });
      return 1;
    }
    await ctx.db.patch(c._id, { value: c.value + 1 });
    return c.value + 1;
  },
});

export const counter = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => (await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique())?.value ?? 0,
});

export const recent = query({
  args: { limit: v.optional(v.number()), salt: v.optional(v.number()) },
  handler: (ctx, { limit }) => ctx.db.query("items").withIndex("by_n").order("desc").take(limit ?? 10),
});

export const latest = query({ args: {}, handler: (ctx) => ctx.db.query("items").order("desc").first() });

export const page = query({
  args: { paginationOpts: paginationOptsValidator, salt: v.optional(v.number()) },
  handler: (ctx, { paginationOpts }) => ctx.db.query("items").withIndex("by_n").order("desc").paginate(paginationOpts),
});
