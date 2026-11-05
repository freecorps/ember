import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    /** API keys (Resend-style): only the SHA-256 of the token is stored; `prefix` is shown in lists. */
    apiKeys: defineTable({
      name: v.string(),
      prefix: v.string(),
      hash: v.string(),
      /** full_access | sending_access | inbox */
      permission: v.string(),
      /** Sending project (suppressions, rate limits, templates): the key's tenant. */
      project: v.string(),
      /** sending_access keys may be limited to one domain. */
      domain: v.optional(v.string()),
      createdAt: v.number(),
      revokedAt: v.optional(v.number()),
    })
      .index("by_hash", ["hash"])
      .index("by_project", ["project"]),

    /** Domains onboarded for sending and/or receiving. */
    domains: defineTable({
      name: v.string(),
      zoneId: v.optional(v.string()),
      zoneName: v.optional(v.string()),
      sendingTag: v.optional(v.string()),
      /** not_started | pending | verified | failed */
      status: v.string(),
      sending: v.boolean(),
      receiving: v.boolean(),
      routingStatus: v.optional(v.string()),
      records: v.array(v.object({ type: v.string(), name: v.string(), value: v.string(), priority: v.optional(v.number()), ttl: v.optional(v.number()), purpose: v.string() })),
      /** Resources this app created (deleted with the domain). */
      ruleIds: v.array(v.string()),
      subscriptionId: v.optional(v.string()),
      createdSending: v.optional(v.boolean()),
      notes: v.array(v.string()),
      createdAt: v.number(),
      checkedAt: v.optional(v.number()),
    }).index("by_name", ["name"]),

    /** Who may read and answer which mailboxes (identity subject from the auth provider). */
    members: defineTable({ userId: v.string(), name: v.optional(v.string()), mailboxes: v.array(v.string()), admin: v.optional(v.boolean()) }).index("by_user", ["userId"]),
  },
});
