import { internalMutation as rawInternalMutation, mutation as rawMutation, query, type TriggerCtx, type Change } from "./_generated/server";
import { requireUser } from "./lib/auth";

export const notesTrigger = (ctx: TriggerCtx, change: Change<"notes">) => {
  if (change.operation === "insert") {
    ctx.db.insert("audit", { table: "notes", op: "insert", at: change.newDoc._creationTime });
  }
};

export const notesTrigger2 = (ctx: TriggerCtx, change: Change<"notes">) => {
  if (change.operation === "delete") ctx.db.insert("audit", { table: "notes", op: "delete", at: 0 });
};

export const mutation = rawMutation;
export const internalMutation = rawInternalMutation;

/** Queries for signed-in users: ctx.user. */
export const authedQuery = query.use((ctx) => ({ /* added to the incoming ctx */ ctx: ((ctx) => {
    const user = requireUser(ctx);
    return { user };
  })(ctx) }));
