/** The Ember app on the other side: who `ctx.auth` says is calling, and the profile copy the outbox keeps in sync. */
import { defineSchema, defineTable, internalMutation, query, v } from "@freecorps/ember-server";

export const schema = defineSchema({
  tables: {
    // What `internal.users.sync` received, as is (the tests check no hidden field ever arrives), and the outbox row's
    // key (`<event>:<id>:recovered:<seq>` for a change the alarm recovered from the journal instead of a hook).
    profiles: defineTable({ userId: v.string(), event: v.string(), key: v.string(), fields: v.array(v.string()), user: v.any() }).index("by_user", ["userId"]),
  },
});

export const whoami = query({
  args: {},
  handler: (ctx) => {
    const identity = ctx.auth.getUserIdentity();
    return identity ? { subject: identity.subject, claims: identity.claims ?? {} } : null;
  },
});

export const profiles = query({
  args: { userId: v.string() },
  handler: (ctx, { userId }) => ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
});

/** `authOutbox()`'s default target (`internal.users.sync`). */
export const sync = internalMutation({
  args: { event: v.string(), user: v.any(), key: v.string() },
  handler: (ctx, { event, user, key }) => {
    const u = user as Record<string, unknown>;
    ctx.db.insert("profiles", { userId: String(u.id), event, key, fields: Object.keys(u).sort(), user: u });
  },
});
