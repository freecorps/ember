// The Expo Updates protocol v1 without a database: headers, negotiation, SFV dictionaries, the multipart body, the
// RSA-SHA256 signature (checked with the public key through WebCrypto) and the directives.
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  assetHash,
  buildManifest,
  finalOutcome,
  importSigningKey,
  multipartMixed,
  negotiate,
  parseMultipart,
  parseSfvDictionary,
  parseUpdateRequest,
  ProtocolError,
  renderResponse,
  rsaSigner,
  serializeSfvDictionary,
  SigningKeyMissing,
  type UpdateEntry,
} from "../src/index.ts";
import { testKeys, verify } from "./keys.ts";

const keys = await testKeys();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const update: UpdateEntry = {
  kind: "update",
  uuid: "0f8b1e7e-2c3d-4e5f-8a9b-0c1d2e3f4a5b",
  createdAt: Date.UTC(2026, 10, 26, 12, 0, 0),
  runtimeVersion: "1.0.0",
  launchAsset: { sha256: sha("bundle"), key: "b1", contentType: "application/javascript" },
  assets: [{ sha256: sha("png"), key: "a1", contentType: "image/png", fileExtension: ".png" }],
  metadata: { branch: "main" },
  extra: { expoClient: { name: "App" } },
};
const assetUrl = (s: string) => `https://u.test/expoUpdates/assets?key=${s}`;
const headers = (h: Record<string, string>) => new Headers({ "expo-protocol-version": "1", "expo-platform": "ios", "expo-runtime-version": "1.0.0", accept: "multipart/mixed", ...h });

describe("request headers", () => {
  test("parses the protocol headers; defaults and errors", () => {
    const r = parseUpdateRequest(headers({ "expo-channel-name": "staging", "expo-current-update-id": "ABC", "eas-client-id": "client-1", "expo-expect-signature": 'sig, keyid="main"' }), "production");
    expect(r).toEqual({ protocolVersion: 1, platform: "ios", runtimeVersion: "1.0.0", channel: "staging", currentUpdateId: "abc", embeddedUpdateId: null, clientId: "client-1", expectSignature: true, format: "multipart" });
    expect(parseUpdateRequest(headers({ "expo-protocol-version": "" }), "production")).toMatchObject({ protocolVersion: 0, channel: "production", expectSignature: false });
    expect(parseUpdateRequest(headers({ "expo-eas-client-id": "x" }), null)).toMatchObject({ clientId: "x", channel: null });
    const status = (h: Record<string, string>) => {
      try {
        parseUpdateRequest(headers(h), "p");
        return 0;
      } catch (e) {
        return (e as ProtocolError).status;
      }
    };
    expect(status({ "expo-platform": "web" })).toBe(400);
    expect(status({ "expo-runtime-version": "" })).toBe(400);
    expect(status({ "expo-protocol-version": "2" })).toBe(406);
    expect(status({ accept: "text/html" })).toBe(406);
  });

  test("negotiation over accept: multipart preferred, q-values honoured", () => {
    expect(negotiate(null)).toBe("multipart");
    expect(negotiate("application/expo+json, application/json, multipart/mixed")).toBe("multipart");
    expect(negotiate("application/expo+json;q=0.9, application/json;q=0.8, multipart/mixed")).toBe("multipart");
    expect(negotiate("application/json, multipart/mixed;q=0.5")).toBe("json");
    expect(negotiate("multipart/mixed;q=0, application/json")).toBe("json");
    expect(negotiate("*/*")).toBe("multipart");
    expect(negotiate("text/plain")).toBeNull();
  });
});

describe("Expo SFV dictionaries", () => {
  test("parse what clients send, serialize what the server sends", () => {
    expect(Object.fromEntries(parseSfvDictionary('sig, keyid="root", alg="rsa-v1_5-sha256"')!)).toEqual({ sig: true, keyid: "root", alg: "rsa-v1_5-sha256" });
    expect(Object.fromEntries(parseSfvDictionary('a=1, b=?0, c=tok, d="q\\"x\\\\"')!)).toEqual({ a: 1, b: false, c: { token: "tok" }, d: 'q"x\\' });
    expect(parseSfvDictionary("")!.size).toBe(0);
    expect(parseSfvDictionary("a=")).toBeNull();
    expect(parseSfvDictionary('a="unterminated')).toBeNull();
    expect(parseSfvDictionary("a, ")).toBeNull();
    const s = serializeSfvDictionary({ sig: 'ab/c+=="', keyid: "main", on: true, off: false, n: 3 });
    expect(s).toBe('sig="ab/c+==\\"", keyid="main", on, off=?0, n=3');
    expect(Object.fromEntries(parseSfvDictionary(s)!)).toEqual({ sig: 'ab/c+=="', keyid: "main", on: true, off: false, n: 3 });
  });
});

describe("manifest and multipart", () => {
  test("the manifest body: base64url SHA-256 hashes, keys, URLs, ISO createdAt; no fileExtension on the launch asset", () => {
    const m = buildManifest({ ...update, launchAsset: { ...update.launchAsset, fileExtension: ".bundle" } }, assetUrl);
    expect(m).toEqual({
      id: update.uuid,
      createdAt: "2026-11-26T12:00:00.000Z",
      runtimeVersion: "1.0.0",
      launchAsset: { hash: createHash("sha256").update("bundle").digest("base64url"), key: "b1", contentType: "application/javascript", url: assetUrl(sha("bundle")) },
      assets: [{ hash: createHash("sha256").update("png").digest("base64url"), key: "a1", contentType: "image/png", fileExtension: ".png", url: assetUrl(sha("png")) }],
      metadata: { branch: "main" },
      extra: { expoClient: { name: "App" } },
    });
    expect(assetHash(sha("x"))).toBe(createHash("sha256").update("x").digest("base64url"));
  });

  test("multipart/mixed round trip (RFC 2046 delimiters, CRLF, named parts)", () => {
    const body = multipartMixed(
      [
        { name: "manifest", contentType: "application/json", body: '{"a":1}', headers: { "expo-signature": 'sig="x"' } },
        { name: "extensions", contentType: "application/json", body: "{}" },
      ],
      "BOUND",
    );
    expect(body).toBe('--BOUND\r\ncontent-type: application/json\r\ncontent-disposition: form-data; name="manifest"\r\nexpo-signature: sig="x"\r\n\r\n{"a":1}\r\n--BOUND\r\ncontent-type: application/json\r\ncontent-disposition: form-data; name="extensions"\r\n\r\n{}\r\n--BOUND--\r\n');
    expect(parseMultipart(body, "multipart/mixed; boundary=BOUND")).toEqual([
      { name: "manifest", headers: { "content-type": "application/json", "content-disposition": 'form-data; name="manifest"', "expo-signature": 'sig="x"' }, body: '{"a":1}' },
      { name: "extensions", headers: { "content-type": "application/json", "content-disposition": 'form-data; name="extensions"' }, body: "{}" },
    ]);
  });
});

describe("signature (RSA-SHA256, WebCrypto)", () => {
  test("PKCS#8 and PKCS#1 PEMs sign the same bytes; the public key verifies the part body", async () => {
    for (const pem of [keys.pkcs8, keys.pkcs1, keys.pkcs1.replace(/\n/g, "\\n")]) {
      const r = await renderResponse({ type: "update", update }, { protocolVersion: 1, expectSignature: true, format: "multipart" }, { assetUrl, signer: rsaSigner(pem, "main") });
      expect(r.status).toBe(200);
      expect(r.headers).toMatchObject({ "expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0" });
      const parts = parseMultipart(r.body!, r.headers["content-type"]!);
      expect(parts.map((p) => p.name)).toEqual(["manifest", "extensions"]);
      const [manifest, extensions] = parts;
      expect(JSON.parse(extensions!.body)).toEqual({ assetRequestHeaders: {} });
      const sig = parseSfvDictionary(manifest!.headers["expo-signature"]!)!;
      expect(sig.get("keyid")).toBe("main");
      expect(await verify(keys.publicKey, sig.get("sig") as string, manifest!.body)).toBe(true);
      // Any other bytes do not verify.
      expect(await verify(keys.publicKey, sig.get("sig") as string, manifest!.body + " ")).toBe(false);
      expect(JSON.parse(manifest!.body).id).toBe(update.uuid);
    }
  });

  test("the JSON form carries the signature as an HTTP header; no expect-signature, no signature", async () => {
    const r = await renderResponse({ type: "update", update }, { protocolVersion: 1, expectSignature: true, format: "json" }, { assetUrl, signer: rsaSigner(keys.pkcs8) });
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(await verify(keys.publicKey, parseSfvDictionary(r.headers["expo-signature"]!)!.get("sig") as string, r.body!)).toBe(true);
    const plain = await renderResponse({ type: "update", update }, { protocolVersion: 1, expectSignature: false, format: "multipart" }, { assetUrl, signer: rsaSigner(keys.pkcs8) });
    expect(parseMultipart(plain.body!, plain.headers["content-type"]!)[0]!.headers["expo-signature"]).toBeUndefined();
  });

  test("a signature expected without a key is an error; a bad PEM is refused", async () => {
    await expect(renderResponse({ type: "update", update }, { protocolVersion: 1, expectSignature: true, format: "multipart" }, { assetUrl, signer: null })).rejects.toBeInstanceOf(SigningKeyMissing);
    expect(() => importSigningKey("not a pem")).toThrow(/PEM private key/);
  });
});

describe("directives", () => {
  const p1 = { protocolVersion: 1 as const, expectSignature: true, format: "multipart" as const };
  test("rollBackToEmbedded and noUpdateAvailable as signed directive parts (protocol 1)", async () => {
    const r = await renderResponse({ type: "rollBackToEmbedded", commitTime: Date.UTC(2026, 0, 2) }, p1, { assetUrl, signer: rsaSigner(keys.pkcs8) });
    const [d] = parseMultipart(r.body!, r.headers["content-type"]!);
    expect(d!.name).toBe("directive");
    expect(JSON.parse(d!.body)).toEqual({ type: "rollBackToEmbedded", parameters: { commitTime: "2026-01-02T00:00:00.000Z" } });
    expect(await verify(keys.publicKey, parseSfvDictionary(d!.headers["expo-signature"]!)!.get("sig") as string, d!.body)).toBe(true);
    const n = await renderResponse({ type: "noUpdateAvailable" }, p1, { assetUrl, signer: rsaSigner(keys.pkcs8) });
    expect(JSON.parse(parseMultipart(n.body!, n.headers["content-type"]!)[0]!.body)).toEqual({ type: "noUpdateAvailable" });
  });

  test("protocol 0 and the JSON form: 204 for nothing new, 406 for a rollback", async () => {
    for (const req of [{ ...p1, protocolVersion: 0 as const }, { ...p1, format: "json" as const }]) {
      expect((await renderResponse({ type: "noUpdateAvailable" }, req, { assetUrl, signer: null })).status).toBe(204);
      expect((await renderResponse({ type: "rollBackToEmbedded", commitTime: 1 }, req, { assetUrl, signer: null })).status).toBe(406);
    }
  });

  test("finalOutcome: the client's current update → noUpdateAvailable; a rollback when it runs the embedded one too", () => {
    const u = { type: "update" as const, update };
    expect(finalOutcome(u, { currentUpdateId: update.uuid, embeddedUpdateId: null })).toEqual({ type: "noUpdateAvailable" });
    expect(finalOutcome(u, { currentUpdateId: "other", embeddedUpdateId: null })).toBe(u);
    const rb = { type: "rollBackToEmbedded" as const, commitTime: 5 };
    expect(finalOutcome(rb, { currentUpdateId: "e1", embeddedUpdateId: "e1" })).toEqual({ type: "noUpdateAvailable" });
    expect(finalOutcome(rb, { currentUpdateId: update.uuid, embeddedUpdateId: "e1" })).toBe(rb);
    expect(finalOutcome(rb, { currentUpdateId: null, embeddedUpdateId: null })).toBe(rb);
  });
});
