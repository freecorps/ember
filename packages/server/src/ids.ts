// Document ids: `<prefix>_<ULID>` (e.g. `msg_01J9Z3...`). Sortable by creation, generable on the client for
// optimistic mutations, readable. The prefix maps to the table (unique per schema).

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A ULID from a timestamp (ms) and a [0,1) random source (deterministic when `random` is seeded). */
export function ulid(time: number, random: () => number): string {
  let t = Math.max(0, Math.floor(time));
  let ts = "";
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  let rnd = "";
  for (let i = 0; i < 16; i++) rnd += CROCKFORD[Math.floor(random() * 32) & 31]!;
  return ts + rnd;
}

export const makeId = (prefix: string, time: number, random: () => number): string => `${prefix}_${ulid(time, random)}`;

/** Splits an id into prefix and ULID; undefined if malformed. */
export function parseId(id: unknown): { prefix: string; ulid: string } | undefined {
  if (typeof id !== "string") return undefined;
  const i = id.lastIndexOf("_");
  if (i <= 0) return undefined;
  const u = id.slice(i + 1);
  return ULID_RE.test(u) ? { prefix: id.slice(0, i), ulid: u } : undefined;
}

/** Deterministic PRNG (sfc32) seeded from a 32-bit integer. */
export function seededRandom(seed: number): () => number {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/**
 * Compact storage (ddl.ts): a document's `_rowid` is its `_creationTime` in microseconds, and its id carries it, so a
 * point read by id is a primary-key read with no `_id` index. The ULID's 48-bit time is the millisecond and the first
 * two random characters are the microsecond within it (0–999); the other 14 stay random (70 bits).
 */
export function makeIdMicros(prefix: string, micros: number, random: () => number): string {
  const ms = Math.floor(micros / 1000);
  const us = micros - ms * 1000;
  const u = ulid(ms, random);
  return `${prefix}_${u.slice(0, 10)}${CROCKFORD[us >> 5]!}${CROCKFORD[us & 31]!}${u.slice(12)}`;
}

/** The `_rowid` a compact-storage id points at (see makeIdMicros); undefined when the id is malformed. */
export function idMicros(id: string): number | undefined {
  const p = parseId(id);
  if (!p) return undefined;
  let ms = 0;
  for (let i = 0; i < 10; i++) ms = ms * 32 + CROCKFORD.indexOf(p.ulid[i]!);
  const us = CROCKFORD.indexOf(p.ulid[10]!) * 32 + CROCKFORD.indexOf(p.ulid[11]!);
  const micros = ms * 1000 + us;
  return us < 1000 && Number.isSafeInteger(micros) ? micros : undefined;
}
