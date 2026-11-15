import { type FileId, v } from "@freecorps/ember-server";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

export const attachment = query({
  args: { noteId: v.id("notes") },
  handler: (ctx, { noteId }) => {
    const note = ctx.db.get(noteId);
    if (!note?.fileId) return null;
    const fileId: FileId = note.fileId;
    const meta = ctx.storage.getMetadata(fileId);
    const url = ctx.storage.getUrl(fileId);
    return { url, size: meta?.size ?? null, contentType: meta?.contentType ?? null };
  },
});

export const fileInfo = query({
  args: { fileId: v.file() },
  handler: (ctx, { fileId }) => {
    const byTable = ctx.storage.getMetadata(fileId);
    const byId = ctx.storage.getMetadata(fileId);
    return { same: byTable?.contentType === byId?.contentType };
  },
});

export const generateUploadUrl = mutation((ctx) => {
  return ctx.storage.generateUploadUrl();
});
