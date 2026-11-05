/**
 * Direct FCM sender (HTTP v1 API), written for Ember from Google's documentation ("Authorize send requests",
 * "Using OAuth 2.0 for Server to Server Applications", "FCM HTTP v1 API" and its `FcmError` codes). Behaviour matches
 * Freecorps Brigade's relay as its README describes it (access token kept until 5 minutes before it expires and
 * refetched on a 401; `UNREGISTERED` drops the device, `SENDER_ID_MISMATCH` does not; data-only messages for sealed
 * pushes); no code is taken from the relay (AGPL).
 *
 * FCM speaks HTTP/1.1, so unlike APNs this also works from local workerd (`ember dev`).
 */
import { DEFAULT_PUSH_FALLBACK, byteLength, fetchWithRetry, mapLimit, resolveTtlSeconds, resolveUrgency, type RetryOptions } from "./delivery.ts";
import { isExpoPushToken } from "./expo.ts";
import { importSigningKey, signJwt } from "./jwt.ts";
import type { AddressedPushMessage, PushErrorCode, PushFallback, PushProvider, PushTicket } from "./types.ts";

export const FCM_SEND_URL = (projectId: string) => `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** FCM's own limits: 4096 bytes of message payload, TTL at most 28 days. */
export const FCM_MAX_PAYLOAD = 4096;
export const FCM_MAX_TTL_SECONDS = 28 * 24 * 3600;
/** An access token is refetched this long before it expires. */
export const FCM_TOKEN_MARGIN_MS = 5 * 60_000;

/** The fields of a Google service-account JSON key that sending needs. */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

export interface FcmOptions extends RetryOptions {
  /** The service account's JSON key: the file's text (as kept in a secret) or the parsed object. */
  serviceAccount: string | ServiceAccount;
  /** Endpoint overrides (tests, proxies). The token URL defaults to the key's `token_uri`. */
  sendUrl?: string;
  tokenUrl?: string;
  /** Text shown for sealed pushes when the app cannot decrypt (sent in clear as `fallbackTitle`/`fallbackBody`). */
  fallback?: PushFallback;
  /** Requests in flight at once (default 10). */
  concurrency?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Parses and checks a service-account key; throws a message naming what is missing (never echoing the key). */
export function parseServiceAccount(value: string | ServiceAccount): ServiceAccount {
  let sa: unknown = value;
  if (typeof value === "string") {
    try {
      sa = JSON.parse(value);
    } catch {
      throw new Error("FCM service account is not valid JSON (expected the key file's contents)");
    }
  }
  const o = sa as Record<string, unknown>;
  const missing = ["project_id", "client_email", "private_key"].filter((k) => typeof o?.[k] !== "string" || !o[k]);
  if (missing.length) throw new Error(`FCM service account is missing ${missing.join(", ")}`);
  return o as unknown as ServiceAccount;
}

/** A registration token as `getDevicePushTokenAsync` returns it on Android. */
export function isFcmToken(token: unknown): token is string {
  return typeof token === "string" && /^[\w\-:.]{20,4096}$/.test(token) && !isExpoPushToken(token);
}

/** FCM's error codes (`google.firebase.fcm.v1.FcmError`, falling back to the HTTP status) → Ember's codes. */
export function fcmErrorCode(status: number, errorCode: string | undefined): PushErrorCode {
  switch (errorCode) {
    case "UNREGISTERED":
      return "DeviceNotRegistered";
    case "SENDER_ID_MISMATCH":
      return "MismatchSenderId";
    case "QUOTA_EXCEEDED":
      return "MessageRateExceeded";
    case "THIRD_PARTY_AUTH_ERROR":
      return "InvalidCredentials";
    case "INVALID_ARGUMENT":
      // Also a malformed token, but just as often a bad payload: never prune on it.
      return "InvalidArgument";
  }
  if (status === 401 || status === 403) return "InvalidCredentials";
  if (status === 429) return "MessageRateExceeded";
  return "RequestFailed";
}

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

/** Forgets cached access tokens (tests; after rotating a key). */
export function clearFcmTokenCache(): void {
  accessTokens.clear();
  inFlight.clear();
}

/**
 * An OAuth access token for the service account (scope `firebase.messaging`): an RS256 assertion exchanged at the
 * token endpoint, cached per isolate until `FCM_TOKEN_MARGIN_MS` before it expires.
 */
export async function fcmAccessToken(o: FcmOptions, force = false): Promise<string> {
  const sa = parseServiceAccount(o.serviceAccount);
  const now = (o.now ?? Date.now)();
  const tokenUrl = o.tokenUrl ?? sa.token_uri ?? GOOGLE_TOKEN_URL;
  const cacheKey = `${sa.client_email}\u0000${sa.private_key_id ?? ""}\u0000${tokenUrl}`;
  const hit = accessTokens.get(cacheKey);
  if (!force && hit && now < hit.expiresAt - FCM_TOKEN_MARGIN_MS) return hit.token;
  // Concurrent sends share one exchange instead of each fetching a token.
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;
  const p = exchange(o, sa, tokenUrl, now).then(
    (t) => {
      accessTokens.set(cacheKey, t);
      return t.token;
    },
  );
  inFlight.set(cacheKey, p);
  try {
    return await p;
  } finally {
    inFlight.delete(cacheKey);
  }
}

const inFlight = new Map<string, Promise<string>>();

async function exchange(o: FcmOptions, sa: ServiceAccount, tokenUrl: string, now: number): Promise<{ token: string; expiresAt: number }> {
  const key = await importSigningKey(sa.private_key, "RS256");
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt("RS256", key, { iss: sa.client_email, scope: FCM_SCOPE, aud: tokenUrl, iat, exp: iat + 3600 }, sa.private_key_id ? { kid: sa.private_key_id } : {});
  const fetchFn = (o.fetch ?? globalThis.fetch).bind(globalThis);
  const res = await fetchWithRetry(
    fetchFn,
    tokenUrl,
    () => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    }),
    o,
  );
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw Object.assign(new Error(`Google token endpoint: ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim()), { credentials: res.status === 400 || res.status === 401 });
  }
  return { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
}

/**
 * The v1 `message` for one push. In clear: a `notification` (title/body; the system shows it while the app is in the
 * background) and `data.body` = JSON of `data`, where expo-notifications reads it on Android. Sealed: a data-only
 * message, `{ ember: <envelope JSON>, fallbackTitle, fallbackBody, channelId?, tag? }`, which the app's background
 * task decrypts and shows (`@freecorps/ember-expo-push`). Background (`contentAvailable` with nothing to show): data only.
 */
export function fcmMessage(m: AddressedPushMessage, fallback: PushFallback = DEFAULT_PUSH_FALLBACK): Record<string, unknown> {
  const urgency = resolveUrgency(m);
  const ttl = Math.min(FCM_MAX_TTL_SECONDS, resolveTtlSeconds(m));
  const android: Record<string, unknown> = { priority: urgency === "low" ? "NORMAL" : "HIGH", ttl: `${ttl}s` };
  if (m.collapseId) android.collapse_key = m.collapseId;
  const message: Record<string, unknown> = { token: m.to, android };
  if (m.sealed) {
    const data: Record<string, string> = { ember: JSON.stringify(m.sealed), urgency };
    if (fallback.title) data.fallbackTitle = fallback.title;
    if (fallback.body) data.fallbackBody = fallback.body;
    if (m.channelId) data.channelId = m.channelId;
    if (m.collapseId) data.tag = m.collapseId;
    message.data = data;
    return message;
  }
  if (m.title || m.body) {
    const notification: Record<string, string> = {};
    if (m.title) notification.title = m.title;
    if (m.body) notification.body = m.body;
    message.notification = notification;
    const an: Record<string, unknown> = {};
    if (m.channelId) an.channel_id = m.channelId;
    if (m.sound) an.sound = m.sound;
    if (m.collapseId) an.tag = m.collapseId;
    if (m.badge !== undefined) an.notification_count = m.badge;
    if (Object.keys(an).length) android.notification = an;
  }
  if (m.data) message.data = { body: JSON.stringify(m.data) };
  return message;
}

/**
 * Sends each message as its own v1 request, `concurrency` at a time. Never throws for message failures: they come
 * back as error tickets (`DeviceNotRegistered` for `UNREGISTERED`, which callers prune). A broken service account
 * fails every message with `InvalidCredentials`.
 */
export async function sendFcm(messages: AddressedPushMessage[], o: FcmOptions): Promise<PushTicket[]> {
  const fetchFn = (o.fetch ?? globalThis.fetch)?.bind(globalThis);
  if (!fetchFn) throw new Error("@freecorps/ember-push: no fetch available; pass options.fetch");
  let sa: ServiceAccount;
  try {
    sa = parseServiceAccount(o.serviceAccount);
  } catch (e) {
    return messages.map((m) => ({ token: String(m.to), status: "error", error: "InvalidCredentials", message: (e as Error).message }));
  }
  const url = o.sendUrl ?? FCM_SEND_URL(sa.project_id);

  const sendOne = async (m: AddressedPushMessage): Promise<PushTicket> => {
    if (!isFcmToken(m.to)) return { token: String(m.to), status: "error", error: "InvalidToken", message: "not an FCM registration token" };
    const message = fcmMessage(m, o.fallback);
    const body = JSON.stringify({ message });
    if (byteLength(JSON.stringify({ n: message.notification, d: message.data })) > FCM_MAX_PAYLOAD) {
      return { token: m.to, status: "error", error: "MessageTooBig", message: `FCM payload over ${FCM_MAX_PAYLOAD} bytes` };
    }
    let refreshed = false;
    try {
      for (;;) {
        const access = await fcmAccessToken(o, refreshed);
        const res = await fetchWithRetry(fetchFn, url, () => ({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${access}` }, body }), o);
        const json = (await res.json().catch(() => ({}))) as { name?: string; error?: { status?: string; message?: string; details?: Array<{ "@type"?: string; errorCode?: string }> } };
        if (res.ok) return { token: m.to, status: "ok", id: json.name ?? "" };
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          continue;
        }
        const errorCode = json.error?.details?.find((d) => d.errorCode)?.errorCode ?? json.error?.status;
        return { token: m.to, status: "error", error: fcmErrorCode(res.status, errorCode), message: `FCM ${res.status} ${errorCode ?? ""}: ${json.error?.message ?? ""}`.trim() };
      }
    } catch (e) {
      const err = e as Error & { credentials?: boolean };
      return { token: m.to, status: "error", error: err.credentials ? "InvalidCredentials" : "RequestFailed", message: err.message.startsWith("Google") ? err.message : `FCM unreachable: ${err.message}` };
    }
  };

  return mapLimit(messages, o.concurrency ?? 10, sendOne);
}

/** Direct FCM as a `PushProvider`. No receipts: FCM answers each request synchronously. */
export function fcmPushProvider(o: FcmOptions): PushProvider {
  return { name: "fcm", isToken: isFcmToken, send: (messages) => sendFcm(messages, o) };
}
