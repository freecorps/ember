// Files in the Worker (PLAN §7): R2 I/O around the shard's `_files` metadata.
//
//   PUT  /api/storage/put        proxy-mode single upload (token from the upload ticket)
//   PUT  /api/storage/part       proxy-mode multipart part
//   POST /api/storage/multipart  {op: create | parts | complete | abort}; S3 mode signs in the Worker
//   POST /api/storage/confirm    explicit confirmation (dev, or a client that wants `ready` before continuing)
//   GET  /api/storage/get        proxy-mode download (HMAC-signed, expiring query)
//
// Confirmation also arrives from R2 event notifications (object-create → Queue → `queue()`): both paths run
// `confirmUpload`, which is idempotent.

import {
  EMPTY_SHA256,
  fileKey,
  parseFileKey,
  partPlan,
  proxyGetSignature,
  proxySigner,
  s3ObjectUrl,
  s3Signer,
  sha256HexOf,
  signRequest,
  toHex,
  type ActionImages,
  type ActionStorage,
  type FileMetadata,
  type FileRow,
  type FileSigner,
  type GetUrlOptions,
  type ImageInput,
  type S3Config,
  type StorableData,
  type UploadOptions,
  type UploadTicket,
} from "@freecorps/ember-server";
import type { EmberEnv } from "./config.ts";

/** Insecure fallback for proxy-mode download signatures (local dev only; deploy sets EMBER_STORAGE_SECRET). */
export const DEV_STORAGE_SECRET = "ember-dev-storage-secret-do-not-use-in-production";

/** Minimal Images binding surface (`env.IMAGES`, https://developers.cloudflare.com/images/transform-images/bindings/). */
export interface ImagesBindingLike {
  input(stream: ReadableStream<Uint8Array>): {
    transform(t: Record<string, unknown>): any;
    output(o: { format: string; quality?: number }): Promise<{ response(): Response; contentType(): string; image(): ReadableStream<Uint8Array> }>;
  };
  info(stream: ReadableStream<Uint8Array>): Promise<{ width?: number; height?: number; format: string; fileSize?: number }>;
}

export interface FilesConfig {
  /** Unreferenced files are deleted after this (default 24 h). */
  gcGraceMs?: number;
  /** Lifetime of upload and download URLs in seconds (default 3600). */
  urlTtlSeconds?: number;
  /** Images binding override (default `env.EMBER_IMAGES`); tests pass a mock. */
  images?: ImagesBindingLike;
}

export type FileResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** The Shard DO's file RPCs (runtime/src/shard.ts). */
export interface FileRpc {
  fileUploadTarget(shard: string, id: string, token: string | null): Promise<FileResult<FileRow>>;
  fileReady(shard: string, id: string, info: { size: number; etag: string | null; sha256?: string; key?: string }): Promise<FileResult<FileRow>>;
  fileFail(shard: string, id: string): Promise<void>;
  filesByKey(shard: string, key: string): Promise<FileRow[]>;
  fileMeta(shard: string, id: string): Promise<FileRow | null>;
  fileUrl(shard: string, id: string, opts: GetUrlOptions): Promise<string | null>;
  fileRegister(shard: string, info: { sha256: string; size: number; contentType: string | null; etag: string | null }): Promise<FileResult<string>>;
  fileGenerateUpload(shard: string, opts: UploadOptions): Promise<FileResult<UploadTicket>>;
  fileDelete(shard: string, id: string): Promise<FileResult<null>>;
}

const str = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);

export function bucketOf(env: EmberEnv): R2Bucket | null {
  return (env.EMBER_FILES as R2Bucket | undefined) ?? null;
}

/** S3 credentials for presigning (secrets EMBER_R2_ACCESS_KEY_ID / EMBER_R2_SECRET_ACCESS_KEY, vars EMBER_R2_ACCOUNT_ID / EMBER_R2_BUCKET). */
export function s3ConfigFromEnv(env: EmberEnv): S3Config | null {
  const accessKeyId = str(env.EMBER_R2_ACCESS_KEY_ID);
  const secretAccessKey = str(env.EMBER_R2_SECRET_ACCESS_KEY);
  const accountId = str(env.EMBER_R2_ACCOUNT_ID);
  const bucket = str(env.EMBER_R2_BUCKET);
  if (!accessKeyId || !secretAccessKey || !accountId || !bucket || env.EMBER_FILES_MODE === "proxy") return null;
  const endpoint = str(env.EMBER_R2_ENDPOINT);
  return { accountId, bucket, credentials: { accessKeyId, secretAccessKey }, ...(endpoint ? { endpoint } : {}) };
}

let warnedDevSecret = false;

/** S3 presign when credentials are configured, else proxy mode through this Worker. Null without a bucket. */
export function fileSignerFromEnv(env: EmberEnv): FileSigner | null {
  if (!bucketOf(env)) return null;
  const s3 = s3ConfigFromEnv(env);
  if (s3) return s3Signer(s3);
  let secret = str(env.EMBER_STORAGE_SECRET);
  if (!secret) {
    if (!warnedDevSecret && env.EMBER_ENV !== "local") console.warn("ember: EMBER_STORAGE_SECRET is not set; file download URLs use an insecure dev secret");
    warnedDevSecret = true;
    secret = DEV_STORAGE_SECRET;
  }
  const baseUrl = str(env.EMBER_PUBLIC_URL);
  return proxySigner({ secret, ...(baseUrl ? { baseUrl } : {}) });
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, PUT, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-amz-checksum-sha256, range",
  "access-control-expose-headers": "etag, content-length, content-range",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...extra } });
const fail = (status: number, code: string, message: string) => json({ ok: false, error: { code, message } }, status);

async function hashObject(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const ds = new crypto.DigestStream("SHA-256");
  await obj.body.pipeTo(ds);
  return toHex(new Uint8Array(await ds.digest));
}

const checksumHex = (head: R2Object): string | null => {
  const c = head.checksums?.sha256;
  return c ? toHex(new Uint8Array(c)) : null;
};

export type ConfirmResult = { ok: true; file: FileMetadata } | { ok: false; status: number; code: string; message: string };

const metaOf = (r: FileRow): FileMetadata => ({ storageId: r.id, sha256: r.sha256, size: r.size, contentType: r.contentType, state: r.state, createdAt: r.createdAt });

/**
 * Checks the uploaded object and marks the file ready (idempotent). sha256-keyed objects are verified against the
 * R2 checksum (or re-hashed); `t/` uploads are hashed, copied to their content-addressed key and deleted.
 * `token: null` = trusted caller (queue consumer).
 */
export async function confirmUpload(bucket: R2Bucket, rpc: FileRpc, shard: string, id: string, token: string | null): Promise<ConfirmResult> {
  const r = await confirmOnce(bucket, rpc, shard, id, token);
  if (r.ok || r.code !== "not_uploaded") return r;
  // A concurrent confirmer (the R2 event consumer vs. an explicit confirm/complete) may have moved the `t/` object
  // to its content-addressed key between our reads. If the row is ready now, that race was won by the other side.
  const again = await rpc.fileUploadTarget(shard, id, token);
  return again.ok && again.value.state === "ready" ? { ok: true, file: metaOf(again.value) } : r;
}

async function confirmOnce(bucket: R2Bucket, rpc: FileRpc, shard: string, id: string, token: string | null): Promise<ConfirmResult> {
  const t = await rpc.fileUploadTarget(shard, id, token);
  if (!t.ok) return { ok: false, status: 404, code: t.code, message: t.message };
  const row = t.value;
  if (row.state === "ready") return { ok: true, file: metaOf(row) };
  if (row.state !== "pending") return { ok: false, status: 409, code: "upload_failed", message: `upload ${id} is ${row.state}` };
  const head = await bucket.head(row.key);
  if (!head) return { ok: false, status: 409, code: "not_uploaded", message: "the object has not been uploaded yet" };
  const reject = async (code: string, message: string): Promise<ConfirmResult> => {
    await bucket.delete(row.key);
    await rpc.fileFail(shard, id);
    return { ok: false, status: 400, code, message };
  };
  if (row.size !== null && head.size !== row.size) return reject("size_mismatch", `uploaded ${head.size} bytes, expected ${row.size}`);
  const kind = parseFileKey(row.key)?.kind;
  if (kind === "f") {
    const sha = checksumHex(head) ?? (await hashObject(bucket, row.key));
    if (sha !== row.sha256) return reject("checksum_mismatch", "the uploaded content does not match its sha256");
    const r = await rpc.fileReady(shard, id, { size: head.size, etag: head.etag });
    return r.ok ? { ok: true, file: metaOf(r.value) } : { ok: false, status: 503, code: r.code, message: r.message };
  }
  const sha = await hashObject(bucket, row.key);
  if (!sha) return { ok: false, status: 409, code: "not_uploaded", message: "the object has not been uploaded yet" };
  if (row.sha256 && sha !== row.sha256) return reject("checksum_mismatch", "the uploaded content does not match its sha256");
  const final = fileKey(shard, sha);
  let target = await bucket.head(final);
  if (!target) {
    const src = await bucket.get(row.key);
    if (!src) return { ok: false, status: 409, code: "not_uploaded", message: "the object disappeared" };
    target = await bucket.put(final, src.body, { httpMetadata: head.httpMetadata ?? {}, sha256: sha });
  }
  const r = await rpc.fileReady(shard, id, { size: head.size, etag: target?.etag ?? head.etag, sha256: sha, key: final });
  if (!r.ok) return { ok: false, status: 503, code: r.code, message: r.message };
  await bucket.delete(row.key);
  return { ok: true, file: metaOf(r.value) };
}

// ------------------------------------------------------------------------------------------------ S3 (multipart)

async function s3Fetch(c: S3Config, method: string, key: string, query: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const url = `${s3ObjectUrl(c, key)}${query}`;
  const signed = signRequest({ method, url, headers, credentials: c.credentials, date: Date.now(), payloadHash: body ? sha256HexOf(body) : EMPTY_SHA256 });
  const res = await fetch(url, { method, headers: signed, ...(body ? { body } : {}) });
  return { status: res.status, text: await res.text() };
}

const xmlTag = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const s3Multipart = {
  async create(c: S3Config, key: string, contentType: string | null): Promise<string> {
    const r = await s3Fetch(c, "POST", key, "?uploads", undefined, contentType ? { "content-type": contentType } : {});
    const id = xmlTag(r.text, "UploadId");
    if (r.status !== 200 || !id) throw new Error(`CreateMultipartUpload failed (${r.status}): ${xmlTag(r.text, "Message") ?? r.text.slice(0, 200)}`);
    return id;
  },
  async complete(c: S3Config, key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<string | null> {
    const body =
      "<CompleteMultipartUpload>" +
      parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join("") +
      "</CompleteMultipartUpload>";
    const r = await s3Fetch(c, "POST", key, `?uploadId=${encodeURIComponent(uploadId)}`, body, { "content-type": "application/xml" });
    // S3 may answer 200 with an <Error> body.
    if (r.status !== 200 || r.text.includes("<Error>")) throw new Error(`CompleteMultipartUpload failed (${r.status}): ${xmlTag(r.text, "Message") ?? r.text.slice(0, 200)}`);
    return xmlTag(r.text, "ETag")?.replace(/&quot;/g, '"') ?? null;
  },
  async abort(c: S3Config, key: string, uploadId: string): Promise<void> {
    await s3Fetch(c, "DELETE", key, `?uploadId=${encodeURIComponent(uploadId)}`);
  },
};

// ------------------------------------------------------------------------------------------------ HTTP

export interface StorageDeps {
  env: EmberEnv;
  rpc: (shard: string) => FileRpc;
  checkShard: (shard: unknown) => string | null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Handles `/api/storage/*`; null for other paths. */
export async function handleStorageRequest(request: Request, url: URL, deps: StorageDeps): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/storage/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const bucket = bucketOf(deps.env);
  if (!bucket) return fail(501, "storage_disabled", "this deployment has no EMBER_FILES bucket");
  const route = url.pathname.slice("/api/storage/".length);

  if (route === "get") {
    if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "method_not_allowed", "use GET");
    const signer = fileSignerFromEnv(deps.env);
    if (signer?.mode !== "proxy") return fail(404, "not_found", "downloads use presigned R2 URLs in this deployment");
    const key = url.searchParams.get("k") ?? "";
    const exp = Number(url.searchParams.get("exp"));
    const ct = url.searchParams.get("ct") ?? "";
    const dl = url.searchParams.get("dl") ?? "";
    const secret = str(deps.env.EMBER_STORAGE_SECRET) ?? DEV_STORAGE_SECRET;
    if (!key || !Number.isFinite(exp) || url.searchParams.get("sig") !== proxyGetSignature(secret, key, exp, ct, dl)) return fail(403, "bad_signature", "invalid signature");
    if (exp * 1000 < Date.now()) return fail(403, "expired", "the URL has expired");
    const obj = await bucket.get(key, { range: request.headers, onlyIf: request.headers });
    if (!obj) return fail(404, "not_found", "no such file");
    const headers = new Headers(CORS);
    obj.writeHttpMetadata(headers);
    if (ct) headers.set("content-type", ct);
    if (dl) headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(dl)}`);
    headers.set("etag", obj.httpEtag);
    headers.set("cache-control", "private, max-age=3600, immutable");
    if (!("body" in obj)) return new Response(null, { status: 304, headers });
    const range = (obj as R2ObjectBody & { range?: { offset?: number; length?: number } }).range;
    if (range && request.headers.has("range") && range.offset !== undefined) {
      const len = range.length ?? obj.size - range.offset;
      headers.set("content-range", `bytes ${range.offset}-${range.offset + len - 1}/${obj.size}`);
      return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers });
    }
    return new Response(request.method === "HEAD" ? null : obj.body, { headers });
  }

  if (route === "put" || route === "part") {
    if (request.method !== "PUT") return fail(405, "method_not_allowed", "use PUT");
    const shard = deps.checkShard(url.searchParams.get("shard"));
    const id = url.searchParams.get("id") ?? "";
    const token = url.searchParams.get("token") ?? "";
    if (!shard || !id || !token) return fail(400, "bad_request", "expected ?shard, id and token");
    const t = await deps.rpc(shard).fileUploadTarget(shard, id, token);
    if (!t.ok) return fail(404, t.code, t.message);
    const row = t.value;
    if (row.state !== "pending") return fail(409, "not_pending", `upload ${id} is ${row.state}`);
    if (!request.body) return fail(400, "bad_request", "empty body");
    if (route === "put") {
      if (row.multipart) return fail(400, "bad_request", "this upload is multipart");
      const len = request.headers.get("content-length");
      if (row.size !== null && len !== null && Number(len) !== row.size) return fail(400, "size_mismatch", `content-length ${len}, expected ${row.size}`);
      const direct = parseFileKey(row.key)?.kind === "f";
      try {
        const obj = await bucket.put(row.key, request.body, {
          httpMetadata: { contentType: row.contentType ?? request.headers.get("content-type") ?? "application/octet-stream" },
          ...(direct && row.sha256 ? { sha256: row.sha256 } : {}),
        });
        return json({ ok: true, etag: obj?.etag ?? null }, 200, obj ? { etag: obj.httpEtag } : {});
      } catch (e) {
        return fail(400, "upload_rejected", (e as Error).message);
      }
    }
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const part = Number(url.searchParams.get("part"));
    if (!row.multipart || !uploadId || !Number.isInteger(part) || part < 1 || part > 10_000) return fail(400, "bad_request", "expected a multipart upload, uploadId and part 1..10000");
    try {
      const up = bucket.resumeMultipartUpload(row.key, uploadId);
      const r = await up.uploadPart(part, request.body);
      return json({ ok: true, partNumber: r.partNumber, etag: r.etag }, 200, { etag: r.etag });
    } catch (e) {
      return fail(400, "upload_rejected", (e as Error).message);
    }
  }

  if (route === "multipart" || route === "confirm") {
    if (request.method !== "POST") return fail(405, "method_not_allowed", "use POST");
    const body = await readJson(request);
    if (!body) return fail(400, "bad_request", "body must be a JSON object");
    const shard = deps.checkShard(body.shard);
    const id = typeof body.storageId === "string" ? body.storageId : "";
    const token = typeof body.token === "string" ? body.token : "";
    if (!shard || !id || !token) return fail(400, "bad_request", "expected {shard, storageId, token}");
    const rpc = deps.rpc(shard);
    if (route === "confirm") {
      const r = await confirmUpload(bucket, rpc, shard, id, token);
      return r.ok ? json({ ok: true, file: r.file }) : fail(r.status, r.code, r.message);
    }
    const t = await rpc.fileUploadTarget(shard, id, token);
    if (!t.ok) return fail(404, t.code, t.message);
    const row = t.value;
    if (!row.multipart) return fail(400, "bad_request", "this upload is not multipart");
    if (row.state !== "pending") return fail(409, "not_pending", `upload ${id} is ${row.state}`);
    const s3 = s3ConfigFromEnv(deps.env);
    const signer = fileSignerFromEnv(deps.env)!;
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    try {
      switch (body.op) {
        case "create": {
          const up = s3
            ? await s3Multipart.create(s3, row.key, row.contentType)
            : (await bucket.createMultipartUpload(row.key, { httpMetadata: { contentType: row.contentType ?? "application/octet-stream" } })).uploadId;
          const plan = row.size !== null ? partPlan(row.size) : null;
          return json({ ok: true, uploadId: up, ...(plan ? plan : {}) });
        }
        case "parts": {
          const nums = Array.isArray(body.partNumbers) ? body.partNumbers : [];
          if (!uploadId || !nums.length || nums.length > 1000 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 10_000)) return fail(400, "bad_request", "expected uploadId and 1..1000 part numbers in 1..10000");
          const now = Date.now();
          const urls = (nums as number[]).map((n) => ({
            partNumber: n,
            url: signer.partUrl(row.key, { uploadId, partNumber: n, storageId: id, token, shard, now, expiresIn: 3600 }),
          }));
          return json({ ok: true, parts: urls });
        }
        case "complete": {
          const parts = Array.isArray(body.parts) ? (body.parts as Array<{ partNumber: number; etag: string }>) : [];
          if (!uploadId || !parts.length || parts.some((p) => !Number.isInteger(p?.partNumber) || typeof p?.etag !== "string")) return fail(400, "bad_request", "expected uploadId and parts [{partNumber, etag}]");
          const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
          if (s3) await s3Multipart.complete(s3, row.key, uploadId, sorted);
          else await bucket.resumeMultipartUpload(row.key, uploadId).complete(sorted.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
          const r = await confirmUpload(bucket, rpc, shard, id, token);
          return r.ok ? json({ ok: true, file: r.file }) : fail(r.status, r.code, r.message);
        }
        case "abort": {
          if (!uploadId) return fail(400, "bad_request", "expected uploadId");
          if (s3) await s3Multipart.abort(s3, row.key, uploadId);
          else await bucket.resumeMultipartUpload(row.key, uploadId).abort();
          await rpc.fileFail(shard, id);
          return json({ ok: true });
        }
        default:
          return fail(400, "bad_request", "op must be create | parts | complete | abort");
      }
    } catch (e) {
      return fail(502, "multipart_failed", (e as Error).message);
    }
  }
  return fail(404, "not_found", "not found");
}

// ------------------------------------------------------------------------------------------------ R2 events

/** R2 event notification message (https://developers.cloudflare.com/r2/buckets/event-notifications/). */
export interface R2EventMessage {
  account: string;
  bucket: string;
  action: string;
  object: { key: string; size?: number; eTag?: string };
  eventTime?: string;
  copySource?: { bucket: string; object: string };
}

export function isR2Event(body: unknown): body is R2EventMessage {
  const b = body as R2EventMessage | null;
  return !!b && typeof b === "object" && typeof b.action === "string" && typeof b.bucket === "string" && typeof b.object?.key === "string";
}

/**
 * Object-create events confirm the pending uploads that target the key (a `t/` key names its upload; an `f/` key
 * may serve several). Delete events and foreign keys are ignored. Throws on transient failures (→ retry).
 */
export async function handleR2Event(msg: R2EventMessage, deps: StorageDeps): Promise<{ confirmed: string[] }> {
  const confirmed: string[] = [];
  if (/delete/i.test(msg.action) || /lifecycle/i.test(msg.action)) return { confirmed };
  const bucket = bucketOf(deps.env);
  const parsed = parseFileKey(msg.object.key);
  if (!bucket || !parsed) return { confirmed };
  const shard = deps.checkShard(parsed.shard);
  if (!shard) return { confirmed };
  const rpc = deps.rpc(shard);
  const rows = (await rpc.filesByKey(shard, msg.object.key)).filter((r) => r.state === "pending");
  for (const row of rows) {
    const r = await confirmUpload(bucket, rpc, shard, row.id, null);
    if (r.ok) confirmed.push(row.id);
    else if (r.status >= 500) throw new Error(`${r.code}: ${r.message}`);
  }
  return { confirmed };
}

// ------------------------------------------------------------------------------------------------ actions

async function toBytes(data: StorableData): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await (data as Blob).arrayBuffer());
}

function unwrap<T>(r: FileResult<T>): T {
  if (r.ok) return r.value;
  throw Object.assign(new Error(r.message), { code: r.code });
}

export function actionStorage(env: EmberEnv, shard: string, rpc: () => FileRpc): ActionStorage {
  const bucket = () => {
    const b = bucketOf(env);
    if (!b) throw Object.assign(new Error("storage is not configured (no EMBER_FILES bucket binding)"), { code: "StorageError" });
    return b;
  };
  return {
    getUrl: (id, opts) => rpc().fileUrl(shard, id, opts ?? {}),
    getMetadata: async (id) => {
      const r = await rpc().fileMeta(shard, id);
      return r && (r.state === "ready" || r.state === "pending") ? metaOf(r) : null;
    },
    async get(id) {
      const r = await rpc().fileMeta(shard, id);
      if (!r || r.state !== "ready") return null;
      const obj = await bucket().get(r.key);
      if (!obj) return null;
      return { storageId: id, size: obj.size, sha256: r.sha256, contentType: r.contentType ?? obj.httpMetadata?.contentType ?? null, body: obj.body, arrayBuffer: () => obj.arrayBuffer() };
    },
    async store(data, opts) {
      const bytes = await toBytes(data);
      const sha = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
      const key = fileKey(shard, sha);
      const contentType = opts?.contentType ?? (data instanceof Blob && data.type ? data.type : null);
      const b = bucket();
      let head = await b.head(key);
      if (!head) head = await b.put(key, bytes, { httpMetadata: { contentType: contentType ?? "application/octet-stream" }, sha256: sha });
      return unwrap(await rpc().fileRegister(shard, { sha256: sha, size: bytes.byteLength, contentType, etag: head?.etag ?? null }));
    },
    generateUploadUrl: async (opts) => unwrap(await rpc().fileGenerateUpload(shard, opts ?? {})),
    delete: async (id) => {
      unwrap(await rpc().fileDelete(shard, id));
    },
  };
}

export function actionImages(binding: ImagesBindingLike | undefined, storage: ActionStorage): ActionImages {
  const images = () => {
    if (!binding) throw Object.assign(new Error("no Images binding (EMBER_IMAGES)"), { code: "StorageError" });
    return binding;
  };
  const stream = async (input: ImageInput): Promise<ReadableStream<Uint8Array>> => {
    if (typeof input === "string") {
      const f = await storage.get(input);
      if (!f) throw Object.assign(new Error(`File ${input} not found or not ready`), { code: "FileNotFound" });
      return f.body;
    }
    if (input instanceof ReadableStream) return input;
    const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(await (input as Blob).arrayBuffer());
    return new Blob([bytes]).stream();
  };
  const api: ActionImages = {
    async transform(input, transform, output = { format: "image/webp" }) {
      const res = await images().input(await stream(input)).transform(transform).output(output);
      const r = res.response();
      return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: res.contentType() };
    },
    async info(input) {
      return images().info(await stream(input));
    },
    async thumbnail(storageId, opts = {}) {
      const t: Record<string, unknown> = { width: opts.width ?? 256 };
      if (opts.height !== undefined) t.height = opts.height;
      if (opts.fit) t.fit = opts.fit;
      const out = await api.transform(storageId, t, { format: opts.format ?? "image/webp", ...(opts.quality !== undefined ? { quality: opts.quality } : {}) });
      return storage.store(out.bytes, { contentType: out.contentType });
    },
  };
  return api;
}
