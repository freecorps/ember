import { v } from "@freecorps/ember-server";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { describe, metadata } from "./_metadata";

const MAX_SIZE = 5 * 1024 * 1024;
/** How long an upload may stay `processing` before the cron schedules its job again. */
export const STUCK_AFTER_MS = 5 * 60_000;

function requireUser(ctx: Pick<MutationCtx, "auth">) {
  const identity = ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Sign in first");
  return identity.subject;
}

// ------------------------------------------------------------------------------------------------ upload

/**
 * Step 1 of an upload. The browser asks for a ticket (`client.files.upload(file, { mutation: api.files.generateUploadUrl })`);
 * this mutation is where the app decides who may upload and how much. The ticket holds a presigned R2 URL (in
 * `ember dev`, a URL on the Worker itself).
 */
export const generateUploadUrl = mutation({
  args: { contentType: v.string(), size: v.number(), sha256: v.optional(v.string()), multipart: v.optional(v.boolean()) },
  handler: (ctx, args) => {
    requireUser(ctx);
    if (!Number.isFinite(args.size) || args.size < 0) throw new Error("Invalid file size");
    if (args.size > MAX_SIZE) throw new Error("Files are limited to 5 MiB in this example");
    return ctx.storage.generateUploadUrl(args);
  },
});

/** Step 2, once the bytes are in R2: record the upload and schedule the job that processes it. */
export const save = mutation({
  args: { storageId: v.file(), name: v.string() },
  handler: (ctx, { storageId, name }) => {
    const userId = requireUser(ctx);
    const file = ctx.storage.getMetadata(storageId);
    if (!file || file.state !== "ready") throw new Error("The file was not uploaded");
    const id = ctx.db.insert("uploads", {
      userId,
      name: name.trim() || "untitled",
      file: storageId,
      contentType: file.contentType ?? "application/octet-stream",
      size: file.size ?? 0,
      status: "processing",
    });
    // Runs after this transaction commits; retried with backoff if it fails.
    ctx.scheduler.runAfter(0, internal.files.process, { id });
    return id;
  },
});

// ------------------------------------------------------------------------------------------------ reading

/** The caller's uploads, newest first, each with a short-lived download URL. Live: `status` flips when the job ends. */
export const list = query({
  handler: (ctx) => {
    const identity = ctx.auth.getUserIdentity();
    if (!identity) return [];
    return ctx.db
      .query("uploads")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .collect()
      .map((u) => ({ ...u, url: ctx.storage.getUrl(u.file) }));
  },
});

export const remove = mutation({
  args: { id: v.id("uploads") },
  handler: (ctx, { id }) => {
    const userId = requireUser(ctx);
    const upload = ctx.db.get(id);
    if (!upload || upload.userId !== userId) throw new Error("No such upload");
    ctx.db.delete(id); // the file's reference count drops; R2 is cleaned up by the garbage collector
  },
});

// ------------------------------------------------------------------------------------------------ the job

/**
 * The scheduled job (an action: it runs in the Worker and may do I/O). It reads the file from R2, works out its
 * metadata and writes the result back with a mutation, which pushes it to every subscribed client.
 * Safe to run twice (the cron may re-schedule it): it only acts on uploads still `processing`.
 */
export const process = internalAction({
  args: { id: v.id("uploads") },
  handler: async (ctx, { id }) => {
    const upload = await ctx.runQuery(internal.files.get, { id });
    if (!upload || upload.status !== "processing") return;
    try {
      const stored = await ctx.storage.get(upload.file);
      if (!stored) throw new Error("The file is missing from storage");
      const meta = { ...describe(new Uint8Array(await stored.arrayBuffer()), upload.contentType), ...(stored.sha256 ? { sha256: stored.sha256 } : {}) };
      await ctx.runMutation(internal.files.finish, { id, status: "ready", meta });
    } catch (e) {
      await ctx.runMutation(internal.files.finish, { id, status: "failed", error: (e as Error).message });
    }
  },
});

export const get = internalQuery({
  args: { id: v.id("uploads") },
  handler: (ctx, { id }) => ctx.db.get(id),
});

export const finish = internalMutation({
  args: {
    id: v.id("uploads"),
    status: v.union(v.literal("ready"), v.literal("failed")),
    meta: v.optional(metadata),
    error: v.optional(v.string()),
  },
  handler: (ctx, { id, status, meta, error }) => {
    if (ctx.db.get(id)?.status !== "processing") return;
    ctx.db.patch(id, { status, ...(meta ? { meta } : {}), ...(error ? { error } : {}) });
  },
});

/** Run by the cron: schedules the job again for uploads stuck in `processing` (a lost job, a deploy in the middle). */
export const sweep = internalMutation({
  handler: (ctx) => {
    const stuck = ctx.db
      .query("uploads")
      .withIndex("by_status", (q) => q.eq("status", "processing").lt("_creationTime", ctx.now - STUCK_AFTER_MS))
      .collect();
    for (const u of stuck) ctx.scheduler.runAfter(0, internal.files.process, { id: u._id });
    return stuck.length;
  },
});
