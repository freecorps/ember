import { defineSchema, defineTable, v } from "cfx";
import "../plugins/vector"; // a user-defined index kind: adds .vectorIndex() / .withVectorIndex()

export default defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.string(),
    admin: v.boolean(),
  }).index("by_email", ["email"]),

  messages: defineTable({
    channel: v.string(),
    author: v.id("users"),
    body: v.string(),
    likes: v.number(),
    meta: v.optional(v.object({ edited: v.boolean(), tags: v.array(v.string()) })),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_channel", ["channel"])
    .index("by_channel_likes", ["channel", "likes"])
    .index("by_edited", ["meta.edited"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] })
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 3, filterFields: ["channel"] }),
});
