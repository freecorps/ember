import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

export const attachment = query({
  args: { noteId: v.id("notes") },
  handler: async (ctx, { noteId }) => {
    const note = await ctx.db.get(noteId);
    if (!note?.fileId) return null;
    const fileId: Id<"_storage"> = note.fileId;
    const meta = await ctx.db.system.get(fileId);
    const url = await ctx.storage.getUrl(fileId);
    return { url, size: meta?.size ?? null, contentType: meta?.contentType ?? null };
  },
});

export const fileInfo = query({
  args: { fileId: v.id("_storage") },
  handler: async (ctx, { fileId }) => {
    const byTable = await ctx.db.system.get("_storage", fileId);
    const byId = await ctx.db.system.get(fileId);
    return { same: byTable?.contentType === byId?.contentType };
  },
});

export const generateUploadUrl = mutation(async (ctx) => {
  return await ctx.storage.generateUploadUrl();
});
