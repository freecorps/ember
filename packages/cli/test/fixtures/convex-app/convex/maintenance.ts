import { internalMutation } from "./_generated/server";

export const cleanup = internalMutation(async (ctx) => {
  let removed = 0;
  for await (const row of ctx.db.query("audit")) {
    if (row.at < ctx.now - 86_400_000) {
      await ctx.db.delete(row._id);
      removed++;
    }
  }
  return removed;
});
