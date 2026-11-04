// Index keys in JavaScript, ordered exactly as SQLite orders the index (so a JS range check on a changed row
// agrees with what an SQL range scan would return), plus document ids.

import type { Bound, Doc } from "./types";
import { isPlainObject, toJson } from "./values";

/** A document field as the index sees it: json_extract / column semantics (undefined -> null, bool -> 0/1). */
export function keyPart(doc: Record<string, unknown>, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur)) return null;
    cur = cur[part];
  }
  if (cur === undefined || cur === null) return null;
  if (typeof cur === "boolean") return cur ? 1 : 0;
  if (typeof cur === "object") return toJson(cur); // json_extract returns JSON text for objects/arrays
  return cur;
}

export const keyOf = (doc: Doc, fields: string[]) => fields.map((f) => keyPart(doc, f));

/** SQLite order: NULL < numbers (integer and real compare numerically) < TEXT (BINARY = UTF-8 bytes). */
export function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  return compareUtf8(a as string, b as string);
}

function rank(x: unknown): number {
  if (x === null || x === undefined) return 0;
  if (typeof x === "number" || typeof x === "bigint") return 1;
  if (typeof x === "string") return 2;
  throw new Error(`Unindexable key value ${String(x)}`);
}

/** Code point order equals UTF-8 byte order (JS `<` compares UTF-16 units, which differs above U+FFFF). */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}

/** Compares `key` against a bound's (possibly shorter) prefix. */
export function comparePrefix(key: unknown[], prefix: unknown[]): number {
  for (let i = 0; i < prefix.length; i++) {
    const c = compareValues(key[i], prefix[i]);
    if (c !== 0) return c;
  }
  return 0;
}

export function inRange(key: unknown[], lower: Bound | null, upper: Bound | null): boolean {
  if (lower) {
    const c = comparePrefix(key, lower.key);
    if (c < 0 || (c === 0 && !lower.inclusive)) return false;
  }
  if (upper) {
    const c = comparePrefix(key, upper.key);
    if (c > 0 || (c === 0 && !upper.inclusive)) return false;
  }
  return true;
}

// -------------------------------------------------------------------------------------------------------- ids
//
// Like Convex: an id is self-describing. bytes = 14 random | varint(table number) | fletcher16 checksum,
// base32 (lowercase, no padding) -> ~27 chars. `db.get(id)` finds the table from the id, and a client can tell
// which table an id belongs to without a round trip. (Convex: 16 random bytes, 31-32 chars.)

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function encodeId(tableNumber: number, random = crypto.getRandomValues(new Uint8Array(14))): string {
  const bytes = [...random];
  let n = tableNumber;
  do {
    bytes.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n >>>= 7;
  } while (n > 0);
  const [s1, s2] = fletcher16(bytes);
  bytes.push(s1, s2);
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

export function decodeId(id: string): number | undefined {
  if (typeof id !== "string" || id.length < 26 || id.length > 40) return undefined;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of id) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return undefined;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  if (bytes.length < 17) return undefined;
  const body = bytes.slice(0, -2);
  const [s1, s2] = fletcher16(body);
  if (s1 !== bytes[bytes.length - 2] || s2 !== bytes[bytes.length - 1]) return undefined;
  let n = 0;
  let shift = 0;
  for (const b of body.slice(14)) {
    n |= (b & 0x7f) << shift;
    shift += 7;
  }
  return n;
}

function fletcher16(bytes: number[]): [number, number] {
  let a = 0;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 255;
    b = (b + a) % 255;
  }
  return [a, b];
}
