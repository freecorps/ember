/**
 * Tagged JSON for values plain JSON cannot carry, mirroring `packages/runtime/src/wire.ts`:
 * `{"$bigint":"123"}` and `{"$bytes":"<base64>"}`.
 *
 * TODO: switch to `@ember/values` once it exports `encodeJson`/`decodeJson` and the runtime agrees on the tags.
 * `@ember/values` currently tags bigint as `$int64` (and has `$float`); the runtime uses `$bigint`. We encode what
 * the runtime decodes (`$bigint`) and accept both on decode.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]!] = i;

/** Pure JS base64 (React Native has no reliable btoa/atob for binary strings). */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX[clean[i]!] ?? 0;
    const b = B64_INDEX[clean[i + 1]!] ?? 0;
    const c = B64_INDEX[clean[i + 2] ?? "A"] ?? 0;
    const d = B64_INDEX[clean[i + 3] ?? "A"] ?? 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  if (value instanceof ArrayBuffer) return { $bytes: toBase64(new Uint8Array(value)) };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1) {
      if (typeof o.$bigint === "string") return BigInt(o.$bigint);
      if (typeof o.$int64 === "string") return BigInt(o.$int64);
      if (typeof o.$bytes === "string") return fromBase64(o.$bytes);
      if (typeof o.$float === "string") {
        if (o.$float === "NaN") return NaN;
        if (o.$float === "Infinity") return Infinity;
        if (o.$float === "-Infinity") return -Infinity;
        if (o.$float === "-0") return -0;
      }
    }
  }
  return value;
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, replacer);
}

export function parse(text: string): unknown {
  return JSON.parse(text, reviver);
}

/** Deterministic JSON (sorted keys): the client's identity for `(fn, args)` (dedup, cache keys). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(v: unknown): unknown {
  const x = replacer.call(null, "", v);
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return x;
}
