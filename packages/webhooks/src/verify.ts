// `@freecorps/ember-webhooks/verify`: Standard Webhooks signatures (https://www.standardwebhooks.com), with WebCrypto
// only and no other import, so a receiver (a Worker, Node ≥ 20, Deno, Bun, a browser) can verify what Ember sends.
//
//   webhook-id:        msg_...                       (the same on every attempt and replay: dedupe on it)
//   webhook-timestamp: 1714000000                    (seconds, the attempt's time)
//   webhook-signature: v1,<base64 HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)> [v1,<...> ...]
//
// The secret is `whsec_<base64>` (the HMAC key is the decoded bytes). During a rotation the sender signs with every
// active secret, space-separated in the one `webhook-signature` header: a receiver holding either secret verifies.

export const SECRET_PREFIX = "whsec_";
/** Default tolerance between `webhook-timestamp` and the receiver's clock (seconds), as the Standard Webhooks libraries. */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
}

const enc = new TextEncoder();

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The HMAC key bytes of a secret (`whsec_<base64>`; without the prefix, the whole string is base64). */
export function secretKey(secret: string): Uint8Array {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  try {
    const k = b64decode(raw);
    if (!k.length) throw new Error("empty");
    return k;
  } catch {
    throw new WebhookVerificationError("the webhook secret is not base64 (expected whsec_<base64>)");
  }
}

/** A new secret: `whsec_` + 24 random bytes (WebCrypto's CSPRNG), base64. */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + b64encode(crypto.getRandomValues(new Uint8Array(24)));
}

const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    // A failed import is not cached (the next call tries again).
    k = crypto.subtle.importKey("raw", secretKey(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]).catch((e: unknown) => {
      keys.delete(secret);
      throw e;
    });
    if (keys.size > 256) keys.clear();
    keys.set(secret, k);
  }
  return k;
}

/** The base64 HMAC-SHA256 of `id.timestamp.body` (the part after `v1,`). */
async function mac(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const m = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${id}.${timestamp}.${body}`) as BufferSource);
  return b64encode(new Uint8Array(m));
}

/** `v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>`. `timestamp` in seconds. */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  return `v1,${await mac(secret, id, timestamp, body)}`;
}

/** The three headers of a delivery, signed with each of `secrets` (newest first), space-separated. */
export async function webhookHeaders(secrets: readonly string[], id: string, timestamp: number, body: string): Promise<Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string>> {
  if (!secrets.length) throw new WebhookVerificationError("no secret to sign with");
  const sigs = await Promise.all(secrets.map((s) => signWebhook(s, id, timestamp, body)));
  return { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": sigs.join(" ") };
}

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(h: HeaderBag, name: string): string | undefined {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  const bag = h as Record<string, string | string[] | undefined>;
  const key = Object.keys(bag).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : bag[key];
  return Array.isArray(v) ? v.join(" ") : v;
}

/** Constant-time comparison of two strings (same length leaks nothing about where they differ). */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export interface VerifyOptions {
  /** Max distance between `webhook-timestamp` and now, in seconds (default 300). */
  toleranceSeconds?: number;
  /** The receiver's clock, ms (default `Date.now()`). */
  now?: number;
}

/**
 * Verifies a delivery: the three headers are present, the timestamp is within the tolerance, and one of the
 * `webhook-signature` entries is the HMAC of `id.timestamp.body` with `secret` (or any of `secrets`, during your own
 * rotation). Returns the parsed JSON body; throws `WebhookVerificationError` otherwise. Pass the raw body text, as
 * received (re-serialized JSON does not verify).
 */
export async function verifyWebhook<T = unknown>(secret: string | readonly string[], headers: HeaderBag, body: string, opts: VerifyOptions = {}): Promise<T> {
  const id = header(headers, "webhook-id");
  const ts = header(headers, "webhook-timestamp");
  const sig = header(headers, "webhook-signature");
  if (!id || !ts || !sig) throw new WebhookVerificationError("missing webhook-id, webhook-timestamp or webhook-signature");
  const t = Number(ts);
  if (!/^\d+$/.test(ts) || !Number.isSafeInteger(t)) throw new WebhookVerificationError("invalid webhook-timestamp");
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (now - t > tolerance) throw new WebhookVerificationError("webhook-timestamp too old");
  if (t - now > tolerance) throw new WebhookVerificationError("webhook-timestamp too new");
  // The `v1` entries' signatures (other versions are skipped); compared without the version prefix.
  const given = sig.split(" ").filter(Boolean).flatMap((s) => {
    const comma = s.indexOf(",");
    return comma > 0 && s.slice(0, comma) === "v1" ? [s.slice(comma + 1)] : [];
  });
  for (const s of typeof secret === "string" ? [secret] : secret) {
    const want = await mac(s, id, t, body);
    if (given.some((g) => equal(g, want))) return JSON.parse(body) as T;
  }
  throw new WebhookVerificationError("no matching signature");
}
