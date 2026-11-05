import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";

const MAX_BODY = 2000;

// What `usePaginatedQuery` sends as `paginationOpts` (Convex has `paginationOptsValidator`; Ember has no helper yet).
const paginationOpts = v.object({ numItems: v.number(), cursor: v.nullable(v.string()) });

/**
 * A room's messages, newest first, one page at a time. Each page is a live query: when someone sends a message the
 * first page updates in real time and the later pages re-anchor behind it.
 */
export const list = query({
  args: { roomId: v.id("rooms"), paginationOpts },
  handler: (ctx, { roomId, paginationOpts }) =>
    ctx.db
      .query("messages")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .order("desc")
      .paginate(paginationOpts),
});

export const send = mutation({
  args: { roomId: v.id("rooms"), author: v.string(), body: v.string() },
  handler: (ctx, { roomId, author, body }) => {
    const text = body.trim();
    if (!text) throw new Error("Empty message");
    if (text.length > MAX_BODY) throw new Error(`Messages are limited to ${MAX_BODY} characters`);
    if (!ctx.db.get(roomId)) throw new Error("No such room");
    return ctx.db.insert("messages", { roomId, author: author.trim() || "anonymous", body: text });
  },
});

/** Full-text search inside one room, best match first. */
export const search = query({
  args: { roomId: v.id("rooms"), text: v.string() },
  handler: (ctx, { roomId, text }) =>
    ctx.db
      .query("messages")
      .withSearchIndex("search_body", (q) => q.search("body", text).eq("roomId", roomId))
      .take(20),
});
