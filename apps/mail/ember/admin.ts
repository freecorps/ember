import { internalMutationGeneric as internalMutation, v } from "@freecorps/ember-server";

/**
 * Grants a user (identity subject) access to mailboxes (HTTP: POST /inbox/members, full_access keys). Patch
 * semantics: a field that is absent keeps its stored value (a new member starts with no mailboxes, not admin);
 * `name: null` clears the name.
 */
export const upsertMember = internalMutation({
  args: { userId: v.string(), name: v.optional(v.union(v.null(), v.string())), mailboxes: v.optional(v.array(v.string())), admin: v.optional(v.boolean()) },
  handler: (ctx, a) => {
    const prev = ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", a.userId)).first();
    if (prev) {
      ctx.db.patch(prev._id, {
        ...(a.name !== undefined ? { name: a.name ?? undefined } : {}),
        ...(a.mailboxes !== undefined ? { mailboxes: a.mailboxes } : {}),
        ...(a.admin !== undefined ? { admin: a.admin } : {}),
      });
      return prev._id;
    }
    return ctx.db.insert("members", { userId: a.userId, mailboxes: a.mailboxes ?? [], ...(a.name ? { name: a.name } : {}), ...(a.admin !== undefined ? { admin: a.admin } : {}) });
  },
});
