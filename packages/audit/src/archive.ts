// Archive objects: gzip NDJSON in R2, one audit row per line in Ember's tagged JSON (`encodeJson`: int64 and bytes
// survive). Web APIs only (CompressionStream, DecompressionStream, Blob): workerd, browsers and Node 22.

import { decodeJson, encodeJson } from "@freecorps/ember-values";

/** The R2 bucket binding, structurally (the part this package uses). */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string; contentEncoding?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  head(key: string): Promise<{ key: string; size: number; customMetadata?: Record<string, string> } | null>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    include?: Array<"httpMetadata" | "customMetadata">;
  }): Promise<{ objects: Array<{ key: string; size: number; uploaded: Date; customMetadata?: Record<string, string> }>; truncated: boolean; cursor?: string }>;
}

/** Gzip of one tagged-JSON line per value. */
export async function gzipNdjson(values: readonly unknown[]): Promise<Uint8Array> {
  const text = values.map((x) => encodeJson(x)).join("\n") + "\n";
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The decompressed NDJSON of an object, as a stream (for an app route that serves an archive). */
export function ndjsonStream(gzipped: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return gzipped.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** The values of a gzip NDJSON object. */
export async function gunzipNdjson(bytes: ArrayBuffer | Uint8Array): Promise<unknown[]> {
  const text = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return text
    .split("\n")
    .filter((l) => l.length)
    .map((l) => decodeJson(l));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `<prefix>/YYYY/MM/DD/<batch>.ndjson.gz` for the UTC day of `at` (the batch's oldest row). */
export function archiveKey(prefix: string, at: number, batch: string): string {
  const d = new Date(at);
  return `${prefix.replace(/\/+$/, "")}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${batch}.ndjson.gz`;
}
