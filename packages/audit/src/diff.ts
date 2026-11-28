// The diff an audit row keeps (contracts.md "Audit"): only the fields a write changed, the redacted ones as
// "[redacted]", within a byte cap. Pure module: no Cloudflare or Node APIs.
//
//   { <field>: { from?: <old value>, to?: <new value> } }
//
// `from` is absent when the field did not exist before (an insert, or a field set by an update), `to` when it no
// longer exists (a delete, or a field removed). Values are Ember values (`v.any()`: bigint and bytes included).

import { encodeJson, encodeJsonStable } from "@freecorps/ember-values";

export const REDACTED = "[redacted]";
export const TRUNCATED = "[truncated]";
/** Default byte cap of a row's diff (its tagged-JSON size). */
export const DEFAULT_MAX_DIFF_BYTES = 4096;
/** The largest cap an install may set. */
export const MAX_DIFF_BYTES = 64 * 1024;

export type FieldChange = { from?: unknown; to?: unknown };
export type Diff = Record<string, FieldChange>;

export interface DiffOptions {
  /** Only these fields are audited (default: every field). */
  fields?: readonly string[];
  /** Fields never audited (`updatedAt`, counters). */
  ignore?: readonly string[];
  /** Fields whose values are never stored: a change shows as `"[redacted]"`. */
  redact?: readonly string[];
  /** Byte cap of the diff (default 4096, at most 64 KiB). */
  maxBytes?: number;
}

export interface DiffResult {
  diff: Diff;
  /** Values replaced by `"[truncated]"` to fit the cap. */
  truncated: boolean;
  /** Fields left out entirely because not even their names fit. */
  omitted: number;
}

const SYSTEM = new Set(["_id", "_creationTime"]);
const bytes = (x: unknown) => new TextEncoder().encode(encodeJson(x)).byteLength;
const same = (a: unknown, b: unknown) => encodeJsonStable(a) === encodeJsonStable(b);

/** The audited fields of a document (system fields never are). */
function auditedKeys(doc: Record<string, unknown> | null, o: DiffOptions): string[] {
  if (!doc) return [];
  return Object.keys(doc).filter((k) => !SYSTEM.has(k) && (!o.fields || o.fields.includes(k)) && !o.ignore?.includes(k));
}

/**
 * The changed audited fields between two versions of a document (`null` = did not exist / no longer exists).
 * Null when an update changed no audited field (no row is written for it).
 */
export function auditDiff(oldDoc: Record<string, unknown> | null, newDoc: Record<string, unknown> | null, o: DiffOptions = {}): DiffResult | null {
  const keys = [...new Set([...auditedKeys(newDoc, o), ...auditedKeys(oldDoc, o)])];
  const diff: Diff = {};
  for (const k of keys) {
    const a = oldDoc?.[k];
    const b = newDoc?.[k];
    if (a === undefined && b === undefined) continue;
    if (a !== undefined && b !== undefined && same(a, b)) continue;
    const red = o.redact?.includes(k);
    const c: FieldChange = {};
    if (a !== undefined) c.from = red ? REDACTED : a;
    if (b !== undefined) c.to = red ? REDACTED : b;
    diff[k] = c;
  }
  if (oldDoc && newDoc && !Object.keys(diff).length) return null;
  return capDiff(diff, o.maxBytes);
}

/** Fits a diff in `maxBytes`: whole changes while they fit, then `"[truncated]"` values, then the rest left out. */
export function capDiff(diff: Diff, maxBytes = DEFAULT_MAX_DIFF_BYTES): DiffResult {
  const max = Math.max(256, Math.min(MAX_DIFF_BYTES, Math.floor(maxBytes)));
  if (bytes(diff) <= max) return { diff, truncated: false, omitted: 0 };
  const out: Diff = {};
  let truncated = false;
  let omitted = 0;
  // Room for the row's own bookkeeping is not needed: `truncated`/`omitted` are row fields, not in the diff.
  for (const [k, c] of Object.entries(diff)) {
    out[k] = c;
    if (bytes(out) <= max) continue;
    const short: FieldChange = {};
    if ("from" in c) short.from = TRUNCATED;
    if ("to" in c) short.to = TRUNCATED;
    out[k] = short;
    truncated = true;
    if (bytes(out) <= max) continue;
    delete out[k];
    omitted++;
  }
  return { diff: out, truncated, omitted };
}
