// File uploads (PLAN §7) — fetch-based, so it works in browsers and React Native:
//   1. a mutation of the app returns `ctx.storage.generateUploadUrl({contentType, size, sha256, multipart})`
//      (the app decides who may upload);
//   2. the bytes go to the presigned R2 URL (or the Worker in proxy mode); multipart above a threshold;
//   3. `POST /api/storage/confirm` marks the file ready (R2 event notifications do the same server-side).
//
//   const { storageId } = await client.files.upload(file, { shard: "org:acme", mutation: api.files.generateUploadUrl })
//   await client.mutation(api.photos.add, { file: storageId }, { shard: "org:acme" })
//
// `client.storage` is not used: EmberClient already has a private `storage` (the pending-mutation store).

import { EmberClient } from "./client.ts";
import { EmberError } from "./errors.ts";
import { getFunctionName, type FunctionReference } from "./functions.ts";

/** What `ctx.storage.generateUploadUrl()` returns (mirrors @ember/server's UploadTicket). */
export interface UploadTicket {
  storageId: string;
  shard: string;
  token: string;
  exists?: true;
  url?: string;
  method?: "PUT";
  headers?: Record<string, string>;
  multipart?: { partSize: number };
  expiresAt: number;
}

export interface UploadedFile {
  storageId: string;
  sha256: string | null;
  size: number | null;
  contentType: string | null;
  state: "pending" | "ready" | "deleting" | "failed";
}

export type UploadData = Blob | ArrayBuffer | Uint8Array;

export interface UploadFileOptions {
  shard?: string;
  /** Mutation returning `ctx.storage.generateUploadUrl(args)`. Default `"storage:generateUploadUrl"`. */
  mutation?: FunctionReference<"mutation"> | string;
  /** Extra args for that mutation (merged with `contentType`, `size`, `sha256`, `multipart`). */
  args?: Record<string, unknown>;
  /** Default: the Blob's type, else application/octet-stream. */
  contentType?: string;
  /** Multipart above this size (default 32 MiB). */
  multipartThreshold?: number;
  /** Parts uploaded in parallel (default 3). */
  concurrency?: number;
  /**
   * Hex SHA-256, or false to skip hashing. Default: computed with WebCrypto for single uploads when available (the
   * object then goes straight to its content-addressed key and identical content is not uploaded twice); otherwise
   * the server hashes it while confirming.
   */
  sha256?: string | false;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  onProgress?: (p: { loaded: number; total: number }) => void;
  signal?: AbortSignal;
}

export const DEFAULT_MULTIPART_THRESHOLD = 32 * 1024 * 1024;
const DEFAULT_PART_SIZE = 10 * 1024 * 1024;

const sizeOf = (d: UploadData) => (d instanceof ArrayBuffer ? d.byteLength : d instanceof Uint8Array ? d.byteLength : d.size);
const slice = (d: UploadData, start: number, end: number): Blob | Uint8Array | ArrayBuffer =>
  d instanceof ArrayBuffer ? d.slice(start, end) : d instanceof Uint8Array ? d.subarray(start, end) : d.slice(start, end);

async function sha256Hex(d: UploadData): Promise<string | null> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle?.digest) return null; // e.g. Hermes without a WebCrypto polyfill: the server hashes instead
  try {
    const buf = d instanceof ArrayBuffer ? d : d instanceof Uint8Array ? d : await d.arrayBuffer();
    const h = new Uint8Array(await subtle.digest("SHA-256", buf as BufferSource));
    return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

async function readError(res: Response, fallback: string): Promise<EmberError> {
  let code = `http_${res.status}`;
  let message = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    try {
      const b = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (b?.error?.code) code = b.error.code;
      if (b?.error?.message) message = b.error.message;
    } catch {
      // S3 XML error
      const m = /<Code>([^<]+)<\/Code>[\s\S]*?<Message>([^<]*)<\/Message>/.exec(text);
      if (m) {
        code = m[1]!;
        message = m[2]!;
      }
    }
  } catch {
    // no body
  }
  return new EmberError(code, `${fallback}: ${message}`);
}

/** Upload helpers bound to one client (also reachable as `client.files`). */
export class ClientFiles {
  constructor(private readonly client: EmberClient) {}

  /** Absolute URL for a path returned by the server (proxy-mode URLs are paths on the deployment). */
  url(pathOrUrl: string): string {
    if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
    return `${this.client.url.replace(/^ws(s?):/, "http$1:")}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  }

  async upload(data: UploadData, opts: UploadFileOptions = {}): Promise<UploadedFile> {
    const doFetch = opts.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    if (!doFetch) throw new EmberError("no_fetch", "no fetch implementation available");
    const size = sizeOf(data);
    const contentType = opts.contentType ?? (typeof Blob !== "undefined" && data instanceof Blob && data.type ? data.type : "application/octet-stream");
    const multipart = size > (opts.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD);
    const sha256 = opts.sha256 === false ? null : (opts.sha256 ?? (multipart ? null : await sha256Hex(data)));
    const shardOpt = opts.shard ? { shard: opts.shard } : {};
    const ticket = (await this.client.mutation(
      (opts.mutation ?? "storage:generateUploadUrl") as FunctionReference<"mutation">,
      { ...(opts.args ?? {}), contentType, size, ...(sha256 ? { sha256 } : {}), ...(multipart ? { multipart: true } : {}) } as never,
      shardOpt,
    )) as UploadTicket;
    if (!ticket || typeof ticket.storageId !== "string" || typeof ticket.token !== "string" || typeof ticket.shard !== "string") {
      throw new EmberError("bad_ticket", `${typeof opts.mutation === "string" || !opts.mutation ? (opts.mutation ?? "storage:generateUploadUrl") : getFunctionName(opts.mutation)} must return ctx.storage.generateUploadUrl(...)`);
    }
    const shard = ticket.shard;
    const progress = (loaded: number) => opts.onProgress?.({ loaded, total: size });
    const post = async (path: string, body: unknown) => {
      const res = await doFetch(this.url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(opts.signal ? { signal: opts.signal } : {}) });
      if (!res.ok) throw await readError(res, `POST ${path} failed`);
      return (await res.json()) as Record<string, any>;
    };
    const auth = { shard, storageId: ticket.storageId, token: ticket.token };

    if (ticket.exists) {
      progress(size);
      return { storageId: ticket.storageId, sha256, size, contentType, state: "ready" };
    }

    if (ticket.url) {
      const res = await doFetch(this.url(ticket.url), {
        method: ticket.method ?? "PUT",
        headers: ticket.headers ?? {},
        body: data as BodyInit,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) throw await readError(res, "upload failed");
      progress(size);
    } else if (ticket.multipart) {
      const created = await post("/api/storage/multipart", { ...auth, op: "create" });
      const uploadId = created.uploadId as string;
      const partSize = (created.partSize as number | undefined) ?? ticket.multipart.partSize ?? DEFAULT_PART_SIZE;
      const count = Math.max(1, Math.ceil(size / partSize));
      const etags: Array<{ partNumber: number; etag: string }> = [];
      let loaded = 0;
      try {
        for (let first = 1; first <= count; first += 100) {
          const numbers = Array.from({ length: Math.min(100, count - first + 1) }, (_, i) => first + i);
          const { parts } = (await post("/api/storage/multipart", { ...auth, op: "parts", uploadId, partNumbers: numbers })) as { parts: Array<{ partNumber: number; url: string }> };
          let next = 0;
          const worker = async () => {
            while (next < parts.length) {
              const p = parts[next++]!;
              const start = (p.partNumber - 1) * partSize;
              const chunk = slice(data, start, Math.min(size, start + partSize));
              const res = await doFetch(this.url(p.url), { method: "PUT", body: chunk as BodyInit, ...(opts.signal ? { signal: opts.signal } : {}) });
              if (!res.ok) throw await readError(res, `part ${p.partNumber} failed`);
              const etag = res.headers.get("etag") ?? ((await res.json().catch(() => ({}))) as { etag?: string }).etag;
              if (!etag) throw new EmberError("no_etag", `part ${p.partNumber}: no ETag in the response (bucket CORS must expose ETag)`);
              etags.push({ partNumber: p.partNumber, etag });
              loaded += sizeOf(chunk as UploadData);
              progress(loaded);
            }
          };
          await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, parts.length)) }, worker));
        }
        const done = await post("/api/storage/multipart", { ...auth, op: "complete", uploadId, parts: etags.sort((a, b) => a.partNumber - b.partNumber) });
        return done.file as UploadedFile;
      } catch (e) {
        await post("/api/storage/multipart", { ...auth, op: "abort", uploadId }).catch(() => undefined);
        throw e;
      }
    } else throw new EmberError("bad_ticket", "upload ticket has neither url nor multipart");

    const confirmed = await post("/api/storage/confirm", auth);
    return confirmed.file as UploadedFile;
  }
}

/** `uploadFile(client, data, opts)` = `client.files.upload(data, opts)`. */
export const uploadFile = (client: EmberClient, data: UploadData, opts?: UploadFileOptions): Promise<UploadedFile> => new ClientFiles(client).upload(data, opts);

declare module "./client.ts" {
  interface EmberClient {
    /** File uploads (PLAN §7). */
    readonly files: ClientFiles;
  }
}

if (!Object.getOwnPropertyDescriptor(EmberClient.prototype, "files")) {
  Object.defineProperty(EmberClient.prototype, "files", {
    configurable: true,
    get(this: EmberClient) {
      const f = new ClientFiles(this);
      Object.defineProperty(this, "files", { value: f, configurable: true });
      return f;
    },
  });
}
