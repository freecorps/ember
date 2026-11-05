import {
  apnsOptionsFromEnv,
  fcmOptionsFromEnv,
  pushDevicesForUsers,
  registerPushDevice,
  removePushTokens,
  removeVoipTokens,
  sendToDevices,
  setPushDeviceEnvironment,
  unregisterPushDevice,
  type PushTransports,
} from "@freecorps/ember-push";
import { v } from "@freecorps/ember-server";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";

function requireUser(ctx: MutationCtx) {
  const identity = ctx.auth.getUserIdentity();
  if (!identity) throw new Error("sign in first");
  return identity;
}

/**
 * Called by the app after sign-in with what `registerForPush()` returned: an Expo token, or (EMBER_PUSH_DIRECT=1) the
 * native APNs/FCM token with its APNs environment and the device public key for sealed pushes.
 */
export const register = mutation({
  args: {
    token: v.string(),
    platform: v.optional(v.string()),
    deviceName: v.optional(v.string()),
    provider: v.optional(v.string()),
    environment: v.optional(v.string()),
    publicKey: v.optional(v.string()),
  },
  handler: (ctx, args) => {
    const { subject } = requireUser(ctx);
    const input: Parameters<typeof registerPushDevice>[1] = { userId: subject, token: args.token };
    for (const f of ["platform", "deviceName", "provider", "environment", "publicKey"] as const) if (args[f] !== undefined) input[f] = args[f];
    return registerPushDevice(ctx, input);
  },
});

/** Called by the app before sign-out, so this device stops getting the user's notifications. */
export const unregister = mutation({
  args: { token: v.string() },
  handler: (ctx, { token }) => unregisterPushDevice(ctx.db, token),
});

/** Every registered device except the sender's (fine for a demo; real apps pick recipients per channel). */
export const recipients = internalQuery({
  args: { sender: v.nullable(v.string()) },
  handler: (ctx, { sender }) => {
    const users = new Set(ctx.db.query("pushDevices").collect().map((d) => d.userId));
    if (sender) users.delete(sender);
    return pushDevicesForUsers(ctx.db, users);
  },
});

/** What a send learned: dead tokens, dead VoIP tokens, APNs environments of devices registered without one. */
export const applyResults = internalMutation({
  args: {
    tokens: v.array(v.string()),
    voipTokens: v.array(v.object({ userId: v.string(), voipToken: v.string() })),
    environments: v.array(v.object({ token: v.string(), environment: v.string() })),
  },
  handler: (ctx, a) => {
    for (const e of a.environments) if (e.environment === "sandbox" || e.environment === "production") setPushDeviceEnvironment(ctx.db, e.token, e.environment);
    removeVoipTokens(ctx.db, a.voipTokens);
    return removePushTokens(ctx.db, a.tokens);
  },
});

/**
 * Expo tokens go through Expo Push (`EXPO_ACCESS_TOKEN` optional); native ones straight to APNs/FCM when their secrets
 * are set (APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC; FCM_SERVICE_ACCOUNT), sealed for devices with a key.
 */
export const notifyChannel = internalAction({
  args: { channel: v.string(), author: v.string(), body: v.string(), sender: v.nullable(v.string()) },
  handler: async (ctx, { channel, author, body, sender }) => {
    const devices = await ctx.runQuery(internal.push.recipients, { sender });
    if (devices.length === 0) return { sent: 0 };
    const env = ctx.env as Record<string, unknown>;
    const accessToken = typeof env.EXPO_ACCESS_TOKEN === "string" ? env.EXPO_ACCESS_TOKEN : undefined;
    const transports: PushTransports = { expo: accessToken ? { accessToken } : {}, fallback: { title: `#${channel}`, body: "New message" } };
    const apns = apnsOptionsFromEnv(env);
    if (!("missing" in apns)) transports.apns = apns;
    const fcm = fcmOptionsFromEnv(env);
    if (fcm) transports.fcm = fcm;
    const r = await sendToDevices(
      devices,
      { title: author, subtitle: `#${channel}`, body: body.slice(0, 200), data: { channel }, sound: "default", collapseId: `chat-${channel}` },
      transports,
    );
    if (r.unregisteredTokens.length || r.unregisteredVoipTokens.length || r.environments.length) {
      await ctx.runMutation(internal.push.applyResults, { tokens: r.unregisteredTokens, voipTokens: r.unregisteredVoipTokens, environments: r.environments });
    }
    // Expo receipts arrive within ~15 min; a follow-up action could call checkPushReceipts(r.expoTickets) and prune again.
    return { sent: r.tickets.filter((t) => t.status === "ok").length, errors: r.tickets.filter((t) => t.status === "error").map((t) => (t.status === "error" ? t.error : "")) };
  },
});
