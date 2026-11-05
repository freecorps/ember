/**
 * The device side of Ember's encrypted pushes, in pure JS (noble), because React Native has no WebCrypto: HPKE
 * (RFC 9180) base mode with DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM — the suite and `info` the server
 * seals with (`@freecorps/ember-push`, ported from Freecorps Brigade's packages/push, MIT) and iOS CryptoKit opens in
 * the Notification Service Extension. Checked against RFC 9180 test vector A.3.1 and against the server's WebCrypto
 * implementation in both directions (test/crypto.test.ts).
 */
import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Must equal `EMBER_PUSH_HPKE_INFO` in `@freecorps/ember-push` and the NSE's (test/crypto.test.ts checks). */
export const EMBER_PUSH_HPKE_INFO = "freecorps.ember push v1";
export const EMBER_PUSH_ENVELOPE_VERSION = 1;

const te = new TextEncoder();

export function toBase64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("invalid base64url");
  const binary = atob(value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const i2osp2 = (v: number) => Uint8Array.of((v >> 8) & 0xff, v & 0xff);
const EMPTY = new Uint8Array(0);
const KEM_SUITE = concat(te.encode("KEM"), i2osp2(0x0010));
const HPKE_SUITE = concat(te.encode("HPKE"), i2osp2(0x0010), i2osp2(0x0001), i2osp2(0x0001));
const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) => extract(sha256, concat(te.encode("HPKE-v1"), suite, te.encode(label), ikm), salt);
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number) =>
  expand(sha256, prk, concat(i2osp2(length), te.encode("HPKE-v1"), suite, te.encode(label), info), length);

function checkPoint(raw: Uint8Array): void {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("expected an uncompressed P-256 public key (65 bytes)");
  p256.Point.fromBytes(raw).assertValidity();
}

function keySchedule(dh: Uint8Array, enc: Uint8Array, pkR: Uint8Array, info: Uint8Array) {
  const sharedSecret = labeledExpand(KEM_SUITE, labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dh), "shared_secret", concat(enc, pkR), 32);
  const context = concat(Uint8Array.of(0), labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY), labeledExtract(HPKE_SUITE, EMPTY, "info_hash", info));
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", EMPTY);
  return { key: labeledExpand(HPKE_SUITE, secret, "key", context, 16), nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12) };
}

/** HPKE single-shot open (base mode, sequence 0). Throws if anything does not match. */
export function hpkeOpen(privateKey: Uint8Array, publicKey: Uint8Array, enc: Uint8Array, ct: Uint8Array, opts: { info?: Uint8Array; aad?: Uint8Array } = {}): Uint8Array {
  checkPoint(enc);
  const dh = p256.getSharedSecret(privateKey, enc, true).subarray(1);
  const { key, nonce } = keySchedule(dh, enc, publicKey, opts.info ?? EMPTY);
  return gcm(key, nonce, opts.aad ?? EMPTY).decrypt(ct);
}

/** HPKE single-shot seal (for tests and JS senders). `ephemeralKey` only for test vectors. */
export function hpkeSeal(publicKey: Uint8Array, plaintext: Uint8Array, opts: { info?: Uint8Array; aad?: Uint8Array; ephemeralKey?: Uint8Array; random?: (n: number) => Uint8Array } = {}): { enc: Uint8Array; ct: Uint8Array } {
  checkPoint(publicKey);
  const skE = opts.ephemeralKey ?? p256.utils.randomSecretKey(opts.random ? opts.random(48) : undefined);
  const enc = p256.getPublicKey(skE, false);
  const dh = p256.getSharedSecret(skE, publicKey, true).subarray(1);
  const { key, nonce } = keySchedule(dh, enc, publicKey, opts.info ?? EMPTY);
  return { enc, ct: gcm(key, nonce, opts.aad ?? EMPTY).encrypt(plaintext) };
}

/** A device key pair: the raw private scalar (32 bytes) and the uncompressed public key (65 bytes). */
export interface PushKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** A new P-256 key pair from 48 random bytes (`random`: `crypto.getRandomValues`-backed on the device). */
export function generatePushKeyPair(random: (n: number) => Uint8Array): PushKeyPair {
  const privateKey = p256.utils.randomSecretKey(random(48));
  return { privateKey, publicKey: p256.getPublicKey(privateKey, false) };
}

/** The key id an envelope names (`k`): base64url of SHA-256(public key)'s first 6 bytes. Same as the server's. */
export function pushKeyId(publicKey: Uint8Array): string {
  return toBase64url(sha256(publicKey).subarray(0, 6));
}

export interface PushEnvelope {
  v: 1;
  k: string;
  enc: string;
  ct: string;
}

/** What an envelope opens to. `iat`: when the server sealed it (Unix seconds). */
export interface OpenedPush {
  title?: string;
  subtitle?: string;
  body?: string;
  data?: Record<string, unknown>;
  iat: number;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** An envelope from a push payload (object, or the JSON string FCM data carries), or null. */
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
  if (typeof k !== "string" || !/^[A-Za-z0-9_-]{8}$/.test(k) || typeof enc !== "string" || typeof ct !== "string") return null;
  try {
    if (fromBase64url(enc).length !== 65 || fromBase64url(ct).length < 16) return null;
  } catch {
    return null;
  }
  return { v: 1, k, enc, ct };
}

/**
 * Opens an envelope with the device's keys (the one named by `k` first, then the others, e.g. right after a
 * rotation). Throws when none opens it or the plaintext is not a push.
 */
export function openPushEnvelope(envelope: PushEnvelope, keys: readonly PushKeyPair[]): OpenedPush {
  const info = te.encode(EMBER_PUSH_HPKE_INFO);
  const enc = fromBase64url(envelope.enc);
  const ct = fromBase64url(envelope.ct);
  const ordered = [...keys].sort((a, b) => Number(pushKeyId(b.publicKey) === envelope.k) - Number(pushKeyId(a.publicKey) === envelope.k));
  let last: unknown = new Error("no device key");
  for (const key of ordered) {
    let pt: Uint8Array;
    try {
      pt = hpkeOpen(key.privateKey, key.publicKey, enc, ct, { info });
    } catch (e) {
      last = e;
      continue;
    }
    return parseOpened(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt)));
  }
  throw new Error(`push did not open: ${(last as Error).message}`);
}

function parseOpened(value: unknown): OpenedPush {
  if (!isRecord(value) || !Number.isSafeInteger(value.iat)) throw new Error("push content has no iat");
  const out: OpenedPush = { iat: value.iat as number };
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
