import { paginationOptsValidator, v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";
import { errors } from "./errors";

const MAX_BODY = 2000;

/**
 * A room's messages, newest first, one page at a time. Each page is a live query: when someone sends a message the
 * first page updates in real time and the later pages re-anchor behind it.
 */
export const list = query({
  args: { roomId: v.id("rooms"), paginationOpts: paginationOptsValidator },
  handler: (ctx, { roomId, paginationOpts }) =>
    ctx.db
      .query("messages")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .order("desc")
      .paginate(paginationOpts),
});

/** Sends a message to a room (trimmed; `author` defaults to "anonymous"). */
export const send = mutation({
  args: { roomId: v.id("rooms"), author: v.string(), body: v.string() },
  errors: [errors.EmptyMessage, errors.MessageTooLong, errors.RoomNotFound],
  handler: (ctx, { roomId, author, body }) => {
    const text = body.trim();
    if (!text) throw errors.EmptyMessage();
    if (text.length > MAX_BODY) throw errors.MessageTooLong({ max: MAX_BODY });
    if (!ctx.db.get(roomId)) ctx.fail.RoomNotFound({ roomId });
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
