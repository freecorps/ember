import { defineTriggers } from "./_generated/server";

/**
 * Per-table triggers: they run inside the mutation that wrote the row (same transaction), so a room's counter and
 * `lastMessageAt` never disagree with its messages, and clients see the room change live like any other write.
 * Optimistic updates on the client do not run them (only the server does).
 */
export default defineTriggers({
  messages: (ctx, change) => {
    if (change.operation === "insert") {
      ctx.db.increment(change.newDoc.roomId, "messageCount", 1);
      ctx.db.patch(change.newDoc.roomId, { lastMessageAt: change.newDoc._creationTime });
    } else if (change.operation === "delete" && ctx.db.get(change.oldDoc.roomId)) {
      ctx.db.increment(change.oldDoc.roomId, "messageCount", -1);
    }
  },
});
