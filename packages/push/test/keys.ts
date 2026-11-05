/** Test credentials made on the fly: an APNs-style `.p8` (P-256 PKCS#8 PEM) and a Google-style service account. */
import { toBase64url } from "../src/base64url.ts";

export function toPem(der: ArrayBuffer, label = "PRIVATE KEY"): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.replace(/.{1,64}/g, "$&\n")}-----END ${label}-----\n`;
}

export async function apnsKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pem: toPem(await crypto.subtle.exportKey("pkcs8", pair.privateKey)), publicKey: pair.publicKey, keyId: "ABC123DEFG", teamId: "TEAM123456" };
}

export async function serviceAccount(projectId = "ember-test") {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const json = {
    type: "service_account",
    project_id: projectId,
    private_key_id: "kid-1",
    private_key: toPem(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    client_email: `push@${projectId}.iam.gserviceaccount.com`,
    client_id: "1234",
    token_uri: "https://oauth2.googleapis.com/token",
  };
  return { json, text: JSON.stringify(json), publicKey: pair.publicKey };
}

export const b64u = toBase64url;
