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
      for (const [k, item] of Object.entries(x)) if (item !== undefined) out[k] = toJSONValue(item);
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
  for (const [k, item] of Object.entries(x)) out[k] = fromJSONValue(item);
  return out;
}

export const stringifyValue = (x: unknown): string => JSON.stringify(toJSONValue(x));
export const parseValue = (s: string): unknown => fromJSONValue(JSON.parse(s));

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

/** JSON Schema (2020-12) of the wire form of `shape`. */
export function toJsonSchema(shape: Shape): JsonSchema {
  switch (shape.kind) {
    case "string":
      return { type: "string" };
    case "file":
      return { type: "string", "x-ember-file": true };
    case "id":
      return { type: "string", "x-ember-id": shape.table };
    case "number":
      return {
        anyOf: [
          { type: "number" },
          { type: "object", properties: { $float: { enum: ["NaN", "Infinity", "-Infinity", "-0"] } }, required: ["$float"], additionalProperties: false },
        ],
      };
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
      return { type: "array", items: toJsonSchema(shape.item) };
    case "record":
      return { type: "object", additionalProperties: toJsonSchema(shape.value), propertyNames: { pattern: "^[^$]" } };
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [k, f] of Object.entries(shape.fields)) {
        properties[k] = toJsonSchema(f.shape);
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
