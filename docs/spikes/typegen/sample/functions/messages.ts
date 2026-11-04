import { v } from "cfx";
import { internalMutation, mutation, query } from "../_generated/server";

export const list = query({
  args: { channel: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { channel, limit }) =>
    ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .take(limit ?? 50),
});

export const popular = query({
  args: { channel: v.string(), minLikes: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("messages")
      .withIndex("by_channel_likes", (q) => q.eq("channel", args.channel).gte("likes", args.minLikes))
      .filter((q) => q.neq(q.field("body"), ""))
      .paginate({ numItems: 10, cursor: args.cursor });
    return { ...page, page: page.page.map((m) => ({ id: m._id, body: m.body, likes: m.likes })) };
  },
});

export const search = query({
  args: { channel: v.string(), text: v.string() },
  handler: async (ctx, { channel, text }) =>
    ctx.db
      .query("messages")
      .withSearchIndex("search_body", (q) => q.search("body", text).eq("channel", channel))
      .take(10),
});

export const similar = query({
  args: { channel: v.string(), vector: v.array(v.float64()) },
  handler: async (ctx, { channel, vector }) =>
    ctx.db.query("messages").withVectorIndex("by_embedding", { vector, limit: 3, filter: { channel } }).collect(),
});

export const send = mutation({
  args: { channel: v.string(), author: v.id("users"), body: v.string() },
  handler: async (ctx, args) => {
    const author = await ctx.db.get(args.author);
    if (!author) throw new Error("no such user");
    return ctx.db.insert("messages", { ...args, likes: 0 });
  },
});

export const like = mutation({
  args: { id: v.id("messages") },
  handler: async (ctx, { id }) => {
    const m = await ctx.db.get(id);
    if (m) await ctx.db.patch(id, { likes: m.likes + 1 });
  },
});

export const purgeChannel = internalMutation({
  args: { channel: v.string() },
  handler: async (ctx, { channel }) => {
    const all = await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel)).collect();
    for (const m of all) await ctx.db.delete(m._id);
    return all.length;
  },
});

/** Not a function: must not appear in `api`. */
export const PAGE_SIZE = 10;
