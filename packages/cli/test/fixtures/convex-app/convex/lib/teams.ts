import { ConvexError } from "convex/values";
import type { DatabaseReader, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireUser } from "./auth";

/** A ctx type of the app, built from QueryCtx. */
type TeamCtx = QueryCtx & { teamId: Id<"teams"> };
/** Not recognisable as a ctx type: functions taking it convert because they await converted helpers. */
type AnyReader = Parameters<typeof requireUser>[0];

export async function membersOf(db: DatabaseReader, teamId: Id<"teams">) {
  const out: Doc<"members">[] = [];
  for await (const m of db.query("members").withIndex("by_team", (q) => q.eq("teamId", teamId))) {
    out.push(m);
  }
  return out;
}

export async function loadTeam(ctx: TeamCtx) {
  const team = await ctx.db.get(ctx.teamId);
  if (!team) throw new ConvexError("TEAM_NOT_FOUND");
  return team;
}

export const assertMember = async (ctx: QueryCtx, teamId: Id<"teams">) => {
  const user = await requireUser(ctx);
  const members = await membersOf(ctx.db, teamId);
  if (!members.some((m) => m.userId === user._id)) throw new ConvexError({ code: "not-a-member", teamId });
  return user;
};

export async function teamWithMembers(ctx: TeamCtx) {
  const [team, members] = await Promise.all([loadTeam(ctx), membersOf(ctx.db, ctx.teamId)]);
  return { ...team, members };
}

/** Transitive: its parameter type is opaque, but everything it awaits converts. */
export async function userName(ctx: AnyReader): Promise<string> {
  const user = await requireUser(ctx);
  return user.name;
}
