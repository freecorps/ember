import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    name: v.string(),
    tokenIdentifier: v.string(),
    avatar: v.optional(v.id("_storage")),
  }).index("by_token", ["tokenIdentifier"]),
  teams: defineTable({
    name: v.string(),
    limits: v.record(v.string(), v.number()),
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
    views: v.bigint(),
    fileId: v.optional(v.id("_storage")),
  })
    .index("by_team", ["teamId"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["teamId"] }),
  audit: defineTable({ table: v.string(), op: v.string(), at: v.number() }),
});
