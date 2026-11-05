import { describe, expect, test } from "vitest";
import { decodeJwt, importSigningKey, pemToDer, signJwt, verifyJwt } from "../src/jwt.ts";
import { apnsKey, serviceAccount } from "./keys.ts";

describe("JWT signing on WebCrypto", () => {
  test("ES256 with a .p8-style key: header, claims and a raw r‖s signature that verifies", async () => {
    const k = await apnsKey();
    const key = await importSigningKey(k.pem, "ES256");
    const token = await signJwt("ES256", key, { iss: k.teamId, iat: 1_700_000_000 }, { kid: k.keyId });
    const { header, claims, signature } = decodeJwt(token);
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: k.keyId });
    expect(claims).toEqual({ iss: k.teamId, iat: 1_700_000_000 });
    expect(signature.length).toBe(64);
    expect(await verifyJwt(token, "ES256", k.publicKey)).toBe(true);
    const other = await apnsKey();
    expect(await verifyJwt(token, "ES256", other.publicKey)).toBe(false);
  });

  test("RS256 with a service-account key verifies; tampered claims do not", async () => {
    const sa = await serviceAccount();
    const key = await importSigningKey(sa.json.private_key, "RS256");
    const token = await signJwt("RS256", key, { iss: sa.json.client_email, aud: sa.json.token_uri });
    expect(await verifyJwt(token, "RS256", sa.publicKey)).toBe(true);
    const [h, , s] = token.split(".");
    const forged = `${h}.${btoa(JSON.stringify({ iss: "evil" })).replace(/=+$/, "")}.${s}`;
    expect(await verifyJwt(forged, "RS256", sa.publicKey)).toBe(false);
    expect(await verifyJwt(token, "ES256", sa.publicKey)).toBe(false);
  });

  test("PEM as secrets deliver it: escaped newlines, CRLF, quotes", async () => {
    const k = await apnsKey();
    const der = pemToDer(k.pem);
    expect(pemToDer(JSON.stringify(k.pem).slice(1, -1))).toEqual(der); // "\n" as two characters
    expect(pemToDer(`"${k.pem.replace(/\n/g, "\r\n")}"`)).toEqual(der);
    await expect(importSigningKey(JSON.stringify(k.pem), "ES256")).resolves.toBeDefined();
  });

  test("clear errors for non-PKCS#8 or mismatched keys", async () => {
    expect(() => pemToDer("not a key")).toThrow(/not a PEM/);
    expect(() => pemToDer("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----")).toThrow(/PKCS#8/);
    const sa = await serviceAccount();
    await expect(importSigningKey(sa.json.private_key, "ES256")).rejects.toThrow(/P-256/);
  });
});
