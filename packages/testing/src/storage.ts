// In-memory files for `@freecorps/ember-testing`: `ctx.storage` of actions and HTTP actions over the shard's real
// `_files` table (FileStore, as the Shard's file RPCs) and a Map in place of the R2 bucket, so ids, dedup, refcounts,
// `FileInUse` and the metadata (`sha256` lowercase hex, `size`, `contentType`, `state`) are the runtime's
// (packages/runtime/src/files.ts `actionStorage`; contracts.md "Arquivos"). URLs are the proxy signer's
// (`http://ember.test/api/storage/get?...`) and `t.fetch` serves them, and the proxy PUT of `generateUploadUrl` tickets.

import { EmberError, FileStore, fileKey, fileMetadata, proxyGetSignature, proxySigner, type ActionStorage, type FileSigner, type SqlDriver, type StorableData, type StoredFile } from "@freecorps/ember-server";
import type { FileId } from "@freecorps/ember-values";

export const STORAGE_ORIGIN = "http://ember.test";
const BASE_PATH = "/api/storage";
const SECRET = "ember-testing";

/** The test deployment's URL signer (proxy mode, absolute URLs on `STORAGE_ORIGIN`). */
export const testSigner: FileSigner = proxySigner({ secret: SECRET, baseUrl: STORAGE_ORIGIN, basePath: BASE_PATH });

type Blob_ = { bytes: Uint8Array; contentType: string };

/** The harness's bucket: object key → bytes (shared by every shard, as one R2 bucket; keys carry the shard). */
export class MemoryBucket {
  readonly objects = new Map<string, Blob_>();
  clear(): void {
    this.objects.clear();
  }
}

async function toBytes(data: StorableData): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data.slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new EmberError("ValidationError", "ctx.storage.store: data must be a Uint8Array, ArrayBuffer, Blob or string");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

const storedFile = (storageId: string, sha256: string | null, contentType: string | null, o: Blob_): StoredFile => ({
  storageId,
  size: o.bytes.byteLength,
  sha256,
  // As the runtime: the row's type, else the object's (`application/octet-stream` when stored without one).
  contentType: contentType ?? o.contentType,
  get body() {
    return new Blob([o.bytes as Uint8Array<ArrayBuffer>]).stream();
  },
  arrayBuffer: async () => o.bytes.slice().buffer,
});

/** `ctx.storage` of an action / HTTP action on `shard`. */
export function memoryStorage(opts: { shard: string; driver: () => SqlDriver; bucket: MemoryBucket; now: () => number }): ActionStorage {
  const files = () => FileStore.ofDriver(opts.driver(), { shard: () => opts.shard, signer: testSigner });
  const tx = <T>(fn: (f: FileStore) => T): T => {
    const d = opts.driver();
    return d.transaction(() => fn(files()));
  };
  return {
    getUrl: async (id, o) => files().getUrl(id, o ?? {}, opts.now()),
    getMetadata: async (id) => files().getMetadata(id),
    async get(id) {
      const r = files().get(id);
      if (!r || r.state !== "ready") return null;
      const o = opts.bucket.objects.get(r.key);
      return o ? storedFile(id, r.sha256, r.contentType, o) : null;
    },
    async store(data, o) {
      const bytes = await toBytes(data);
      const sha = await sha256Hex(bytes);
      const key = fileKey(opts.shard, sha);
      const contentType = o?.contentType ?? (data instanceof Blob && data.type ? data.type : null);
      // Content-addressed: the same bytes are one object (and one ready row) per shard.
      if (!opts.bucket.objects.has(key)) opts.bucket.objects.set(key, { bytes, contentType: contentType ?? "application/octet-stream" });
      return tx((f) => f.register({ sha256: sha, size: bytes.byteLength, contentType, etag: null }, opts.now()).id) as FileId;
    },
    generateUploadUrl: async (o) => tx((f) => f.generateUploadUrl(o ?? {}, opts.now())),
    async delete(id) {
      tx((f) => f.delete(id, opts.now()));
      // The shard's alarm runs a GC turn right after (an explicit delete is due at once): so does the harness.
      collectFiles(opts.driver(), opts.shard, opts.bucket, opts.now());
    },
  };
}

/**
 * A GC turn of a shard's files, as the Shard's alarm (FileStore `gcBegin` / `gcFinish`): rows deleted explicitly and
 * files left unreferenced past the grace period (24 h) go, with their objects. Returns how many rows went.
 */
export function collectFiles(driver: SqlDriver, shard: string, bucket: MemoryBucket, now: number): number {
  const files = FileStore.ofDriver(driver, { shard: () => shard, signer: testSigner });
  let n = 0;
  for (;;) {
    const due = driver.transaction(() => files.gcBegin(now));
    if (!due.length) return n;
    for (const d of due) if (d.deleteObject) bucket.objects.delete(d.key);
    driver.transaction(() => files.gcFinish(due.map((d) => d.id)));
    n += due.length;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, code: string, message: string) => json({ ok: false, error: { code, message } }, status);

/**
 * `t.fetch` of the storage endpoints, as the runtime's proxy mode (`handleStorageRequest`): `GET /api/storage/get`
 * (the URLs of `getUrl`, signature and expiry checked against the test clock), `PUT /api/storage/put` (a
 * `generateUploadUrl` ticket's URL) and `POST /api/storage/confirm` (`{ shard, storageId, token }`: hashes the
 * upload, moves it to its content-addressed key and marks it ready). Null for any other path.
 */
export async function serveStorage(
  request: Request,
  url: URL,
  o: { bucket: MemoryBucket; driverOf: (shard: string) => SqlDriver | null; now: () => number },
): Promise<Response | null> {
  if (!url.pathname.startsWith(`${BASE_PATH}/`)) return null;
  const route = url.pathname.slice(BASE_PATH.length + 1);
  const target = (shard: string, id: string, token: string) => {
    const driver = shard ? o.driverOf(shard) : null;
    if (!driver) return null;
    const files = FileStore.ofDriver(driver, { shard: () => shard, signer: testSigner });
    try {
      return { driver, files, row: files.uploadTarget(id, token) };
    } catch {
      return null;
    }
  };

  if (route === "get") {
    if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "method_not_allowed", "use GET");
    const key = url.searchParams.get("k") ?? "";
    const exp = Number(url.searchParams.get("exp"));
    const ct = url.searchParams.get("ct") ?? "";
    const dl = url.searchParams.get("dl") ?? "";
    if (!key || !Number.isFinite(exp) || url.searchParams.get("sig") !== proxyGetSignature(SECRET, key, exp, ct, dl)) return fail(403, "bad_signature", "invalid signature");
    if (exp * 1000 < o.now()) return fail(403, "expired", "the URL has expired");
    const obj = o.bucket.objects.get(key);
    if (!obj) return fail(404, "not_found", "no such file");
    const headers = new Headers({ "content-type": ct || obj.contentType, "content-length": String(obj.bytes.byteLength) });
    if (dl) headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(dl)}`);
    return new Response(request.method === "HEAD" ? null : (obj.bytes.slice() as Uint8Array<ArrayBuffer>), { headers });
  }

  if (route === "put") {
    if (request.method !== "PUT") return fail(405, "method_not_allowed", "use PUT");
    const id = url.searchParams.get("id") ?? "";
    const t = target(url.searchParams.get("shard") ?? "", id, url.searchParams.get("token") ?? "");
    if (!t) return fail(404, "FileNotFound", `Upload ${id} not found`);
    if (t.row.state !== "pending") return fail(409, "not_pending", `upload ${id} is ${t.row.state}`);
    if (t.row.multipart) return fail(400, "bad_request", "this upload is multipart (not emulated by @freecorps/ember-testing)");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (t.row.size !== null && bytes.byteLength !== t.row.size) return fail(400, "size_mismatch", `content-length ${bytes.byteLength}, expected ${t.row.size}`);
    // As R2's put with `sha256`: a body that does not match is refused before the write, so it never replaces the
    // object the declared hash names (shared by content with files already ready).
    if (t.row.sha256 && (await sha256Hex(bytes)) !== t.row.sha256) return fail(400, "checksum_mismatch", "the uploaded content does not match its sha256");
    o.bucket.objects.set(t.row.key, { bytes, contentType: t.row.contentType ?? request.headers.get("content-type") ?? "application/octet-stream" });
    return json({ ok: true, etag: null });
  }

  if (route === "confirm") {
    if (request.method !== "POST") return fail(405, "method_not_allowed", "use POST");
    let body: { shard?: unknown; storageId?: unknown; token?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return fail(400, "bad_request", "body must be a JSON object");
    }
    const shard = typeof body?.shard === "string" ? body.shard : "";
    const id = typeof body?.storageId === "string" ? body.storageId : "";
    const token = typeof body?.token === "string" ? body.token : "";
    if (!shard || !id || !token) return fail(400, "bad_request", "expected {shard, storageId, token}");
    const t = target(shard, id, token);
    if (!t) return fail(404, "FileNotFound", `Upload ${id} not found`);
    if (t.row.state === "ready") return json({ ok: true, file: fileMetadata(t.row) });
    if (t.row.state !== "pending") return fail(409, "upload_failed", `upload ${id} is ${t.row.state}`);
    const obj = o.bucket.objects.get(t.row.key);
    if (!obj) return fail(409, "not_uploaded", "the object has not been uploaded yet");
    const sha = await sha256Hex(obj.bytes);
    if (t.row.sha256 && sha !== t.row.sha256) {
      o.bucket.objects.delete(t.row.key);
      t.driver.transaction(() => t.files.markFailed(id, o.now()));
      return fail(400, "checksum_mismatch", "the uploaded content does not match its sha256");
    }
    const key = fileKey(shard, sha);
    if (key !== t.row.key) {
      if (!o.bucket.objects.has(key)) o.bucket.objects.set(key, obj);
      o.bucket.objects.delete(t.row.key);
    }
    const ready = t.driver.transaction(() => t.files.markReady(id, { size: obj.bytes.byteLength, etag: null, sha256: sha, key }, o.now()));
    return json({ ok: true, file: fileMetadata(ready) });
  }

  return fail(404, "not_found", `${url.pathname} is not emulated by @freecorps/ember-testing (get, put and confirm are)`);
}
