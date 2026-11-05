import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";

/**
 * A list's todos, oldest first. `filter` picks an index range, so "pending" and "done" are separate live queries
 * that only re-run when a row in their own range changes (completing a todo moves it from one to the other).
 *
 * Queries like this one also run on the device: the client registers them for offline use (web/src/ember.ts),
 * so they only read through `ctx.db`.
 */
export const list = query({
  args: { listId: v.id("lists"), filter: v.union(v.literal("all"), v.literal("pending"), v.literal("done")) },
  handler: (ctx, { listId, filter }) => {
    if (filter === "all") return ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect();
    return ctx.db
      .query("todos")
      .withIndex("by_list_done", (q) => q.eq("listId", listId).eq("done", filter === "done"))
      .collect();
  },
});

export const add = mutation({
  args: { listId: v.id("lists"), text: v.string() },
  handler: (ctx, { listId, text }) => {
    const clean = text.trim();
    if (!clean) throw new Error("A todo needs some text");
    if (!ctx.db.get(listId)) throw new Error("No such list");
    return ctx.db.insert("todos", { listId, text: clean, done: false });
  },
});

export const setDone = mutation({
  args: { id: v.id("todos"), done: v.boolean() },
  handler: (ctx, { id, done }) => {
    if (!ctx.db.get(id)) return; // already removed, e.g. from another device: like `remove`, a replayed offline edit converges
    ctx.db.patch(id, { done });
  },
});

export const remove = mutation({
  args: { id: v.id("todos") },
  handler: (ctx, { id }) => {
    // `delete` throws when the document is missing. A todo that is already gone (deleted on another device while
    // this one was offline) is not an error: the queued mutation just has nothing left to do.
    if (ctx.db.get(id)) ctx.db.delete(id);
  },
});

/** Deletes every finished todo of a list; returns how many. */
export const clearDone = mutation({
  args: { listId: v.id("lists") },
  handler: (ctx, { listId }) => {
    const done = ctx.db.query("todos").withIndex("by_list_done", (q) => q.eq("listId", listId).eq("done", true)).collect();
    for (const t of done) ctx.db.delete(t._id);
    return done.length;
  },
});
