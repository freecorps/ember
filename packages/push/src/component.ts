/**
 * Push as an Ember component (PLAN §12): the device table lives in the component (`push$devices` in each shard),
 * and sends can be enqueued from a mutation, atomically with it (`push.send(ctx, ...)` schedules the delivery
 * action). The table helpers (`pushDevicesTable`, `registerPushDevice`, ...) and `sendPush` stay available for apps
 * that keep devices in their own schema: the component is built on them.
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(pushComponent);
 *   // ember/push.ts
 *   const push = new PushNotifications(components.push);
 *   export const register = mutation({ args: { token: v.string() }, handler: (ctx, a) => push.register(ctx, { userId: me(ctx), token: a.token }) });
 *   // in a mutation that creates a message:
 *   push.send(ctx, [recipient], { title: "New message", body: text });
 */
import { componentBuilders, defineComponent, defineSchema, v, type FunctionReference } from "@freecorps/ember-server";
import { pushDevicesForUser, pushDevicesTable, pushTokensForUsers, registerPushDevice, removePushTokens, unregisterPushDevice, type PushDevice, type RegisterPushDeviceInput } from "./devices.ts";
import { checkPushReceipts, sendPush, type ExpoPushOptions } from "./expo.ts";
import type { PushMessage, PushTicket } from "./types.ts";

const schema = defineSchema({ tables: { devices: pushDevicesTable() } });

export type PushInstallConfig = {
  /** Worker env var (secret) with the Expo access token (default "EXPO_ACCESS_TOKEN"; absent = no token). */
  accessTokenEnv?: string;
  /** Delay of the receipts check after a send (default 15 min; 0 disables it). */
  receiptsDelayMs?: number;
  /** Override Expo endpoints (proxies, tests). */
  sendUrl?: string;
  receiptsUrl?: string;
};

const { query, mutation, action, internalAction, internalMutation, internalQuery } = componentBuilders<typeof schema, PushInstallConfig | undefined>();

const TABLE = "devices";
const RECEIPTS_DELAY = 15 * 60_000;

/** The install's receipts delay (`receiptsDelayMs`), used for the first check and for re-checks of pending ids. */
const receiptsDelay = (ctx: { component: { config: PushInstallConfig | undefined } }): number => ctx.component.config?.receiptsDelayMs ?? RECEIPTS_DELAY;

const expoOptions = (ctx: { env: Record<string, unknown>; component: { config: PushInstallConfig | undefined } }): ExpoPushOptions => {
  const c = ctx.component.config ?? {};
  const token = ctx.env[c.accessTokenEnv ?? "EXPO_ACCESS_TOKEN"];
  const o: ExpoPushOptions = {};
  if (typeof token === "string" && token) o.accessToken = token;
  if (c.sendUrl) o.sendUrl = c.sendUrl;
  if (c.receiptsUrl) o.receiptsUrl = c.receiptsUrl;
  return o;
};

const deviceArgs = {
  userId: v.string(),
  token: v.string(),
  provider: v.optional(v.string()),
  platform: v.optional(v.string()),
  deviceName: v.optional(v.string()),
};

export type DeliveryResult = { sent: number; errors: number; removedTokens: number };

async function deliver(ctx: any, userIds: string[], message: PushMessage): Promise<DeliveryResult> {
  const tokens = (await ctx.runQuery("lib:tokens", { userIds, provider: "expo" })) as string[];
  if (!tokens.length) return { sent: 0, errors: 0, removedTokens: 0 };
  const r = await sendPush(tokens, message, expoOptions(ctx));
  const removedTokens = r.unregisteredTokens.length ? ((await ctx.runMutation("lib:removeTokens", { tokens: r.unregisteredTokens })) as number) : 0;
  const ok = r.tickets.filter((t) => t.status === "ok");
  const delay = receiptsDelay(ctx);
  if (ok.length && delay > 0) await ctx.scheduler.runAfter(delay, "lib:receipts", { tickets: ok, attempt: 1 });
  return { sent: ok.length, errors: r.tickets.length - ok.length, removedTokens };
}

export const pushFunctions = {
  lib: {
    /** Upserts a device by token (a token re-registered by another user moves to that user). */
    register: mutation({ args: deviceArgs, returns: v.string(), handler: (ctx, a) => registerPushDevice(ctx as any, a as RegisterPushDeviceInput, TABLE) }),
    unregister: mutation({ args: { token: v.string() }, returns: v.boolean(), handler: (ctx, { token }) => unregisterPushDevice(ctx.db as any, token, TABLE) }),
    devices: query({ args: { userId: v.string() }, handler: (ctx, { userId }) => pushDevicesForUser(ctx.db as any, userId, TABLE) }),
    tokens: query({
      args: { userIds: v.array(v.string()), provider: v.optional(v.string()) },
      returns: v.array(v.string()),
      handler: (ctx, a) => pushTokensForUsers(ctx.db as any, a.userIds, { table: TABLE, ...(a.provider ? { provider: a.provider } : {}) }),
    }),
    /** Enqueues a delivery to these users' devices (atomic with the calling mutation). Returns the job id. */
    send: mutation({
      args: { userIds: v.array(v.string()), message: v.any() },
      returns: v.string(),
      handler: (ctx, a) => ctx.scheduler.runAfter(0, "lib:deliver" as any, { userIds: a.userIds, message: a.message }),
    }),
    /** Sends right away (from an action) and reports what happened. */
    sendNow: action({
      args: { userIds: v.array(v.string()), message: v.any() },
      handler: (ctx, a) => deliver(ctx, a.userIds, a.message as PushMessage),
    }),
    deliver: internalAction({ args: { userIds: v.array(v.string()), message: v.any() }, handler: (ctx, a) => deliver(ctx, a.userIds, a.message as PushMessage) }),
    /** Expo receipts: removes devices reported DeviceNotRegistered; re-checks pending ids twice. */
    receipts: internalAction({
      args: { tickets: v.array(v.any()), attempt: v.number() },
      handler: async (ctx, a) => {
        const r = await checkPushReceipts(a.tickets as PushTicket[], expoOptions(ctx as any));
        if (r.unregisteredTokens.length) await ctx.runMutation("lib:removeTokens" as any, { tokens: r.unregisteredTokens });
        const delay = receiptsDelay(ctx as any);
        if (r.pending.length && a.attempt < 3 && delay > 0) {
          await ctx.scheduler.runAfter(delay, "lib:receipts" as any, { tickets: r.pending.map((p) => ({ ...p, status: "ok" })), attempt: a.attempt + 1 });
        }
        return { receipts: r.receipts.length, pending: r.pending.length, removed: r.unregisteredTokens.length };
      },
    }),
    removeTokens: internalMutation({ args: { tokens: v.array(v.string()) }, returns: v.number(), handler: (ctx, a) => removePushTokens(ctx.db as any, a.tokens, TABLE) }),
    count: internalQuery({ args: {}, handler: (ctx) => ctx.db.query("devices").collect().length }),
  },
};

export const pushComponent = defineComponent({
  name: "push",
  schema,
  functions: pushFunctions,
  config: v.optional(
    v.object({
      accessTokenEnv: v.optional(v.string()),
      receiptsDelayMs: v.optional(v.number()),
      sendUrl: v.optional(v.string()),
      receiptsUrl: v.optional(v.string()),
    }),
  ),
});

type Ref<T extends "query" | "mutation" | "action", A, R> = FunctionReference<T, "public", A, R>;
/** What `components.<name>` of the push component looks like. */
export interface PushComponentApi {
  lib: {
    register: Ref<"mutation", RegisterPushDeviceInput, string>;
    unregister: Ref<"mutation", { token: string }, boolean>;
    devices: Ref<"query", { userId: string }, PushDevice[]>;
    tokens: Ref<"query", { userIds: string[]; provider?: string }, string[]>;
    send: Ref<"mutation", { userIds: string[]; message: any }, string>;
    sendNow: Ref<"action", { userIds: string[]; message: any }, DeliveryResult>;
  };
}

type SyncCtx = { db: unknown; runQuery(fn: any, args?: any): any; runMutation?(fn: any, args?: any): any };
type AsyncCtx = { runAction(fn: any, args?: any): Promise<any>; runQuery(fn: any, args?: any): Promise<any>; runMutation(fn: any, args?: any): Promise<any> };

const needMutation = (ctx: SyncCtx | AsyncCtx, what: string) => {
  if (!ctx.runMutation) throw new Error(`push.${what} needs a mutation or action ctx`);
  return ctx.runMutation;
};

/** Typed helper over an installed push component (sync in mutations/queries, Promises in actions). */
export class PushNotifications {
  constructor(readonly component: PushComponentApi) {}

  register(ctx: SyncCtx, device: RegisterPushDeviceInput): string;
  register(ctx: AsyncCtx, device: RegisterPushDeviceInput): Promise<string>;
  register(ctx: SyncCtx | AsyncCtx, device: RegisterPushDeviceInput) {
    return needMutation(ctx, "register").call(ctx, this.component.lib.register, device);
  }

  unregister(ctx: SyncCtx, token: string): boolean;
  unregister(ctx: AsyncCtx, token: string): Promise<boolean>;
  unregister(ctx: SyncCtx | AsyncCtx, token: string) {
    return needMutation(ctx, "unregister").call(ctx, this.component.lib.unregister, { token });
  }

  devices(ctx: SyncCtx, userId: string): PushDevice[];
  devices(ctx: AsyncCtx, userId: string): Promise<PushDevice[]>;
  devices(ctx: SyncCtx | AsyncCtx, userId: string) {
    return ctx.runQuery(this.component.lib.devices, { userId });
  }

  /** Enqueues a push to these users (in a mutation: atomic with it). Returns the delivery job id. */
  send(ctx: SyncCtx, userIds: string[], message: PushMessage): string;
  send(ctx: AsyncCtx, userIds: string[], message: PushMessage): Promise<string>;
  send(ctx: SyncCtx | AsyncCtx, userIds: string[], message: PushMessage) {
    return needMutation(ctx, "send").call(ctx, this.component.lib.send, { userIds, message });
  }

  /** Sends now, from an action; resolves with the counts. */
  sendNow(ctx: AsyncCtx, userIds: string[], message: PushMessage): Promise<DeliveryResult> {
    return ctx.runAction(this.component.lib.sendNow, { userIds, message });
  }
}
