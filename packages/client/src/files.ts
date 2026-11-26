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
//
// `client.files` is a getter of `EmberClient` itself (no prototype patching on import), so this module has no side
// effects and the package can declare `"sideEffects": false`. It is not in the static graph of `EmberClient`: the
// getter loads it with `import()` on the first upload, unless the app passes `files: files()` (this module, as
// `@freecorps/ember-client/files`) or calls `uploadFile` from here.
//
// Bytes are never copied to upload them: an `ArrayBuffer` or `Uint8Array` goes as it is, and a part of one is a view
// over it (`subarray` / `new Uint8Array(buffer, offset, length)`), not a copy (`ArrayBuffer.slice`).

import type { EmberClient, FilesApi } from "./client.ts";
import { EmberError } from "./errors.ts";
import type { FunctionReference } from "./functions.ts";

/** What `ctx.storage.generateUploadUrl()` returns (mirrors @freecorps/ember-server's UploadTicket). */
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
  /** Cancels the upload, a part being sent again or waiting to be included. */
  signal?: AbortSignal;
  /**
   * Attempts per multipart part (default 3, at least 1). A part answered 5xx or 429, or lost to a network error, is sent
   * again after a wait (its `Retry-After` when the answer has one, up to 30 s; else exponential with jitter from
   * `retryDelayMs`) before the whole upload is aborted. Any other answer (4xx: an expired URL, a bad request) aborts it
   * at once.
   */
  partAttempts?: number;
  /** First wait before a part is sent again (default 500 ms), doubled on every attempt (capped at 8 s). */
  retryDelayMs?: number;
}

export const DEFAULT_MULTIPART_THRESHOLD = 32 * 1024 * 1024;
const DEFAULT_PART_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;

/** The wait a `Retry-After` header asks for (seconds, or an HTTP date), capped; undefined when there is none. */
function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const seconds = Number(h);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)) : undefined;
}

/** Why `signal` aborted, as fetch rejects with it. */
const abortError = (signal: AbortSignal): unknown => signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

/** `ms`, or until `signal` aborts (then it rejects as fetch would). */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A reference's `"module:export"`, as `getFunctionName` reads it: the `Symbol.for` key every copy of the values package
 * shares. Not imported from it: this module is loaded with `import()` by `client.files`, and importing the values
 * package from it would make a bundler without code splitting wrap that whole package for lazy init.
 */
const nameOf = (ref: FunctionReference<"mutation">): string => String((ref as unknown as Record<symbol, unknown>)[Symbol.for("ember.functionName")]);
const DEFAULT_PART_SIZE = 10 * 1024 * 1024;

const sizeOf = (d: UploadData) => (d instanceof ArrayBuffer ? d.byteLength : d instanceof Uint8Array ? d.byteLength : d.size);
/** A part of the data: a view for bytes (no copy), a Blob slice (lazy) for a Blob. */
const slice = (d: UploadData, start: number, end: number): Blob | Uint8Array =>
  d instanceof ArrayBuffer ? new Uint8Array(d, start, end - start) : d instanceof Uint8Array ? d.subarray(start, end) : d.slice(start, end);

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
export class ClientFiles implements FilesApi {
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
      throw new EmberError("bad_ticket", `${typeof opts.mutation === "string" || !opts.mutation ? (opts.mutation ?? "storage:generateUploadUrl") : nameOf(opts.mutation)} must return ctx.storage.generateUploadUrl(...)`);
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
      // `partNumbers` asks the create call for the first batch of part URLs too (`partUrls`): a runtime that answers
      // them saves the first `parts` round trip; one that does not (it ignores the field) costs nothing extra.
      const guess = Math.max(1, Math.ceil(size / (ticket.multipart.partSize || DEFAULT_PART_SIZE)));
      const created = await post("/api/storage/multipart", { ...auth, op: "create", partNumbers: Array.from({ length: Math.min(100, guess) }, (_, i) => i + 1) });
      const uploadId = created.uploadId as string;
      const partSize = (created.partSize as number | undefined) ?? ticket.multipart.partSize ?? DEFAULT_PART_SIZE;
      const count = Math.max(1, Math.ceil(size / partSize));
      const given = new Map<number, string>();
      if (Array.isArray(created.partUrls)) {
        for (const p of created.partUrls as Array<{ partNumber?: unknown; url?: unknown }>) {
          if (Number.isInteger(p?.partNumber) && typeof p?.url === "string") given.set(p.partNumber as number, p.url);
        }
      }
      const etags: Array<{ partNumber: number; etag: string }> = [];
      let loaded = 0;
      try {
        for (let first = 1; first <= count; first += 100) {
          const numbers = Array.from({ length: Math.min(100, count - first + 1) }, (_, i) => first + i);
          // URLs the create call gave are used as they are; only the missing ones are asked for (the guess above used
          // the ticket's part size, and the create call may answer another one: more parts, or fewer).
          const missing = numbers.filter((n) => !given.has(n));
          const asked = missing.length
            ? ((await post("/api/storage/multipart", { ...auth, op: "parts", uploadId, partNumbers: missing })) as { parts: Array<{ partNumber: number; url: string }> }).parts
            : [];
          const parts = [...numbers.filter((n) => given.has(n)).map((n) => ({ partNumber: n, url: given.get(n)! })), ...asked];
          let next = 0;
          let failed = false;
          const attempts = Math.max(1, Math.floor(opts.partAttempts ?? DEFAULT_PART_ATTEMPTS));
          const baseDelay = Math.max(0, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
          /** One part, sent again after a 5xx, a 429 or a network error (`partAttempts`) before the upload gives up. */
          const putPart = async (url: string, chunk: Blob | Uint8Array, partNumber: number): Promise<Response> => {
            for (let attempt = 1; ; attempt++) {
              let res: Response | undefined;
              let lost: unknown;
              try {
                res = await doFetch(url, { method: "PUT", body: chunk as BodyInit, ...(opts.signal ? { signal: opts.signal } : {}) });
              } catch (e) {
                if (opts.signal?.aborted) throw e;
                lost = e;
              }
              if (res?.ok) return res;
              // Another part already failed for good: the upload is being aborted, nothing is sent again.
              const again = (!res || res.status === 429 || res.status >= 500) && !failed;
              if (!again || attempt >= attempts) {
                if (res) throw await readError(res, `part ${partNumber} failed${attempt > 1 ? ` after ${attempt} attempts` : ""}`);
                throw lost;
              }
              const backoff = Math.min(MAX_RETRY_DELAY_MS, baseDelay * 2 ** (attempt - 1));
              const delay = (res && retryAfterMs(res)) ?? Math.round(backoff / 2 + (Math.random() * backoff) / 2);
              // The failed answer's body is not needed: released before the wait.
              await res?.body?.cancel().catch(() => undefined);
              await wait(delay, opts.signal);
            }
          };
          const worker = async () => {
            while (next < parts.length && !failed) {
              const p = parts[next++]!;
              const start = (p.partNumber - 1) * partSize;
              const chunk = slice(data, start, Math.min(size, start + partSize));
              const res = await putPart(this.url(p.url), chunk, p.partNumber);
              const etag = res.headers.get("etag") ?? ((await res.json().catch(() => ({}))) as { etag?: string }).etag;
              if (!etag) throw new EmberError("no_etag", `part ${p.partNumber}: no ETag in the response (bucket CORS must expose ETag)`);
              etags.push({ partNumber: p.partNumber, etag });
              loaded += sizeOf(chunk as UploadData);
              progress(loaded);
            }
          };
          const guarded = () =>
            worker().catch((e: unknown) => {
              failed = true; // the other workers take no new part and send none again
              throw e;
            });
          await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, parts.length)) }, guarded));
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

/**
 * Option `files` of `EmberClient` (`@freecorps/ember-client/files`): `client.files` is this helper from the start,
 * instead of being loaded with `import()` on the first upload.
 */
export function files(): (client: EmberClient) => ClientFiles {
  return (client) => new ClientFiles(client);
}

/** `uploadFile(client, data, opts)` = `client.files.upload(data, opts)`. */
export const uploadFile = (client: EmberClient, data: UploadData, opts?: UploadFileOptions): Promise<UploadedFile> => new ClientFiles(client).upload(data, opts);
