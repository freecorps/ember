import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    rooms: defineTable({
      name: v.string(),
      // Kept by ember/triggers.ts on every message write, in the same transaction.
      messageCount: v.optional(v.number()),
      lastMessageAt: v.optional(v.number()),
    }).index("by_name", ["name"]),

    messages: defineTable({
      roomId: v.id("rooms"),
      author: v.string(),
      body: v.string(),
    })
      // Every index ends with `_creationTime`, so one room's messages come out in order for free.
      .index("by_room", ["roomId"])
      // Full-text search (SQLite FTS5) over the text, narrowed to one room.
      .searchIndex("search_body", { searchField: "body", filterFields: ["roomId"] }),
  },
});
