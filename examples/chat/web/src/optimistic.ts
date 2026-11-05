// The optimistic update for `messages.send`, shared by the UI and the tests (pure: no DOM, no React).
import type { OptimisticUpdate } from "@freecorps/ember-client";
import { api } from "../../ember/_generated/api";
import type { Id } from "../../ember/_generated/dataModel";

export type SendArgs = { roomId: Id<"rooms">; author: string; body: string };

/**
 * Show the message at once, at the top of the first page of every loaded `messages.list` of that room. Pages are
 * separate live queries (one per cursor), so the update walks them all; only the one without a cursor is the head.
 * The server's version replaces this one when the mutation commits; if it fails, the update is rolled back.
 */
export const addMessageOptimistically: OptimisticUpdate<SendArgs> = (store, { roomId, author, body }) => {
  for (const { args, value } of store.getAllQueries(api.messages.list)) {
    if (!value || args.roomId !== roomId || args.paginationOpts.cursor !== null) continue;
    const message = { _id: `optimistic:${crypto.randomUUID()}` as Id<"messages">, _creationTime: Date.now(), roomId, author, body };
    store.setQuery(api.messages.list, args, { ...value, page: [message, ...value.page] });
  }
};

export const isOptimistic = (id: string) => id.startsWith("optimistic:");
