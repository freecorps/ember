/**
 * Fake APNs and FCM endpoints as `fetch` functions. They check what the real services check (provider token or OAuth
 * access token, path, required headers) and answer per device token: a token containing "dead" is `Unregistered`
 * (APNs 410) / `UNREGISTERED` (FCM 404); "bad" is APNs `BadDeviceToken`; "busy" gets one 429 / 503 then succeeds;
 * "topic" is `DeviceTokenNotForTopic`; "sender" is FCM `SENDER_ID_MISMATCH`; "sandbox" tokens exist only on the APNs
 * sandbox host.
 */
import { decodeJwt, verifyJwt } from "../src/jwt.ts";

export interface FakeRequest {
  url: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

const headersOf = (init?: RequestInit) => {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (out[k] = v));
  return out;
};

export function fakeApns(opts: { publicKey: CryptoKey; teamId: string; keyId: string; topic: string; expiredOnce?: boolean }) {
  const requests: FakeRequest[] = [];
  const seen = new Map<string, number>();
  let expired = !!opts.expiredOnce;
  const json = (status: number, body: unknown, id = crypto.randomUUID()) => new Response(JSON.stringify(body), { status, headers: { "apns-id": id } });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = headersOf(init);
    const body = JSON.parse(String(init?.body));
    requests.push({ url: url.href, host: url.host, path: url.pathname, headers, body });
    const token = url.pathname.replace(/^\/3\/device\//, "");
    const auth = headers.authorization ?? "";
    if (!auth.startsWith("bearer ")) return json(403, { reason: "MissingProviderToken" });
    const jwt = auth.slice(7);
    const { header, claims } = decodeJwt(jwt);
    if (header.kid !== opts.keyId || claims.iss !== opts.teamId || !(await verifyJwt(jwt, "ES256", opts.publicKey))) return json(403, { reason: "InvalidProviderToken" });
    if (expired) {
      expired = false;
      return json(403, { reason: "ExpiredProviderToken" });
    }
    const topic = headers["apns-topic"];
    if (!topic) return json(400, { reason: "MissingTopic" });
    if (topic !== opts.topic && topic !== `${opts.topic}.voip`) return json(400, { reason: "TopicDisallowed" });
    if (!["alert", "background", "voip"].includes(headers["apns-push-type"] ?? "")) return json(400, { reason: "InvalidPushType" });
    if (!["5", "10"].includes(headers["apns-priority"] ?? "")) return json(400, { reason: "BadPriority" });
    const isSandbox = url.host.includes("sandbox");
    if (token.includes("dead")) return json(410, { reason: "Unregistered", timestamp: Date.now() });
    if (token.includes("bad") || (token.includes("5a2db0c5") && !isSandbox)) return json(400, { reason: "BadDeviceToken" });
    if (token.includes("70b1c")) return json(400, { reason: "DeviceTokenNotForTopic" });
    if (token.includes("b05e")) {
      const n = (seen.get(token) ?? 0) + 1;
      seen.set(token, n);
      if (n === 1) return new Response(JSON.stringify({ reason: "TooManyRequests" }), { status: 429, headers: { "retry-after": "1" } });
    }
    return new Response(null, { status: 200, headers: { "apns-id": `apns-${token.slice(0, 8)}`, "apns-unique-id": crypto.randomUUID() } });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/** Hex APNs-style tokens with a marker: `hexToken("dead")` contains "dead", which the fake answers `Unregistered`. */
export const APNS_MARKERS = { ok: "0000", dead: "dead", bad: "0bad", sandbox: "5a2db0c5", topic: "70b1c", busy: "b05e" } as const;
export function hexToken(kind: keyof typeof APNS_MARKERS, n = 0): string {
  const m = APNS_MARKERS[kind];
  return (m + n.toString(16).padStart(4, "0")).padEnd(64, "0");
}

export function fakeFcm(opts: { publicKey: CryptoKey; clientEmail: string; projectId: string; tokenUri?: string; tokenTtl?: number; revokeOnce?: boolean }) {
  const requests: FakeRequest[] = [];
  const issued = new Set<string>();
  const seen = new Map<string, number>();
  let tokenCalls = 0;
  let revoke = !!opts.revokeOnce;
  const tokenUri = opts.tokenUri ?? "https://oauth2.googleapis.com/token";
  const err = (code: number, status: string, errorCode?: string, message = status) =>
    new Response(JSON.stringify({ error: { code, status, message, ...(errorCode ? { details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] } : {}) } }), {
      status: code,
      headers: { "content-type": "application/json" },
    });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = headersOf(init);
    if (url.href === tokenUri) {
      tokenCalls++;
      const form = new URLSearchParams(String(init?.body));
      requests.push({ url: url.href, host: url.host, path: url.pathname, headers, body: Object.fromEntries(form) });
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      const assertion = form.get("assertion") ?? "";
      const { claims } = decodeJwt(assertion);
      const now = Math.floor(Date.now() / 1000);
      const ok =
        (await verifyJwt(assertion, "RS256", opts.publicKey)) &&
        claims.iss === opts.clientEmail &&
        claims.aud === tokenUri &&
        claims.scope === "https://www.googleapis.com/auth/firebase.messaging" &&
        typeof claims.iat === "number" &&
        typeof claims.exp === "number" &&
        (claims.exp as number) - (claims.iat as number) <= 3600 &&
        Math.abs((claims.iat as number) - now) < 600;
      if (!ok) return Response.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 });
      const access = `ya29.fake-${tokenCalls}`;
      issued.add(access);
      return Response.json({ access_token: access, expires_in: opts.tokenTtl ?? 3599, token_type: "Bearer" });
    }
    const body = JSON.parse(String(init?.body));
    requests.push({ url: url.href, host: url.host, path: url.pathname, headers, body });
    if (url.pathname !== `/v1/projects/${opts.projectId}/messages:send`) return err(404, "NOT_FOUND");
    const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
    if (!issued.has(bearer)) return err(401, "UNAUTHENTICATED");
    if (revoke) {
      revoke = false;
      issued.delete(bearer);
      return err(401, "UNAUTHENTICATED");
    }
    const token: string = body.message?.token ?? "";
    if (!token) return err(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT", "token missing");
    if (body.message.data && Object.values(body.message.data).some((v) => typeof v !== "string")) return err(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT", "data values must be strings");
    if (token.includes("dead")) return err(404, "NOT_FOUND", "UNREGISTERED", "Requested entity was not found.");
    if (token.includes("sender")) return err(403, "PERMISSION_DENIED", "SENDER_ID_MISMATCH", "SenderId mismatch");
    if (token.includes("busy")) {
      const n = (seen.get(token) ?? 0) + 1;
      seen.set(token, n);
      if (n === 1) return err(503, "UNAVAILABLE", "UNAVAILABLE");
    }
    return Response.json({ name: `projects/${opts.projectId}/messages/${token.slice(0, 6)}-${requests.length}` });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests, tokenCalls: () => tokenCalls };
}
