import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
import { metadata } from "./_metadata";

export default defineSchema({
  // One shard per Better Auth organization (`org:<organizationId>`): its members, invitations and teams are replicated
  // there (`ember.replicate` in auth.config.ts) as the read-only tables `auth:organization`, `auth:member`, ...
  shards: { org: defineShard({ key: v.string() }) },
  tables: {
    // Reference data (PLAN §22 L5): written in global:main only, copied to every org shard as a read-only table with
    // the same `_id`s and indexes, so `ctx.db.get(rateId)` and `withIndex("by_pair")` work inside any org's mutations.
    fxRates: defineTable({ base: v.string(), quote: v.string(), rate: v.number() }).index("by_pair", ["base", "quote"]).replicated(),
    // An org's prices, in its shard, pointing at the rate they used.
    quotes: defineTable({ org: v.string(), rateId: v.id("fxRates"), amount: v.number(), converted: v.number() }).shard("org", "org"),
    uploads: defineTable({
      userId: v.string(), // the Better Auth user id (`ctx.auth.getUserIdentity().subject`)
      name: v.string(),
      // A reference to a file in R2. The engine counts references: the object is garbage-collected after the last
      // document pointing at it is deleted.
      file: v.file(),
      contentType: v.string(),
      size: v.number(),
      // `processing` until the scheduled job has looked at the file; then `ready` (with `meta`) or `failed`.
      status: v.union(v.literal("processing"), v.literal("ready"), v.literal("failed")),
      meta: v.optional(metadata),
      error: v.optional(v.string()),
    })
      .index("by_user", ["userId"])
      .index("by_status", ["status"]),
  },
});
