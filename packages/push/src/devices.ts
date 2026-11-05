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
 *
 * A device is one push token: an Expo token (`provider: "expo"`), or a native one for the direct transport (`apns`
 * with its `environment`, `fcm`). Direct devices may also carry a PushKit `voipToken` and the `publicKey` their pushes
 * are sealed to (end-to-end encryption, `@freecorps/ember-expo-push`).
 */
import { defineTable } from "@freecorps/ember-server";
import { v } from "@freecorps/ember-values";
import { isApnsToken } from "./apns.ts";
import { isDevicePublicKey } from "./envelope.ts";
import { isExpoPushToken } from "./expo.ts";
import type { ApnsEnvironment } from "./types.ts";

export const PUSH_DEVICES_TABLE = "pushDevices";

export type PushProviderName = "expo" | "apns" | "fcm";

/** Whether `p` is a provider `sendToDevices` knows (`expo`, `apns`, `fcm`; exact case). */
export function isPushProviderName(p: unknown): p is PushProviderName {
  return p === "expo" || p === "apns" || p === "fcm";
}

/**
 * `{ userId, token, provider, platform?, deviceName?, environment?, voipToken?, publicKey?, updatedAt }` with
 * `by_user` and `by_token` indexes. The direct-transport fields are optional, so an existing table gains them with no
 * migration.
 */
export function pushDevicesTable() {
  return defineTable({
    userId: v.string(),
    token: v.string(),
    /** "expo" | "apns" | "fcm" */
    provider: v.string(),
    platform: v.optional(v.string()),
    deviceName: v.optional(v.string()),
    /** APNs environment of an iOS token: "sandbox" | "production". */
    environment: v.optional(v.string()),
    /** iOS PushKit token (VoIP pushes, `voip: true`). */
    voipToken: v.optional(v.string()),
    /** Device public key for sealed pushes (uncompressed P-256, base64url). */
    publicKey: v.optional(v.string()),
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
  environment?: ApnsEnvironment;
  voipToken?: string;
  publicKey?: string;
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
  /** Default: inferred from the token (Expo token → `expo`, hex → `apns`, `platform: "android"` → `fcm`), else `expo`. */
  provider?: string;
  platform?: string;
  deviceName?: string;
  environment?: string;
  voipToken?: string;
  publicKey?: string;
}

const byToken = (db: Db, table: string, token: string): PushDevice | null =>
  db.query(table).withIndex("by_token", (q) => q.eq("token", token)).unique();

/** The provider a token belongs to when the caller did not say. */
export function inferPushProvider(token: string, platform?: string): PushProviderName {
  if (isExpoPushToken(token)) return "expo";
  if (isApnsToken(token)) return "apns";
  if (platform === "android") return "fcm";
  return "expo";
}

/**
 * Upserts a device by token. A token re-registered by another user (shared device, account switch) moves to that
 * user. Fields left out keep their stored value. Returns the device id. Throws for an `environment` other than
 * `sandbox`/`production`, a `provider` other than `expo`/`apns`/`fcm` or a malformed `publicKey`, so a bad registration fails at the client instead of at send time.
 */
export function registerPushDevice(ctx: { db: WriterDb; now: number }, input: RegisterPushDeviceInput, table = PUSH_DEVICES_TABLE): string {
  if (!input.token) throw new Error("registerPushDevice: empty token");
  if (input.environment !== undefined && input.environment !== "sandbox" && input.environment !== "production") {
    throw new Error(`registerPushDevice: environment must be "sandbox" or "production", got ${JSON.stringify(input.environment)}`);
  }
  if (input.provider !== undefined && !isPushProviderName(input.provider)) {
    throw new Error(`registerPushDevice: provider must be "expo", "apns" or "fcm", got ${JSON.stringify(input.provider)}`);
  }
  if (input.publicKey !== undefined && !isDevicePublicKey(input.publicKey)) {
    throw new Error("registerPushDevice: publicKey must be an uncompressed P-256 point (65 bytes, base64url)");
  }
  const fields: Record<string, unknown> = {
    userId: input.userId,
    token: input.token,
    provider: input.provider ?? inferPushProvider(input.token, input.platform),
    updatedAt: ctx.now,
  };
  for (const f of ["platform", "deviceName", "environment", "voipToken", "publicKey"] as const) if (input[f] !== undefined) fields[f] = input[f];
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

/** Clears dead VoIP tokens (`unregisteredVoipTokens` from `sendToDevices`); the devices keep their push token. */
export function removeVoipTokens(db: WriterDb, entries: Iterable<{ userId: string; voipToken: string }>, table = PUSH_DEVICES_TABLE): number {
  let n = 0;
  for (const e of entries) {
    for (const d of pushDevicesForUser(db, e.userId, table)) {
      if (d.voipToken !== e.voipToken) continue;
      db.patch(d._id, { voipToken: undefined }); // undefined removes the field (Convex semantics)
      n++;
    }
  }
  return n;
}

/** Records the APNs environment a send discovered for a device registered without one. */
export function setPushDeviceEnvironment(db: WriterDb, token: string, environment: ApnsEnvironment, table = PUSH_DEVICES_TABLE): boolean {
  const existing = byToken(db, table, token);
  if (!existing || existing.environment === environment) return false;
  db.patch(existing._id, { environment });
  return true;
}

export function pushDevicesForUser(db: Db, userId: string, table = PUSH_DEVICES_TABLE): PushDevice[] {
  return db.query(table).withIndex("by_user", (q) => q.eq("userId", userId)).collect();
}

/** Devices of these users (one per token), optionally of one provider: what `sendToDevices` takes. */
export function pushDevicesForUsers(db: Db, userIds: Iterable<string>, opts: { provider?: string; table?: string } = {}): PushDevice[] {
  const out = new Map<string, PushDevice>();
  for (const u of new Set(userIds))
    for (const d of pushDevicesForUser(db, u, opts.table)) if (!opts.provider || d.provider === opts.provider) out.set(d.token, d);
  return [...out.values()];
}

/** Distinct tokens of these users, optionally of one provider. */
export function pushTokensForUsers(db: Db, userIds: Iterable<string>, opts: { provider?: string; table?: string } = {}): string[] {
  return pushDevicesForUsers(db, userIds, opts).map((d) => d.token);
}
