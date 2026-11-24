// JSON forms of Ember values.
// - Wire/storage JSON: plain JSON with tagged objects for what JSON cannot carry:
//     bigint -> {"$int64": "123"}, Uint8Array -> {"$bytes": "<base64>"},
//     NaN / Infinity / -Infinity / -0 -> {"$float": "NaN" | "Infinity" | "-Infinity" | "-0"}.
//   Field names starting with "$" are rejected by validation, so tags cannot collide with user data.
// - JSON Schema of a Shape (for OpenAPI / tooling), describing the wire form.

import { literalValue, type Shape } from "./shape.ts";
import { isPlainObject } from "./validate.ts";

export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** char code -> 6-bit value (both alphabets: `+`/`-` are 62, `/`/`_` 63), -1 for anything else. */
const B64_LOOKUP = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) {
    t[B64.charCodeAt(i)] = i;
    t[B64_URL.charCodeAt(i)] = i;
  }
  return t;
})();

const B64_CODES = Uint8Array.from(B64, (c) => c.charCodeAt(0));
const B64_URL_CODES = Uint8Array.from(B64_URL, (c) => c.charCodeAt(0));
/** Base64 is ASCII, so valid UTF-8: the platform decoder turns the char codes into the string natively. */
const ascii = typeof TextDecoder === "function" ? new TextDecoder() : undefined;

/** Standard base64 (with padding). `url` = base64url without padding. Pure JS: no Buffer/btoa. */
export function bytesToBase64(bytes: Uint8Array, url = false): string {
  if (!ascii) return bytesToBase64Concat(bytes, url);
  const A = url ? B64_URL_CODES : B64_CODES;
  const len = bytes.length;
  const rest = len % 3;
  const full = len - rest;
  // The output's char codes in one array, decoded once (no string built per 3 bytes).
  const out = new Uint8Array((((len + 2) / 3) | 0) * 4);
  let o = 0;
  for (let i = 0; i < full; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = A[n >> 18]!;
    out[o++] = A[(n >> 12) & 63]!;
    out[o++] = A[(n >> 6) & 63]!;
    out[o++] = A[n & 63]!;
  }
  if (rest === 1) {
    const n = bytes[full]! << 16;
    out[o++] = A[n >> 18]!;
    out[o++] = A[(n >> 12) & 63]!;
    if (!url) {
      out[o++] = 61;
      out[o++] = 61;
    }
  } else if (rest === 2) {
    const n = (bytes[full]! << 16) | (bytes[full + 1]! << 8);
    out[o++] = A[n >> 18]!;
    out[o++] = A[(n >> 12) & 63]!;
    out[o++] = A[(n >> 6) & 63]!;
    if (!url) out[o++] = 61;
  }
  return ascii.decode(o === out.length ? out : out.subarray(0, o));
}

/** `bytesToBase64` where the platform has no TextDecoder. */
function bytesToBase64Concat(bytes: Uint8Array, url: boolean): string {
  const A = url ? B64_URL : B64;
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += A[n >> 18]! + A[(n >> 12) & 63]! + A[(n >> 6) & 63]! + A[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += A[n >> 18]! + A[(n >> 12) & 63]! + (url ? "" : "==");
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += A[n >> 18]! + A[(n >> 12) & 63]! + A[(n >> 6) & 63]! + (url ? "" : "=");
  }
  return out;
}

/** Either alphabet, padding optional (trailing `=` only). */
export function base64ToBytes(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--;
  if (len % 4 === 1) throw new Error("Invalid base64");
  const at = (i: number): number => {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c]! : -1;
    if (v < 0) throw new Error("Invalid base64");
    return v;
  };
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = at(i);
    const b = at(i + 1);
    const c = i + 2 < len ? at(i + 2) : 0;
    const d = i + 3 < len ? at(i + 3) : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >> 16;
    if (i + 2 < len) out[o++] = (n >> 8) & 255;
    if (i + 3 < len) out[o++] = n & 255;
  }
  return out;
}

/** Ember value -> JSON-safe value (tags for bigint, bytes and non-finite / negative-zero numbers). */
export function toJSONValue(x: unknown): JSONValue {
  switch (typeof x) {
    case "string":
    case "boolean":
      return x;
    case "number":
      if (Number.isFinite(x) && !Object.is(x, -0)) return x;
      return { $float: Number.isNaN(x) ? "NaN" : Object.is(x, -0) ? "-0" : x > 0 ? "Infinity" : "-Infinity" };
    case "bigint":
      return { $int64: x.toString() };
    case "undefined":
      return null;
    case "object": {
      if (x === null) return null;
      if (x instanceof Uint8Array) return { $bytes: bytesToBase64(x) };
      if (Array.isArray(x)) return x.map(toJSONValue);
      const out: Record<string, JSONValue> = {};
      for (const [k, item] of Object.entries(x)) {
        if (item === undefined) continue;
        // A "__proto__" key is data (JSON.stringify writes it), never the copy's prototype.
        if (k === "__proto__") Object.defineProperty(out, k, { value: toJSONValue(item), enumerable: true, writable: true, configurable: true });
        else out[k] = toJSONValue(item);
      }
      return out;
    }
    default:
      throw new Error(`Cannot convert ${typeof x} to JSON`);
  }
}

/** Inverse of `toJSONValue`. */
export function fromJSONValue(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(fromJSONValue);
  if (!isPlainObject(x)) return x;
  const tag = untag(x);
  if (tag !== NOT_A_TAG) return tag;
  const out: Record<string, unknown> = {};
  for (const [k, item] of Object.entries(x)) {
    // A "__proto__" key is data (as JSON.parse made it), never the object's prototype.
    if (k === "__proto__") Object.defineProperty(out, k, { value: fromJSONValue(item), enumerable: true, writable: true, configurable: true });
    else out[k] = fromJSONValue(item);
  }
  return out;
}

const NOT_A_TAG: unique symbol = Symbol("ember.notATag");

/** The value a tag object (`{$int64}`, `{$bytes}`, `{$float}` with a string) stands for; NOT_A_TAG otherwise. */
function untag(x: Record<string, unknown>): unknown {
  const keys = Object.keys(x);
  if (keys.length !== 1) return NOT_A_TAG;
  const k = keys[0]!;
  const val = x[k];
  if (typeof val !== "string") return NOT_A_TAG;
  if (k === "$int64") return BigInt(val);
  if (k === "$bytes") return base64ToBytes(val);
  if (k === "$float") return val === "-0" ? -0 : Number(val);
  return NOT_A_TAG;
}

/**
 * `fromJSONValue(x)` for a value JSON.parse just made (nobody else holds it): tags are replaced in place, and only
 * the containers that hold one are touched (no copy of every object and array).
 */
function reviveInPlace(x: unknown): unknown {
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) {
      const item = x[i];
      if (typeof item === "object" && item !== null) {
        const r = reviveInPlace(item);
        if (r !== item) x[i] = r;
      }
    }
    return x;
  }
  if (typeof x !== "object" || x === null) return x;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const tag = untag(o);
    if (tag !== NOT_A_TAG) return tag;
  }
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const item = o[k];
    if (typeof item !== "object" || item === null) continue;
    const r = reviveInPlace(item);
    if (r === item) continue;
    // A "__proto__" key is data (as JSON.parse made it), never the object's prototype.
    if (k === "__proto__") Object.defineProperty(o, k, { value: r, enumerable: true, writable: true, configurable: true });
    else o[k] = r;
  }
  return o;
}

/**
 * True when `JSON.stringify(x)` already is the canonical tagged JSON of `x`: nothing to tag (bigint, bytes,
 * non-finite or negative-zero numbers), nothing `toJSONValue` would reject (functions, symbols) and only plain
 * objects and arrays (no `toJSON`, Dates or class instances, which JSON.stringify would render differently).
 * Walks without allocating; a cycle overflows the stack as `toJSONValue` does.
 */
function plainJson(x: unknown): boolean {
  switch (typeof x) {
    case "string":
    case "boolean":
    case "undefined":
      return true;
    case "number":
      // Finite and not -0 (1 / -0 is -Infinity).
      return Number.isFinite(x) && (x !== 0 || 1 / x > 0);
    case "object": {
      if (x === null) return true;
      // JSON.stringify would call it (arrays included); toJSONValue ignores it.
      if (typeof (x as { toJSON?: unknown }).toJSON === "function") return false;
      if (Array.isArray(x)) {
        for (let i = 0; i < x.length; i++) if (!plainJson(x[i])) return false;
        return true;
      }
      const proto = Object.getPrototypeOf(x);
      if (proto !== Object.prototype && proto !== null) return false;
      for (const k in x as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
        if (!plainJson((x as Record<string, unknown>)[k])) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/** One pass when there is nothing to tag (the common case); the same text as `JSON.stringify(toJSONValue(x))`. */
export const stringifyValue = (x: unknown): string => {
  if (x === undefined) return "null";
  return plainJson(x) ? JSON.stringify(x) : JSON.stringify(toJSONValue(x));
};
/**
 * `JSON.parse` alone when the text cannot hold a tag. A tag key is a JSON string that decodes to `$int64`, `$bytes` or
 * `$float`: its text starts `"$` or `"\u` (a `\u0024`; no other escape spells `$` or a letter), and when it starts
 * `"$` the rest is plain (TAG_KEY) or holds a `\u` escape. Anything that may hold one takes the tag-decoding pass.
 */
export const parseValue = (s: string): unknown => {
  // Only the three tags are ever decoded (`fromJSONValue`): other `"$…` keys pass through as they are.
  // One scan for the common text (no string starting `"$` or `"\`), cheaper than the exact tests that follow.
  if (!MAYBE_TAG.test(s)) return JSON.parse(s);
  if (!ESCAPED_START.test(s) && (!DOLLAR_START.test(s) || (!TAG_KEY.test(s) && !ANY_U_ESCAPE.test(s)))) return JSON.parse(s);
  return reviveInPlace(JSON.parse(s));
};
// RegExps with a character class, not `includes` nor literal patterns: V8 scans for these short needles several
// times faster that way (measured in scripts/bench-hot-path.ts).
const MAYBE_TAG = /"[\\$]/;
const ESCAPED_START = /"\\[u]/;
const DOLLAR_START = /"[$]/;
const ANY_U_ESCAPE = /[\\]u/;
const TAG_KEY = /"\$(?:int64|bytes|float)"/;

/**
 * The canonical tagged JSON text of an Ember value (wire protocol, change log, `_json` column):
 * `{"$int64":"…"}`, `{"$bytes":"<base64>"}`, `{"$float":"NaN"|"Infinity"|"-Infinity"|"-0"}`.
 */
export const encodeJson = stringifyValue;
/** Inverse of `encodeJson`. */
export const decodeJson = parseValue;

/** Like `encodeJson` but with object keys sorted (stable cache keys, hashing). */
export function encodeJsonStable(x: unknown): string {
  const sort = (j: JSONValue): JSONValue =>
    Array.isArray(j) ? j.map(sort) : j && typeof j === "object" ? Object.fromEntries(Object.keys(j).sort().map((k) => [k, sort(j[k]!)])) : j;
  return JSON.stringify(sort(toJSONValue(x)));
}

// ---------------------------------------------------------------------------------------------- JSON Schema

export type JsonSchema = Record<string, unknown>;

const FLOAT_SPECIALS: ReadonlyArray<readonly [string, number]> = [
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["-0", -0],
];

/** JSON Schema has no flags: `i`, `m` and `s` become an inline group (`(?i:...)`); `u`/`v` are the JSON Schema default. */
function patternWithFlags(pattern: string, flags: string | undefined): string {
  const mods = (flags ?? "").replace(/[^ims]/g, "");
  return mods ? `(?${mods}:${pattern})` : pattern;
}

/** JSON Schema (2020-12) of the wire form of `shape`. */
export function toJsonSchema(shape: Shape): JsonSchema {
  switch (shape.kind) {
    case "string": {
      const c = shape.checks;
      if (!c) return { type: "string" };
      return {
        type: "string",
        ...(c.minLength !== undefined ? { minLength: c.minLength } : {}),
        ...(c.maxLength !== undefined ? { maxLength: c.maxLength } : {}),
        ...(c.pattern !== undefined ? { pattern: patternWithFlags(c.pattern, c.flags) } : {}),
        ...(c.format === "email" ? { format: "email" } : c.format === "url" ? { format: "uri" } : c.format === "uuid" ? { format: "uuid" } : {}),
      };
    }
    case "file":
      return { type: "string", "x-ember-file": true };
    case "id":
      return { type: "string", "x-ember-id": shape.table };
    case "number": {
      const c = shape.checks;
      const plain = {
        type: c?.int ? "integer" : "number",
        ...(c?.min !== undefined ? { minimum: c.min } : {}),
        ...(c?.max !== undefined ? { maximum: c.max } : {}),
      };
      // The tagged specials the refinements still accept (same rules as the runtime check).
      const specials = FLOAT_SPECIALS.filter(([, x]) => !c || ((!c.int || Number.isInteger(x)) && (c.min === undefined || x >= c.min) && (c.max === undefined || x <= c.max)));
      if (!specials.length) return plain;
      return {
        anyOf: [plain, { type: "object", properties: { $float: { enum: specials.map(([tag]) => tag) } }, required: ["$float"], additionalProperties: false }],
      };
    }
    case "int64":
      return int64Schema;
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "bytes":
      return { type: "object", properties: { $bytes: { type: "string", contentEncoding: "base64" } }, required: ["$bytes"], additionalProperties: false };
    case "any":
      return {};
    case "literal": {
      const val = literalValue(shape);
      return typeof val === "bigint"
        ? { type: "object", properties: { $int64: { const: val.toString() } }, required: ["$int64"], additionalProperties: false }
        : { const: val };
    }
    case "array":
      return {
        type: "array",
        items: toJsonSchema(shape.item),
        ...(shape.checks?.minItems !== undefined ? { minItems: shape.checks.minItems } : {}),
        ...(shape.checks?.maxItems !== undefined ? { maxItems: shape.checks.maxItems } : {}),
      };
    case "record":
      return { type: "object", additionalProperties: toJsonSchema(shape.value), propertyNames: { pattern: "^[^$]" } };
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [k, f] of Object.entries(shape.fields)) {
        const p = toJsonSchema(f.shape);
        if (f.description !== undefined) p.description = f.description;
        if (f.default !== undefined) p.default = f.default;
        properties[k] = p;
        if (!f.optional) required.push(k);
      }
      return { type: "object", properties, required, additionalProperties: false };
    }
    case "union":
      return { anyOf: shape.members.map(toJsonSchema) };
  }
}

const int64Schema: JsonSchema = {
  type: "object",
  properties: { $int64: { type: "string", pattern: "^-?[0-9]+$" } },
  required: ["$int64"],
  additionalProperties: false,
};
