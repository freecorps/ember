// Ported from Freecorps Brigade, packages/push/src/hpke.ts (MIT License, Copyright (c) 2026 Freecorps Tecnologia da
// Informação LTDA; https://github.com/freecorps/brigade/tree/main/packages/push). Kept byte-for-byte compatible with it:
// same suite, same RFC 9180 steps, so Brigade's test vectors and native decoders apply unchanged.

/**
 * HPKE (RFC 9180), base mode, single-shot, with one cipher suite: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and
 * AES-128-GCM. Only WebCrypto, so it runs unchanged in Workers, browsers and Node. iOS opens it with CryptoKit
 * (`HPKE.Ciphersuite(kem: .P256_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_128)`, iOS 17+) and Android
 * with the pure-JS decoder in `@freecorps/ember-expo-push`. Why this suite: Brigade's spike S1
 * (https://github.com/freecorps/brigade/blob/main/docs/spikes/s1-apns-encryption.md).
 */

import { toBase64url } from "./base64url.ts";

type Bytes = Uint8Array<ArrayBuffer>;

const KEM_ID = 0x0010; // DHKEM(P-256, HKDF-SHA256)
const KDF_ID = 0x0001; // HKDF-SHA256
const AEAD_ID = 0x0001; // AES-128-GCM
const MODE_BASE = 0x00;

/** Hash, shared secret, AES key and nonce lengths. */
const N_H = 32;
const N_SECRET = 32;
const N_K = 16;
const N_N = 12;
/** An uncompressed P-256 point (0x04 || x || y): the encapsulated key and every public key. */
export const P256_PUBLIC_KEY_LENGTH = 65;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();

export interface HpkeSealed {
  /** The sender's ephemeral public key (65 bytes). */
  enc: Bytes;
  /** Ciphertext followed by the 16-byte GCM tag. */
  ct: Bytes;
}

export interface HpkeRecipient {
  privateKey: CryptoKey;
  /** The recipient's public key, uncompressed (65 bytes); part of the KEM context. */
  publicKey: Uint8Array;
}

export interface HpkeOptions {
  info?: Uint8Array;
  aad?: Uint8Array;
}

export interface SealOptions extends HpkeOptions {
  /** Test vectors only: a fixed ephemeral key pair instead of a fresh one. Never reuse one in real use. */
  ephemeral?: CryptoKeyPair;
}

/** Encrypts `plaintext` to the holder of the private key for `recipientPublicKey` (uncompressed P-256). */
export async function seal(
  recipientPublicKey: Uint8Array,
  plaintext: Uint8Array,
  options: SealOptions = {},
): Promise<HpkeSealed> {
  const pkR = await importPublicKey(recipientPublicKey);
  const ephemeral =
    options.ephemeral ??
    ((await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair);
  const enc = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);
  const dh = await deriveDh(ephemeral.privateKey, pkR);
  const sharedSecret = await extractAndExpand(dh, concat(enc, recipientPublicKey));
  const { key, baseNonce } = await keySchedule(sharedSecret, options.info);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: baseNonce, additionalData: bytes(options.aad) },
    key,
    bytes(plaintext),
  );
  return { enc, ct: new Uint8Array(ct) };
}

/** Decrypts what `seal` produced. Throws if the key, `info`, `aad` or any byte does not match. */
export async function open(
  recipient: HpkeRecipient,
  sealed: { enc: Uint8Array; ct: Uint8Array },
  options: HpkeOptions = {},
): Promise<Bytes> {
  const pkE = await importPublicKey(sealed.enc);
  const dh = await deriveDh(recipient.privateKey, pkE);
  const sharedSecret = await extractAndExpand(dh, concat(sealed.enc, recipient.publicKey));
  const { key, baseNonce } = await keySchedule(sharedSecret, options.info);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: baseNonce, additionalData: bytes(options.aad) },
    key,
    bytes(sealed.ct),
  );
  return new Uint8Array(pt);
}

/** A fresh recipient key pair. The private key is not extractable. */
export async function generateRecipient(): Promise<HpkeRecipient> {
  const pair = (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicKey };
}

/**
 * Imports a P-256 key pair from its raw private scalar (32 bytes) and uncompressed public key, the form CryptoKit
 * (`rawRepresentation`, `x963Representation`) and the RFC 9180 test vectors use.
 */
export async function importKeyPair(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<CryptoKeyPair> {
  if (privateKey.length !== 32) throw new Error("P-256 private key must be 32 bytes");
  const { x, y } = await publicJwk(publicKey);
  const jwk = { kty: "EC", crv: "P-256", x, y, d: toBase64url(privateKey) };
  const priv = await crypto.subtle.importKey("jwk", jwk, ECDH, false, ["deriveBits"]);
  return { privateKey: priv, publicKey: await importPublicKey(publicKey) };
}

async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  // Uncompressed only: WebCrypto's raw import also takes the 33-byte compressed form, which the KEM context
  // would then hash differently from the other side.
  if (raw.length !== P256_PUBLIC_KEY_LENGTH || raw[0] !== 0x04) {
    throw new Error("expected an uncompressed P-256 public key (65 bytes)");
  }
  return crypto.subtle.importKey("raw", bytes(raw), ECDH, true, []);
}

async function publicJwk(raw: Uint8Array): Promise<{ x: string; y: string }> {
  const jwk = (await crypto.subtle.exportKey("jwk", await importPublicKey(raw))) as JsonWebKey;
  if (!jwk.x || !jwk.y) throw new Error("invalid P-256 public key");
  return { x: jwk.x, y: jwk.y };
}

async function deriveDh(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Bytes> {
  // The x coordinate of the shared point (RFC 9180, section 7.1.1).
  return new Uint8Array(
    // Cast: DOM lib types call the peer key `public`, @cloudflare/workers-types `$public`; runtimes read `public`.
    await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0], privateKey, 256),
  );
}

// RFC 9180, section 4.1: DHKEM's ExtractAndExpand.
async function extractAndExpand(dh: Bytes, kemContext: Bytes): Promise<Bytes> {
  const suite = concat(encoder.encode("KEM"), i2osp(KEM_ID, 2));
  const eaePrk = await labeledExtract(suite, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(suite, eaePrk, "shared_secret", kemContext, N_SECRET);
}

// RFC 9180, section 5.1, base mode (no PSK).
async function keySchedule(
  sharedSecret: Bytes,
  info: Uint8Array = new Uint8Array(0),
): Promise<{ key: CryptoKey; baseNonce: Bytes }> {
  const suite = concat(
    encoder.encode("HPKE"),
    i2osp(KEM_ID, 2),
    i2osp(KDF_ID, 2),
    i2osp(AEAD_ID, 2),
  );
  const empty = new Uint8Array(0);
  const pskIdHash = await labeledExtract(suite, empty, "psk_id_hash", empty);
  const infoHash = await labeledExtract(suite, empty, "info_hash", bytes(info));
  const context = concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = await labeledExtract(suite, sharedSecret, "secret", empty);
  const keyBytes = await labeledExpand(suite, secret, "key", context, N_K);
  const baseNonce = await labeledExpand(suite, secret, "base_nonce", context, N_N);
  // Single-shot: one message at sequence number 0, so the nonce is the base nonce.
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return { key, baseNonce };
}

function labeledExtract(suite: Bytes, salt: Bytes, label: string, ikm: Bytes): Promise<Bytes> {
  return hkdfExtract(salt, concat(encoder.encode("HPKE-v1"), suite, encoder.encode(label), ikm));
}

function labeledExpand(
  suite: Bytes,
  prk: Bytes,
  label: string,
  info: Bytes,
  length: number,
): Promise<Bytes> {
  const labeled = concat(
    i2osp(length, 2),
    encoder.encode("HPKE-v1"),
    suite,
    encoder.encode(label),
    info,
  );
  return hkdfExpand(prk, labeled, length);
}

// RFC 5869 with SHA-256. WebCrypto's HKDF fuses extract and expand, and HPKE labels each step on its own.
async function hkdfExtract(salt: Bytes, ikm: Bytes): Promise<Bytes> {
  // An empty salt means HashLen zero bytes; WebCrypto rejects a zero-length HMAC key, and HMAC pads either way.
  return hmac(salt.length === 0 ? new Uint8Array(N_H) : salt, ikm);
}

async function hkdfExpand(prk: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const out = new Uint8Array(length);
  let block: Bytes = new Uint8Array(0);
  for (let i = 1, offset = 0; offset < length; i++) {
    block = await hmac(prk, concat(block, info, Uint8Array.of(i)));
    out.set(block.subarray(0, Math.min(N_H, length - offset)), offset);
    offset += N_H;
  }
  return out;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

function i2osp(value: number, length: number): Bytes {
  const out = new Uint8Array(length);
  for (let i = length - 1, v = value; i >= 0; i--, v >>>= 8) out[i] = v & 0xff;
  return out;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A copy backed by a plain ArrayBuffer, which WebCrypto's types require. */
function bytes(value: Uint8Array = new Uint8Array(0)): Bytes {
  return new Uint8Array(value);
}
