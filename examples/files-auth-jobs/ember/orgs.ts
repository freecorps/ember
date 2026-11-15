// Functions of an organization's shard (`org:<organizationId>`). Better Auth's organization rows live there as
// read-only replica tables (`auth:organization`, `auth:member`, `auth:invitation`, `auth:team`, `auth:teamMember` and
// the members' `auth:user`), so a permission check is a local, synchronous read in the same transaction, and every
// membership change reaches subscribers like any other write.
import { query } from "./_generated/server";

/** The caller's role in this organization, or null (signed out, or not a member). */
export const myRole = query({
  shard: "org",
  handler: (ctx) => {
    const me = ctx.auth.getUserIdentity();
    if (!me) return null;
    return ctx.db.query("auth:member").withIndex("by_userId", (q) => q.eq("userId", me.subject)).first()?.role ?? null;
  },
});

/** The organization with its members (name and email from their replicated users), teams and pending invitations. */
export const overview = query({
  shard: "org",
  handler: (ctx) => {
    const org = ctx.db.query("auth:organization").first();
    if (!org) return null;
    const members = ctx.db
      .query("auth:member")
      .collect()
      .map((m) => {
        const user = ctx.db.query("auth:user").withIndex("by_source_id", (q) => q.eq("id", m.userId)).first();
        return { memberId: m.id, userId: m.userId, role: m.role, name: user?.name ?? null, email: user?.email ?? null };
      })
      .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));
    const teams = ctx.db
      .query("auth:team")
      .collect()
      .map((t) => ({ name: t.name, members: ctx.db.query("auth:teamMember").withIndex("by_teamId", (q) => q.eq("teamId", t.id)).collect().length }));
    const invitations = ctx.db
      .query("auth:invitation")
      .collect()
      .filter((i) => i.status === "pending")
      .map((i) => ({ email: i.email, role: i.role ?? null }));
    return { id: org.id, name: org.name, slug: org.slug, members, teams, invitations };
  },
});
