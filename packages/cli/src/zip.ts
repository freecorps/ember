// ZIP files without loading them: the reader reads the central directory (ZIP64 included) and streams one entry at
// a time (stored or deflated); the writer streams entries with data descriptors and ZIP64 records. Used by
// `ember import convex` (snapshots of several GB), `ember export` and the tests that build snapshots.

import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { createDeflateRaw, createInflateRaw } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the local header. */
  offset: number;
}

const U16 = 0xffff;
const U32 = 0xffffffff;

/** A ZIP opened for reading: its entries (from the central directory) and a stream per entry. */
export class ZipReader {
  readonly path: string;
  readonly entries: ZipEntry[];
  private readonly fh: FileHandle;
  private readonly byName: Map<string, ZipEntry>;

  private constructor(path: string, fh: FileHandle, entries: ZipEntry[]) {
    this.path = path;
    this.fh = fh;
    this.entries = entries;
    this.byName = new Map(entries.map((x) => [x.name, x]));
  }

  static async open(path: string): Promise<ZipReader> {
    const fh = await open(path, "r");
    try {
      const size = (await fh.stat()).size;
      const tailLen = Math.min(size, 65_557 + 20);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      let eocd = -1;
      for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0) throw new Error(`${path}: not a ZIP file (no end of central directory)`);
      let count = tail.readUInt16LE(eocd + 10);
      let cdSize = tail.readUInt32LE(eocd + 12);
      let cdOffset = tail.readUInt32LE(eocd + 16);
      if (count === U16 || cdSize === U32 || cdOffset === U32) {
        const loc = eocd - 20;
        if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error(`${path}: ZIP64 locator missing`);
        const recOffset = Number(tail.readBigUInt64LE(loc + 8));
        const rec = Buffer.alloc(56);
        await fh.read(rec, 0, 56, recOffset);
        if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error(`${path}: ZIP64 end of central directory missing`);
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
      const cd = Buffer.alloc(cdSize);
      await fh.read(cd, 0, cdSize, cdOffset);
      const entries: ZipEntry[] = [];
      let p = 0;
      for (let i = 0; i < count; i++) {
        if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path}: corrupt central directory`);
        const method = cd.readUInt16LE(p + 10);
        let compressedSize = cd.readUInt32LE(p + 20);
        let size = cd.readUInt32LE(p + 24);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        let offset = cd.readUInt32LE(p + 42);
        const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
        // ZIP64 extra field: the 64-bit values, in this order, of the fields that are 0xFFFFFFFF.
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.readUInt16LE(e);
          const len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (size === U32) (size = Number(cd.readBigUInt64LE(q)), (q += 8));
            if (compressedSize === U32) (compressedSize = Number(cd.readBigUInt64LE(q)), (q += 8));
            if (offset === U32) offset = Number(cd.readBigUInt64LE(q));
          }
          e += 4 + len;
        }
        entries.push({ name, method, compressedSize, size, offset });
        p = end + commentLen;
      }
      return new ZipReader(path, fh, entries);
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  entry(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** The entry's bytes as a stream (inflated when deflated). */
  async stream(entry: ZipEntry): Promise<Readable> {
    const h = Buffer.alloc(30);
    await this.fh.read(h, 0, 30, entry.offset);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`${this.path}: corrupt local header for ${entry.name}`);
    const start = entry.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    if (entry.compressedSize === 0) {
      const { Readable } = await import("node:stream");
      return Readable.from([]);
    }
    const raw = createReadStream(this.path, { start, end: start + entry.compressedSize - 1, highWaterMark: 1 << 20 });
    if (entry.method === 0) return raw;
    if (entry.method !== 8) throw new Error(`${this.path}: ${entry.name} uses compression method ${entry.method} (only stored and deflate)`);
    return raw.pipe(createInflateRaw());
  }

  async bytes(entry: ZipEntry): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of await this.stream(entry)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  /** The entry's lines (JSON Lines), streamed; empty lines are skipped. */
  async *lines(entry: ZipEntry): AsyncGenerator<string> {
    const rl = createInterface({ input: await this.stream(entry), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) yield line;
  }

  close(): Promise<void> {
    return this.fh.close();
  }
}

// ------------------------------------------------------------------------------------------------ writer

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc: number, b: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** Streams a ZIP to a file: `add(name, data)` per entry (deflated), `close()` writes the central directory. */
export class ZipWriter {
  private readonly out: WriteStream;
  private offset = 0;
  private readonly central: Buffer[] = [];
  private count = 0;

  private failed: Error | null = null;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.out = createWriteStream(path);
    this.out.on("error", (e) => (this.failed = e));
  }

  private write(b: Buffer): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    this.offset += b.length;
    return this.out.write(b) ? Promise.resolve() : new Promise((resolve) => this.out.once("drain", () => resolve()));
  }

  /** One entry: bytes, a string, or an (async) iterable of chunks (streamed, never held whole). */
  async add(name: string, data: Uint8Array | string | Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>): Promise<void> {
    const nameBuf = Buffer.from(name, "utf8");
    const offset = this.offset;
    // Local header: sizes in the data descriptor (flag 8), a ZIP64 extra with zeros so readers expect 8-byte sizes.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(U32, 18);
    local.writeUInt32LE(U32, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(20, 28);
    const zip64 = Buffer.alloc(20);
    zip64.writeUInt16LE(0x0001, 0);
    zip64.writeUInt16LE(16, 2);
    await this.write(Buffer.concat([local, nameBuf, zip64]));
    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = createDeflateRaw({ level: 6 });
    const pending: Promise<void>[] = [];
    deflate.on("data", (c: Buffer) => {
      compressed += c.length;
      pending.push(this.write(c));
    });
    const ended = new Promise<void>((resolve, reject) => {
      deflate.on("end", resolve);
      deflate.on("error", reject);
    });
    const feed = (chunk: Uint8Array | string) => {
      const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      crc = crc32(crc, b);
      size += b.length;
      return new Promise<void>((resolve) => (deflate.write(b) ? resolve() : deflate.once("drain", resolve)));
    };
    if (typeof data === "string" || data instanceof Uint8Array) await feed(data);
    else for await (const chunk of data as AsyncIterable<Uint8Array | string>) await feed(chunk);
    deflate.end();
    await ended;
    await Promise.all(pending);
    const desc = Buffer.alloc(24);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeBigUInt64LE(BigInt(compressed), 8);
    desc.writeBigUInt64LE(BigInt(size), 16);
    await this.write(desc);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(45, 4);
    cd.writeUInt16LE(45, 6);
    cd.writeUInt16LE(0x0808, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(U32, 20);
    cd.writeUInt32LE(U32, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(28, 30);
    cd.writeUInt32LE(U32, 42);
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(size), 4);
    extra.writeBigUInt64LE(BigInt(compressed), 12);
    extra.writeBigUInt64LE(BigInt(offset), 20);
    this.central.push(cd, nameBuf, extra);
    this.count++;
  }

  async close(): Promise<void> {
    const cdOffset = this.offset;
    const cd = Buffer.concat(this.central);
    await this.write(cd);
    const recOffset = this.offset;
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(this.count), 24);
    rec.writeBigUInt64LE(BigInt(this.count), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(recOffset), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(U16, 8);
    eocd.writeUInt16LE(U16, 10);
    eocd.writeUInt32LE(U32, 12);
    eocd.writeUInt32LE(U32, 16);
    await this.write(Buffer.concat([rec, loc, eocd]));
    await new Promise<void>((resolve, reject) => this.out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  }
}
