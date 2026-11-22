/**
 * Session lookup between Ember and the app it is moving from (PLAN §22 L14, contracts.md "Auth"). While users still
 * sign in on the origin backend, Ember accepts its JWTs (`remoteAuth`, JWKS), but a `sensitive` function needs to know
 * whether the session behind the JWT is still alive. Ember then asks the origin:
 *
 *   POST <url>
 *   content-type: application/json
 *   x-ember-signature: t=<ms since epoch>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
 *   {"sid":"<session id>","sub":"<user id>"}
 *
 *   200 {"active":true|false,"expiresAt"?:<ms>,"revokedAt"?:<ms>}
 *
 * This module is the origin's side too (`@freecorps/ember-auth/session-lookup`): `verifySessionLookupRequest` checks the
 * signature and the clock skew. Pure WebCrypto and `Request`, no other import: it runs in Workers, Node 20+, Deno, Bun
 * and Convex `httpAction`s.
 *
 *   // in the origin app: an HTTP endpoint that checks the session id in its own session table
 *   export async function handle(request: Request): Promise<Response> {
 *     const q = await verifySessionLookupRequest(request, process.env.SESSION_LOOKUP_SECRET!);
 *     if (!q.ok) return new Response(q.reason, { status: q.status });
 *     const session = await db.sessions.get(q.sid); // the app's own lookup
 *     const active = !!session && session.userId === q.sub && session.expiresAt > Date.now();
 *     return Response.json({ active, ...(session ? { expiresAt: session.expiresAt } : {}) });
 *   }
 */

/** Header carrying the timestamp and signature. */
export const SESSION_LOOKUP_HEADER = "x-ember-signature";
/** Default name of the shared secret on both sides (`ember env set SESSION_LOOKUP_SECRET`). */
export const SESSION_LOOKUP_SECRET_ENV = "SESSION_LOOKUP_SECRET";
/** Largest accepted difference between the request's timestamp and the origin's clock (5 minutes). */
export const SESSION_LOOKUP_MAX_SKEW_MS = 5 * 60_000;

/** What Ember asks. */
export interface SessionLookupQuery {
  sid: string;
  sub: string;
}

/** What the origin answers. `active: true` is the only answer that lets a `sensitive` function run. */
export interface SessionLookupAnswer {
  active: boolean;
  /** ms since epoch: when the session ends (a past value counts as inactive). */
  expiresAt?: number;
  /** ms since epoch: when the session was revoked (any value counts as inactive). */
  revokedAt?: number;
}

export type SessionLookupVerdict =
  | ({ ok: true; t: number } & SessionLookupQuery)
  | { ok: false; status: 400 | 401 | 405; reason: "method" | "signature" | "skew" | "body" };

const enc = new TextEncoder();

const subtle = (): SubtleCrypto => {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s) throw new Error("session lookup: WebCrypto (globalThis.crypto.subtle) is not available in this runtime");
  return s;
};

/** Imported keys per (usage, secret): a lookup signs or verifies with the same secret every time. A failed import is not kept. */
const keys = new Map<string, Promise<CryptoKey>>();
const hmacKey = (secret: string, usage: "sign" | "verify"): Promise<CryptoKey> => {
  const k = `${usage}\u0000${secret}`;
  let key = keys.get(k);
  if (!key) {
    if (keys.size >= 16) keys.clear();
    key = subtle().importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
    keys.set(k, key);
    key.catch(() => keys.delete(k));
  }
  return key;
};

const toHex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

const fromHex = (s: string): Uint8Array | null => {
  if (s.length % 2 || !/^[0-9a-f]*$/i.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** `t=<ms>,v1=<hex>` for `body` at time `t` (Ember's side; exported for tests and other callers). */
export async function signSessionLookup(body: string, secret: string, t: number = Date.now()): Promise<string> {
  const mac = await subtle().sign("HMAC", await hmacKey(secret, "sign"), enc.encode(`${t}.${body}`));
  return `t=${t},v1=${toHex(mac)}`;
}

/** Parses `t=<ms>,v1=<hex>[,v1=<hex>...]`. */
function parseHeader(h: string): { t: number; sigs: Uint8Array[] } | null {
  let t: number | null = null;
  const sigs: Uint8Array[] = [];
  for (const part of h.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,16}$/.test(v)) t = Number(v);
    else if (k === "v1") {
      const b = fromHex(v);
      if (b && b.length === 32) sigs.push(b);
    }
  }
  return t === null || !sigs.length ? null : { t, sigs };
}

/**
 * The origin's check of a lookup request: method POST, a valid `x-ember-signature` for one of `secret` (an array
 * allows rotating it: the new and the old one), a timestamp within `maxSkewMs` of now, and a JSON body
 * `{ sid, sub }` of strings. Reads the request body. On failure the verdict carries the status to answer.
 *
 * A captured request can be replayed within the skew window; it only ever asks whether a session is alive.
 */
export async function verifySessionLookupRequest(
  request: Request,
  secret: string | readonly string[],
  opts: { now?: number; maxSkewMs?: number } = {},
): Promise<SessionLookupVerdict> {
  if (request.method !== "POST") return { ok: false, status: 405, reason: "method" };
  const secrets = (typeof secret === "string" ? [secret] : [...secret]).filter((s) => typeof s === "string" && s.length > 0);
  if (!secrets.length) throw new Error("verifySessionLookupRequest: the shared secret is empty");
  const parsed = parseHeader(request.headers.get(SESSION_LOOKUP_HEADER) ?? "");
  if (!parsed) return { ok: false, status: 401, reason: "signature" };
  const now = opts.now ?? Date.now();
  if (Math.abs(now - parsed.t) > (opts.maxSkewMs ?? SESSION_LOOKUP_MAX_SKEW_MS)) return { ok: false, status: 401, reason: "skew" };
  const body = await request.text();
  const signed = enc.encode(`${parsed.t}.${body}`);
  let valid = false;
  // subtle.verify compares in constant time.
  for (const s of secrets) {
    const key = await hmacKey(s, "verify");
    for (const sig of parsed.sigs) if (await subtle().verify("HMAC", key, sig, signed)) valid = true;
  }
  if (!valid) return { ok: false, status: 401, reason: "signature" };
  let q: unknown;
  try {
    q = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, reason: "body" };
  }
  const o = q as Partial<SessionLookupQuery> | null;
  if (!o || typeof o !== "object" || typeof o.sid !== "string" || !o.sid || typeof o.sub !== "string" || !o.sub) return { ok: false, status: 400, reason: "body" };
  return { ok: true, t: parsed.t, sid: o.sid, sub: o.sub };
}

/** Reads an origin's answer: anything but a well-formed `{ active: boolean }` is null (Ember then fails closed). */
export function parseSessionLookupAnswer(x: unknown): SessionLookupAnswer | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.active !== "boolean") return null;
  const a: SessionLookupAnswer = { active: o.active };
  if (typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt)) a.expiresAt = o.expiresAt;
  if (typeof o.revokedAt === "number" && Number.isFinite(o.revokedAt)) a.revokedAt = o.revokedAt;
  return a;
}

/** Whether an answer lets a sensitive function run at `now`: active, not expired, not revoked. */
export function isSessionAlive(a: SessionLookupAnswer, now: number = Date.now()): boolean {
  return a.active === true && a.revokedAt === undefined && (a.expiresAt === undefined || a.expiresAt > now);
}
