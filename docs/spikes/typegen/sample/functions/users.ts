import { v } from "cfx";
import { mutation, query } from "../_generated/server";

export const create = mutation({
  args: { name: v.string(), email: v.string() },
  handler: async (ctx, args) => ctx.db.insert("users", { ...args, admin: false }),
});

export const byEmail = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).unique(),
});

export const count = query({
  handler: async (ctx) => (await ctx.db.query("users").collect()).length,
});
