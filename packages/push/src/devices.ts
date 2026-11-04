/**
 * Device registration for user schemas. Add the table to your schema and call the helpers from your own
 * mutations/queries (they take `ctx.db`, so they run inside the caller's transaction):
 *
 *   // ember/schema.ts
 *   tables: { ..., pushDevices: pushDevicesTable() }
 *
 *   // ember/push.ts
 *   export const register = mutation({
 *     args: { token: v.string(), platform: v.optional(v.string()) },
 *     handler: (ctx, args) => registerPushDevice(ctx, { userId: requireUser(ctx).subject, ...args }),
 *   });
 */
import { defineTable } from "@ember/server";
import { v } from "@ember/values";

export const PUSH_DEVICES_TABLE = "pushDevices";

/** `{ userId, token, provider, platform?, deviceName?, updatedAt }` with `by_user` and `by_token` indexes. */
export function pushDevicesTable() {
  return defineTable({
    userId: v.string(),
    token: v.string(),
    /** "expo" | "apns" | "fcm" */
    provider: v.string(),
    platform: v.optional(v.string()),
    deviceName: v.optional(v.string()),
    /** ms since epoch of the last registration (stale devices can be pruned). */
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["token"]);
}

export interface PushDevice {
  _id: string;
  _creationTime: number;
  userId: string;
  token: string;
  provider: string;
  platform?: string;
  deviceName?: string;
  updatedAt: number;
}

/**
 * The slice of `ctx.db` the helpers use. Typed loosely so it accepts any schema's `DatabaseReader`/`Writer`
 * (the table name is a parameter).
 */
type Db = {
  query(table: any): { withIndex(name: any, range?: (q: any) => any): { collect(): any[]; unique(): any } };
};
type WriterDb = Db & {
  insert(table: any, value: any): string;
  patch(id: any, value: any): void;
  delete(id: any): void;
};

export interface RegisterPushDeviceInput {
  userId: string;
  token: string;
  provider?: string;
  platform?: string;
  deviceName?: string;
}

const byToken = (db: Db, table: string, token: string): PushDevice | null =>
  db.query(table).withIndex("by_token", (q) => q.eq("token", token)).unique();

/**
 * Upserts a device by token. A token re-registered by another user (shared device, account switch) moves to that
 * user. Returns the device id.
 */
export function registerPushDevice(ctx: { db: WriterDb; now: number }, input: RegisterPushDeviceInput, table = PUSH_DEVICES_TABLE): string {
  if (!input.token) throw new Error("registerPushDevice: empty token");
  const fields: Record<string, unknown> = {
    userId: input.userId,
    token: input.token,
    provider: input.provider ?? "expo",
    updatedAt: ctx.now,
  };
  if (input.platform !== undefined) fields.platform = input.platform;
  if (input.deviceName !== undefined) fields.deviceName = input.deviceName;
  const existing = byToken(ctx.db, table, input.token);
  if (existing) {
    ctx.db.patch(existing._id, fields);
    return existing._id;
  }
  return ctx.db.insert(table, fields);
}

/** Removes a device by token (sign-out on that device). Returns whether it existed. */
export function unregisterPushDevice(db: WriterDb, token: string, table = PUSH_DEVICES_TABLE): boolean {
  const existing = byToken(db, table, token);
  if (existing) db.delete(existing._id);
  return !!existing;
}

/** Removes every device with one of `tokens` (e.g. `unregisteredTokens` from `sendPush`/`checkPushReceipts`). */
export function removePushTokens(db: WriterDb, tokens: Iterable<string>, table = PUSH_DEVICES_TABLE): number {
  let n = 0;
  for (const t of new Set(tokens)) if (unregisterPushDevice(db, t, table)) n++;
  return n;
}

export function pushDevicesForUser(db: Db, userId: string, table = PUSH_DEVICES_TABLE): PushDevice[] {
  return db.query(table).withIndex("by_user", (q) => q.eq("userId", userId)).collect();
}

/** Distinct tokens of these users, optionally of one provider. */
export function pushTokensForUsers(db: Db, userIds: Iterable<string>, opts: { provider?: string; table?: string } = {}): string[] {
  const out = new Set<string>();
  for (const u of new Set(userIds))
    for (const d of pushDevicesForUser(db, u, opts.table)) if (!opts.provider || d.provider === opts.provider) out.add(d.token);
  return [...out];
}
