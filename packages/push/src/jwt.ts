/**
 * Compact JWS signing on WebCrypto, for the two tokens direct push needs (RFC 7515/7518):
 *
 * - **ES256** — the APNs provider token, signed with the `.p8` key from Apple (a PKCS#8 P-256 key). WebCrypto's ECDSA
 *   signature is already the raw `r ‖ s` (64 bytes) that JWS wants, so no DER conversion.
 * - **RS256** — the assertion Google's OAuth token endpoint exchanges for an FCM access token, signed with the
 *   service account's `private_key` (PKCS#8 RSA).
 *
 * Written for Ember from the RFCs and Apple/Google documentation; no Node APIs, so it runs in Workers.
 */
import { fromBase64url, toBase64url } from "./base64url.ts";

export type JwtAlgorithm = "ES256" | "RS256";

const ALGORITHMS = {
  ES256: { importParams: { name: "ECDSA", namedCurve: "P-256" }, signParams: { name: "ECDSA", hash: "SHA-256" } },
  RS256: { importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, signParams: { name: "RSASSA-PKCS1-v1_5" } },
} as const;

const encoder = new TextEncoder();

/**
 * The DER bytes of a PEM `PRIVATE KEY` (PKCS#8), the form of an Apple `.p8` file and of a Google service account's
 * `private_key`. Tolerates what secrets go through: `\n` written as two characters, `\r\n`, surrounding whitespace and
 * quotes. Throws for an encrypted or non-PKCS#8 key (`BEGIN EC PRIVATE KEY`, `BEGIN RSA PRIVATE KEY`).
 */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const text = pem.trim().replace(/^"|"$/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!m) throw new Error("not a PEM key (expected -----BEGIN PRIVATE KEY-----)");
  if (m[1] !== "PRIVATE KEY") throw new Error(`expected a PKCS#8 "PRIVATE KEY", got "${m[1]}" (convert it with \`openssl pkcs8 -topk8 -nocrypt\`)`);
  const b64 = m[2]!.replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** An error about the configured key itself (not the network): senders report it as `InvalidCredentials`. */
export type CredentialsError = Error & { credentials: true };
const credentialsError = (message: string): CredentialsError => Object.assign(new Error(message), { credentials: true as const });

/**
 * Imports a PKCS#8 PEM private key for signing with `alg`. The key is not extractable. Throws a `CredentialsError`
 * (`credentials: true`) for anything wrong with the key: not PEM, not PKCS#8, bad base64, wrong curve or type.
 */
export async function importSigningKey(pem: string, alg: JwtAlgorithm): Promise<CryptoKey> {
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = pemToDer(pem);
  } catch (e) {
    throw credentialsError((e as Error).message);
  }
  try {
    return await crypto.subtle.importKey("pkcs8", der, ALGORITHMS[alg].importParams, false, ["sign"]);
  } catch (e) {
    throw credentialsError(`cannot import the ${alg === "ES256" ? "P-256 (.p8)" : "RSA"} private key: ${(e as Error).message}`);
  }
}

const b64json = (value: unknown) => toBase64url(encoder.encode(JSON.stringify(value)));

/** `base64url(header).base64url(claims).base64url(signature)`, with `alg` and `typ: "JWT"` set in the header. */
export async function signJwt(alg: JwtAlgorithm, key: CryptoKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const signingInput = `${b64json({ alg, typ: "JWT", ...header })}.${b64json(claims)}`;
  const signature = await crypto.subtle.sign(ALGORITHMS[alg].signParams, key, encoder.encode(signingInput));
  return `${signingInput}.${toBase64url(new Uint8Array(signature))}`;
}

/** Splits a compact JWS into its decoded header, claims and raw signature (no verification). For tests and fakes. */
export function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signature: Uint8Array<ArrayBuffer>; signingInput: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a compact JWS");
  const json = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64url(s))) as Record<string, unknown>;
  return { header: json(parts[0]!), claims: json(parts[1]!), signature: fromBase64url(parts[2]!), signingInput: `${parts[0]}.${parts[1]}` };
}

/** Verifies a compact JWS with a public key (`verify` usage). For tests and fakes. */
export async function verifyJwt(token: string, alg: JwtAlgorithm, publicKey: CryptoKey): Promise<boolean> {
  const { header, signature, signingInput } = decodeJwt(token);
  if (header.alg !== alg) return false;
  return crypto.subtle.verify(ALGORITHMS[alg].signParams, publicKey, signature, encoder.encode(signingInput));
}
