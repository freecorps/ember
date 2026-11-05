import { internalMutationGeneric as internalMutation, v } from "@freecorps/ember-server";

/** Grants a user (identity subject) access to mailboxes (HTTP: POST /inbox/members, full_access keys). */
export const upsertMember = internalMutation({
  args: { userId: v.string(), name: v.optional(v.string()), mailboxes: v.array(v.string()), admin: v.optional(v.boolean()) },
  handler: (ctx, a) => {
    const prev = ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", a.userId)).first();
    if (prev) {
      ctx.db.replace(prev._id, a);
      return prev._id;
    }
    return ctx.db.insert("members", a);
  },
});
