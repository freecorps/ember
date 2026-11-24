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

import type { FileId } from "@freecorps/ember-values";
import {
  EMPTY_SHA256,
  ORPHAN_CLAIM_MS,
  emberObjectKey,
  fileMetadata,
  fileKey,
  tmpKey,
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
  /** Which of `keys` no row references; `claim`: with a tombstone each (`FileStore.orphans`). */
  fileOrphans(shard: string, keys: string[], claim: boolean): Promise<FileResult<Array<{ key: string; id: string | null }>>>;
  /** Drops the tombstones once their objects are deleted. */
  fileOrphansDone(shard: string, ids: string[]): Promise<FileResult<null>>;
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

/**
 * Rotated secrets (`ember keys rotate`): `<NAME>` is generation 0 and `<NAME>_R<n>` generation n. The highest
 * generation signs; every one still bound verifies (the CLI keeps the current and the previous generation), so
 * values never have to be read back to rotate.
 */
export function rotatedSecrets(env: Record<string, unknown>, name: string): string[] {
  const gens: Array<[number, string]> = [];
  const base = env[name];
  if (typeof base === "string" && base) gens.push([0, base]);
  const re = new RegExp(`^${name}_R(\\d+)$`);
  for (const [k, v] of Object.entries(env)) {
    const m = re.exec(k);
    if (m && typeof v === "string" && v) gens.push([Number(m[1]), v]);
  }
  return gens.sort((a, b) => b[0] - a[0]).map(([, v]) => v);
}

/**
 * S3 presign when credentials are configured, else proxy mode through this Worker. Proxy URLs are relative to the
 * runtime (`/api/storage/...`, which the client joins with its `url`), or absolute under `EMBER_PUBLIC_URL` with the
 * mount `basePath` in them. Null without a bucket.
 */
export function fileSignerFromEnv(env: EmberEnv, basePath = ""): FileSigner | null {
  if (!bucketOf(env)) return null;
  const s3 = s3ConfigFromEnv(env);
  if (s3) return s3Signer(s3);
  let secret = rotatedSecrets(env, "EMBER_STORAGE_SECRET")[0];
  if (!secret) {
    if (!warnedDevSecret && env.EMBER_ENV !== "local") console.warn("ember: EMBER_STORAGE_SECRET is not set; file download URLs use an insecure dev secret");
    warnedDevSecret = true;
    secret = DEV_STORAGE_SECRET;
  }
  const baseUrl = str(env.EMBER_PUBLIC_URL);
  // Relative URLs are relative to the runtime's own URL (the client joins them with its `url`, mount included);
  // absolute ones (EMBER_PUBLIC_URL, the origin) need the mount spelled out.
  return proxySigner({ secret, ...(baseUrl ? { baseUrl, ...(basePath ? { basePath: `${basePath}/api/storage` } : {}) } : {}) });
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

const metaOf = (r: FileRow): FileMetadata => fileMetadata(r);

/**
 * Checks the uploaded object and marks the file ready (idempotent). sha256-keyed objects are verified against the
 * R2 checksum (or re-hashed); `t/` uploads are hashed, copied to their content-addressed key and deleted.
 * `token: null` = trusted caller (queue consumer).
 */
export async function confirmUpload(bucket: R2Bucket, rpc: FileRpc, shard: string, id: string, token: string | null, known?: FileRow): Promise<ConfirmResult> {
  // `known`: the row the caller just read for (id, token) (multipart `complete`, the R2 event): no second RPC for it.
  const r = await confirmOnce(bucket, rpc, shard, id, token, known);
  if (r.ok || r.code !== "not_uploaded") return r;
  // A concurrent confirmer (the R2 event consumer vs. an explicit confirm/complete) may have moved the `t/` object
  // to its content-addressed key between our reads. If the row is ready now, that race was won by the other side.
  const again = await rpc.fileUploadTarget(shard, id, token);
  return again.ok && again.value.state === "ready" ? { ok: true, file: metaOf(again.value) } : r;
}

/** `t/` uploads up to this size are read once into memory (hash and copy from the same bytes: one R2 read, not two). */
const SMALL_UPLOAD = 4 * 1024 * 1024;

async function confirmOnce(bucket: R2Bucket, rpc: FileRpc, shard: string, id: string, token: string | null, known?: FileRow): Promise<ConfirmResult> {
  let row: FileRow;
  if (known && known.id === id) row = known;
  else {
    const t = await rpc.fileUploadTarget(shard, id, token);
    if (!t.ok) return { ok: false, status: 404, code: t.code, message: t.message };
    row = t.value;
  }
  if (row.state === "ready") {
    // A confirmation that stopped after `fileReady` (the copy below failed, the Worker died) left its `t/` upload
    // behind, and maybe no object at the row's key: finish it from the upload before answering that it is ready.
    const tmp = tmpKey(shard, id);
    if (row.key !== tmp && (await bucket.head(tmp))) {
      await ensureObject(bucket, row.key, async () => {
        const src = await bucket.get(tmp);
        if (!src) throw new Error(`the upload ${tmp} disappeared before ${row.key} could be written again`);
        await bucket.put(row.key, src.body, { httpMetadata: src.httpMetadata ?? {}, ...(row.sha256 ? { sha256: row.sha256 } : {}) });
      });
      await bucket.delete(tmp);
    }
    return { ok: true, file: metaOf(row) };
  }
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
  // R2's own checksum when the upload carried one; else a small object is read once (hashed and copied from memory).
  let sha = checksumHex(head);
  let bytes: Uint8Array | null = null;
  if (!sha && head.size <= SMALL_UPLOAD) {
    const obj = await bucket.get(row.key);
    if (!obj) return { ok: false, status: 409, code: "not_uploaded", message: "the object has not been uploaded yet" };
    // Replaced since `head` by a larger upload: never buffered, hashed streaming below.
    if (obj.size > SMALL_UPLOAD) await obj.body.cancel();
    else {
      bytes = new Uint8Array(await obj.arrayBuffer());
      sha = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    }
  }
  sha ??= await hashObject(bucket, row.key);
  if (!sha) return { ok: false, status: 409, code: "not_uploaded", message: "the object has not been uploaded yet" };
  if (row.sha256 && sha !== row.sha256) return reject("checksum_mismatch", "the uploaded content does not match its sha256");
  const final = fileKey(shard, sha);
  let target = await bucket.head(final);
  if (!target) {
    if (bytes) target = await bucket.put(final, bytes, { httpMetadata: head.httpMetadata ?? {}, sha256: sha });
    else {
      const src = await bucket.get(row.key);
      if (!src) return { ok: false, status: 409, code: "not_uploaded", message: "the object disappeared" };
      target = await bucket.put(final, src.body, { httpMetadata: head.httpMetadata ?? {}, sha256: sha });
    }
  }
  const r = await rpc.fileReady(shard, id, { size: head.size, etag: target?.etag ?? head.etag, sha256: sha, key: final });
  if (!r.ok) return { ok: false, status: 503, code: r.code, message: r.message };
  // The `final` object seen above may have been an orphan that a GC turn or the orphan sweep deleted before the row
  // existed (`fileReady` is refused only while their tombstone is there). The row protects it from now on: copy again.
  // Also when this call wrote `final` itself: a deleter that decided before the put (see `store`) may have removed it.
  await ensureObject(bucket, final, async () => {
    if (bytes) {
      await bucket.put(final, bytes, { httpMetadata: head.httpMetadata ?? {}, sha256: sha });
      return;
    }
    const src = await bucket.get(row.key);
    if (!src) throw new Error(`the upload ${row.key} disappeared before ${final} could be written again`);
    await bucket.put(final, src.body, { httpMetadata: head.httpMetadata ?? {}, sha256: sha });
  });
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
  /** The runtime's mount point (`EmberConfig.basePath`), for the URLs it signs. */
  basePath?: string;
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
    const signer = fileSignerFromEnv(deps.env, deps.basePath);
    if (signer?.mode !== "proxy") return fail(404, "not_found", "downloads use presigned R2 URLs in this deployment");
    const key = url.searchParams.get("k") ?? "";
    const exp = Number(url.searchParams.get("exp"));
    const ct = url.searchParams.get("ct") ?? "";
    const dl = url.searchParams.get("dl") ?? "";
    // Key rotation (`ember keys rotate --files`): URLs signed with the previous generation stay valid until they expire.
    const secrets = rotatedSecrets(deps.env, "EMBER_STORAGE_SECRET");
    if (!secrets.length) secrets.push(DEV_STORAGE_SECRET);
    const sig = url.searchParams.get("sig");
    if (!key || !Number.isFinite(exp) || !secrets.some((s) => sig === proxyGetSignature(s, key, exp, ct, dl))) return fail(403, "bad_signature", "invalid signature");
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
    const signer = fileSignerFromEnv(deps.env, deps.basePath)!;
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
          const r = await confirmUpload(bucket, rpc, shard, id, token, row);
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
    const r = await confirmUpload(bucket, rpc, shard, row.id, null, row);
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

/** Writes `key` again when it is missing (after the row that references it exists). */
async function ensureObject(bucket: R2Bucket, key: string, write: () => Promise<unknown>): Promise<void> {
  if (!(await bucket.head(key))) await write();
}

/**
 * Deletes the objects among `keys` (all of `shard`) that no `_files` row references, safely against a concurrent
 * upload of the same content: the shard tombstones the orphans in the transaction that checks them (registering or
 * confirming that key is refused meanwhile), the objects go, then the tombstones. Returns the keys deleted. A failure
 * after the claim leaves tombstones that the shard's GC finishes (a stale `deleting` row).
 */
export async function deleteOrphans(bucket: R2Bucket, rpc: Pick<FileRpc, "fileOrphans" | "fileOrphansDone">, shard: string, keys: string[], now: () => number = Date.now): Promise<string[]> {
  const asked = now();
  const claimed = await rpc.fileOrphans(shard, keys, true);
  if (!claimed.ok) throw Object.assign(new Error(claimed.message), { code: claimed.code });
  const mine = claimed.value.filter((o): o is { key: string; id: string } => o.id !== null);
  if (!mine.length) return [];
  // The claim is this sweep's for ORPHAN_CLAIM_MS, counted by the shard from when it wrote the tombstones (after
  // `asked`). A sweep that got its answer late does not delete on what may be left of it: past that, a GC turn may
  // finish the tombstone and a new upload may register the key. The tombstones stay, and the shard's GC deletes the
  // objects itself (it removes a row only after its own delete) when the release below cannot drop them.
  if (now() - asked > ORPHAN_CLAIM_MS / 2) {
    // Best effort: the shard drops the tombstones that are still this sweep's (by its own clock), so the content is
    // not held for the rest of the claim and a later sweep can take the objects; the ones it keeps go to its GC.
    await rpc.fileOrphansDone(shard, mine.map((o) => o.id)).catch(() => undefined);
    throw Object.assign(new Error(`the claim on ${mine.length} object(s) of ${shard} took too long to come back; nothing was deleted (run the sweep again)`), { code: "OrphanClaimLate" });
  }
  await bucket.delete(mine.map((o) => o.key));
  // The objects are gone whatever happens next: a release that fails (an answer or a thrown RPC) leaves tombstones
  // for the GC, and the keys are still reported as deleted.
  const left = await rpc.fileOrphansDone(shard, mine.map((o) => o.id)).then(
    (done) => (done.ok ? null : `${done.code}: ${done.message}`),
    (e: unknown) => (e as Error).message,
  );
  if (left !== null) console.error(`ember: files: ${mine.length} orphan tombstone(s) of ${shard} left for the GC: ${left}`);
  return mine.map((o) => o.key);
}

function unwrap<T>(r: FileResult<T>): T {
  if (r.ok) return r.value;
  throw Object.assign(new Error(r.message), { code: r.code });
}

/** Best effort: the cleanup of a failed `store` must not hide its error. */
async function dropUnreferenced(rpc: FileRpc, bucket: R2Bucket, shard: string, key: string): Promise<void> {
  try {
    await deleteOrphans(bucket, rpc, shard, [key]);
  } catch (e) {
    console.error(`ember: files: could not remove ${key} after a failed store (the orphan sweep can): ${(e as Error).message}`);
  }
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
      const put = () => b.put(key, bytes, { httpMetadata: { contentType: contentType ?? "application/octet-stream" }, sha256: sha });
      let head = await b.head(key);
      const wrote = !head;
      if (!head) head = await put();
      let r: FileResult<string>;
      try {
        r = await rpc().fileRegister(shard, { sha256: sha, size: bytes.byteLength, contentType, etag: head?.etag ?? null });
      } catch (e) {
        if (wrote) await dropUnreferenced(rpc(), b, shard, key);
        throw e;
      }
      // Not registered (a refused shard, a limit, ...): the object this call wrote goes, unless a row references it
      // (a concurrent store of the same content). Left in place when the shard cannot say: the orphan sweep finds it.
      if (!r.ok && wrote) await dropUnreferenced(rpc(), b, shard, key);
      const id = unwrap(r) as FileId;
      // The object seen by `head` may have been an orphan that a GC turn or the orphan sweep deleted before the row
      // existed (`fileRegister` is refused only while their tombstone is there). The row protects it from now on.
      // Also after writing it here: until the row exists nothing protects a fresh object either, and a deleter that
      // decided before this put (a GC retry of a stale tombstone, a sweep working from an older listing) may remove
      // it and drop its tombstone before `fileRegister` runs.
      await ensureObject(b, key, put);
      return id;
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

// ------------------------------------------------------------------------------------------------ orphan sweep

/** Default age below which an object is never an orphan (an upload in flight, an import between blob and row). */
export const ORPHAN_GRACE_MS = 24 * 3_600_000;
/** Objects listed per page (R2 lists at most 1000). */
export const ORPHAN_PAGE_DEFAULT = 500;
export const ORPHAN_PAGE_MAX = 1000;

export interface OrphanSweepOptions {
  /** Where the previous page stopped (`cursor` of its result); absent: from the start of the bucket. */
  cursor?: string | null;
  limit?: number;
  graceMs?: number;
  /** Delete the orphans of this page (default: only list them). */
  delete?: boolean;
  now?: number;
}

export interface OrphanSweepPage {
  /** Objects listed in this page. */
  scanned: number;
  /** Not an Ember key (`f/<shard>/<sha256>`, `t/<shard>/<storageId>`): never touched. */
  foreign: number;
  /** Ember keys newer than the grace period: not considered. */
  young: number;
  /** Objects no row of their shard references (deleted ones included, when `delete`). */
  orphans: Array<{ key: string; shard: string; size: number; uploaded: number }>;
  deleted: number;
  /** Shards that could not answer (refused, unreachable): their objects were left alone. */
  skipped: Array<{ shard: string; keys: number; code: string; message: string }>;
  graceMs: number;
  cursor: string | null;
  done: boolean;
}

/**
 * One page of the orphan sweep (admin `POST /api/_ember/files/orphans`, `ember files orphans`). Lists `limit` objects
 * of the bucket (never the whole bucket), keeps the Ember keys older than the grace period, and asks each key's shard
 * (the key names it: an object belongs to exactly one shard) which of them no `_files` row references. With `delete`
 * they are removed through `deleteOrphans` (tombstone, delete, drop the tombstone).
 */
export async function sweepOrphans(bucket: R2Bucket, rpcOf: (shard: string) => FileRpc, validShard: (shard: string) => boolean, o: OrphanSweepOptions = {}): Promise<OrphanSweepPage> {
  const now = o.now ?? Date.now();
  const graceMs = o.graceMs ?? ORPHAN_GRACE_MS;
  const limit = Math.max(1, Math.min(ORPHAN_PAGE_MAX, Math.floor(o.limit ?? ORPHAN_PAGE_DEFAULT)));
  const page = await bucket.list({ limit, ...(o.cursor ? { cursor: o.cursor } : {}) });
  const out: OrphanSweepPage = { scanned: page.objects.length, foreign: 0, young: 0, orphans: [], deleted: 0, skipped: [], graceMs, cursor: page.truncated ? page.cursor : null, done: !page.truncated };
  const byShard = new Map<string, R2Object[]>();
  for (const obj of page.objects) {
    const owner = emberObjectKey(obj.key);
    if (!owner || !validShard(owner.shard)) {
      out.foreign++;
      continue;
    }
    if (obj.uploaded.getTime() > now - graceMs) {
      out.young++;
      continue;
    }
    let list = byShard.get(owner.shard);
    if (!list) byShard.set(owner.shard, (list = []));
    list.push(obj);
  }
  for (const [shard, objs] of byShard) {
    const rpc = rpcOf(shard);
    const keys = objs.map((x) => x.key);
    try {
      let orphanKeys: string[];
      if (o.delete) {
        orphanKeys = await deleteOrphans(bucket, rpc, shard, keys);
        out.deleted += orphanKeys.length;
      } else {
        const r = await rpc.fileOrphans(shard, keys, false);
        if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
        orphanKeys = r.value.map((x) => x.key);
      }
      const set = new Set(orphanKeys);
      for (const x of objs) if (set.has(x.key)) out.orphans.push({ key: x.key, shard, size: x.size, uploaded: x.uploaded.getTime() });
    } catch (e) {
      out.skipped.push({ shard, keys: keys.length, code: (e as { code?: string }).code ?? "Error", message: (e as Error).message });
    }
  }
  return out;
}
