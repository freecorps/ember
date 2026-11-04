/**
 * Tagged JSON for values that plain JSON cannot carry (bigint, bytes).
 * `{"$bigint":"123"}` and `{"$bytes":"<base64>"}`.
 * TODO: swap for the canonical JSON encoding of `@ember/values` once it exists.
 */

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
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
      if (typeof o.$bytes === "string") return fromBase64(o.$bytes);
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

/** Deterministic JSON (sorted keys) used for cache keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(replacer.call(null, "", value)));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => sortKeys(replacer.call(null, "", x)));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(replacer.call(null, k, o[k]));
    return out;
  }
  return v;
}
