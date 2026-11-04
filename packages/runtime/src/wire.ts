/**
 * Wire / storage JSON: the canonical tagged JSON of `@freecorps/ember-values`
 * (`{"$int64":"…"}`, `{"$bytes":"<base64>"}`, `{"$float":"NaN"|"Infinity"|"-Infinity"|"-0"}`).
 * Used for protocol frames, HTTP bodies, the change log, dedup results, `_ember_subs` args and job args.
 */
import { decodeJson, encodeJson, encodeJsonStable } from "@freecorps/ember-values";

export const stringify: (value: unknown) => string = encodeJson;
export const parse: (text: string) => unknown = decodeJson;
/** Deterministic JSON (sorted keys) used for cache keys. */
export const stableStringify: (value: unknown) => string = encodeJsonStable;
