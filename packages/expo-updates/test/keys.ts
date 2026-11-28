// An RSA key pair for the tests: the private key as PKCS#8 and PKCS#1 PEM (what `npx expo-updates codesigning:generate`
// writes), the public key for WebCrypto verification.
import { createPrivateKey } from "node:crypto";
import { base64 } from "../src/protocol.ts";

const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${base64(der).match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

type TestKeys = { pkcs8: string; pkcs1: string; publicKey: CryptoKey };
let cached: Promise<TestKeys> | null = null;

/** One RSA-2048 pair per test file (keygen is slow): every call returns the same keys. */
export function testKeys(): Promise<TestKeys> {
  return (cached ??= generate());
}

async function generate(): Promise<TestKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = pem("PRIVATE KEY", new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const pkcs1 = createPrivateKey(pkcs8).export({ type: "pkcs1", format: "pem" }).toString();
  return { pkcs8, pkcs1, publicKey: pair.publicKey };
}

/** Verifies an `expo-signature` `sig` (base64) over `body` with the public key. */
export async function verify(publicKey: CryptoKey, sig: string, body: string): Promise<boolean> {
  const bytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, bytes, new TextEncoder().encode(body));
}
