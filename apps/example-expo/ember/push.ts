import { pushTokensForUsers, registerPushDevice, removePushTokens, sendPush, unregisterPushDevice } from "@ember/push";
import { v } from "@ember/server";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";

function requireUser(ctx: MutationCtx) {
  const identity = ctx.auth.getUserIdentity();
  if (!identity) throw new Error("sign in first");
  return identity;
}

/** Called by the app after sign-in with the token from `registerForPush()`. */
export const register = mutation({
  args: { token: v.string(), platform: v.optional(v.string()), deviceName: v.optional(v.string()) },
  handler: (ctx, args) => {
    const { subject } = requireUser(ctx);
    const input: { userId: string; token: string; platform?: string; deviceName?: string } = { userId: subject, token: args.token };
    if (args.platform !== undefined) input.platform = args.platform;
    if (args.deviceName !== undefined) input.deviceName = args.deviceName;
    return registerPushDevice(ctx, input);
  },
});

/** Called by the app before sign-out, so this device stops getting the user's notifications. */
export const unregister = mutation({
  args: { token: v.string() },
  handler: (ctx, { token }) => unregisterPushDevice(ctx.db, token),
});

/** Every registered token except the sender's devices (fine for a demo; real apps pick recipients per channel). */
export const recipients = internalQuery({
  args: { sender: v.nullable(v.string()) },
  handler: (ctx, { sender }) => {
    const users = new Set(ctx.db.query("pushDevices").collect().map((d) => d.userId));
    if (sender) users.delete(sender);
    return pushTokensForUsers(ctx.db, users, { provider: "expo" });
  },
});

export const prune = internalMutation({
  args: { tokens: v.array(v.string()) },
  handler: (ctx, { tokens }) => removePushTokens(ctx.db, tokens),
});

export const notifyChannel = internalAction({
  args: { channel: v.string(), author: v.string(), body: v.string(), sender: v.nullable(v.string()) },
  handler: async (ctx, { channel, author, body, sender }) => {
    const tokens = await ctx.runQuery(internal.push.recipients, { sender });
    if (tokens.length === 0) return { sent: 0 };
    const accessToken = ctx.env.EXPO_ACCESS_TOKEN as string | undefined;
    const r = await sendPush(
      tokens,
      { title: `#${channel}`, body: `${author}: ${body}`.slice(0, 200), data: { channel }, sound: "default" },
      accessToken ? { accessToken } : {},
    );
    if (r.unregisteredTokens.length) await ctx.runMutation(internal.push.prune, { tokens: r.unregisteredTokens });
    // Receipts arrive within ~15 min; a follow-up action could call checkPushReceipts(r.tickets) and prune again.
    return { sent: r.tickets.filter((t) => t.status === "ok").length };
  },
});
