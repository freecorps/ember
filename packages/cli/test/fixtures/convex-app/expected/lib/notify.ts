import type { MutationCtx } from "../_generated/server";

/** Mixes database access and I/O: the codemod leaves it and reports it. */
export async function notifyWebhook(ctx: MutationCtx, text: string) {
  await ctx.db.insert("audit", { table: "webhook", op: text, at: Date.now() });
  await fetch("https://hooks.example.com/notify", { method: "POST", body: text });
}
