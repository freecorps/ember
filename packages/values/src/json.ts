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
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Standard base64 (with padding). `url` = base64url without padding. Pure JS: no Buffer/btoa. */
export function bytesToBase64(bytes: Uint8Array, url = false): string {
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
  return url ? out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new Error("Invalid base64");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX.get(clean[i]!)!;
    const b = B64_INDEX.get(clean[i + 1]!)!;
    const c = i + 2 < clean.length ? B64_INDEX.get(clean[i + 2]!)! : 0;
    const d = i + 3 < clean.length ? B64_INDEX.get(clean[i + 3]!)! : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >> 16;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
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
  const keys = Object.keys(x);
  if (keys.length === 1) {
    const k = keys[0]!;
    const val = x[k];
    if (k === "$int64" && typeof val === "string") return BigInt(val);
    if (k === "$bytes" && typeof val === "string") return base64ToBytes(val);
    if (k === "$float" && typeof val === "string") {
      if (val === "-0") return -0;
      return Number(val);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, item] of Object.entries(x)) {
    // A "__proto__" key is data (as JSON.parse made it), never the object's prototype.
    if (k === "__proto__") Object.defineProperty(out, k, { value: fromJSONValue(item), enumerable: true, writable: true, configurable: true });
    else out[k] = fromJSONValue(item);
  }
  return out;
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
      return Number.isFinite(x) && !Object.is(x, -0);
    case "object": {
      if (x === null) return true;
      // JSON.stringify would call it (arrays included); toJSONValue ignores it.
      if ("toJSON" in (x as object)) return false;
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
 * `JSON.parse` alone when the text cannot hold a tag: tags are keys starting with "$" (always written `"$…`), and
 * `\u` escapes could spell one; anything else takes the tag-decoding pass.
 */
export const parseValue = (s: string): unknown => {
  if (!s.includes('"$') && !s.includes("\\u")) return JSON.parse(s);
  return fromJSONValue(JSON.parse(s));
};

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
