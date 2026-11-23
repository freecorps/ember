// Ported from Freecorps Brigade, packages/push/tests/hpke.test.ts (MIT License, Copyright (c) 2026 Freecorps Tecnologia
// da Informação LTDA): RFC 9180 test vector A.3.1 in both directions, round trips, tampering and key checks.
import { afterEach, describe, expect, test, vi } from "vitest";
import { clearHpkeCaches, generateRecipient, HPKE_INFO_CACHE_MAX, HPKE_RECIPIENT_CACHE_MAX, hpkeCacheSizes, importKeyPair, open, seal } from "../src/hpke.ts";

const hex = (value: string) => Uint8Array.from(Buffer.from(value.replace(/\s+/g, ""), "hex"));
const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

// RFC 9180, appendix A.3.1: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode, sequence number 0.
const A31 = {
  info: hex("4f6465206f6e2061204772656369616e2055726e"),
  pkEm: hex(`04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b32
    5ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4`),
  skEm: hex("4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb"),
  pkRm: hex(`04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f70
    6a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0`),
  skRm: hex("f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2"),
  pt: hex("4265617574792069732074727574682c20747275746820626561757479"),
  aad: hex("436f756e742d30"),
  ct: hex(`5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f
    9076ac232e3ab2523f39513434`),
};

describe("RFC 9180 test vector A.3.1", () => {
  test("seal with the vector's ephemeral key gives its enc and ciphertext", async () => {
    const ephemeral = await importKeyPair(A31.skEm, A31.pkEm);
    const sealed = await seal(A31.pkRm, A31.pt, { info: A31.info, aad: A31.aad, ephemeral });
    expect(toHex(sealed.enc)).toBe(toHex(A31.pkEm));
    expect(toHex(sealed.ct)).toBe(toHex(A31.ct));
  });

  test("open recovers the vector's plaintext", async () => {
    const { privateKey } = await importKeyPair(A31.skRm, A31.pkRm);
    const pt = await open(
      { privateKey, publicKey: A31.pkRm },
      { enc: A31.pkEm, ct: A31.ct },
      { info: A31.info, aad: A31.aad },
    );
    expect(toHex(pt)).toBe(toHex(A31.pt));
  });
});

describe("seal and open", () => {
  test("round trip with a fresh key and a fresh ephemeral key each time", async () => {
    const recipient = await generateRecipient();
    const message = new TextEncoder().encode("SEV1: checkout down");
    const a = await seal(recipient.publicKey, message, { info: A31.info });
    const b = await seal(recipient.publicKey, message, { info: A31.info });
    expect(toHex(a.enc)).not.toBe(toHex(b.enc));
    expect(toHex(a.ct)).not.toBe(toHex(b.ct));
    expect(toHex(await open(recipient, a, { info: A31.info }))).toBe(toHex(message));
    expect(toHex(await open(recipient, b, { info: A31.info }))).toBe(toHex(message));
  });

  test("an empty plaintext is 16 bytes of tag", async () => {
    const recipient = await generateRecipient();
    const sealed = await seal(recipient.publicKey, new Uint8Array(0));
    expect(sealed.ct.length).toBe(16);
    expect((await open(recipient, sealed)).length).toBe(0);
  });

  test("open fails on another key, another info or aad, or a flipped bit", async () => {
    const recipient = await generateRecipient();
    const other = await generateRecipient();
    const sealed = await seal(recipient.publicKey, A31.pt, { info: A31.info, aad: A31.aad });
    const options = { info: A31.info, aad: A31.aad };
    await expect(open(other, sealed, options)).rejects.toThrow();
    await expect(
      open(recipient, sealed, { ...options, info: new Uint8Array(0) }),
    ).rejects.toThrow();
    await expect(open(recipient, sealed, { ...options, aad: new Uint8Array(0) })).rejects.toThrow();
    const ct = Uint8Array.from(sealed.ct);
    ct[0] = (ct[0] ?? 0) ^ 1;
    await expect(open(recipient, { enc: sealed.enc, ct }, options)).rejects.toThrow();
  });

  test("only uncompressed P-256 public keys are accepted", async () => {
    const compressed = Uint8Array.of(0x02 | ((A31.pkRm[64] ?? 0) & 1), ...A31.pkRm.subarray(1, 33));
    await expect(seal(compressed, A31.pt)).rejects.toThrow(/uncompressed/);
    await expect(seal(new Uint8Array(65), A31.pt)).rejects.toThrow();
    const offCurve = Uint8Array.from(A31.pkRm);
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    await expect(seal(offCurve, A31.pt)).rejects.toThrow();
  });
});

describe("per-isolate caches", () => {
  afterEach(() => vi.restoreAllMocks());

  test("the vector still comes out byte for byte with cold and warm caches, sealing and opening", async () => {
    const ephemeral = await importKeyPair(A31.skEm, A31.pkEm);
    const { privateKey } = await importKeyPair(A31.skRm, A31.pkRm);
    clearHpkeCaches();
    for (let i = 0; i < 3; i++) {
      const sealed = await seal(A31.pkRm, A31.pt, { info: A31.info, aad: A31.aad, ephemeral });
      expect(toHex(sealed.ct)).toBe(toHex(A31.ct));
      const pt = await open({ privateKey, publicKey: A31.pkRm }, { enc: A31.pkEm, ct: A31.ct }, { info: A31.info, aad: A31.aad });
      expect(toHex(pt)).toBe(toHex(A31.pt));
    }
  });

  test("a warm seal imports 4 keys instead of 9: no recipient key, empty-salt key or psk/info hash again, `secret` once", async () => {
    const recipient = await generateRecipient();
    const info = new TextEncoder().encode("freecorps.ember push v1");
    clearHpkeCaches();
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    await seal(recipient.publicKey, A31.pt, { info });
    // Cold: the recipient key, the empty-salt HMAC key (eae_prk; then reused for psk_id_hash and info_hash), the
    // eae_prk key, `secret`'s salt, `secret` (once for both expansions) and the AES key.
    expect(importKey).toHaveBeenCalledTimes(6);
    importKey.mockClear();
    const sealed = await seal(recipient.publicKey, A31.pt, { info });
    // Warm: eae_prk, `secret`'s salt (the shared secret), `secret`, the AES key. It was 9 per seal before.
    expect(importKey).toHaveBeenCalledTimes(4);
    expect(toHex(await open(recipient, sealed, { info }))).toBe(toHex(A31.pt));
  });

  test("bounded: many infos and many recipients keep at most the limits, and evicted entries recompute the same", async () => {
    clearHpkeCaches();
    const recipient = await generateRecipient();
    for (let i = 0; i < HPKE_INFO_CACHE_MAX + 5; i++) {
      const info = new TextEncoder().encode(`info ${i}`);
      const sealed = await seal(recipient.publicKey, A31.pt, { info });
      expect(toHex(await open(recipient, sealed, { info }))).toBe(toHex(A31.pt));
    }
    expect(hpkeCacheSizes().info).toBe(HPKE_INFO_CACHE_MAX);
    // "info 0" was evicted: computed again, still opens.
    const info0 = new TextEncoder().encode("info 0");
    expect(toHex(await open(recipient, await seal(recipient.publicKey, A31.pt, { info: info0 }), { info: info0 }))).toBe(toHex(A31.pt));

    const first = await generateRecipient();
    await seal(first.publicKey, A31.pt);
    const others = await Promise.all(Array.from({ length: HPKE_RECIPIENT_CACHE_MAX }, () => generateRecipient()));
    for (const r of others) await seal(r.publicKey, A31.pt);
    expect(hpkeCacheSizes().recipients).toBe(HPKE_RECIPIENT_CACHE_MAX);
    // The first recipient was evicted; sealing to it again still works.
    expect(toHex(await open(first, await seal(first.publicKey, A31.pt)))).toBe(toHex(A31.pt));
  });

  test("a rejected key is never cached, and the caller's buffer can change after sealing", async () => {
    clearHpkeCaches();
    const offCurve = Uint8Array.from(A31.pkRm);
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    await expect(seal(offCurve, A31.pt)).rejects.toThrow();
    await expect(seal(offCurve, A31.pt)).rejects.toThrow();
    expect(hpkeCacheSizes().recipients).toBe(0);

    const a = await generateRecipient();
    const b = await generateRecipient();
    const buf = Uint8Array.from(a.publicKey);
    await seal(buf, A31.pt);
    buf.set(b.publicKey); // same buffer, another key: sealed to b, not to the cached a
    const sealed = await seal(buf, A31.pt);
    expect(toHex(await open(b, sealed))).toBe(toHex(A31.pt));
    await expect(open(a, sealed)).rejects.toThrow();
  });
});
