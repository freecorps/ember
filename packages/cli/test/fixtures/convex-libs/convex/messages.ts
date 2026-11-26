import { query } from "./_generated/server";
import { filter } from "convex-helpers/server/filter";
import { lib } from "./lib";

export const list = query({
  args: {},
  handler: async (ctx) => filter(ctx.db.query("messages"), () => lib()).collect(),
});
