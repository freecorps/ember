// Ported from Freecorps Brigade, packages/push/src/base64url.ts (MIT License, Copyright (c) 2026 Freecorps Tecnologia da
// Informação LTDA; https://github.com/freecorps/brigade/tree/main/packages/push). Unchanged.

/** Base64url without padding (RFC 4648, section 5), the encoding of every binary field in a push. */
export function toBase64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64url, padded or not. Throws on any other character. */
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("invalid base64url");
  const binary = atob(value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
