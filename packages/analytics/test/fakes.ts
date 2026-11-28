// Test doubles: an Analytics Engine dataset that keeps its points, an R2 bucket in memory, a Rate Limiting binding.
import type { DataPoint } from "../src/index.ts";

export function fakeDataset() {
  const points: DataPoint[] = [];
  return { points, writeDataPoint: (p?: unknown) => void points.push(structuredClone(p) as DataPoint) };
}

type Obj = { key: string; body: Uint8Array; size: number; uploaded: Date; customMetadata: Record<string, string>; httpMetadata: Record<string, string> };

export function memoryBucket() {
  const objects = new Map<string, Obj>();
  const toBytes = (v: ArrayBuffer | Uint8Array | string) => (typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v));
  return {
    objects,
    puts: 0,
    async put(key: string, value: ArrayBuffer | Uint8Array | string, o?: { customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> }) {
      this.puts++;
      const body = toBytes(value).slice();
      const obj = { key, body, size: body.byteLength, uploaded: new Date(), customMetadata: o?.customMetadata ?? {}, httpMetadata: o?.httpMetadata ?? {} };
      objects.set(key, obj);
      return obj;
    },
    async head(key: string) {
      return objects.get(key) ?? null;
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return { ...o, body: new Blob([o.body as BlobPart]).stream(), arrayBuffer: async () => o.body.slice().buffer };
    },
    async list(o: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const all = [...objects.values()].filter((x) => x.key.startsWith(o.prefix ?? "")).sort((a, b) => a.key.localeCompare(b.key));
      const start = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 1000;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return { objects: page, truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

export function fakeRateLimit(allow: number) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: keys.filter((k) => k === key).length <= allow }) };
}
