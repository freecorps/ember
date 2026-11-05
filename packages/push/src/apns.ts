/**
 * Direct APNs sender: token-based (`.p8`) authentication over HTTP/2, written for Ember from Apple's documentation
 * ("Establishing a token-based connection to APNs", "Sending notification requests to APNs", "Handling notification
 * responses from APNs", "Generating a remote notification"). Its observable behaviour — 40-minute provider-token
 * reuse, priority/TTL per urgency, the per-device sandbox/production host and which answers drop a device — matches
 * Freecorps Brigade's relay as its README describes it; no code is taken from the relay (AGPL).
 *
 * HTTP/2: APNs speaks nothing else. A deployed Worker's `fetch` reaches it (Brigade spike S1, Ember ops E2E R12);
 * local workerd (`ember dev`) does not, and fails with a network error. Test locally with a fake `fetch`.
 */
import { DEFAULT_PUSH_FALLBACK, byteLength, fetchWithRetry, mapLimit, resolveInterruptionLevel, resolveTtlSeconds, resolveUrgency, type RetryOptions } from "./delivery.ts";
import { importSigningKey, signJwt } from "./jwt.ts";
import type { AddressedPushMessage, ApnsEnvironment, PushErrorCode, PushFallback, PushProvider, PushTicket } from "./types.ts";

export const APNS_PRODUCTION_URL = "https://api.push.apple.com";
export const APNS_SANDBOX_URL = "https://api.sandbox.push.apple.com";
/** Payload limits (bytes): 4 KB for regular pushes, 5 KB for VoIP. */
export const APNS_MAX_PAYLOAD = 4096;
export const APNS_VOIP_MAX_PAYLOAD = 5120;
/**
 * Provider tokens are reused for 40 minutes: APNs refuses one older than an hour (`ExpiredProviderToken`) and one
 * refreshed more often than every 20 minutes (`TooManyProviderTokenUpdates`).
 */
export const APNS_TOKEN_REFRESH_MS = 40 * 60_000;

export interface ApnsCredentials {
  /** The `.p8` key's 10-character id (developer.apple.com → Keys). */
  keyId: string;
  /** The Apple Developer team id. */
  teamId: string;
  /** The `.p8` file's text (PKCS#8 PEM). */
  key: string;
}

export interface ApnsOptions extends ApnsCredentials, RetryOptions {
  /** The app's bundle id (`apns-topic`). VoIP pushes use `<topic>.voip`. */
  topic: string;
  /** Host for devices that registered no environment (default `production`). */
  environment?: ApnsEnvironment;
  /** Endpoint overrides (tests, an HTTP/2 proxy for local development). */
  productionUrl?: string;
  sandboxUrl?: string;
  /** Text shown in clear for sealed pushes (default `DEFAULT_PUSH_FALLBACK`). */
  fallback?: PushFallback;
  /** Requests in flight at once (default 10). */
  concurrency?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** A device token as `getDevicePushTokenAsync` returns it on iOS: hex, 32 bytes on devices (Simulator tokens are longer). */
export function isApnsToken(token: unknown): token is string {
  return typeof token === "string" && token.length % 2 === 0 && /^[0-9a-fA-F]{64,200}$/.test(token);
}

/** What APNs answers mean for the caller (Apple's reason strings → Ember's codes). */
export function apnsErrorCode(status: number, reason: string | undefined): PushErrorCode {
  switch (reason) {
    case "Unregistered":
    case "ExpiredToken":
    case "BadDeviceToken":
      return "DeviceNotRegistered";
    case "DeviceTokenNotForTopic":
    case "TopicDisallowed":
    case "BadTopic":
    case "MissingTopic":
      return "MismatchSenderId";
    case "ExpiredProviderToken":
    case "InvalidProviderToken":
    case "MissingProviderToken":
    case "Forbidden":
    case "BadCertificate":
    case "BadCertificateEnvironment":
    case "BadEnvironmentKeyInToken":
    case "UnrelatedKeyIdInToken":
      return "InvalidCredentials";
    case "PayloadTooLarge":
      return "MessageTooBig";
    case "TooManyRequests":
    case "TooManyProviderTokenUpdates":
      return "MessageRateExceeded";
  }
  if (status === 410) return "DeviceNotRegistered";
  if (status === 403) return "InvalidCredentials";
  if (status === 413) return "MessageTooBig";
  if (status === 429) return "MessageRateExceeded";
  return "RequestFailed";
}

const providerTokens = new Map<string, { token: string; issuedAt: number }>();
const signing = new Map<string, Promise<string>>();

/**
 * The ES256 provider token for these credentials, reused for `APNS_TOKEN_REFRESH_MS` (per isolate). Concurrent callers
 * share one signing (APNs answers `TooManyProviderTokenUpdates` when tokens change too often). `force` signs a new
 * one: `true` always; a token string only if the cache still holds that token (after `ExpiredProviderToken`, so
 * concurrent sends that saw the same stale token refresh once).
 */
export async function apnsProviderToken(c: ApnsCredentials, now: number = Date.now(), force: boolean | string = false): Promise<string> {
  const cacheKey = `${c.teamId}\u0000${c.keyId}\u0000${c.key}`;
  const hit = providerTokens.get(cacheKey);
  const fresh = !!hit && now - hit.issuedAt < APNS_TOKEN_REFRESH_MS && now >= hit.issuedAt;
  const refresh = force === true || (typeof force === "string" && hit?.token === force);
  if (fresh && !refresh) return hit!.token;
  const pending = signing.get(cacheKey);
  if (pending) return pending;
  const p = (async () => {
    const key = await importSigningKey(c.key, "ES256");
    const token = await signJwt("ES256", key, { iss: c.teamId, iat: Math.floor(now / 1000) }, { kid: c.keyId });
    providerTokens.set(cacheKey, { token, issuedAt: now });
    return token;
  })().finally(() => signing.delete(cacheKey));
  signing.set(cacheKey, p);
  return p;
}

/** Forgets cached provider tokens (tests; after rotating a key). */
export function clearApnsTokenCache(): void {
  providerTokens.clear();
  signing.clear();
}

type PushType = "alert" | "background" | "voip";

export function apnsPushType(m: AddressedPushMessage): PushType {
  if (m.voip) return "voip";
  if (m.sealed) return "alert";
  const visible = !!(m.title || m.subtitle || m.body || m.sound || m.badge !== undefined);
  return !visible && m.contentAvailable ? "background" : "alert";
}

/**
 * The JSON body for one message. Custom `data` goes under `body`, where expo-notifications reads it on iOS
 * (`notification.request.content.data`). A sealed message carries only the fallback text, `mutable-content` (so the
 * Notification Service Extension runs) and the envelope under `ember`.
 */
export function apnsPayload(m: AddressedPushMessage, fallback: PushFallback = DEFAULT_PUSH_FALLBACK): Record<string, unknown> {
  if (m.voip) {
    const out: Record<string, unknown> = { aps: {} };
    if (m.sealed) out.ember = m.sealed;
    else if (m.data) out.body = m.data;
    return out;
  }
  const aps: Record<string, unknown> = {};
  if (m.sealed) {
    const alert: Record<string, string> = {};
    if (fallback.titleLocKey) alert["title-loc-key"] = fallback.titleLocKey;
    else if (fallback.title) alert.title = fallback.title;
    if (fallback.locKey) alert["loc-key"] = fallback.locKey;
    else if (fallback.body) alert.body = fallback.body;
    aps.alert = alert;
    aps["mutable-content"] = 1;
  } else {
    const alert: Record<string, string> = {};
    if (m.title) alert.title = m.title;
    if (m.subtitle) alert.subtitle = m.subtitle;
    if (m.body) alert.body = m.body;
    if (Object.keys(alert).length) aps.alert = alert;
    if (m.mutableContent) aps["mutable-content"] = 1;
  }
  if (m.sound) aps.sound = m.sound;
  if (m.badge !== undefined) aps.badge = m.badge;
  if (m.threadId) aps["thread-id"] = m.threadId;
  if (m.categoryId) aps.category = m.categoryId;
  if (m.contentAvailable) aps["content-available"] = 1;
  const level = resolveInterruptionLevel(m);
  if (level && aps.alert) aps["interruption-level"] = level;
  const out: Record<string, unknown> = { aps };
  if (m.sealed) out.ember = m.sealed;
  else if (m.data) out.body = m.data;
  return out;
}

/** The request headers for one message (without `authorization`). */
export function apnsHeaders(m: AddressedPushMessage, topic: string, nowMs: number): Record<string, string> {
  const type = apnsPushType(m);
  const ttl = resolveTtlSeconds(m);
  // Background pushes must go at priority 5 (APNs refuses 10 for them).
  const priority = type === "background" || resolveUrgency(m) === "low" ? "5" : "10";
  const h: Record<string, string> = {
    "content-type": "application/json",
    "apns-topic": type === "voip" ? `${topic}.voip` : topic,
    "apns-push-type": type,
    "apns-priority": priority,
    "apns-expiration": ttl === 0 ? "0" : String(Math.floor(nowMs / 1000) + ttl),
  };
  if (m.collapseId) h["apns-collapse-id"] = m.collapseId;
  return h;
}

interface Attempt {
  status: number;
  reason?: string;
  id?: string;
}

/**
 * Sends each message as its own request (APNs has no batch API), `concurrency` at a time. Never throws for message
 * failures: they come back as error tickets with Ember's codes (`DeviceNotRegistered` for `Unregistered`, `ExpiredToken`
 * and `BadDeviceToken`, which callers prune). A device with no recorded environment that gets `BadDeviceToken` is
 * tried once on the other host; when that works, its ticket says which `environment` it was.
 */
export async function sendApns(messages: AddressedPushMessage[], o: ApnsOptions): Promise<PushTicket[]> {
  const fetchFn = (o.fetch ?? globalThis.fetch)?.bind(globalThis);
  if (!fetchFn) throw new Error("@freecorps/ember-push: no fetch available; pass options.fetch");
  const now = o.now ?? Date.now;
  const urlFor = (env: ApnsEnvironment) => (env === "sandbox" ? (o.sandboxUrl ?? APNS_SANDBOX_URL) : (o.productionUrl ?? APNS_PRODUCTION_URL));

  const attempt = async (m: AddressedPushMessage, env: ApnsEnvironment, body: string): Promise<Attempt> => {
    let refreshed = false;
    let stale: string | false = false;
    for (;;) {
      const jwt = await apnsProviderToken(o, now(), stale);
      const res = await fetchWithRetry(
        fetchFn,
        `${urlFor(env)}/3/device/${m.to}`,
        () => ({ method: "POST", headers: { ...apnsHeaders(m, o.topic, now()), authorization: `bearer ${jwt}` }, body }),
        o,
      );
      const id = res.headers.get("apns-id") ?? undefined;
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        return { status: res.status, ...(id ? { id } : {}) };
      }
      let reason: string | undefined;
      try {
        reason = ((await res.json()) as { reason?: string })?.reason;
      } catch {
        reason = undefined;
      }
      if (reason === "ExpiredProviderToken" && !refreshed) {
        refreshed = true;
        stale = jwt;
        continue;
      }
      if (reason === "InvalidProviderToken") clearApnsTokenCache(); // a fixed secret is picked up on the next send
      return { status: res.status, ...(reason ? { reason } : {}), ...(id ? { id } : {}) };
    }
  };

  const sendOne = async (m: AddressedPushMessage): Promise<PushTicket> => {
    if (!isApnsToken(m.to)) return { token: String(m.to), status: "error", error: "InvalidToken", message: "not an APNs device token (hex)" };
    if (m.collapseId && byteLength(m.collapseId) > 64) return { token: m.to, status: "error", error: "RequestFailed", message: "collapseId is over 64 bytes (APNs BadCollapseId)" };
    const body = JSON.stringify(apnsPayload(m, o.fallback));
    const limit = m.voip ? APNS_VOIP_MAX_PAYLOAD : APNS_MAX_PAYLOAD;
    if (byteLength(body) > limit) return { token: m.to, status: "error", error: "MessageTooBig", message: `APNs payload over ${limit} bytes` };
    const env = m.environment ?? o.environment ?? "production";
    let r: Attempt;
    let usedEnv = env;
    try {
      r = await attempt(m, env, body);
      if (!m.environment && r.reason === "BadDeviceToken") {
        const other: ApnsEnvironment = env === "production" ? "sandbox" : "production";
        const second = await attempt(m, other, body);
        if (second.status === 200 || second.reason !== "BadDeviceToken") {
          r = second;
          usedEnv = other;
        }
      }
    } catch (e) {
      // A bad .p8 (importSigningKey) is the configuration's fault, not the network's.
      const err = e as Error & { credentials?: boolean };
      if (err.credentials) return { token: m.to, status: "error", error: "InvalidCredentials", message: `APNs key: ${err.message}` };
      return { token: m.to, status: "error", error: "RequestFailed", message: `APNs unreachable: ${err.message}` };
    }
    if (r.status === 200) {
      const ticket: PushTicket = { token: m.to, status: "ok", id: r.id ?? "" };
      if (!m.environment && usedEnv !== env) ticket.environment = usedEnv;
      return ticket;
    }
    return { token: m.to, status: "error", error: apnsErrorCode(r.status, r.reason), message: `APNs ${r.status} ${r.reason ?? ""}`.trim() };
  };

  return mapLimit(messages, o.concurrency ?? 10, sendOne);
}

/** Direct APNs as a `PushProvider`. No receipts: APNs answers each request synchronously. */
export function apnsPushProvider(o: ApnsOptions): PushProvider {
  return { name: "apns", isToken: isApnsToken, send: (messages) => sendApns(messages, o) };
}
