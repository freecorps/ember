import { customCtx, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { Triggers } from "convex-helpers/server/triggers";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation as rawInternalMutation, mutation as rawMutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

const triggers = new Triggers<DataModel>();

triggers.register("notes", async (ctx, change) => {
  if (change.operation === "insert") {
    await ctx.db.insert("audit", { table: "notes", op: "insert", at: change.newDoc._creationTime });
  }
});

triggers.register("notes", async (ctx, change) => {
  if (change.operation === "delete") await ctx.db.insert("audit", { table: "notes", op: "delete", at: 0 });
});

export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
export const internalMutation = customMutation(rawInternalMutation, customCtx(triggers.wrapDB));

/** Queries for signed-in users: ctx.user. */
export const authedQuery = customQuery(
  query,
  customCtx(async (ctx) => {
    const user = await requireUser(ctx);
    return { user };
  }),
);
