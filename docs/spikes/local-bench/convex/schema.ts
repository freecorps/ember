// Same tables and indexes as the Ember bench app (docs/spikes/remote/scripts/convex-vs-ember.ts, EMBER_SCHEMA).
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({ n: v.number(), sentAt: v.number(), body: v.string() }).index("by_n", ["n"]),
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
});
