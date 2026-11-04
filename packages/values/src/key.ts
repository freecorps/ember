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

class Writer {
  buf = new Uint8Array(64);
  len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const f64 = new DataView(new ArrayBuffer(8));
const TWO63 = 2n ** 63n;
const MASK64 = 2n ** 64n - 1n;

function writeEscapedByte(w: Writer, b: number) {
  w.byte(b);
  if (b === 0) w.byte(0xff);
}

/** Code points as (WTF-)UTF-8, escaping 0x00, then the terminator. */
function writeStringBody(w: Writer, s: string) {
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) writeEscapedByte(w, c);
    else if (c < 0x800) {
      w.byte(0xc0 | (c >> 6));
      w.byte(0x80 | (c & 63));
    } else if (c < 0x10000) {
      w.byte(0xe0 | (c >> 12));
      w.byte(0x80 | ((c >> 6) & 63));
      w.byte(0x80 | (c & 63));
    } else {
      w.byte(0xf0 | (c >> 18));
      w.byte(0x80 | ((c >> 12) & 63));
      w.byte(0x80 | ((c >> 6) & 63));
      w.byte(0x80 | (c & 63));
    }
  }
  w.byte(0);
}

function writeValue(w: Writer, x: unknown, top: boolean) {
  switch (typeof x) {
    case "undefined":
      if (!top) throw new Error("undefined can only appear as a top-level key element");
      w.byte(TAG.undefined);
      return;
    case "bigint": {
      if (x < -TWO63 || x >= TWO63) throw new Error("int64 out of range");
      const u = (x + TWO63) & MASK64;
      w.byte(TAG.int64);
      for (let i = 7; i >= 0; i--) w.byte(Number((u >> BigInt(i * 8)) & 0xffn));
      return;
    }
    case "number": {
      w.byte(TAG.number);
      f64.setFloat64(0, Number.isNaN(x) ? NaN : x);
      if (Number.isNaN(x)) f64.setBigUint64(0, 0x7ff8000000000000n);
      const negative = (f64.getUint8(0) & 0x80) !== 0;
      for (let i = 0; i < 8; i++) {
        const b = f64.getUint8(i);
        w.byte(negative ? b ^ 0xff : i === 0 ? b ^ 0x80 : b);
      }
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
        for (const b of x) writeEscapedByte(w, b);
        w.byte(0);
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
  const w = new Writer();
  for (const x of values) writeValue(w, x, true);
  return w.finish();
}

/** Encodes a single value (as a one-element tuple). */
export const encodeValue = (x: unknown): Uint8Array => encodeKey([x]);

// ---------------------------------------------------------------------------------------------- decoding

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  next(): number {
    if (this.pos >= this.b.length) throw new Error("Truncated key");
    return this.b[this.pos++]!;
  }
  peek(): number | undefined {
    return this.b[this.pos];
  }
}

function readEscaped(r: Reader): Uint8Array {
  const out: number[] = [];
  for (;;) {
    const b = r.next();
    if (b === 0) {
      if (r.peek() === 0xff) {
        r.pos++;
        out.push(0);
      } else return Uint8Array.from(out);
    } else out.push(b);
  }
}

function utf8ToString(bytes: Uint8Array): string {
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

function readValue(r: Reader): unknown {
  const tag = r.next();
  switch (tag) {
    case TAG.undefined:
      return undefined;
    case TAG.null:
      return null;
    case TAG.int64: {
      let u = 0n;
      for (let i = 0; i < 8; i++) u = (u << 8n) | BigInt(r.next());
      return u - TWO63;
    }
    case TAG.number: {
      const first = r.next();
      const negative = (first & 0x80) === 0;
      f64.setUint8(0, negative ? first ^ 0xff : first ^ 0x80);
      for (let i = 1; i < 8; i++) {
        const b = r.next();
        f64.setUint8(i, negative ? b ^ 0xff : b);
      }
      return f64.getFloat64(0);
    }
    case TAG.false:
      return false;
    case TAG.true:
      return true;
    case TAG.string:
      return utf8ToString(readEscaped(r));
    case TAG.bytes:
      return readEscaped(r);
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
        const k = utf8ToString(readEscaped(r));
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
  const p = encodeKey(eq);
  let lo = p;
  let hi = prefixEnd(p);
  if (lower) {
    const k = concatBytes(p, encodeKey([lower.value]));
    lo = lower.op === "gte" ? k : prefixEnd(k);
  }
  if (upper) {
    const k = concatBytes(p, encodeKey([upper.value]));
    hi = upper.op === "lt" ? k : prefixEnd(k);
  }
  return { lo, hi };
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

const totalOrderBits = (x: number): bigint => {
  f64.setFloat64(0, x);
  if (Number.isNaN(x)) return 0xfff8000000000000n;
  const bits = f64.getBigUint64(0);
  return bits & 0x8000000000000000n ? ~bits & MASK64 : bits | 0x8000000000000000n;
};

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
    case 4: {
      const x = totalOrderBits(a as number);
      const y = totalOrderBits(b as number);
      return x < y ? -1 : x > y ? 1 : 0;
    }
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
