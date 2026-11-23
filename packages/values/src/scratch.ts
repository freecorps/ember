// The reusable encode buffer of key.ts (internal: not exported from the package).

export class Writer {
  len = 0;
  constructor(public buf: Uint8Array) {}
  ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number) {
    if (this.len >= this.buf.length) this.ensure(1);
    this.buf[this.len++] = b;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// One scratch buffer for every encoding: an encode writes into it and copies the bytes out once (`finish`). A buffer
// that grew past SCRATCH_KEEP (one huge key) is dropped after the call instead of pinning that memory. A re-entrant
// encode (a getter on a value calling `encodeKey`) finds the scratch taken and uses a writer of its own.
const SCRATCH_SIZE = 256;
const SCRATCH_KEEP = 16 * 1024;
let scratch: Writer | null = new Writer(new Uint8Array(SCRATCH_SIZE));

export function acquire(): Writer {
  const w = scratch;
  if (!w) return new Writer(new Uint8Array(64));
  scratch = null;
  w.len = 0;
  return w;
}

export function release(w: Writer): void {
  if (w.buf.length > SCRATCH_KEEP) w.buf = new Uint8Array(SCRATCH_SIZE);
  scratch = w;
}

/** The scratch buffer's capacity now (tests: the memory cap). */
export const scratchCapacity = (): number => scratch?.buf.length ?? 0;
