// The raw archive (`config.archive`): each accepted batch becomes one gzip NDJSON object in R2, written by the action
// that received it (`analytics/YYYY/MM/DD/HH/<uuid>.ndjson.gz`, UTC hour of arrival). No Durable Object is involved.
// Web APIs only (CompressionStream, Blob): workerd, browsers and Node 22.

import type { TrackedEvent } from "./events.ts";

/** The R2 bucket binding, structurally (the part this package uses). */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string; contentEncoding?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string; size: number; uploaded: Date; customMetadata?: Record<string, string> }>; truncated: boolean; cursor?: string }>;
}

/** Gzip of the lines, one JSON value per line. */
export async function gzipNdjson(lines: readonly unknown[]): Promise<Uint8Array> {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The lines of a gzip NDJSON object. */
export async function gunzipNdjson(bytes: ArrayBuffer | Uint8Array): Promise<unknown[]> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((l) => l.length)
    .map((l) => JSON.parse(l) as unknown);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `<prefix>/YYYY/MM/DD/HH/<id>.ndjson.gz` for the UTC hour of `at`. */
export function archiveKey(prefix: string, at: number, id: string): string {
  const d = new Date(at);
  return `${prefix.replace(/\/+$/, "")}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/${id}.ndjson.gz`;
}

/** What one archived line holds (the event as checked, plus where it came from). */
export type ArchivedEvent = TrackedEvent & { install: string; source: "client" | "server"; country: string };

/** Writes one batch; returns its key. */
export async function archiveBatch(bucket: R2BucketLike, events: readonly ArchivedEvent[], o: { prefix: string; now: number; id?: string }): Promise<string> {
  const key = archiveKey(o.prefix, o.now, o.id ?? crypto.randomUUID());
  const body = await gzipNdjson(events);
  await bucket.put(key, body, {
    httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    customMetadata: { count: String(events.length) },
  });
  return key;
}
