import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalQuery, query } from "./_generated/server";
import { authedQuery, internalMutation, mutation } from "./functions";
import { assertMember, membersOf, userName } from "./lib/teams";
import { notifyWebhook } from "./lib/notify";

export const list = query({
  args: { teamId: v.id("teams") },
  handler: async (ctx, { teamId }) => {
    await assertMember(ctx, teamId);
    const notes = await ctx.db
      .query("notes")
      .withIndex("by_team", (q) => q.eq("teamId", teamId))
      .order("desc")
      .collect();
    return await Promise.all(
      notes.map(async (n) => {
        const author = await ctx.db.get(n.authorId);
        return { _id: n._id, body: n.body, author: author?.name ?? "unknown" };
      }),
    );
  },
});

export const page = query({
  args: { teamId: v.id("teams"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) =>
    ctx.db
      .query("notes")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .paginate(args.paginationOpts),
});

export const search = query({
  args: { teamId: v.id("teams"), text: v.string() },
  handler: async (ctx, { teamId, text }) => {
    return await ctx.db
      .query("notes")
      .withSearchIndex("search_body", (q) => q.search("body", text).eq("teamId", teamId))
      .take(10);
  },
});

export const mine = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .collect();
    return rows.map((r) => r.teamId);
  },
});

export const create = mutation({
  args: { teamId: v.id("teams"), body: v.string() },
  handler: async (ctx, { teamId, body }) => {
    const user = await assertMember(ctx, teamId);
    if (body.length > 500) throw new ConvexError("NOTE_TOO_LONG");
    if (body.trim() === "") throw new ConvexError(`empty note from ${user.name}`);
    const id = await ctx.db.insert("notes", { teamId, authorId: user._id, body, views: 0n });
    await ctx.scheduler.runAfter(0, internal.notes.countView, { id });
    await ctx.runMutation(internal.notes.touch, { teamId });
    return id;
  },
});

export const countView = internalMutation({
  args: { id: v.id("notes") },
  handler: async (ctx, { id }) => {
    const note = await ctx.db.get("notes", id);
    if (note) await ctx.db.patch("notes", id, { views: note.views + 1n });
  },
});

export const touch = internalMutation({
  args: { teamId: v.id("teams") },
  handler: async (ctx, { teamId }) => {
    await ctx.db.insert("audit", { table: "teams", op: `touch ${teamId}`, at: Date.now() });
  },
});

export const count = internalQuery({
  args: { teamId: v.id("teams") },
  handler: async (ctx, { teamId }) => {
    const notes = await ctx.db
      .query("notes")
      .withIndex("by_team", (q) => q.eq("teamId", teamId))
      .collect();
    return notes.length;
  },
});

export const stats = query({
  args: { teamId: v.id("teams") },
  handler: async (ctx, { teamId }) => {
    const [members, notes, me] = await Promise.all([
      membersOf(ctx.db, teamId),
      ctx.runQuery(internal.notes.count, { teamId }),
      userName(ctx),
    ]);
    return { members: members.length, notes, me };
  },
});

/** Stays async: it awaits a helper that does I/O. */
export const createAndNotify = mutation({
  args: { teamId: v.id("teams"), body: v.string() },
  handler: async (ctx, { teamId, body }) => {
    const user = await assertMember(ctx, teamId);
    await ctx.db.insert("notes", { teamId, authorId: user._id, body, views: 0n });
    await notifyWebhook(ctx, body);
  },
});
