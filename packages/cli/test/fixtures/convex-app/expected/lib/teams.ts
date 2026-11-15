import { errors } from "../errors";
import type { DatabaseReader, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireUser } from "./auth";

/** A ctx type of the app, built from QueryCtx. */
type TeamCtx = QueryCtx & { teamId: Id<"teams"> };
/** Not recognisable as a ctx type: functions taking it convert because they await converted helpers. */
type AnyReader = Parameters<typeof requireUser>[0];

export function membersOf(db: DatabaseReader, teamId: Id<"teams">) {
  const out: Doc<"members">[] = [];
  for (const m of db.query("members").withIndex("by_team", (q) => q.eq("teamId", teamId)).collect()) {
    out.push(m);
  }
  return out;
}

export function loadTeam(ctx: TeamCtx) {
  const team = ctx.db.get(ctx.teamId);
  if (!team) throw errors.TeamNotFound("TEAM_NOT_FOUND");
  return team;
}

export const assertMember = (ctx: QueryCtx, teamId: Id<"teams">) => {
  const user = requireUser(ctx);
  const members = membersOf(ctx.db, teamId);
  if (!members.some((m) => m.userId === user._id)) throw errors.NotAMember({ code: "not-a-member", teamId });
  return user;
};

export function teamWithMembers(ctx: TeamCtx) {
  const [team, members] = [loadTeam(ctx), membersOf(ctx.db, ctx.teamId)];
  return { ...team, members };
}

/** Transitive: its parameter type is opaque, but everything it awaits converts. */
export function userName(ctx: AnyReader): string {
  const user = requireUser(ctx);
  return user.name;
}
