import { v } from "@freecorps/ember-server";
import { query } from "./_generated/server";

export const job = query({
  args: { id: v.string() },
  handler: (ctx, { id }) => {
    const job = ctx.scheduler.get(id);
    const all = ctx.scheduler.list({ limit: 1000 /* at most 1000 jobs: Convex's .collect() returned all of them */ });
    return { state: job?.state.kind ?? null, total: all.length };
  },
});
