import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";

export const list = query({
  handler: (ctx) => ctx.db.query("rooms").withIndex("by_name").collect(),
});

export const create = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => {
    const clean = name.trim().toLowerCase().replace(/\s+/g, "-");
    if (!clean) throw new Error("A room needs a name");
    // Mutations are serializable transactions, so check-then-insert cannot race.
    const existing = ctx.db.query("rooms").withIndex("by_name", (q) => q.eq("name", clean)).unique();
    return existing?._id ?? ctx.db.insert("rooms", { name: clean });
  },
});

export const get = query({
  args: { roomId: v.id("rooms") },
  handler: (ctx, { roomId }) => ctx.db.get(roomId),
});
