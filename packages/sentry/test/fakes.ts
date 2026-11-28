// In-memory stand-ins for the bindings the component uses: R2 (with ranged reads and delimited lists), a Queue and an
// Analytics Engine dataset. Enough of each API for the component, nothing more.
import type { AnalyticsEngineLike, QueueLike, R2BodyLike, R2Like, R2ObjectLike } from "../src/config.ts";

export class MemoryR2 implements R2Like {
  readonly objects = new Map<string, { bytes: Uint8Array; uploaded: Date; contentEncoding?: string; contentType?: string }>();
  puts = 0;
  now: () => number = () => Date.now();
  async put(key: string, value: Uint8Array | ArrayBuffer | string, o?: { httpMetadata?: { contentType?: string; contentEncoding?: string } }) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
    this.objects.set(key, { bytes, uploaded: new Date(this.now()), ...(o?.httpMetadata?.contentEncoding ? { contentEncoding: o.httpMetadata.contentEncoding } : {}), ...(o?.httpMetadata?.contentType ? { contentType: o.httpMetadata.contentType } : {}) });
    this.puts++;
    return {};
  }
  async get(key: string, o?: { range?: { offset: number; length: number } }): Promise<R2BodyLike | null> {
    const obj = this.objects.get(key);
    if (!obj) return null;
    const bytes = o?.range ? obj.bytes.slice(o.range.offset, o.range.offset + o.range.length) : obj.bytes;
    return { key, size: obj.bytes.length, uploaded: obj.uploaded, arrayBuffer: async () => bytes.slice().buffer, text: async () => new TextDecoder().decode(bytes) };
  }
  async head(key: string): Promise<R2ObjectLike | null> {
    const obj = this.objects.get(key);
    return obj ? { key, size: obj.bytes.length, uploaded: obj.uploaded } : null;
  }
  async list(o: { prefix?: string; delimiter?: string; cursor?: string; limit?: number } = {}) {
    const all = [...this.objects.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort();
    const prefixes = new Set<string>();
    const objects: R2ObjectLike[] = [];
    for (const k of all) {
      const rest = k.slice((o.prefix ?? "").length);
      const cut = o.delimiter ? rest.indexOf(o.delimiter) : -1;
      if (cut >= 0) prefixes.add((o.prefix ?? "") + rest.slice(0, cut + 1));
      else objects.push({ key: k, size: this.objects.get(k)!.bytes.length, uploaded: this.objects.get(k)!.uploaded });
    }
    const start = o.cursor ? Number(o.cursor) : 0;
    const limit = o.limit ?? 1000;
    const page = objects.slice(start, start + limit);
    const truncated = start + limit < objects.length;
    return { objects: page, delimitedPrefixes: [...prefixes], truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export class FakeQueue<T = unknown> implements QueueLike<T> {
  readonly sent: T[] = [];
  calls = 0;
  async send(body: T) {
    this.calls++;
    this.sent.push(structuredClone(body));
  }
  /** Refuses what a real Queue refuses: more than 100 messages, or more than 256 KB in all (with ~100 bytes each of metadata). */
  async sendBatch(messages: Iterable<{ body: T }>) {
    this.calls++;
    const list = [...messages];
    const bytes = list.reduce((n, m) => n + new TextEncoder().encode(JSON.stringify(m.body)).length + 100, 0);
    if (list.length > 100 || bytes > 256_000) throw new Error(`Queue sendBatch() limit exceeded: ${list.length} messages, ${bytes} bytes`);
    for (const m of list) this.sent.push(structuredClone(m.body));
  }
  take(): T[] {
    return this.sent.splice(0);
  }
}

export class FakeAnalytics implements AnalyticsEngineLike {
  readonly points: Array<{ indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }> = [];
  writeDataPoint(p: { indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }) {
    this.points.push(p);
  }
  of(kind: string) {
    return this.points.filter((p) => p.blobs?.[0] === kind);
  }
}

/** A Sentry DSN key for the tests (8+ url-safe characters). */
export const KEY = "pubkey0123456789";
