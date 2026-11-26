// Functions of an organization's shard (`org:<organizationId>`). Better Auth's organization rows live there as
// read-only replica tables (`auth:organization`, `auth:member`, `auth:invitation`, `auth:team`, `auth:teamMember` and
// the members' `auth:user`), so a permission check is a local, synchronous read in the same transaction, and every
// membership change reaches subscribers like any other write.
import { query, type QueryCtx } from "./_generated/server";

/** The caller's membership in this organization (the shard's own `auth:member`), or null: signed out, or not a member. */
function membership(ctx: QueryCtx) {
  const me = ctx.auth.getUserIdentity();
  if (!me) return null;
  return ctx.db.query("auth:member").withIndex("by_userId", (q) => q.eq("userId", me.subject)).first();
}

/** The caller's role in this organization, or null (signed out, or not a member). */
export const myRole = query({
  shard: "org",
  handler: (ctx) => membership(ctx)?.role ?? null,
});

/**
 * The organization with its members (name and email from their replicated users), teams and pending invitations.
 * Members only: anyone can name a shard (`org:<organizationId>`), so the check is here, a local read like `myRole`.
 */
export const overview = query({
  shard: "org",
  handler: (ctx) => {
    if (!membership(ctx)) return null;
    const org = ctx.db.query("auth:organization").first();
    if (!org) return null;
    // The org shard's `auth:user` holds the users of this org's members: one scan, not a lookup per member.
    const users = new Map(ctx.db.query("auth:user").collect().map((u) => [u.id, u]));
    const members = ctx.db
      .query("auth:member")
      .collect()
      .map((m) => {
        const user = users.get(m.userId);
        return { memberId: m.id, userId: m.userId, role: m.role, name: user?.name ?? null, email: user?.email ?? null };
      })
      .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));
    // Team sizes from one scan of `auth:teamMember` (replica tables have no aggregates), not a count per team.
    const perTeam = new Map<string, number>();
    for (const tm of ctx.db.query("auth:teamMember").collect()) perTeam.set(tm.teamId, (perTeam.get(tm.teamId) ?? 0) + 1);
    const teams = ctx.db
      .query("auth:team")
      .collect()
      .map((t) => ({ name: t.name, members: perTeam.get(t.id) ?? 0 }));
    const invitations = ctx.db
      .query("auth:invitation")
      .collect()
      .filter((i) => i.status === "pending")
      .map((i) => ({ email: i.email, role: i.role ?? null }));
    return { id: org.id, name: org.name, slug: org.slug, members, teams, invitations };
  },
});
