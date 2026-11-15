import { internalMutation } from "./_generated/server";

export const cleanup = internalMutation((ctx) => {
  let removed = 0;
  for (const row of ctx.db.query("audit").collect()) {
    if (row.at < ctx.now - 86_400_000) {
      ctx.db.delete(row._id);
      removed++;
    }
  }
  return removed;
});
