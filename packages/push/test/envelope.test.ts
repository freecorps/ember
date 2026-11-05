import { describe, expect, test } from "vitest";
import {
  EMBER_PUSH_HPKE_INFO,
  generateRecipient,
  isDevicePublicKey,
  open,
  openPushEnvelope,
  parsePushEnvelope,
  PUSH_PLAINTEXT_MAX_BYTES,
  pushKeyId,
  sealPushContent,
  toBase64url,
  fromBase64url,
} from "../src/index.ts";

async function device() {
  const r = await generateRecipient();
  return { recipient: r, publicKey: toBase64url(r.publicKey) };
}

describe("push envelope", () => {
  test("seals title/subtitle/body/data for a device key and opens with it (non-ASCII included)", async () => {
    const d = await device();
    const env = await sealPushContent(d.publicKey, { title: "Ana Souza", subtitle: "Re: orçamento", body: "Segue em anexo ✓", data: { mailbox: "inbox", id: 42 } }, { now: 1_700_000_000_000 });
    expect(env.v).toBe(1);
    expect(env.k).toBe(await pushKeyId(d.publicKey));
    // Plaintext markers with characters outside base64url (space, ç, quotes), so random ciphertext can't match them.
    expect(JSON.stringify(env)).not.toMatch(/Ana Souza|orçamento|em anexo|"inbox"/);
    expect(await openPushEnvelope(d.recipient, env)).toEqual({ title: "Ana Souza", subtitle: "Re: orçamento", body: "Segue em anexo ✓", data: { mailbox: "inbox", id: 42 }, iat: 1_700_000_000 });
  });

  test("the HPKE info is Ember's: the raw ciphertext opens only with it", async () => {
    const d = await device();
    const env = await sealPushContent(d.publicKey, { body: "x" });
    const sealed = { enc: fromBase64url(env.enc), ct: fromBase64url(env.ct) };
    await expect(open(d.recipient, sealed, { info: new TextEncoder().encode("app.freecorps.brigade push v1") })).rejects.toThrow();
    await expect(open(d.recipient, sealed, { info: new TextEncoder().encode(EMBER_PUSH_HPKE_INFO) })).resolves.toBeInstanceOf(Uint8Array);
  });

  test("another device's key does not open it; a flipped byte does not open", async () => {
    const a = await device();
    const b = await device();
    const env = await sealPushContent(a.publicKey, { title: "secret" });
    await expect(openPushEnvelope(b.recipient, env)).rejects.toThrow();
    const ct = fromBase64url(env.ct);
    ct[3]! ^= 1;
    await expect(openPushEnvelope(a.recipient, { ...env, ct: toBase64url(ct) })).rejects.toThrow();
  });

  test("refuses content over the plaintext limit and malformed keys", async () => {
    const d = await device();
    await expect(sealPushContent(d.publicKey, { body: "x".repeat(PUSH_PLAINTEXT_MAX_BYTES) })).rejects.toThrow(/over 2048/);
    await expect(sealPushContent("AAAA", { body: "x" })).rejects.toThrow(/uncompressed P-256/);
    expect(isDevicePublicKey(d.publicKey)).toBe(true);
    expect(isDevicePublicKey("AAAA")).toBe(false);
    expect(isDevicePublicKey(42)).toBe(false);
  });

  test("parsePushEnvelope accepts objects and JSON strings, rejects anything malformed", async () => {
    const d = await device();
    const env = await sealPushContent(d.publicKey, { body: "x" });
    expect(parsePushEnvelope(env)).toEqual(env);
    expect(parsePushEnvelope(JSON.stringify(env))).toEqual(env);
    expect(parsePushEnvelope({ ...env, v: 2 })).toBeNull();
    expect(parsePushEnvelope({ ...env, k: "short" })).toBeNull();
    expect(parsePushEnvelope({ ...env, enc: "AAAA" })).toBeNull();
    expect(parsePushEnvelope({ ...env, ct: "AAAA" })).toBeNull();
    expect(parsePushEnvelope("{not json")).toBeNull();
    expect(parsePushEnvelope(null)).toBeNull();
  });

  test("key ids are 8 base64url characters and differ per key", async () => {
    const a = await device();
    const b = await device();
    expect(await pushKeyId(a.publicKey)).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(await pushKeyId(a.publicKey)).not.toBe(await pushKeyId(b.publicKey));
  });
});
