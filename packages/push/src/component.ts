/**
 * Push as an Ember component (PLAN §12): the device table lives in the component (`push$devices` in each shard),
 * and sends can be enqueued from a mutation, atomically with it (`push.send(ctx, ...)` schedules the delivery
 * action). The table helpers (`pushDevicesTable`, `registerPushDevice`, ...) and `sendPush` stay available for apps
 * that keep devices in their own schema: the component is built on them.
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(pushComponent, { config: { apns: { topic: "com.acme.mail" }, encryption: "required" } });
 *   // ember/push.ts
 *   const push = new PushNotifications(components.push);
 *   export const register = mutation({ args: { token: v.string() }, handler: (ctx, a) => push.register(ctx, { userId: me(ctx), token: a.token }) });
 *   // in a mutation that creates a message:
 *   push.send(ctx, [recipient], { title: "New message", body: text });
 *
 * Transports, per device: Expo tokens go through Expo Push (zero setup, `EXPO_ACCESS_TOKEN` optional); native tokens
 * go directly to APNs (`APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` secrets + the topic) or FCM (`FCM_SERVICE_ACCOUNT`).
 * Secret names are configurable; values are read from the Worker env at send time and never stored.
 */
import { componentBuilders, defineComponent, defineSchema, v, type FunctionReference } from "@freecorps/ember-server";
import type { ApnsOptions } from "./apns.ts";
import {
  pushDevicesForUser,
  pushDevicesForUsers,
  pushDevicesTable,
  pushTokensForUsers,
  registerPushDevice,
  removePushTokens,
  removeVoipTokens,
  setPushDeviceEnvironment,
  unregisterPushDevice,
  type PushDevice,
  type RegisterPushDeviceInput,
} from "./devices.ts";
import { sendToDevices, type PushTransports } from "./direct.ts";
import { checkPushReceipts, type ExpoPushOptions } from "./expo.ts";
import type { FcmOptions } from "./fcm.ts";
import type { ApnsEnvironment, PushEncryption, PushFallback, PushMessage, PushTicket } from "./types.ts";

const schema = defineSchema({ tables: { devices: pushDevicesTable() } });

export type PushInstallConfig = {
  /** Worker env var (secret) with the Expo access token (default "EXPO_ACCESS_TOKEN"; absent = no token). */
  accessTokenEnv?: string;
  /** Delay of the Expo receipts check after a send (default 15 min; 0 disables it). */
  receiptsDelayMs?: number;
  /** Override Expo endpoints (proxies, tests). */
  sendUrl?: string;
  receiptsUrl?: string;
  /**
   * Direct APNs. Enabled when the three secrets are set and a topic is known; until then `apns` devices get
   * `ProviderNotConfigured` (and are kept).
   */
  apns?: {
    /** The app's bundle id. Default: the `APNS_TOPIC` env var. */
    topic?: string;
    /** Env var names (defaults `APNS_KEY` — the `.p8` text —, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`). */
    keyEnv?: string;
    keyIdEnv?: string;
    teamIdEnv?: string;
    topicEnv?: string;
    /** Host for devices registered without an environment (default `production`). */
    environment?: ApnsEnvironment;
    /** Endpoint overrides (tests, an HTTP/2 proxy). */
    productionUrl?: string;
    sandboxUrl?: string;
  };
  /** Direct FCM. Enabled when the service-account secret is set. */
  fcm?: {
    /** Env var with the service account's JSON key (default `FCM_SERVICE_ACCOUNT`). */
    serviceAccountEnv?: string;
    sendUrl?: string;
    tokenUrl?: string;
  };
  /** End-to-end encryption for direct devices (default `auto`: sealed when the device registered a public key). */
  encryption?: PushEncryption;
  /** What sealed pushes show in clear (default "New notification" / "Open the app to see it."). */
  fallback?: PushFallback;
};

/** Seal hooks by install name (`setPushSeal`): a function cannot be part of the install config, which holds values. */
const sealHooks = new Map<string, NonNullable<PushTransports["seal"]>>();

/**
 * An app with its own envelope: `seal` builds each direct (APNs/FCM) device's payload for the push component installed
 * as `installName` (default `"push"`), as `PushTransports.seal` does for `sendToDevices`. Call it in the Worker's entry
 * module, next to `createEmberWorker`; `null` removes it.
 */
export function setPushSeal(seal: PushTransports["seal"] | null, installName = "push"): void {
  if (seal) sealHooks.set(installName, seal);
  else sealHooks.delete(installName);
}

const { query, mutation, action, internalAction, internalMutation, internalQuery } = componentBuilders<typeof schema, PushInstallConfig | undefined>();

const TABLE = "devices";
const RECEIPTS_DELAY = 15 * 60_000;

type Ctx = { env: Record<string, unknown>; component: { name?: string; config: PushInstallConfig | undefined } };

/** The install's receipts delay (`receiptsDelayMs`), used for the first check and for re-checks of pending ids. */
const receiptsDelay = (ctx: { component: { config: PushInstallConfig | undefined } }): number => ctx.component.config?.receiptsDelayMs ?? RECEIPTS_DELAY;

const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);

const expoOptions = (ctx: Ctx): ExpoPushOptions => {
  const c = ctx.component.config ?? {};
  const token = str(ctx.env[c.accessTokenEnv ?? "EXPO_ACCESS_TOKEN"]);
  const o: ExpoPushOptions = {};
  if (token) o.accessToken = token;
  if (c.sendUrl) o.sendUrl = c.sendUrl;
  if (c.receiptsUrl) o.receiptsUrl = c.receiptsUrl;
  return o;
};

/** APNs options from the install config and the env, or the names of what is missing. */
export function apnsOptionsFromEnv(env: Record<string, unknown>, c: PushInstallConfig["apns"] = {}): ApnsOptions | { missing: string[] } {
  const names = { key: c.keyEnv ?? "APNS_KEY", keyId: c.keyIdEnv ?? "APNS_KEY_ID", teamId: c.teamIdEnv ?? "APNS_TEAM_ID", topic: c.topicEnv ?? "APNS_TOPIC" };
  const key = str(env[names.key]);
  const keyId = str(env[names.keyId]);
  const teamId = str(env[names.teamId]);
  const topic = c.topic ?? str(env[names.topic]);
  const missing = [!key && names.key, !keyId && names.keyId, !teamId && names.teamId, !topic && `${names.topic} (or config.apns.topic)`].filter((x): x is string => !!x);
  if (missing.length) return { missing };
  const o: ApnsOptions = { key: key!, keyId: keyId!, teamId: teamId!, topic: topic! };
  if (c.environment) o.environment = c.environment;
  if (c.productionUrl) o.productionUrl = c.productionUrl;
  if (c.sandboxUrl) o.sandboxUrl = c.sandboxUrl;
  return o;
}

/** FCM options from the install config and the env, or undefined when the secret is not set. */
export function fcmOptionsFromEnv(env: Record<string, unknown>, c: PushInstallConfig["fcm"] = {}): FcmOptions | undefined {
  const sa = str(env[c.serviceAccountEnv ?? "FCM_SERVICE_ACCOUNT"]);
  if (!sa) return undefined;
  const o: FcmOptions = { serviceAccount: sa };
  if (c.sendUrl) o.sendUrl = c.sendUrl;
  if (c.tokenUrl) o.tokenUrl = c.tokenUrl;
  return o;
}

function transports(ctx: Ctx, providers: Set<string>): PushTransports {
  const c = ctx.component.config ?? {};
  const t: PushTransports = { expo: expoOptions(ctx) };
  if (providers.has("apns")) {
    const a = apnsOptionsFromEnv(ctx.env, c.apns);
    if ("missing" in a) console.warn(`[push] APNs devices skipped: set ${a.missing.join(", ")}`);
    else t.apns = a;
  }
  if (providers.has("fcm")) {
    const f = fcmOptionsFromEnv(ctx.env, c.fcm);
    if (!f) console.warn(`[push] FCM devices skipped: set ${c.fcm?.serviceAccountEnv ?? "FCM_SERVICE_ACCOUNT"}`);
    else t.fcm = f;
  }
  if (c.encryption) t.encryption = c.encryption;
  if (c.fallback) t.fallback = c.fallback;
  const seal = sealHooks.get(ctx.component.name ?? "push");
  if (seal) t.seal = seal;
  return t;
}

const deviceArgs = {
  userId: v.string(),
  token: v.string(),
  provider: v.optional(v.string()),
  platform: v.optional(v.string()),
  deviceName: v.optional(v.string()),
  environment: v.optional(v.string()),
  voipToken: v.optional(v.string()),
  publicKey: v.optional(v.string()),
};

export type DeliveryResult = {
  sent: number;
  errors: number;
  removedTokens: number;
  /** Error codes and how many tickets had each (never tokens or content), e.g. `{ ProviderNotConfigured: 2 }`. */
  errorCodes?: Record<string, number>;
};

async function deliver(ctx: any, userIds: string[], message: PushMessage): Promise<DeliveryResult> {
  const devices = (await ctx.runQuery("lib:targets", { userIds })) as PushDevice[];
  if (!devices.length) return { sent: 0, errors: 0, removedTokens: 0 };
  const r = await sendToDevices(devices, message, transports(ctx, new Set(devices.map((d) => d.provider))));
  const removedTokens =
    r.unregisteredTokens.length || r.unregisteredVoipTokens.length || r.environments.length
      ? ((await ctx.runMutation("lib:applyResults", { tokens: r.unregisteredTokens, voipTokens: r.unregisteredVoipTokens, environments: r.environments })) as number)
      : 0;
  const delay = receiptsDelay(ctx);
  if (r.expoTickets.length && delay > 0) await ctx.scheduler.runAfter(delay, "lib:receipts", { tickets: r.expoTickets, attempt: 1 });
  const ok = r.tickets.filter((t) => t.status === "ok").length;
  const out: DeliveryResult = { sent: ok, errors: r.tickets.length - ok, removedTokens };
  if (out.errors) {
    const codes: Record<string, number> = {};
    for (const t of r.tickets) if (t.status === "error") codes[t.error ?? "Error"] = (codes[t.error ?? "Error"] ?? 0) + 1;
    out.errorCodes = codes;
  }
  return out;
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
    targets: internalQuery({ args: { userIds: v.array(v.string()) }, handler: (ctx, a) => pushDevicesForUsers(ctx.db as any, a.userIds, { table: TABLE }) }),
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
    /** What a direct send learned: dead push tokens (removed), dead VoIP tokens (cleared), APNs environments (recorded). */
    applyResults: internalMutation({
      args: {
        tokens: v.array(v.string()),
        voipTokens: v.array(v.object({ userId: v.string(), voipToken: v.string() })),
        environments: v.array(v.object({ token: v.string(), environment: v.string() })),
      },
      returns: v.number(),
      handler: (ctx, a) => {
        for (const e of a.environments) if (e.environment === "sandbox" || e.environment === "production") setPushDeviceEnvironment(ctx.db as any, e.token, e.environment, TABLE);
        removeVoipTokens(ctx.db as any, a.voipTokens, TABLE);
        return removePushTokens(ctx.db as any, a.tokens, TABLE);
      },
    }),
    count: internalQuery({ args: {}, handler: (ctx) => ctx.db.query("devices").collect().length }),
  },
};

const fallbackValidator = v.object({ title: v.optional(v.string()), body: v.optional(v.string()), titleLocKey: v.optional(v.string()), locKey: v.optional(v.string()) });

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
      apns: v.optional(
        v.object({
          topic: v.optional(v.string()),
          keyEnv: v.optional(v.string()),
          keyIdEnv: v.optional(v.string()),
          teamIdEnv: v.optional(v.string()),
          topicEnv: v.optional(v.string()),
          environment: v.optional(v.union(v.literal("sandbox"), v.literal("production"))),
          productionUrl: v.optional(v.string()),
          sandboxUrl: v.optional(v.string()),
        }),
      ),
      fcm: v.optional(v.object({ serviceAccountEnv: v.optional(v.string()), sendUrl: v.optional(v.string()), tokenUrl: v.optional(v.string()) })),
      encryption: v.optional(v.union(v.literal("off"), v.literal("auto"), v.literal("required"))),
      fallback: v.optional(fallbackValidator),
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

  /** Registers a device: an Expo token, or a native one with `environment`, `voipToken` and `publicKey` as the app reports them. */
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
