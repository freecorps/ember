// Order-preserving key encoding (FoundationDB tuple style). memcmp of two encodings gives the logical order of
// the tuples they encode, so SQLite can index a BLOB column and a range read is `key >= lo AND key < hi`.
//
// Type order: undefined < null < int64 < number < boolean < string < bytes < array < object.
//
//   0x00            terminator (arrays, objects, strings, bytes); never a type tag
//   0x01            undefined (a missing field)
//   0x02            null
//   0x03 + 8 bytes  int64, big-endian with the sign bit flipped
//   0x04 + 8 bytes  float64, IEEE-754 total order: negative -> all bits flipped, positive -> sign bit flipped.
//                   -0 < +0; every NaN is canonicalised and sorts after +Infinity.
//   0x05 / 0x06     false / true
//   0x07 ... 0x00   string: UTF-8 of the code points (lone surrogates as 3-byte sequences, so it round-trips);
//                   a 0x00 byte is escaped as 0x00 0xFF
//   0x08 ... 0x00   bytes, escaped the same way
//   0x09 ... 0x00   array: the elements' encodings, then the terminator
//   0x0A ... 0x00   object: per entry (keys sorted by code point) 0x01, the key as an escaped string body, the
//                   value; then the terminator
//
// Every element encoding is self-delimiting, and after an element the next byte is a tag (<= 0x0A) or 0x00,
// never 0xFF. So the keys that start with the tuple prefix P are exactly the keys in [P, P ++ 0xFF), and
// K ++ 0x00 is the smallest key greater than K.

import { acquire, release, type Writer } from "./scratch.ts";
import { isPlainObject } from "./validate.ts";

export const TAG = {
  end: 0x00,
  undefined: 0x01,
  null: 0x02,
  int64: 0x03,
  number: 0x04,
  false: 0x05,
  true: 0x06,
  string: 0x07,
  bytes: 0x08,
  array: 0x09,
  object: 0x0a,
} as const;

export type KeyValue = unknown;

const f64 = new DataView(new ArrayBuffer(8));
const f64Bytes = new Uint8Array(f64.buffer);
const TWO63 = 2n ** 63n;

/** Code points as (WTF-)UTF-8, escaping 0x00, then the terminator. */
function writeStringBody(w: Writer, s: string) {
  const n = s.length;
  // At most 3 bytes per UTF-16 unit (a pair is 4 bytes for 2 units, an escaped NUL 2 for 1), plus the terminator.
  w.ensure(3 * n + 1);
  const buf = w.buf;
  let o = w.len;
  for (let i = 0; i < n; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      buf[o++] = c;
      if (c === 0) buf[o++] = 0xff;
      continue;
    }
    if (c < 0x800) {
      buf[o++] = 0xc0 | (c >> 6);
      buf[o++] = 0x80 | (c & 63);
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
        buf[o++] = 0xf0 | (c >> 18);
        buf[o++] = 0x80 | ((c >> 12) & 63);
        buf[o++] = 0x80 | ((c >> 6) & 63);
        buf[o++] = 0x80 | (c & 63);
        continue;
      }
    }
    // The rest of the BMP, lone surrogates included (3 bytes, so the string round-trips).
    buf[o++] = 0xe0 | (c >> 12);
    buf[o++] = 0x80 | ((c >> 6) & 63);
    buf[o++] = 0x80 | (c & 63);
  }
  buf[o++] = 0;
  w.len = o;
}

/** Bytes with 0x00 escaped, then the terminator. */
function writeBytesBody(w: Writer, x: Uint8Array) {
  if (x.indexOf(0) < 0) {
    w.ensure(x.length + 1);
    w.buf.set(x, w.len);
    w.len += x.length;
  } else {
    w.ensure(2 * x.length + 1);
    const buf = w.buf;
    let o = w.len;
    for (let i = 0; i < x.length; i++) {
      const b = x[i]!;
      buf[o++] = b;
      if (b === 0) buf[o++] = 0xff;
    }
    w.len = o;
  }
  w.byte(0);
}

/** The 8 bytes of `f64` after its tag (`flip`: every bit; otherwise only the sign bit). */
function writeF64(w: Writer, tag: number, flipAll: boolean) {
  w.ensure(9);
  const buf = w.buf;
  let o = w.len;
  buf[o++] = tag;
  if (flipAll) for (let i = 0; i < 8; i++) buf[o++] = f64Bytes[i]! ^ 0xff;
  else {
    buf[o++] = f64Bytes[0]! ^ 0x80;
    for (let i = 1; i < 8; i++) buf[o++] = f64Bytes[i]!;
  }
  w.len = o;
}

function writeValue(w: Writer, x: unknown, top: boolean) {
  switch (typeof x) {
    case "undefined":
      if (!top) throw new Error("undefined can only appear as a top-level key element");
      w.byte(TAG.undefined);
      return;
    case "bigint": {
      if (x < -TWO63 || x >= TWO63) throw new Error("int64 out of range");
      // Two's complement with the sign bit flipped is x + 2^63, big-endian.
      f64.setBigInt64(0, x);
      writeF64(w, TAG.int64, false);
      return;
    }
    case "number": {
      // Every NaN is canonicalised (0x7FF8...).
      if (x !== x) {
        f64.setUint32(0, 0x7ff80000);
        f64.setUint32(4, 0);
      } else f64.setFloat64(0, x);
      writeF64(w, TAG.number, (f64Bytes[0]! & 0x80) !== 0);
      return;
    }
    case "boolean":
      w.byte(x ? TAG.true : TAG.false);
      return;
    case "string":
      w.byte(TAG.string);
      writeStringBody(w, x);
      return;
    case "object": {
      if (x === null) {
        w.byte(TAG.null);
        return;
      }
      if (x instanceof Uint8Array) {
        w.byte(TAG.bytes);
        writeBytesBody(w, x);
        return;
      }
      if (Array.isArray(x)) {
        w.byte(TAG.array);
        for (const item of x) writeValue(w, item, false);
        w.byte(0);
        return;
      }
      if (isPlainObject(x)) {
        w.byte(TAG.object);
        const keys = Object.keys(x).filter((k) => x[k] !== undefined).sort(compareStrings);
        for (const k of keys) {
          w.byte(0x01);
          writeStringBody(w, k);
          writeValue(w, x[k], false);
        }
        w.byte(0);
        return;
      }
      throw new Error(`Cannot encode ${Object.prototype.toString.call(x)} in a key`);
    }
    default:
      throw new Error(`Cannot encode ${typeof x} in a key`);
  }
}

/** Encodes a tuple of values into an order-preserving byte string. */
export function encodeKey(values: readonly unknown[]): Uint8Array {
  const w = acquire();
  try {
    for (let i = 0; i < values.length; i++) writeValue(w, values[i], true);
    return w.finish();
  } finally {
    release(w);
  }
}

/** Encodes a single value (as a one-element tuple). */
export const encodeValue = (x: unknown): Uint8Array => {
  const w = acquire();
  try {
    writeValue(w, x, true);
    return w.finish();
  } finally {
    release(w);
  }
};

// ---------------------------------------------------------------------------------------------- decoding

class Reader {
  pos = 0;
  /** The last `readEscaped` returned a view of `b` (no escaped 0x00). */
  view = false;
  constructor(readonly b: Uint8Array) {}
  next(): number {
    if (this.pos >= this.b.length) throw new Error("Truncated key");
    return this.b[this.pos++]!;
  }
  peek(): number | undefined {
    return this.b[this.pos];
  }
}

/**
 * An escaped body up to its terminator: a view of the key when it holds no escaped 0x00 (the common case), else a
 * new array. Callers that hand the bytes out copy a view (`readBytes`).
 */
function readEscaped(r: Reader): Uint8Array {
  const b = r.b;
  const start = r.pos;
  const n = b.length;
  let z = start;
  while (z < n && b[z] !== 0) z++;
  if (z >= n) throw new Error("Truncated key");
  if (b[z + 1] !== 0xff) {
    r.pos = z + 1;
    r.view = true;
    return b.subarray(start, z);
  }
  // Escaped zeros: measure, then copy without the 0xFF after each data 0x00.
  let len = 0;
  let i = start;
  for (;;) {
    if (i >= n) throw new Error("Truncated key");
    const c = b[i]!;
    if (c === 0) {
      if (b[i + 1] !== 0xff) break;
      i++;
    }
    len++;
    i++;
  }
  const out = new Uint8Array(len);
  let o = 0;
  for (let j = start; j < i; j++) {
    const c = b[j]!;
    out[o++] = c;
    if (c === 0) j++;
  }
  r.pos = i + 1;
  r.view = false;
  return out;
}

/** A `bytes` value: always its own array (never a view of the key). */
function readBytes(r: Reader): Uint8Array {
  const b = readEscaped(r);
  // (Not `b.buffer`: reading it makes V8 materialize an ArrayBuffer for a small on-heap array.)
  return r.view ? b.slice() : b;
}

// `fatal`: anything that is not well-formed UTF-8 (lone surrogates, which the encoding writes as 3-byte sequences)
// throws instead of turning into U+FFFD, and `utf8ToStringSlow` decodes it. `ignoreBOM`: a leading U+FEFF is data.
const utf8 = typeof TextDecoder === "function" ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }) : undefined;

/** A string body (`readEscaped`, decoded). Short ASCII bodies (ids, names) are read in place, with no view. */
function readString(r: Reader): string {
  const b = r.b;
  const start = r.pos;
  const n = b.length;
  let z = start;
  let ascii = true;
  while (z < n) {
    const c = b[z]!;
    if (c === 0) break;
    if (c >= 0x80) ascii = false;
    z++;
  }
  if (ascii && z < n && b[z + 1] !== 0xff && z - start <= 32) {
    r.pos = z + 1;
    let s = "";
    for (let i = start; i < z; i++) s += String.fromCharCode(b[i]!);
    return s;
  }
  return utf8ToString(readEscaped(r));
}

function utf8ToString(bytes: Uint8Array): string {
  const n = bytes.length;
  for (let i = 0; i < n; i++) {
    // 0xED 0xA0..0xBF starts an encoded surrogate: not UTF-8 (TextDecoder would throw), decoded by hand.
    if (bytes[i] === 0xed && i + 1 < n && bytes[i + 1]! >= 0xa0) return utf8ToStringSlow(bytes);
  }
  if (!utf8) return utf8ToStringSlow(bytes);
  try {
    return utf8.decode(bytes);
  } catch {
    return utf8ToStringSlow(bytes);
  }
}

/** WTF-8 by hand (lone surrogates included); also what any malformed input decodes to. */
function utf8ToStringSlow(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    let c: number;
    if (b < 0x80) {
      c = b;
      i += 1;
    } else if (b < 0xe0) {
      c = ((b & 0x1f) << 6) | (bytes[i + 1]! & 63);
      i += 2;
    } else if (b < 0xf0) {
      c = ((b & 0x0f) << 12) | ((bytes[i + 1]! & 63) << 6) | (bytes[i + 2]! & 63);
      i += 3;
    } else {
      c = ((b & 0x07) << 18) | ((bytes[i + 1]! & 63) << 12) | ((bytes[i + 2]! & 63) << 6) | (bytes[i + 3]! & 63);
      i += 4;
    }
    if (c >= 0x10000) {
      c -= 0x10000;
      s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else s += String.fromCharCode(c);
  }
  return s;
}

/** The 8 bytes after a tag into `f64` (`flipAll`: every bit; otherwise only the sign bit). */
function readF64(r: Reader, flipAll: boolean | undefined): void {
  const b = r.b;
  const p = r.pos;
  if (p + 8 > b.length) {
    r.pos = b.length;
    throw new Error("Truncated key");
  }
  const all = flipAll ?? (b[p]! & 0x80) === 0;
  if (all) for (let i = 0; i < 8; i++) f64Bytes[i] = b[p + i]! ^ 0xff;
  else {
    f64Bytes[0] = b[p]! ^ 0x80;
    for (let i = 1; i < 8; i++) f64Bytes[i] = b[p + i]!;
  }
  r.pos = p + 8;
}

function readValue(r: Reader): unknown {
  const tag = r.next();
  switch (tag) {
    case TAG.undefined:
      return undefined;
    case TAG.null:
      return null;
    case TAG.int64:
      readF64(r, false);
      return f64.getBigInt64(0);
    case TAG.number:
      // A negative number was written with every bit flipped (its first byte then has the high bit clear).
      readF64(r, undefined);
      return f64.getFloat64(0);
    case TAG.false:
      return false;
    case TAG.true:
      return true;
    case TAG.string:
      return readString(r);
    case TAG.bytes:
      return readBytes(r);
    case TAG.array: {
      const out: unknown[] = [];
      while (r.peek() !== 0) out.push(readValue(r));
      r.pos++;
      return out;
    }
    case TAG.object: {
      const out: Record<string, unknown> = {};
      for (;;) {
        const m = r.next();
        if (m === 0) return out;
        if (m !== 0x01) throw new Error("Malformed object key");
        const k = readString(r);
        out[k] = readValue(r);
      }
    }
    default:
      throw new Error(`Unknown key tag 0x${tag.toString(16)}`);
  }
}

/** Decodes a key produced by `encodeKey` back into its tuple. */
export function decodeKey(key: Uint8Array): unknown[] {
  const r = new Reader(key);
  const out: unknown[] = [];
  while (r.pos < key.length) out.push(readValue(r));
  return out;
}

// ---------------------------------------------------------------------------------------------- bytes & bounds

/** memcmp: negative, zero or positive. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const FF = Uint8Array.of(0xff);
const ZERO = Uint8Array.of(0x00);

/** Exclusive upper bound of every key that starts with the tuple `prefix` (the encoded prefix ++ 0xFF). */
export const prefixEnd = (prefix: Uint8Array): Uint8Array => concatBytes(prefix, FF);
/** The smallest key strictly greater than `key` (key ++ 0x00). */
export const keySuccessor = (key: Uint8Array): Uint8Array => concatBytes(key, ZERO);

/** A half-open key range `[lo, hi)`. */
export type KeyRange = { lo: Uint8Array; hi: Uint8Array };

export type LowerBound = { op: "gt" | "gte"; value: unknown };
export type UpperBound = { op: "lt" | "lte"; value: unknown };

/**
 * The key range of an index read: equality on a prefix of the index fields, then optional lower/upper bounds on
 * the next field. Bounds are on tuples, so `gt(x)` excludes every key whose field equals `x` regardless of the
 * fields that follow.
 */
export function rangeFor(eq: readonly unknown[], lower?: LowerBound, upper?: UpperBound): KeyRange {
  // The prefix is encoded once; each bound is written after it in the same buffer: two arrays in all.
  const w = acquire();
  try {
    for (let i = 0; i < eq.length; i++) writeValue(w, eq[i], true);
    const p = w.len;
    let lo: Uint8Array;
    if (lower) {
      writeValue(w, lower.value, true);
      if (lower.op !== "gte") w.byte(0xff);
      lo = w.finish();
      w.len = p;
    } else lo = w.finish();
    if (upper) {
      writeValue(w, upper.value, true);
      if (upper.op !== "lt") w.byte(0xff);
    } else w.byte(0xff);
    return { lo, hi: w.finish() };
  } finally {
    release(w);
  }
}

/**
 * `{ lo: encodeKey(values), hi: keySuccessor(lo) }` (the range of exactly that key) from one encoding: `lo` is a view
 * of `hi`'s buffer without its last byte. Both are read-only.
 */
export function pointRange(values: readonly unknown[]): KeyRange {
  const w = acquire();
  try {
    for (let i = 0; i < values.length; i++) writeValue(w, values[i], true);
    w.byte(0);
    const hi = w.finish();
    return { lo: hi.subarray(0, hi.length - 1), hi };
  } finally {
    release(w);
  }
}

/** Whether `key` lies in `[lo, hi)`. */
export const inKeyRange = (key: Uint8Array, lo: Uint8Array, hi: Uint8Array): boolean =>
  compareBytes(key, lo) >= 0 && compareBytes(key, hi) < 0;

// ---------------------------------------------------------------------------------------------- logical order

const typeRank = (x: unknown): number => {
  switch (typeof x) {
    case "undefined":
      return 1;
    case "bigint":
      return 3;
    case "number":
      return 4;
    case "boolean":
      return 5;
    case "string":
      return 7;
    default:
      if (x === null) return 2;
      if (x instanceof Uint8Array) return 8;
      if (Array.isArray(x)) return 9;
      return 10;
  }
};

/** Code-point order (which equals UTF-8 byte order); JS `<` compares UTF-16 units and differs above U+FFFF. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // Compare whole code points: a surrogate pair stands for >= 0x10000 (after every BMP code point), and a lone
    // surrogate stands for itself. If the shared previous unit is a high surrogate, the code point began there.
    if (i > 0 && isHigh(a.charCodeAt(i - 1))) {
      const ca = cpRank(a, i - 1);
      const cb = cpRank(b, i - 1);
      if (ca !== cb) return ca - cb;
    }
    return cpRank(a, i) - cpRank(b, i);
  }
  return a.length - b.length;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;

function cpRank(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
  }
  return c;
}

/**
 * The order the key encoding gives numbers (sign-flipped IEEE 754), without BigInts: -0 before +0, every NaN equal
 * and after +Infinity.
 */
function compareNumbers(x: number, y: number): number {
  if (x === y) {
    if (x !== 0) return 0;
    const nx = 1 / x < 0;
    return nx === 1 / y < 0 ? 0 : nx ? -1 : 1;
  }
  const xn = x !== x;
  const yn = y !== y;
  if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
  return x < y ? -1 : 1;
}

/**
 * Logical comparison of two values in index order (the order `encodeKey` produces). Used for `.filter()`
 * comparisons and anywhere values are ordered outside SQL.
 */
export function compareValues(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 1:
    case 2:
      return 0;
    case 3:
      return (a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0;
    case 4:
      return compareNumbers(a as number, b as number);
    case 5:
      return Number(a) - Number(b);
    case 7:
      return Math.sign(compareStrings(a as string, b as string));
    case 8:
      return Math.sign(compareBytes(a as Uint8Array, b as Uint8Array));
    case 9: {
      const x = a as unknown[];
      const y = b as unknown[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compareValues(x[i], y[i]);
        if (c !== 0) return c;
      }
      return Math.sign(x.length - y.length);
    }
    default: {
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      const kx = Object.keys(x).filter((k) => x[k] !== undefined).sort(compareStrings);
      const ky = Object.keys(y).filter((k) => y[k] !== undefined).sort(compareStrings);
      for (let i = 0; i < Math.min(kx.length, ky.length); i++) {
        const c = compareStrings(kx[i]!, ky[i]!);
        if (c !== 0) return Math.sign(c);
        const d = compareValues(x[kx[i]!], y[ky[i]!]);
        if (d !== 0) return d;
      }
      return Math.sign(kx.length - ky.length);
    }
  }
}
