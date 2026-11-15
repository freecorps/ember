import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  users: defineTable({
    name: v.string(),
    tokenIdentifier: v.string(),
    avatar: v.optional(v.file()),
  }).index("by_token", ["tokenIdentifier"]),
  teams: defineTable({
    name: v.string(),
    limits: v.record(v.number()),
  }),
  members: defineTable({
    teamId: v.id("teams"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("member")),
  })
    .index("by_team", ["teamId"])
    .index("by_user", ["userId"]),
  notes: defineTable({
    teamId: v.id("teams"),
    authorId: v.id("users"),
    body: v.string(),
    views: v.int64(),
    fileId: v.optional(v.file()),
  })
    .index("by_team", ["teamId"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["teamId"] }),
  audit: defineTable({ table: v.string(), op: v.string(), at: v.number() }),
});
