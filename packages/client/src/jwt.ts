// The payload of a JWT, decoded once per token. The client looks at the same token on every `fromAuth` call (its claim
// picks the shard), every frame that renews it, every refresh check and, with `multiTab`, every hello and `auth` the
// leader routes: a base64 + JSON decode each time, for a value that never changes. Only a few tokens are alive at once
// (the current one, the one replacing it, the tabs' own): the most recently used ones are kept.
//
// No runtime import (as `unverifiedJwtPayload` of `@freecorps/ember-values`, which reads a payload the same way): the
// modules the client loads with `import()` (`multitab.ts`) use it, and a module they share with the main graph that
// imports the values package would make a bundler without code splitting wrap that whole package for lazy init.

const MAX = 16;
const payloads = new Map<string, Readonly<Record<string, unknown>> | null>();

/** Made on first use: importing this module must not need `TextDecoder` (absent from older Hermes builds). */
let utf8: TextDecoder | undefined;

/** Base64, either alphabet, padding optional (as `base64ToBytes`); null when it is not. */
function base64(s: string): Uint8Array | null {
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--;
  if (len % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const v = c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 71 : c >= 48 && c <= 57 ? c + 4 : c === 43 || c === 45 ? 62 : c === 47 || c === 95 ? 63 : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}

/** The payload of a JWT (frozen; null: not a JWT), decoded once per token. NOT verified: routing hints only. */
export function jwtPayload(token: string): Readonly<Record<string, unknown>> | null {
  const hit = payloads.get(token);
  if (hit !== undefined) {
    // Least recently used goes first: the current token, read on every call, never leaves while others churn.
    if (payloads.size > 1) {
      payloads.delete(token);
      payloads.set(token, hit);
    }
    return hit;
  }
  let payload: Readonly<Record<string, unknown>> | null = null;
  const parts = token.split(".");
  const bytes = parts.length === 3 && parts[1] ? base64(parts[1]) : null;
  if (bytes) {
    try {
      const p = JSON.parse((utf8 ??= new TextDecoder()).decode(bytes)) as unknown;
      if (typeof p === "object" && p !== null && !Array.isArray(p)) payload = Object.freeze(p as Record<string, unknown>);
    } catch {
      payload = null;
    }
  }
  if (payloads.size >= MAX) {
    const oldest = payloads.keys().next();
    if (!oldest.done) payloads.delete(oldest.value);
  }
  payloads.set(token, payload);
  return payload;
}
