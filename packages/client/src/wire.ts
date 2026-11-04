/**
 * Wire / storage JSON: the canonical tagged JSON of `@ember/values`, same as `packages/runtime/src/wire.ts`
 * (`{"$int64":"…"}`, `{"$bytes":"<base64>"}`, `{"$float":"NaN"|"Infinity"|"-Infinity"|"-0"}`).
 */
import { base64ToBytes, decodeJson, encodeJson, encodeJsonStable } from "@ember/values";

export const stringify: (value: unknown) => string = encodeJson;
export const parse: (text: string) => unknown = decodeJson;
/** Deterministic JSON (sorted keys): the client's identity for `(fn, args)` (dedup, cache keys). */
export const stableStringify: (value: unknown) => string = encodeJsonStable;
export const fromBase64: (s: string) => Uint8Array = base64ToBytes;
