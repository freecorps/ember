import { v } from "@ember/server";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";

function requireUser(ctx: MutationCtx) {
  const identity = ctx.auth.getUserIdentity();
  if (!identity) throw new Error("sign in first");
  return identity;
}

/** The caller as the runtime verified it (JWT claims), plus the synced profile. */
export const me = query({
  handler: (ctx) => {
    const identity = ctx.auth.getUserIdentity();
    if (!identity) return null;
    const profile = ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();
    return { subject: identity.subject, email: identity.claims?.email ?? null, profile };
  },
});

export const addCredits = mutation({
  args: { amount: v.number() },
  handler: (ctx, { amount }) => {
    const { subject } = requireUser(ctx);
    const p = ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", subject)).unique();
    if (!p) throw new Error("profile not synced yet");
    ctx.db.patch(p._id, { credits: p.credits + amount });
    return p.credits + amount;
  },
});

/**
 * `sensitive: true`: the session is re-checked in the Auth DO on every call, so it fails right after sign-out
 * even while the 5-minute JWT is still valid.
 */
export const spendCredits = mutation({
  sensitive: true,
  args: { amount: v.number() },
  handler: (ctx, { amount }) => {
    const { subject } = requireUser(ctx);
    const p = ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", subject)).unique();
    if (!p || p.credits < amount) throw new Error("not enough credits");
    ctx.db.patch(p._id, { credits: p.credits - amount });
    return p.credits - amount;
  },
});

/** Profile sync: the Auth DO's outbox calls this on every user create/update/delete (retried, deduplicated). */
export const sync = internalMutation({
  args: { event: v.string(), user: v.any(), key: v.string() },
  handler: (ctx, { event, user }) => {
    const existing = ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", user.id)).unique();
    if (event === "delete") {
      if (existing) ctx.db.delete(existing._id);
      return;
    }
    const fields = { email: String(user.email ?? ""), name: String(user.name ?? "") };
    if (existing) ctx.db.patch(existing._id, fields);
    else ctx.db.insert("profiles", { userId: user.id, credits: 0, ...fields });
  },
});
