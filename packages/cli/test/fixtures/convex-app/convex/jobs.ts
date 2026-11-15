import { v } from "convex/values";
import { query } from "./_generated/server";

export const job = query({
  args: { id: v.id("_scheduled_functions") },
  handler: async (ctx, { id }) => {
    const job = await ctx.db.system.get(id);
    const all = await ctx.db.system.query("_scheduled_functions").collect();
    return { state: job?.state.kind ?? null, total: all.length };
  },
});
