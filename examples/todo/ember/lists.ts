import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";

export const list = query({
  handler: (ctx) => ctx.db.query("lists").withIndex("by_name").collect(),
});

export const create = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => {
    const clean = name.trim();
    if (!clean) throw new Error("A list needs a name");
    return ctx.db.query("lists").withIndex("by_name", (q) => q.eq("name", clean)).unique()?._id ?? ctx.db.insert("lists", { name: clean });
  },
});
