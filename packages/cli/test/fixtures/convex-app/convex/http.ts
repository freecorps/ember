import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/count",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const teamId = new URL(req.url).searchParams.get("team") ?? "";
    const n = await ctx.runQuery(internal.notes.count, { teamId: teamId as never });
    return new Response(String(n));
  }),
});

export default http;
