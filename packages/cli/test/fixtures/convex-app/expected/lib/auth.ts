import { errors } from "../errors";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/** The signed-in user, or null. */
export function currentUser(ctx: QueryCtx): Doc<"users"> | null {
  const identity = ctx.auth.getUserIdentity();
  if (!identity) return null;
  return ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.subject))
    .unique();
}

export function requireUser(ctx: QueryCtx) {
  const user = currentUser(ctx);
  if (!user) throw errors.Unauthenticated({ code: "UNAUTHENTICATED", message: "Sign in first" });
  return user;
}
