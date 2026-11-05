import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    lists: defineTable({
      name: v.string(),
    }).index("by_name", ["name"]),

    todos: defineTable({
      listId: v.id("lists"),
      text: v.string(),
      done: v.boolean(),
    })
      // All of a list's todos, in creation order.
      .index("by_list", ["listId"])
      // Only the pending (or only the done) ones: the filter is part of the index, so it costs nothing to read.
      .index("by_list_done", ["listId", "done"]),
  },
});
