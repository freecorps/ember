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
import { componentBuilders, defineComponent, defineSchema, defineTable, unsafeRef, v, type ComponentCtx, type FunctionReference, type GenericId } from "@freecorps/ember-server";
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
import { sendToDevices, type PushTarget, type PushTransports } from "./direct.ts";
import { checkPushReceipts, EXPO_RECEIPTS_CHUNK, type ExpoPushOptions } from "./expo.ts";
import type { FcmOptions } from "./fcm.ts";
import type { ApnsEnvironment, PushEncryption, PushFallback, PushMessage, PushTicket } from "./types.ts";

const receiptTicket = v.object({ token: v.string(), id: v.string() });
const claimedRow = v.object({ id: v.id("pendingReceipts"), attempt: v.number() });

const schema = defineSchema({
  tables: {
    devices: pushDevicesTable(),
    /**
     * Expo tickets waiting for their receipts: one row per send (at most `EXPO_RECEIPTS_CHUNK` tickets; a bigger send
     * takes several), checked by `lib:drainReceipts` up to `EXPO_RECEIPTS_CHUNK` tickets (one Expo request) at a time.
     * `attempt`: the check this row waits for (1..`RECEIPT_CHECKS`).
     */
    pendingReceipts: defineTable({ tickets: v.array(receiptTicket), dueAt: v.number(), attempt: v.number() }).index("by_due", ["dueAt"]),
    /**
     * At most one row: the drain job that is next (`nonce` in its args, `job` its id, `at` when it runs) and the rows a
     * drain claimed and has not settled yet (`inflight`; left there by a drain that crashed), each with the attempt it
     * claimed: a row settled (or counted again) since then has another attempt, and recovery leaves it alone.
     */
    receiptsDrain: defineTable({ nonce: v.string(), job: v.string(), at: v.number(), inflight: v.optional(v.array(claimedRow)) }),
  },
});

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
/** Receipt checks per ticket: the first one `receiptsDelayMs` after the send, then re-checks of the pending ones. */
export const RECEIPT_CHECKS = 3;
/**
 * A drain runs this long after the earliest row it waits for (a tenth of `receiptsDelayMs` when that is shorter), so
 * the sends of that window share one check instead of waking one each. Receipts are never checked before
 * `receiptsDelayMs`; at most this much after. More tickets due than one check takes: the next drain runs right away.
 */
export const RECEIPTS_BATCH_WINDOW_MS = 60_000;
const batchWindow = (delay: number) => Math.min(RECEIPTS_BATCH_WINDOW_MS, Math.floor(Math.max(0, delay) / 10));
/** A drain this late was lost (its job never ran): the next send schedules another. */
export const RECEIPTS_DRAIN_STALE_MS = 10 * 60_000;
/** `send` reads the devices up front (no job when there are none) for at most this many users. */
export const SEND_PRECHECK_MAX_USERS = 100;
/** Up to this many devices travel in the delivery job's args, so the action does not read them again. */
export const SEND_EMBED_MAX_DEVICES = 25;
/**
 * Embedded devices are used when the job starts within this long of the send (about what the read-then-send of the
 * action without them takes); a job that starts later reads them again, so a token unregistered or moved to another
 * user in the meantime does not get the push.
 */
export const SEND_EMBED_FRESH_MS = 5_000;

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

type ActionCtx = ComponentCtx<typeof schema, PushInstallConfig | undefined>["action"];
type MutationCtx = ComponentCtx<typeof schema, PushInstallConfig | undefined>["mutation"];
type ReceiptTicket = { token: string; id: string };

/** What a delivery job carries of a device: what `sendToDevices` reads (no ids, no timestamps). */
const targetValidator = v.object({
  token: v.string(),
  provider: v.optional(v.string()),
  platform: v.optional(v.string()),
  environment: v.optional(v.string()),
  publicKey: v.optional(v.string()),
  voipToken: v.optional(v.string()),
  userId: v.optional(v.string()),
});

/**
 * The devices of these users (one per token), reading at most `limit` of them: past `SEND_EMBED_MAX_DEVICES` the
 * action reads them again, so `send` stops there (its cost in the caller's transaction stays bounded).
 */
function devicesUpTo(ctx: Pick<MutationCtx, "db">, userIds: string[], limit: number): PushDevice[] {
  const out = new Map<string, PushDevice>();
  for (const u of new Set(userIds)) {
    for (const d of ctx.db.query(TABLE).withIndex("by_user", (q) => q.eq("userId", u)).take(limit - out.size)) out.set(d.token, d as PushDevice);
    if (out.size >= limit) break;
  }
  return [...out.values()];
}

function toTarget(d: PushDevice): PushTarget {
  const t: PushTarget = { token: d.token };
  for (const f of ["provider", "platform", "environment", "publicKey", "voipToken", "userId"] as const) if (d[f] !== undefined) t[f] = d[f];
  return t;
}

async function deliver(ctx: ActionCtx, userIds: string[], message: PushMessage, embedded?: { devices: PushTarget[]; at: number }): Promise<DeliveryResult> {
  // Devices read by `lib:send` (when few) come in the job's args; jobs without them (many devices, older jobs) or
  // started late (the devices may have changed since) read now.
  const fresh = embedded && ctx.now - embedded.at <= SEND_EMBED_FRESH_MS;
  const devices = fresh ? embedded.devices : ((await ctx.runQuery(unsafeRef<"query">("lib:targets"), { userIds })) as PushDevice[]);
  if (!devices.length) return { sent: 0, errors: 0, removedTokens: 0 };
  const r = await sendToDevices(devices, message, transports(ctx, new Set(devices.map((d) => d.provider ?? ""))));
  const receipts: ReceiptTicket[] = receiptsDelay(ctx) > 0 ? r.expoTickets.flatMap((t) => (t.status === "ok" && t.id ? [{ token: t.token, id: t.id }] : [])) : [];
  // One mutation for everything the send learned, receipts to check included (was: a mutation and a receipts job).
  const removedTokens =
    r.unregisteredTokens.length || r.unregisteredVoipTokens.length || r.environments.length || receipts.length
      ? ((await ctx.runMutation(unsafeRef<"mutation">("lib:applyResults"), {
          tokens: r.unregisteredTokens,
          voipTokens: r.unregisteredVoipTokens,
          environments: r.environments,
          ...(receipts.length ? { receipts } : {}),
        })) as number)
      : 0;
  const ok = r.tickets.filter((t) => t.status === "ok").length;
  const out: DeliveryResult = { sent: ok, errors: r.tickets.length - ok, removedTokens };
  if (out.errors) {
    const codes: Record<string, number> = {};
    for (const t of r.tickets) if (t.status === "error") codes[t.error ?? "Error"] = (codes[t.error ?? "Error"] ?? 0) + 1;
    out.errorCodes = codes;
  }
  return out;
}

/*
 * Expo receipts, batched. A send's tickets become a `pendingReceipts` row due `receiptsDelayMs` later; one drain job
 * checks up to `EXPO_RECEIPTS_CHUNK` due tickets (one Expo request) for every send in that window, instead of a job
 * per send. Invariants:
 * - While rows wait, the `receiptsDrain` row names the next drain (`nonce`, `job`, `at`). Only the drain whose args
 *   carry that nonce works; any other (superseded) one returns at once, so there is one chain of drains.
 * - `claimReceipts` (a mutation) takes the batch, records it in `inflight` and moves the next drain to
 *   `now + receiptsDelayMs`: if the action dies before `settleReceipts`, that drain finds `inflight` set, counts one
 *   attempt for those rows (dropping them past `RECEIPT_CHECKS`) and checks them again. Crashes cannot loop forever.
 * - `settleReceipts` removes the dead tokens, deletes the rows that got receipts (or ran out of checks), keeps the
 *   pending tickets for the next check and points the next drain at the earliest due row (no row: no drain).
 * - A drain that never ran (`at` older than `RECEIPTS_DRAIN_STALE_MS`) is replaced by the next send's `queueReceipts`.
 */

const RECEIPTS = "pendingReceipts";
const DRAIN = "receiptsDrain";

function drainState(ctx: Pick<MutationCtx, "db">) {
  return ctx.db.query(DRAIN).first();
}

function earliestReceipts(ctx: Pick<MutationCtx, "db">) {
  return ctx.db.query(RECEIPTS).withIndex("by_due").first();
}

type ClaimedRow = { id: GenericId<"pendingReceipts">; attempt: number };

/** Points the next drain at `at`: cancels the one scheduled (if another) and schedules a new one with a fresh nonce. */
function scheduleDrain(ctx: MutationCtx, at: number, state: { _id: GenericId<"receiptsDrain">; job: string } | null, inflight?: ClaimedRow[]) {
  if (state) ctx.scheduler.cancel(state.job);
  const nonce = `${ctx.now.toString(36)}-${Math.floor(ctx.random() * 2 ** 48).toString(36)}`;
  const job = ctx.scheduler.runAt(Math.max(at, ctx.now), unsafeRef<"action">("lib:drainReceipts"), { nonce });
  const doc = { nonce, job, at: Math.max(at, ctx.now), ...(inflight ? { inflight } : {}) };
  if (state) ctx.db.replace(state._id, doc);
  else ctx.db.insert(DRAIN, doc);
  return nonce;
}

/** Queues tickets for the check number `attempt`, `receiptsDelayMs` from now; schedules a drain when none will run. */
function queueReceipts(ctx: MutationCtx, tickets: ReceiptTicket[], attempt: number): void {
  const delay = receiptsDelay(ctx);
  if (!tickets.length || delay <= 0 || attempt > RECEIPT_CHECKS) return;
  const dueAt = ctx.now + delay;
  for (let i = 0; i < tickets.length; i += EXPO_RECEIPTS_CHUNK) ctx.db.insert(RECEIPTS, { tickets: tickets.slice(i, i + EXPO_RECEIPTS_CHUNK), dueAt, attempt });
  const state = drainState(ctx);
  const at = dueAt + batchWindow(delay);
  if (!state) scheduleDrain(ctx, at, null);
  else if (state.at < ctx.now - RECEIPTS_DRAIN_STALE_MS) scheduleDrain(ctx, ctx.now, state, state.inflight); // lost: drain now
  // A shorter receiptsDelayMs than before: earlier. Not while a check runs (`inflight`): that drain is its safety net,
  // and moving it would take the running check for crashed; its settle points the chain at the earliest row.
  else if (at < state.at && !state.inflight?.length) scheduleDrain(ctx, at, state);
}

/**
 * Counts one attempt for rows a crashed drain claimed (they are checked again; past the last check, dropped). A row
 * gone or at another attempt was settled (or counted) since that claim: left alone.
 */
function recoverInflight(ctx: MutationCtx, claimed: ClaimedRow[]): void {
  for (const { id, attempt } of claimed) {
    const row = ctx.db.get(id);
    if (!row || row.attempt !== attempt) continue;
    if (row.attempt >= RECEIPT_CHECKS) ctx.db.delete(id);
    else ctx.db.patch(id, { attempt: row.attempt + 1 });
  }
}

type Claimed = { nonce: string; rows: ClaimedRow[]; tickets: ReceiptTicket[] };

function claimReceipts(ctx: MutationCtx, nonce: string): Claimed | null {
  const state = drainState(ctx);
  if (!state || state.nonce !== nonce) return null; // superseded
  if (state.inflight?.length) recoverInflight(ctx, state.inflight);
  const rows: Claimed["rows"] = [];
  const tickets: ReceiptTicket[] = [];
  let cursor: string | null = null;
  scan: for (;;) {
    const page = ctx.db.query(RECEIPTS).withIndex("by_due", (q) => q.lte("dueAt", ctx.now)).paginate({ cursor, numItems: 64 });
    for (const row of page.page) {
      if (rows.length && tickets.length + row.tickets.length > EXPO_RECEIPTS_CHUNK) break scan;
      rows.push({ id: row._id, attempt: row.attempt });
      tickets.push(...row.tickets);
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  if (!rows.length) {
    // Nothing due (a drain moved earlier, or rows deleted): point at the earliest row, or stop.
    const next = earliestReceipts(ctx);
    if (next) scheduleDrain(ctx, next.dueAt + batchWindow(receiptsDelay(ctx)), state);
    else ctx.db.delete(state._id);
    return null;
  }
  // The safety net: runs only if this drain never settles (settleReceipts moves it).
  const next = scheduleDrain(ctx, ctx.now + Math.max(receiptsDelay(ctx), RECEIPTS_BATCH_WINDOW_MS), state, rows);
  return { nonce: next, rows, tickets };
}

function settleReceipts(ctx: MutationCtx, a: { nonce: string; rows: Claimed["rows"]; pending: string[]; tokens: string[] }): number {
  const removed = removePushTokens(ctx.db, a.tokens, TABLE);
  const pending = new Set(a.pending);
  const delay = receiptsDelay(ctx);
  for (const { id, attempt } of a.rows) {
    const row = ctx.db.get(id);
    // Gone, or already counted again by a drain that took this one for crashed: that drain owns it now.
    if (!row || row.attempt !== attempt) continue;
    const left = row.tickets.filter((t) => pending.has(t.id));
    if (!left.length || attempt >= RECEIPT_CHECKS || delay <= 0) ctx.db.delete(id);
    else ctx.db.replace(id, { tickets: left, dueAt: ctx.now + delay, attempt: attempt + 1 });
  }
  const state = drainState(ctx);
  if (!state) return removed;
  // Another drain took over the chain (a send replaced a late one). Its `inflight` stays: entries for the rows settled
  // here name an attempt they no longer have (recovery skips them), and the rows it claimed itself are its own.
  if (state.nonce !== a.nonce) return removed;
  const next = earliestReceipts(ctx);
  if (!next) {
    ctx.scheduler.cancel(state.job);
    ctx.db.delete(state._id);
    return removed;
  }
  // More due than one check took: right away. Else one window after the earliest row (the sends of that window share it).
  scheduleDrain(ctx, next.dueAt <= ctx.now ? ctx.now : next.dueAt + batchWindow(delay), state);
  return removed;
}

export const pushFunctions = {
  lib: {
    /** Upserts a device by token (a token re-registered by another user moves to that user). */
    register: mutation({ args: deviceArgs, returns: v.string(), handler: (ctx, a) => registerPushDevice(ctx, a as RegisterPushDeviceInput, TABLE) }),
    unregister: mutation({ args: { token: v.string() }, returns: v.boolean(), handler: (ctx, { token }) => unregisterPushDevice(ctx.db, token, TABLE) }),
    devices: query({ args: { userId: v.string() }, handler: (ctx, { userId }) => pushDevicesForUser(ctx.db, userId, TABLE) }),
    tokens: query({
      args: { userIds: v.array(v.string()), provider: v.optional(v.string()) },
      returns: v.array(v.string()),
      handler: (ctx, a) => pushTokensForUsers(ctx.db, a.userIds, { table: TABLE, ...(a.provider ? { provider: a.provider } : {}) }),
    }),
    /**
     * Enqueues a delivery to these users' devices (atomic with the calling mutation). Returns the job id, or `""` when
     * none of them has a device (nothing is scheduled). Up to `SEND_PRECHECK_MAX_USERS` users, the devices are read
     * here (stopping past `SEND_EMBED_MAX_DEVICES`), and up to that many travel in the job: the action uses them when
     * it starts within `SEND_EMBED_FRESH_MS`, and reads them again otherwise.
     */
    send: mutation({
      args: { userIds: v.array(v.string()), message: v.any() },
      returns: v.string(),
      handler: (ctx, a) => {
        const args: { userIds: string[]; message: unknown; devices?: PushTarget[]; at?: number } = { userIds: a.userIds, message: a.message };
        if (a.userIds.length <= SEND_PRECHECK_MAX_USERS) {
          const devices = devicesUpTo(ctx, a.userIds, SEND_EMBED_MAX_DEVICES + 1);
          if (!devices.length) return "";
          if (devices.length <= SEND_EMBED_MAX_DEVICES) {
            args.devices = devices.map(toTarget);
            args.at = ctx.now;
          }
        }
        return ctx.scheduler.runAfter(0, unsafeRef<"action">("lib:deliver"), args);
      },
    }),
    /** Sends right away (from an action) and reports what happened. */
    sendNow: action({
      args: { userIds: v.array(v.string()), message: v.any() },
      handler: (ctx, a) => deliver(ctx, a.userIds, a.message as PushMessage),
    }),
    deliver: internalAction({
      args: { userIds: v.array(v.string()), message: v.any(), devices: v.optional(v.array(targetValidator)), at: v.optional(v.number()) },
      handler: (ctx, a) => deliver(ctx, a.userIds, a.message as PushMessage, a.devices && a.at !== undefined ? { devices: a.devices as PushTarget[], at: a.at } : undefined),
    }),
    targets: internalQuery({ args: { userIds: v.array(v.string()) }, handler: (ctx, a) => pushDevicesForUsers(ctx.db, a.userIds, { table: TABLE }) }),
    /**
     * Expo receipts of one send, the way older versions scheduled them (jobs already queued when the app upgraded):
     * checks now, and what is still pending joins the batched queue (`pendingReceipts`) for the next attempt.
     */
    receipts: internalAction({
      args: { tickets: v.array(v.any()), attempt: v.number() },
      handler: async (ctx, a) => {
        const r = await checkPushReceipts(a.tickets as PushTicket[], expoOptions(ctx));
        const pending = a.attempt < RECEIPT_CHECKS ? r.pending : [];
        if (r.unregisteredTokens.length || pending.length) {
          await ctx.runMutation(unsafeRef<"mutation">("lib:queueReceipts"), { tokens: r.unregisteredTokens, tickets: pending.map((p) => ({ token: p.token, id: p.id })), attempt: a.attempt + 1 });
        }
        return { receipts: r.receipts.length, pending: r.pending.length, removed: r.unregisteredTokens.length };
      },
    }),
    /** Checks one batch of due receipts (see "Expo receipts, batched" above). */
    drainReceipts: internalAction({
      args: { nonce: v.string() },
      handler: async (ctx, a) => {
        const claimed = (await ctx.runMutation(unsafeRef<"mutation">("lib:claimReceipts"), { nonce: a.nonce })) as Claimed | null;
        if (!claimed) return { receipts: 0, pending: 0, removed: 0 };
        const r = await checkPushReceipts(claimed.tickets.map((t) => ({ ...t, status: "ok" as const })), expoOptions(ctx));
        const removed = (await ctx.runMutation(unsafeRef<"mutation">("lib:settleReceipts"), {
          nonce: claimed.nonce,
          rows: claimed.rows,
          pending: r.pending.map((p) => p.id),
          tokens: r.unregisteredTokens,
        })) as number;
        return { receipts: r.receipts.length, pending: r.pending.length, removed };
      },
    }),
    claimReceipts: internalMutation({ args: { nonce: v.string() }, handler: (ctx, a) => claimReceipts(ctx, a.nonce) }),
    settleReceipts: internalMutation({
      args: { nonce: v.string(), rows: v.array(claimedRow), pending: v.array(v.string()), tokens: v.array(v.string()) },
      returns: v.number(),
      handler: (ctx, a) => settleReceipts(ctx, a),
    }),
    queueReceipts: internalMutation({
      args: { tokens: v.array(v.string()), tickets: v.array(receiptTicket), attempt: v.number() },
      returns: v.number(),
      handler: (ctx, a) => {
        queueReceipts(ctx, a.tickets, a.attempt);
        return removePushTokens(ctx.db, a.tokens, TABLE);
      },
    }),
    /** What waits for a receipts check (tests, the dashboard's function runner). */
    receiptsQueue: internalQuery({
      args: {},
      handler: (ctx) => {
        const rows = ctx.db.query(RECEIPTS).collect();
        const drain = ctx.db.query(DRAIN).first();
        return { rows: rows.length, tickets: rows.reduce((n, r) => n + r.tickets.length, 0), drainAt: drain?.at ?? null, inflight: drain?.inflight?.length ?? 0 };
      },
    }),
    removeTokens: internalMutation({ args: { tokens: v.array(v.string()) }, returns: v.number(), handler: (ctx, a) => removePushTokens(ctx.db, a.tokens, TABLE) }),
    /**
     * What a direct send learned: dead push tokens (removed), dead VoIP tokens (cleared), APNs environments (recorded),
     * and the Expo tickets whose receipts to check (queued).
     */
    applyResults: internalMutation({
      args: {
        tokens: v.array(v.string()),
        voipTokens: v.array(v.object({ userId: v.string(), voipToken: v.string() })),
        environments: v.array(v.object({ token: v.string(), environment: v.string() })),
        receipts: v.optional(v.array(receiptTicket)),
      },
      returns: v.number(),
      handler: (ctx, a) => {
        for (const e of a.environments) if (e.environment === "sandbox" || e.environment === "production") setPushDeviceEnvironment(ctx.db, e.token, e.environment, TABLE);
        removeVoipTokens(ctx.db, a.voipTokens, TABLE);
        if (a.receipts?.length) queueReceipts(ctx, a.receipts, 1);
        return removePushTokens(ctx.db, a.tokens, TABLE);
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
    send: Ref<"mutation", { userIds: string[]; message: unknown }, string>;
    sendNow: Ref<"action", { userIds: string[]; message: unknown }, DeliveryResult>;
  };
}

// The slice of a query/mutation (sync) or action (async) ctx the helpers call. Method syntax: any ctx's typed
// `runQuery`/`runMutation`/`runAction` fits (parameters are compared bivariantly); results are typed by the overloads.
type SyncCtx = { db: unknown; runQuery(fn: unknown, args?: unknown): unknown; runMutation?(fn: unknown, args?: unknown): unknown };
type AsyncCtx = { runAction(fn: unknown, args?: unknown): Promise<unknown>; runQuery(fn: unknown, args?: unknown): Promise<unknown>; runMutation(fn: unknown, args?: unknown): Promise<unknown> };

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

  /** Enqueues a push to these users (in a mutation: atomic with it). Returns the delivery job id, `""` when none has a device. */
  send(ctx: SyncCtx, userIds: string[], message: PushMessage): string;
  send(ctx: AsyncCtx, userIds: string[], message: PushMessage): Promise<string>;
  send(ctx: SyncCtx | AsyncCtx, userIds: string[], message: PushMessage) {
    return needMutation(ctx, "send").call(ctx, this.component.lib.send, { userIds, message });
  }

  /** Sends now, from an action; resolves with the counts. */
  sendNow(ctx: AsyncCtx, userIds: string[], message: PushMessage): Promise<DeliveryResult> {
    // `lib.sendNow` is declared to return DeliveryResult (PushComponentApi); AsyncCtx does not carry it through.
    return ctx.runAction(this.component.lib.sendNow, { userIds, message }) as Promise<DeliveryResult>;
  }
}
