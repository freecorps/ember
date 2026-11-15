import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
import { metadata } from "./_metadata";

export default defineSchema({
  // One shard per Better Auth organization (`org:<organizationId>`): its members, invitations and teams are replicated
  // there (`ember.replicate` in auth.config.ts) as the read-only tables `auth:organization`, `auth:member`, ...
  shards: { org: defineShard({ key: v.string() }) },
  tables: {
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
