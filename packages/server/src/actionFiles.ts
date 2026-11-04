// Types of `ctx.storage` / `ctx.images` in actions (implemented by @ember/runtime, which has the R2 and Images
// bindings). Kept here so ActionCtx stays a pure type.

import type { FileMetadata, GetUrlOptions, UploadOptions, UploadTicket } from "./files.ts";

export interface StoredFile {
  storageId: string;
  size: number;
  sha256: string | null;
  contentType: string | null;
  /** The bytes as a stream (read once). */
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type StorableData = Uint8Array | ArrayBuffer | Blob | string;

export interface ActionStorage {
  getUrl(storageId: string, opts?: GetUrlOptions): Promise<string | null>;
  getMetadata(storageId: string): Promise<FileMetadata | null>;
  /** The object's bytes (null when unknown or not uploaded yet). */
  get(storageId: string): Promise<StoredFile | null>;
  /** Hashes and stores bytes (content-addressed, deduplicated per shard); returns a ready storage id. */
  store(data: StorableData, opts?: { contentType?: string }): Promise<string>;
  /** Same as `ctx.storage.generateUploadUrl` in a mutation, through an RPC to the shard. */
  generateUploadUrl(opts?: UploadOptions): Promise<UploadTicket>;
  delete(storageId: string): Promise<void>;
}

/** Subset of the Images binding transform options (https://developers.cloudflare.com/images/transform-images/bindings/). */
export interface ImageTransform {
  width?: number;
  height?: number;
  fit?: "scale-down" | "contain" | "cover" | "crop" | "pad";
  rotate?: 90 | 180 | 270;
  [k: string]: unknown;
}
export interface ImageOutput {
  format: "image/webp" | "image/avif" | "image/jpeg" | "image/png" | "image/gif" | string;
  quality?: number;
}
export type ImageInput = string /* storage id */ | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

export interface ActionImages {
  /** Runs the Images binding: input (a storage id or bytes) → transform → output. */
  transform(input: ImageInput, transform: ImageTransform, output?: ImageOutput): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Width/height/format (free in the Images binding). */
  info(input: ImageInput): Promise<{ width?: number; height?: number; format: string; fileSize?: number }>;
  /** transform + `storage.store`: a thumbnail as a new storage id. */
  thumbnail(storageId: string, opts?: { width?: number; height?: number; format?: ImageOutput["format"]; quality?: number; fit?: ImageTransform["fit"] }): Promise<string>;
}
