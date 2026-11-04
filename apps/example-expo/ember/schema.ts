import { pushDevicesTable } from "@freecorps/ember-push";
import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    messages: defineTable({
      channel: v.string(),
      author: v.string(),
      body: v.string(),
      edited: v.optional(v.boolean()),
    }).index("by_channel", ["channel"]),
    // App-side copy of auth users (the Auth DO owns the real ones), kept in sync by users.sync.
    profiles: defineTable({
      userId: v.string(),
      email: v.string(),
      name: v.string(),
      credits: v.number(),
    }).index("by_user", ["userId"]),
    // Expo push tokens per user (registered by the app after sign-in; see push.ts).
    pushDevices: pushDevicesTable(),
  },
});
