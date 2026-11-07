/**
 * Sending to registered devices through whichever transport each one uses: Expo Push for Expo tokens, APNs or FCM
 * directly for native tokens (`provider` in the device table). Content is sealed per device when the device has a
 * public key and encryption allows it (see `PushEncryption`); APNs and FCM then see only the envelope and the fallback
 * text.
 *
 *   const devices = await ctx.runQuery(internal.push.devicesOf, { userIds });
 *   const r = await sendToDevices(devices, { title: "Ana Souza", body: "Re: orçamento", urgency: "high" }, {
 *     apns: { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, key: env.APNS_KEY, topic: "com.acme.mail" },
 *     fcm: { serviceAccount: env.FCM_SERVICE_ACCOUNT },
 *     encryption: "required",
 *   });
 *   // r.unregisteredTokens / r.unregisteredVoipTokens → prune; r.environments → record; r.expoTickets → receipts later
 */
import { sendApns, type ApnsOptions } from "./apns.ts";
import { DEFAULT_PUSH_FALLBACK } from "./delivery.ts";
import { sealPushContent } from "./envelope.ts";
import { sendExpoMessages, type ExpoPushOptions } from "./expo.ts";
import { sendFcm, type FcmOptions } from "./fcm.ts";
import { inferPushProvider, isPushProviderName, type PushProviderName } from "./devices.ts";
import type { AddressedPushMessage, ApnsEnvironment, PushEncryption, PushFallback, PushMessage, PushPayload, PushTicket } from "./types.ts";

/** What `sendToDevices` needs of a device (a `PushDevice` row fits). */
export interface PushTarget {
  token: string;
  provider?: string;
  platform?: string;
  environment?: string;
  publicKey?: string;
  voipToken?: string;
  userId?: string;
}

export interface PushTransports {
  /** Expo Push options; `false` refuses Expo devices. Default `{}` (enabled, no access token). */
  expo?: ExpoPushOptions | false;
  /** Direct APNs; without it, `apns` devices get `ProviderNotConfigured` tickets (never pruned). */
  apns?: ApnsOptions;
  /** Direct FCM; without it, `fcm` devices get `ProviderNotConfigured` tickets. */
  fcm?: FcmOptions;
  /** Default `auto`; a message's `encryption` wins. */
  encryption?: PushEncryption;
  /** What sealed pushes show in clear (and `required` sends to devices without a key). */
  fallback?: PushFallback;
  /**
   * An app with its own envelope: called for every direct (APNs/FCM) device, it returns the payload to send as given
   * (`PushPayload`), or `null` for Ember's usual handling (its envelope, encryption mode and fallback). A throw is that
   * device's `RequestFailed` ticket. Expo devices never reach it.
   */
  seal?: (device: PushTarget, message: PushMessage, provider: "apns" | "fcm") => PushPayload | null | Promise<PushPayload | null>;
  now?: () => number;
}

export interface DeviceSendResult {
  /** One per target (VoIP sends: one per target with a VoIP token), in order. */
  tickets: PushTicket[];
  /** Push tokens to delete (`DeviceNotRegistered` or a malformed token). */
  unregisteredTokens: string[];
  /** VoIP tokens APNs no longer accepts: clear them (`removeVoipTokens`), the device keeps its push token. */
  unregisteredVoipTokens: Array<{ userId: string; voipToken: string }>;
  /** APNs environments discovered for devices registered without one: record them (`setPushDeviceEnvironment`). */
  environments: Array<{ token: string; environment: ApnsEnvironment }>;
  /** Expo `ok` tickets, for `checkPushReceipts` later (APNs/FCM answers are final). */
  expoTickets: PushTicket[];
}

const hasVisibleContent = (m: PushMessage) => !!(m.title || m.subtitle || m.body);

/** The fallback-only version of a message: no title/subtitle/body/data beyond the fallback text. */
function fallbackOnly(m: PushMessage, fallback: PushFallback): PushMessage {
  const { title, subtitle, body, data, ...rest } = m;
  void title;
  void subtitle;
  void body;
  void data;
  const out: PushMessage = { ...rest };
  if (fallback.title) out.title = fallback.title;
  if (fallback.body) out.body = fallback.body;
  return out;
}

/**
 * Sends `message` to every target (duplicate tokens once). Never throws for per-device failures: they come back as
 * error tickets (a provider other than `expo`/`apns`/`fcm` is `ProviderNotConfigured`, like one with no credentials). Encryption, per device:
 * - `off`: clear;
 * - `auto`: sealed when the device is `apns`/`fcm` and registered a public key, else clear;
 * - `required`: sealed, or the fallback text only (no data) for an Expo device or one without a key.
 * Only pushes with something to show (title/subtitle/body) are sealed; background (`contentAvailable` only) and VoIP
 * pushes go as they are under `auto`, and lose their `data` under `required`.
 */
export async function sendToDevices(targets: Iterable<PushTarget>, message: PushMessage, t: PushTransports = {}): Promise<DeviceSendResult> {
  const mode: PushEncryption = message.encryption ?? t.encryption ?? "auto";
  const fallback = t.fallback ?? DEFAULT_PUSH_FALLBACK;
  const now = t.now ?? Date.now;
  const seen = new Set<string>();
  // `provider` is whatever the device row holds: anything but expo/apns/fcm gets an error ticket below.
  const list: Array<{ target: PushTarget; provider: string; to: string }> = [];
  for (const target of targets) {
    const provider = target.provider ?? inferPushProvider(target.token, target.platform);
    let to = target.token;
    if (message.voip) {
      if (provider !== "apns" || !target.voipToken) continue;
      to = target.voipToken;
    }
    if (seen.has(to)) continue;
    seen.add(to);
    list.push({ target, provider, to });
  }

  const tickets: PushTicket[] = new Array(list.length);
  const groups: Record<PushProviderName, Array<{ i: number; m: AddressedPushMessage }>> = { expo: [], apns: [], fcm: [] };

  await Promise.all(
    list.map(async ({ target, provider, to }, i) => {
      if (!isPushProviderName(provider)) {
        tickets[i] = { token: to, status: "error", error: "ProviderNotConfigured", message: `unknown push provider ${JSON.stringify(provider)} (expected expo, apns or fcm)` };
        return;
      }
      let m: AddressedPushMessage = { ...message, to };
      if (provider === "apns" && (target.environment === "sandbox" || target.environment === "production")) m.environment = target.environment;
      const direct = provider === "apns" || provider === "fcm";
      if (direct && t.seal) {
        let own: PushPayload | null;
        try {
          own = await t.seal(target, message, provider);
        } catch (e) {
          tickets[i] = { token: to, status: "error", error: "RequestFailed", message: `seal hook: ${(e as Error).message}` };
          return;
        }
        if (own) {
          groups[provider].push({ i, m: { ...m, payload: own } });
          return;
        }
      }
      const sealable = direct && !message.voip && hasVisibleContent(message);
      if (mode !== "off" && sealable && target.publicKey) {
        try {
          const content: Record<string, unknown> = {};
          for (const f of ["title", "subtitle", "body", "data"] as const) if (message[f] !== undefined) content[f] = message[f];
          m.sealed = await sealPushContent(target.publicKey, content, { now: now() });
        } catch (e) {
          const msg = (e as Error).message;
          tickets[i] = { token: to, status: "error", error: /over \d+/.test(msg) ? "MessageTooBig" : "RequestFailed", message: `cannot seal: ${msg}` };
          return;
        }
      } else if (mode === "required") {
        const { data, ...withoutData } = message;
        void data;
        const base = hasVisibleContent(message) ? fallbackOnly(message, fallback) : withoutData;
        m = { ...base, to, ...(m.environment ? { environment: m.environment } : {}) };
      }
      groups[provider].push({ i, m });
    }),
  );

  const run = async (provider: PushProviderName, send: ((ms: AddressedPushMessage[]) => Promise<PushTicket[]>) | null) => {
    const g = groups[provider];
    if (!g.length) return;
    if (!send) {
      for (const { i, m } of g) tickets[i] = { token: m.to, status: "error", error: "ProviderNotConfigured", message: `no ${provider} credentials configured` };
      return;
    }
    const out = await send(g.map((x) => x.m));
    g.forEach(({ i }, k) => (tickets[i] = out[k]!));
  };
  await Promise.all([
    run("expo", t.expo === false ? null : (ms) => sendExpoMessages(ms, t.expo || {})),
    run("apns", t.apns ? (ms) => sendApns(ms, { ...t.apns!, fallback: t.apns!.fallback ?? fallback }) : null),
    run("fcm", t.fcm ? (ms) => sendFcm(ms, { ...t.fcm!, fallback: t.fcm!.fallback ?? fallback }) : null),
  ]);

  const result: DeviceSendResult = { tickets, unregisteredTokens: [], unregisteredVoipTokens: [], environments: [], expoTickets: [] };
  const dead = new Set<string>();
  tickets.forEach((ticket, i) => {
    const { target, provider } = list[i]!;
    if (ticket.status === "ok") {
      if (provider === "expo") result.expoTickets.push(ticket);
      if (ticket.environment && !message.voip) result.environments.push({ token: target.token, environment: ticket.environment });
      return;
    }
    if (ticket.error !== "DeviceNotRegistered" && ticket.error !== "InvalidToken") return;
    if (message.voip) result.unregisteredVoipTokens.push({ userId: target.userId ?? "", voipToken: ticket.token });
    else dead.add(target.token);
  });
  result.unregisteredTokens = [...dead];
  return result;
}
