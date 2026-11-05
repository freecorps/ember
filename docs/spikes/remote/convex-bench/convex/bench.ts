// Same functions as the Ember bench app (EMBER_BENCH in docs/spikes/remote/scripts/convex-vs-ember.ts).
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, mutation, query } from "./_generated/server";

export const put = mutation({
  args: { n: v.number(), sentAt: v.number(), body: v.string() },
  handler: (ctx, a) => ctx.db.insert("items", a),
});

// Hot-document contention: read-modify-write of one counter row (OCC on Convex, serial in the shard on Ember).
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

export const latest = query({
  args: {},
  handler: (ctx) => ctx.db.query("items").order("desc").first(),
});

export const page = query({
  args: { paginationOpts: paginationOptsValidator, salt: v.optional(v.number()) },
  handler: (ctx, { paginationOpts }) => ctx.db.query("items").withIndex("by_n").order("desc").paginate(paginationOpts),
});

// Cleanup: delete rows in batches (`npx convex run bench:clear` until it returns 0).
export const clear = internalMutation({
  args: {},
  handler: async (ctx) => {
    let n = 0;
    for (const t of ["items", "counters"] as const) {
      for (const d of await ctx.db.query(t).take(4000)) {
        await ctx.db.delete(d._id);
        n++;
      }
    }
    return n;
  },
});
