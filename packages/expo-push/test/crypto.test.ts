import { EMBER_PUSH_HPKE_INFO as SERVER_INFO, generateRecipient, importKeyPair, open as webOpen, sealPushContent, toBase64url as serverB64 } from "@freecorps/ember-push";
import { describe, expect, test } from "vitest";
import { EMBER_PUSH_HPKE_INFO, generatePushKeyPair, hpkeOpen, hpkeSeal, openPushEnvelope, parsePushEnvelope, pushKeyId, toBase64url } from "../src/index.ts";

const hex = (value: string) => Uint8Array.from(Buffer.from(value.replace(/\s+/g, ""), "hex"));
const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

// RFC 9180, appendix A.3.1 (the vector Brigade's packages/push tests use): DHKEM(P-256, HKDF-SHA256), HKDF-SHA256,
// AES-128-GCM, base mode, sequence number 0.
const A31 = {
  info: hex("4f6465206f6e2061204772656369616e2055726e"),
  pkEm: hex(`04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b32 5ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4`),
  skEm: hex("4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb"),
  pkRm: hex(`04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f70 6a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0`),
  skRm: hex("f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2"),
  pt: hex("4265617574792069732074727574682c20747275746820626561757479"),
  aad: hex("436f756e742d30"),
  ct: hex(`5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f 9076ac232e3ab2523f39513434`),
};

describe("pure-JS HPKE (noble)", () => {
  test("RFC 9180 A.3.1: open recovers the plaintext; seal with the vector's ephemeral key reproduces enc and ct", () => {
    expect(toHex(hpkeOpen(A31.skRm, A31.pkRm, A31.pkEm, A31.ct, { info: A31.info, aad: A31.aad }))).toBe(toHex(A31.pt));
    const sealed = hpkeSeal(A31.pkRm, A31.pt, { info: A31.info, aad: A31.aad, ephemeralKey: A31.skEm });
    expect(toHex(sealed.enc)).toBe(toHex(A31.pkEm));
    expect(toHex(sealed.ct)).toBe(toHex(A31.ct));
  });

  test("interoperates with the server's WebCrypto HPKE in both directions", async () => {
    const device = generatePushKeyPair(random);
    // Server seals (WebCrypto) → device opens (noble).
    const env = await sealPushContent(toBase64url(device.publicKey), { title: "Ana Souza", body: "Segue o orçamento", data: { id: "m-1" } });
    expect(openPushEnvelope(env, [device])).toMatchObject({ title: "Ana Souza", body: "Segue o orçamento", data: { id: "m-1" } });
    // noble seals → WebCrypto opens.
    const web = await generateRecipient();
    const sealed = hpkeSeal(web.publicKey, new TextEncoder().encode("olá"), { info: new TextEncoder().encode(EMBER_PUSH_HPKE_INFO), random });
    expect(new TextDecoder().decode(await webOpen(web, sealed, { info: new TextEncoder().encode(SERVER_INFO) }))).toBe("olá");
    // Key import compatibility: the device's raw scalar works in WebCrypto too.
    const imported = await importKeyPair(device.privateKey, device.publicKey);
    expect(imported.privateKey.type).toBe("private");
  });

  test("constants and key ids match the server", async () => {
    expect(EMBER_PUSH_HPKE_INFO).toBe(SERVER_INFO);
    const device = generatePushKeyPair(random);
    const env = await sealPushContent(serverB64(device.publicKey), { body: "x" });
    expect(env.k).toBe(pushKeyId(device.publicKey));
  });

  test("tries the named key first, then the others; fails for foreign keys and tampering", async () => {
    const old = generatePushKeyPair(random);
    const current = generatePushKeyPair(random);
    const env = await sealPushContent(toBase64url(old.publicKey), { body: "sealed to the old key" });
    expect(openPushEnvelope(env, [current, old]).body).toBe("sealed to the old key");
    expect(() => openPushEnvelope(env, [current])).toThrow(/did not open/);
    expect(() => openPushEnvelope(env, [])).toThrow(/did not open/);
    const ct = Buffer.from(env.ct, "base64url");
    ct[0]! ^= 1;
    expect(() => openPushEnvelope({ ...env, ct: ct.toString("base64url") }, [old])).toThrow();
    expect(() => hpkeOpen(old.privateKey, old.publicKey, new Uint8Array(65), new Uint8Array(16))).toThrow();
  });

  test("parsePushEnvelope accepts the FCM JSON string form", async () => {
    const device = generatePushKeyPair(random);
    const env = await sealPushContent(toBase64url(device.publicKey), { body: "x" });
    expect(parsePushEnvelope(JSON.stringify(env))).toEqual(env);
    expect(parsePushEnvelope({ ...env, v: 2 })).toBeNull();
    expect(parsePushEnvelope("nope")).toBeNull();
  });
});
