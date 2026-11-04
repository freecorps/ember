import { internalQuery, httpAction } from "../../_generated/server";

export const stats = internalQuery({
  handler: async (ctx) => ({
    users: (await ctx.db.query("users").collect()).length,
    messages: (await ctx.db.query("messages").collect()).length,
  }),
});

export const health = httpAction(async () => new Response("ok"));
