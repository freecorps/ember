import { ConvexError, v } from "convex/values";
import { api } from "./_generated/api";
import { action } from "./_generated/server";

/** Actions keep their awaits. */
export const importNote = action({
  args: { teamId: v.id("teams"), url: v.string() },
  handler: async (ctx, { teamId, url }) => {
    const res = await fetch(url);
    const body = await res.text();
    try {
      return await ctx.runMutation(api.notes.create, { teamId, body });
    } catch (e) {
      if (e instanceof ConvexError) return null;
      throw e;
    }
  },
});
