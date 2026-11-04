import { v } from "@freecorps/ember-server";
import { api, internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";

export const list = query({
  args: { channel: v.string(), limit: v.optional(v.number()) },
  handler: (ctx, { channel, limit }) =>
    ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .take(limit ?? 50),
});

export const count = query({
  args: { channel: v.string() },
  returns: v.number(),
  handler: (ctx, { channel }) =>
    ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel)).collect().length,
});

export const send = mutation({
  args: { channel: v.string(), author: v.string(), body: v.string() },
  handler: (ctx, args) => {
    const id = ctx.db.insert("messages", args);
    // Push to everyone else's devices (an action: I/O happens after this transaction commits).
    const sender = ctx.auth.getUserIdentity()?.subject ?? null;
    ctx.scheduler.runAfter(0, internal.push.notifyChannel, { ...args, sender });
    return { id, at: ctx.now };
  },
});

export const edit = mutation({
  args: { id: v.id("messages"), body: v.string() },
  handler: (ctx, { id, body }) => {
    const msg = ctx.db.get(id);
    if (!msg) return null;
    ctx.db.patch(id, { body, edited: true });
    return msg.channel;
  },
});

/**
 * Actions run in the Worker and may do I/O (fetch, AI, email); they reach the shard through ctx.runQuery,
 * ctx.runMutation and ctx.scheduler (each call is its own transaction).
 */
export const digest = action({
  args: { channel: v.string() },
  handler: async (ctx, { channel }) => {
    const count = await ctx.runQuery(api.messages.count, { channel });
    return `#${channel}: ${count} messages`;
  },
});

/** Internal: run by the cron in crons.ts. */
export const trim = internalMutation({
  args: { channel: v.string(), keep: v.number() },
  handler: (ctx, { channel, keep }) => {
    const old = ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .collect()
      .slice(keep);
    for (const m of old) ctx.db.delete(m._id);
    return old.length;
  },
});
