// Test-only functions (not part of the app).
import { v } from "@freecorps/ember-server";
import { mutation } from "../ember/_generated/server";

/** An upload as the app would have left it after a lost job: `processing`, and no job scheduled for it. */
export const insertStuck = mutation({
  args: { storageId: v.file(), name: v.string() },
  handler: (ctx, { storageId, name }) => {
    const file = ctx.storage.getMetadata(storageId)!;
    return ctx.db.insert("uploads", {
      userId: ctx.auth.getUserIdentity()!.subject,
      name,
      file: storageId,
      contentType: file.contentType ?? "application/octet-stream",
      size: file.size ?? 0,
      status: "processing",
    });
  },
});

/** Deletes every upload: `_creationTime` never goes below a table's newest document, so a test that fakes an old one starts empty. */
export const clearUploads = mutation({
  args: {},
  handler: (ctx) => {
    for (const u of ctx.db.query("uploads").collect()) ctx.db.delete(u._id);
  },
});
