// Adapted from Freecorps Brigade, packages/push/src/envelope.ts (MIT License, Copyright (c) 2026 Freecorps Tecnologia
// da Informação LTDA; https://github.com/freecorps/brigade/tree/main/packages/push): the envelope shape (`v`, `k`,
// `enc`, `ct`, base64url), the key id, the plaintext limit and the validation of untrusted input come from there. The
// content is Ember's (title/subtitle/body/data instead of Brigade's incident fields) and the HPKE `info` is Ember's own,
// so a Brigade ciphertext never opens as an Ember push or the other way round.

import { fromBase64url, toBase64url } from "./base64url.ts";
import { open, P256_PUBLIC_KEY_LENGTH, seal, type HpkeRecipient } from "./hpke.ts";

/**
 * What is sealed for one device: everything a person would read. APNs and FCM only see the envelope (and the
 * fallback text the sender chose, which should say nothing).
 */
export interface EncryptedPushContent {
  title?: string;
  subtitle?: string;
  body?: string;
  /** Delivered to the app after decryption (`notification.request.content.data` in expo-notifications). */
  data?: Record<string, unknown>;
}

/** What opening an envelope gives: the content and when the server sealed it (Unix seconds). */
export interface OpenedPushContent extends EncryptedPushContent {
  iat: number;
}

/**
 * The encrypted push as it travels, in the APNs payload's `ember` field or the FCM data's `ember` field (as a JSON
 * string): HPKE's encapsulated key and ciphertext, base64url, and `k`, the id of the device key it was sealed to, so a
 * device holding a rotated key tries the right one.
 */
export interface PushEnvelope {
  v: typeof EMBER_PUSH_ENVELOPE_VERSION;
  k: string;
  enc: string;
  ct: string;
}

export const EMBER_PUSH_ENVELOPE_VERSION = 1;

/**
 * HPKE `info`: binds every ciphertext to this protocol and version. The iOS Notification Service Extension and the
 * Android decoder in `@freecorps/ember-expo-push` use the same string. Change it (and `v`) together everywhere.
 */
export const EMBER_PUSH_HPKE_INFO = "freecorps.ember push v1";

/**
 * Plaintext limit in UTF-8 bytes (Brigade's): about 2.8 KB once sealed and base64url-encoded, which leaves room in
 * APNs' and FCM's 4 KB for the fallback text and the other fields.
 */
export const PUSH_PLAINTEXT_MAX_BYTES = 2048;

/** A key id: 8 base64url characters (`pushKeyId`). */
export const PUSH_KEY_ID = /^[A-Za-z0-9_-]{8}$/;

const encoder = new TextEncoder();
const info = encoder.encode(EMBER_PUSH_HPKE_INFO);

/**
 * Seals `content` for a device, given its public key as the device registered it (base64url of the uncompressed
 * P-256 point, 65 bytes). Throws over `PUSH_PLAINTEXT_MAX_BYTES` or for a malformed key.
 */
export async function sealPushContent(devicePublicKey: string, content: EncryptedPushContent, opts: { now?: number } = {}): Promise<PushEnvelope> {
  const key = parseDevicePublicKey(devicePublicKey);
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const { title, subtitle, body, data } = content;
  const plaintext = encoder.encode(JSON.stringify({ title, subtitle, body, data, iat }));
  if (plaintext.length > PUSH_PLAINTEXT_MAX_BYTES) {
    throw new Error(`push content is ${plaintext.length} bytes, over ${PUSH_PLAINTEXT_MAX_BYTES}`);
  }
  const sealed = await seal(key, plaintext, { info });
  return { v: EMBER_PUSH_ENVELOPE_VERSION, k: await pushKeyId(key), enc: toBase64url(sealed.enc), ct: toBase64url(sealed.ct) };
}

/** Opens an envelope (what the device does; for tests and JS clients with WebCrypto). Throws if it does not open. */
export async function openPushEnvelope(recipient: HpkeRecipient, envelope: PushEnvelope): Promise<OpenedPushContent> {
  const plaintext = await open(recipient, { enc: fromBase64url(envelope.enc), ct: fromBase64url(envelope.ct) }, { info });
  return parseOpenedContent(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext)));
}

/** The plaintext of an envelope as a device accepts it; throws for anything else. */
export function parseOpenedContent(value: unknown): OpenedPushContent {
  if (!isRecord(value) || !Number.isSafeInteger(value.iat)) throw new Error("push content has no iat");
  const out: OpenedPushContent = { iat: value.iat as number };
  for (const f of ["title", "subtitle", "body"] as const) {
    const s = value[f];
    if (s === undefined || s === null) continue;
    if (typeof s !== "string") throw new Error(`push content ${f} is not a string`);
    out[f] = s;
  }
  if (value.data !== undefined && value.data !== null) {
    if (!isRecord(value.data)) throw new Error("push content data is not an object");
    out.data = value.data;
  }
  return out;
}

/**
 * The id of a device key, as an envelope names it (`k`): base64url of the first 6 bytes of SHA-256 over the
 * uncompressed public key, 8 characters (Brigade's `pushKeyId`). Only a hint for which key to try; the AEAD decides.
 */
export async function pushKeyId(publicKey: string | Uint8Array): Promise<string> {
  const key = typeof publicKey === "string" ? parseDevicePublicKey(publicKey) : publicKey;
  if (key.length !== P256_PUBLIC_KEY_LENGTH || key[0] !== 0x04) throw new Error("device public key must be an uncompressed P-256 point");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(key)));
  return toBase64url(digest.subarray(0, 6));
}

/** Accepts an envelope from untrusted JSON (or the JSON string FCM data carries), or returns null. */
export function parsePushEnvelope(value: unknown): PushEnvelope | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || value.v !== EMBER_PUSH_ENVELOPE_VERSION) return null;
  const { k, enc, ct } = value;
  if (typeof k !== "string" || !PUSH_KEY_ID.test(k) || typeof enc !== "string" || typeof ct !== "string") return null;
  try {
    // 16 bytes is the GCM tag alone: an empty plaintext.
    if (fromBase64url(enc).length !== P256_PUBLIC_KEY_LENGTH || fromBase64url(ct).length < 16) return null;
  } catch {
    return null;
  }
  return { v: EMBER_PUSH_ENVELOPE_VERSION, k, enc, ct };
}

/** A device public key from its base64url form; throws unless it is an uncompressed P-256 point. */
export function parseDevicePublicKey(value: string): Uint8Array<ArrayBuffer> {
  const key = fromBase64url(value);
  if (key.length !== P256_PUBLIC_KEY_LENGTH || key[0] !== 0x04) {
    throw new Error("device public key must be an uncompressed P-256 point (65 bytes, base64url)");
  }
  return key;
}

/** Cheap shape check for registration (the curve check happens when sealing). */
export function isDevicePublicKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parseDevicePublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
