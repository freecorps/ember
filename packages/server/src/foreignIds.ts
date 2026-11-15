// Foreign document ids (PLAN §22 L4): ids that came with an import and are kept as they are, next to Ember's own
// `<prefix>_<ULID>` ids. Today the only source is Convex.
//
// A Convex id (public description in Convex's "How Convex Works"; the decoder below is ours) is Crockford base32,
// lowercase and unpadded, of
//   varint(table number) ++ 14 random bytes ++ 2 timestamp bytes ++ 2 bytes of version and checksum
// The varint is LEB128 (7 bits per byte, low bits first), 1–5 bytes, so an id is 31–37 characters. The table number
// is what tells the table: the shard keeps `table number → table` from the snapshot (`_ember_meta.foreign_ids`).
// The checksum is not verified (its exact algorithm is not documented): an id is recognized by its structure, and a
// table number that no imported table has is "no table", like a malformed id.

/** Convex's base32 alphabet (Crockford, lowercase: no i, l, o, u). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const CONVEX_ID_RE = /^[0-9a-hjkmnp-tv-z]{31,37}$/;
const VALUE = new Map([...ALPHABET].map((c, i) => [c, i]));

/** `source → (table number, as a string → table)`; the import writes it, every shard of the deployment has the same. */
export type ForeignIds = { convex?: Readonly<Record<string, string>> };
/** The `_ember_meta` key holding `ForeignIds` (JSON). */
export const FOREIGN_IDS_META = "foreign_ids";

function base32Decode(s: string): Uint8Array | undefined {
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const c of s) {
    acc = ((acc << 5) | VALUE.get(c)!) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  // Unpadded encoding: the bits left over must be zero (one string per byte sequence).
  return (acc & ((1 << bits) - 1)) === 0 ? out : undefined;
}

function base32Encode(b: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const x of b) {
    acc = ((acc << 8) | x) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** The table number of a Convex id; undefined when `id` is not one. */
export function convexTableNumber(id: unknown): number | undefined {
  if (typeof id !== "string" || !CONVEX_ID_RE.test(id)) return undefined;
  const b = base32Decode(id);
  // Canonical length only: n bytes are exactly ceil(8n / 5) characters.
  if (!b || Math.ceil((b.length * 8) / 5) !== id.length) return undefined;
  let n = 0;
  let i = 0;
  for (;;) {
    if (i >= 5 || i >= b.length) return undefined;
    const x = b[i]!;
    n += (x & 0x7f) * 2 ** (7 * i);
    i++;
    if (x < 0x80) {
      // Minimal encoding only (no trailing zero continuation byte).
      if (x === 0 && i > 1) return undefined;
      break;
    }
  }
  // 16 bytes of internal id and the 2-byte footer follow the varint.
  if (b.length !== i + 18 || n < 1 || n > 0xffffffff) return undefined;
  return n;
}

/** Whether `id` has the structure of a Convex id. */
export const isConvexId = (id: unknown): id is string => convexTableNumber(id) !== undefined;

/** Whether `id` is a foreign id of any supported source (structure only). */
export const isForeignId = isConvexId;

/**
 * A Convex-shaped id for `tableNumber` (tests, fixtures, `ember import` synthetic snapshots): our own encoding of the
 * format above. The footer is a Fletcher-16 of the bytes before it; Ember never checks it.
 */
export function makeConvexId(tableNumber: number, random: () => number = Math.random): string {
  if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 0xffffffff) throw new Error(`table number out of range: ${tableNumber}`);
  const bytes: number[] = [];
  let n = tableNumber;
  do {
    const low = n % 128;
    n = Math.floor(n / 128);
    bytes.push(n > 0 ? low | 0x80 : low);
  } while (n > 0);
  for (let i = 0; i < 16; i++) bytes.push(Math.floor(random() * 256) & 0xff);
  let s1 = 0;
  let s2 = 0;
  for (const x of bytes) {
    s1 = (s1 + x) % 255;
    s2 = (s2 + s1) % 255;
  }
  bytes.push(s2, s1);
  return base32Encode(Uint8Array.from(bytes));
}

/** The table of a foreign id under `map`; undefined when it is not one or its table was not imported. */
export function foreignTableOf(map: ForeignIds | undefined, id: string): string | undefined {
  const convex = map?.convex;
  if (!convex) return undefined;
  const n = convexTableNumber(id);
  return n === undefined ? undefined : convex[String(n)];
}

/** Parses `_ember_meta.foreign_ids`; malformed or absent → undefined. */
export function parseForeignIds(text: unknown): ForeignIds | undefined {
  if (typeof text !== "string") return undefined;
  try {
    const x = JSON.parse(text) as unknown;
    if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
    const convex = (x as { convex?: unknown }).convex;
    if (!convex || typeof convex !== "object" || Array.isArray(convex)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(convex)) if (/^[1-9][0-9]*$/.test(k) && typeof v === "string") out[k] = v;
    return { convex: out };
  } catch {
    return undefined;
  }
}

/**
 * `next` merged into `cur`: a table number that already names another table is a conflict (two snapshots of
 * different deployments into the same shards), reported instead of overwritten.
 */
export function mergeForeignIds(cur: ForeignIds | undefined, next: ForeignIds): { merged: ForeignIds; conflicts: string[] } {
  const out: Record<string, string> = { ...(cur?.convex ?? {}) };
  const conflicts: string[] = [];
  for (const [k, v] of Object.entries(next.convex ?? {})) {
    if (out[k] !== undefined && out[k] !== v) conflicts.push(`table number ${k} is ${out[k]}, not ${v}`);
    else out[k] = v;
  }
  return { merged: { convex: out }, conflicts };
}
