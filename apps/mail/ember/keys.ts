// API keys: created by the HTTP API (token generated in the Worker with crypto.getRandomValues; only its hash
// reaches the shard), looked up by hash on every request.
import { internalMutationGeneric as internalMutation, internalQueryGeneric as internalQuery, v } from "@freecorps/ember-server";

export const PERMISSIONS = ["full_access", "sending_access", "inbox"] as const;

export const insert = internalMutation({
  args: { name: v.string(), prefix: v.string(), hash: v.string(), permission: v.string(), project: v.string(), domain: v.optional(v.string()) },
  handler: (ctx, a) => {
    if (!(PERMISSIONS as readonly string[]).includes(a.permission)) throw new Error(`permission must be one of ${PERMISSIONS.join(", ")}`);
    return ctx.db.insert("apiKeys", { ...a, createdAt: ctx.now });
  },
});

export const byHash = internalQuery({
  args: { hash: v.string() },
  handler: (ctx, { hash }) => {
    const k = ctx.db.query("apiKeys").withIndex("by_hash", (q) => q.eq("hash", hash)).first();
    return k && !k.revokedAt ? { id: k._id, permission: k.permission, project: k.project, ...(k.domain ? { domain: k.domain } : {}) } : null;
  },
});

export const list = internalQuery({
  args: {},
  handler: (ctx) =>
    ctx.db
      .query("apiKeys")
      .collect()
      .filter((k) => !k.revokedAt)
      .map((k) => ({ id: k._id, name: k.name, prefix: k.prefix, permission: k.permission, project: k.project, created_at: new Date(k._creationTime).toISOString() })),
});

export const revoke = internalMutation({
  args: { id: v.string() },
  handler: (ctx, { id }) => {
    const nid = ctx.db.normalizeId("apiKeys", id);
    const k = nid ? ctx.db.get(nid) : null;
    if (!k || k.revokedAt) return false;
    ctx.db.patch(k._id, { revokedAt: ctx.now });
    return true;
  },
});
