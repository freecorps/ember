// Must FAIL: server-side typing of ctx.db (indexes, range builder, writes). Every `// ERR` line errors.
import { v } from "cfx";
import { mutation, query } from "./_generated/server";

export const bad = query({
  args: { channel: v.string() },
  handler: async (ctx, { channel }) => {
    await ctx.db.query("messages").withIndex("by_nothing"); // ERR unknown index
    await ctx.db.query("messages").withIndex("by_channel_likes", (q) => q.eq("likes", 1)); // ERR must eq channel first
    await ctx.db.query("messages").withIndex("by_channel_likes", (q) => q.eq("channel", 1)); // ERR wrong value type
    await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel).gt("channel", "a")); // ERR range after full eq is on _creationTime
    await ctx.db.query("nope"); // ERR unknown table
    await ctx.db.query("messages").withSearchIndex("search_body", (q) => q.search("channel", "x")); // ERR not the search field
    await ctx.db.query("messages").withSearchIndex("search_body", (q) => q.search("body", "x").eq("author", channel)); // ERR not a filter field
    await ctx.db.query("messages").withVectorIndex("by_embedding", { vector: [1], filter: { body: "x" } }); // ERR not a filter field
    await ctx.db.query("messages").filter((q) => q.eq(q.field("nope"), 1)); // ERR unknown field
    return null;
  },
});

export const badWrite = mutation({
  handler: async (ctx) => {
    await ctx.db.insert("messages", { channel: "c", body: "b", likes: 0 }); // ERR missing author
    await ctx.db.insert("users", { name: "n", email: "e", admin: "yes" }); // ERR admin is boolean
    await ctx.db.insert("users", { name: "n", email: "e", admin: true, _id: "x" }); // ERR system field
  },
});
