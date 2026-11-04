// Files (PLAN §7, D9): metadata in the shard's `_files` table, bytes in R2. Pure TS and synchronous — what the
// engine needs inside queries and mutations (`ctx.storage`) and what the runtime's Shard DO uses for its RPCs
// (upload checks, confirmation, GC). The R2 I/O itself lives in @ember/runtime.
//
// Object keys (decided in docs/design/contracts.md "Files"):
//   f/<b64url(shard)>/<sha256>          content-addressed object, owned by that shard
//   t/<b64url(shard)>/<storageId>       upload whose sha256 was not known up front (or multipart); finalized by
//                                       hashing + copying to the f/ key, then deleted (R2 lifecycle expires t/)
// Content is deduplicated per shard, not across shards: each shard owns its prefix, so the per-shard refcount is
// the whole truth and GC needs no cross-shard coordination.

import type { Shape } from "@ember/values";
import { q, type SqlDriver, type SqlRow, type SqlValue } from "./driver.ts";
import { EmberError, type EmberErrorCode } from "./errors.ts";
import { ulid } from "./ids.ts";
import { base64, encodeKeyPath, hexToBytes, hmacSha256, hex, presignUrl, type SigV4Credentials } from "./sigv4.ts";

export const FILES_TABLE = "_files";
export const STORAGE_ID_PREFIX = "_storage";
export const DEFAULT_GC_GRACE_MS = 24 * 3_600_000;
/** Below this a single presigned PUT is used; S3 caps a single PUT at ~5 GiB. */
export const MAX_SINGLE_PUT = 5 * 1024 ** 3 - 5 * 1024 ** 2;
export const MIN_PART_SIZE = 5 * 1024 ** 2;
export const DEFAULT_PART_SIZE = 10 * 1024 ** 2;
export const MAX_PARTS = 10_000;
export const DEFAULT_URL_TTL_S = 3600;
/** `getUrl` signs with time rounded down to this window, so a query's value is stable while it re-runs. */
export const URL_TIME_WINDOW_MS = 5 * 60_000;

export const FILES_DDL = [
  `CREATE TABLE IF NOT EXISTS "_files" ("id" TEXT PRIMARY KEY, "sha256" TEXT, "size" INTEGER, "content_type" TEXT, ` +
    `"refcount" INTEGER NOT NULL DEFAULT 0, "state" TEXT NOT NULL, "key" TEXT NOT NULL, "etag" TEXT, "token" TEXT NOT NULL, ` +
    `"multipart" INTEGER NOT NULL DEFAULT 0, "created_at" INTEGER NOT NULL, "updated_at" INTEGER NOT NULL, "zero_since" INTEGER) STRICT`,
  `CREATE INDEX IF NOT EXISTS "_files_sha" ON "_files" ("sha256")`,
  `CREATE INDEX IF NOT EXISTS "_files_key" ON "_files" ("key")`,
  `CREATE INDEX IF NOT EXISTS "_files_gc" ON "_files" ("zero_since") WHERE "refcount" = 0`,
];

export type FileState = "pending" | "ready" | "deleting" | "failed";

export interface FileMetadata {
  storageId: string;
  sha256: string | null;
  size: number | null;
  contentType: string | null;
  state: FileState;
  createdAt: number;
}

export interface UploadOptions {
  contentType?: string;
  /** Bytes. Signed into the PUT (`content-length`) when known: R2 rejects another size. */
  size?: number;
  /** Hex SHA-256 of the content. Known up front: the object goes straight to its content-addressed key. */
  sha256?: string;
  /** Force a multipart upload (the client does this above its threshold). */
  multipart?: boolean;
}

/** What `ctx.storage.generateUploadUrl()` returns (and the client helper consumes). */
export interface UploadTicket {
  storageId: string;
  /** Capability for the upload endpoints (`/api/storage/*`): multipart, proxy PUT and confirm. */
  token: string;
  /** The content is already stored and ready: nothing to upload. */
  exists?: true;
  /** Single PUT: an absolute presigned URL (R2 S3 API) or a path on the Worker (proxy mode). */
  url?: string;
  method?: "PUT";
  /** Headers the PUT must carry exactly (they are signed). */
  headers?: Record<string, string>;
  /** Multipart: create / part URLs / complete go through `POST /api/storage/multipart`. */
  multipart?: { partSize: number };
  expiresAt: number;
}

export interface GetUrlOptions {
  /** Seconds (default 3600, max 7 days). */
  expiresIn?: number;
  /** Served as an attachment with this file name. */
  download?: string;
}

export interface StorageReader {
  /** Short-lived URL of a ready file (null if unknown or not uploaded yet). Check permissions before calling. */
  getUrl(storageId: string, opts?: GetUrlOptions): string | null;
  getMetadata(storageId: string): FileMetadata | null;
}
export interface StorageWriter extends StorageReader {
  generateUploadUrl(opts?: UploadOptions): UploadTicket;
  /** Deletes a file nothing references (FileInUse otherwise); the object goes on the next GC turn. */
  delete(storageId: string): void;
}

/** Signs object URLs. Synchronous: it runs inside queries and mutations. */
export interface FileSigner {
  readonly mode: "s3" | "proxy";
  putUrl(key: string, o: { storageId: string; token: string; shard: string; contentType?: string; size?: number; sha256?: string; now: number; expiresIn: number }): { url: string; headers: Record<string, string> };
  getUrl(key: string, o: { contentType?: string | null; download?: string; now: number; expiresIn: number }): string;
  /** Multipart part URL (the Worker hands these out after CreateMultipartUpload). */
  partUrl(key: string, o: { uploadId: string; partNumber: number; storageId: string; token: string; shard: string; now: number; expiresIn: number }): string;
}

export interface S3Config {
  /** Cloudflare account id (endpoint `https://<accountId>.r2.cloudflarestorage.com`). */
  accountId: string;
  bucket: string;
  credentials: SigV4Credentials;
  /** Override the endpoint (tests, jurisdictions: `<acct>.eu.r2.cloudflarestorage.com`). */
  endpoint?: string;
}

export const s3Endpoint = (c: S3Config): string => (c.endpoint ?? `https://${c.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
export const s3ObjectUrl = (c: S3Config, key: string): string => `${s3Endpoint(c)}/${encodeURIComponent(c.bucket)}/${encodeKeyPath(key)}`;

/** Presigned R2 S3 URLs (presigning works only on `*.r2.cloudflarestorage.com`, not custom domains). */
export function s3Signer(c: S3Config): FileSigner {
  return {
    mode: "s3",
    putUrl(key, o) {
      const headers: Record<string, string> = {};
      if (o.contentType) headers["content-type"] = o.contentType;
      if (o.size !== undefined) headers["content-length"] = String(o.size);
      if (o.sha256) headers["x-amz-checksum-sha256"] = base64(hexToBytes(o.sha256));
      const url = presignUrl({ method: "PUT", url: s3ObjectUrl(c, key), headers, credentials: c.credentials, date: o.now, expiresIn: o.expiresIn });
      // content-length is set by fetch from the body; the others must be sent as signed.
      const send = { ...headers };
      delete send["content-length"];
      return { url, headers: send };
    },
    getUrl(key, o) {
      const u = new URL(s3ObjectUrl(c, key));
      if (o.contentType) u.searchParams.set("response-content-type", o.contentType);
      if (o.download) u.searchParams.set("response-content-disposition", contentDisposition(o.download));
      return presignUrl({ method: "GET", url: u.toString(), credentials: c.credentials, date: o.now, expiresIn: o.expiresIn });
    },
    partUrl(key, o) {
      const u = new URL(s3ObjectUrl(c, key));
      u.searchParams.set("partNumber", String(o.partNumber));
      u.searchParams.set("uploadId", o.uploadId);
      return presignUrl({ method: "PUT", url: u.toString(), credentials: c.credentials, date: o.now, expiresIn: o.expiresIn });
    },
  };
}

/**
 * Proxy mode (no S3 credentials: `ember dev`, or a deployment that wants URLs on its own domain): uploads go to the
 * Worker (`/api/storage/put|part`, authorized by the upload token) and downloads to `/api/storage/get` with an
 * HMAC-signed, expiring query. `baseUrl` makes the URLs absolute (else they are paths on the deployment).
 */
export function proxySigner(o: { secret: string; baseUrl?: string; basePath?: string }): FileSigner {
  const base = `${(o.baseUrl ?? "").replace(/\/+$/, "")}${o.basePath ?? "/api/storage"}`;
  return {
    mode: "proxy",
    putUrl(_key, p) {
      const qs = new URLSearchParams({ shard: p.shard, id: p.storageId, token: p.token });
      const headers: Record<string, string> = {};
      if (p.contentType) headers["content-type"] = p.contentType;
      return { url: `${base}/put?${qs}`, headers };
    },
    getUrl(key, p) {
      const exp = Math.floor(p.now / 1000) + p.expiresIn;
      const ct = p.contentType ?? "";
      const dl = p.download ?? "";
      const qs = new URLSearchParams({ k: key, exp: String(exp) });
      if (ct) qs.set("ct", ct);
      if (dl) qs.set("dl", dl);
      qs.set("sig", proxyGetSignature(o.secret, key, exp, ct, dl));
      return `${base}/get?${qs}`;
    },
    partUrl(_key, p) {
      const qs = new URLSearchParams({ shard: p.shard, id: p.storageId, token: p.token, uploadId: p.uploadId, part: String(p.partNumber) });
      return `${base}/part?${qs}`;
    },
  };
}

export const proxyGetSignature = (secret: string, key: string, exp: number, ct: string, dl: string): string =>
  hex(hmacSha256(secret, `ember-get\n${key}\n${exp}\n${ct}\n${dl}`));

export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ------------------------------------------------------------------------------------------------ keys

function b64url(s: string): string {
  return base64(new TextEncoder().encode(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): string {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
}

export const fileKey = (shard: string, sha256: string): string => `f/${b64url(shard)}/${sha256}`;
export const tmpKey = (shard: string, storageId: string): string => `t/${b64url(shard)}/${storageId}`;

/** `{ shard, kind, rest }` of an Ember object key, or null for foreign keys. */
export function parseFileKey(key: string): { shard: string; kind: "f" | "t"; rest: string } | null {
  const m = /^([ft])\/([A-Za-z0-9_-]+)\/(.+)$/.exec(key);
  if (!m) return null;
  try {
    return { kind: m[1] as "f" | "t", shard: unb64url(m[2]!), rest: m[3]! };
  } catch {
    return null;
  }
}

const SHA_RE = /^[0-9a-f]{64}$/;
const STORAGE_ID_RE = /^_storage_[0-9A-HJKMNP-TV-Z]{26}$/;
export const isStorageId = (x: unknown): x is string => typeof x === "string" && STORAGE_ID_RE.test(x);

function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return hex(b);
}

function newStorageId(now: number): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let i = 0;
  // Secure randomness (ids double as part of upload capabilities), not the mutation's seeded random.
  return `${STORAGE_ID_PREFIX}_${ulid(now, () => b[i++ % 16]! / 256)}`;
}

// ------------------------------------------------------------------------------------------------ file fields

/** True if any file can live in a value of this shape. */
export function shapeHasFiles(shape: Shape): boolean {
  switch (shape.kind) {
    case "file":
      return true;
    case "object":
      return Object.values(shape.fields).some((f) => shapeHasFiles(f.shape));
    case "array":
      return shapeHasFiles(shape.item);
    case "record":
      return shapeHasFiles(shape.value);
    case "union":
      return shape.members.some(shapeHasFiles);
    default:
      return false;
  }
}

/** Every file id in `value` (with multiplicity). Inside unions only strings shaped like storage ids count. */
export function collectFiles(shape: Shape, value: unknown, out: string[] = [], inUnion = false): string[] {
  if (value === undefined || value === null) return out;
  switch (shape.kind) {
    case "file":
      if (typeof value === "string" && (!inUnion || isStorageId(value))) out.push(value);
      break;
    case "object":
      if (typeof value === "object" && !Array.isArray(value))
        for (const [k, f] of Object.entries(shape.fields)) collectFiles(f.shape, (value as Record<string, unknown>)[k], out, inUnion);
      break;
    case "array":
      if (Array.isArray(value)) for (const x of value) collectFiles(shape.item, x, out, inUnion);
      break;
    case "record":
      if (typeof value === "object" && !Array.isArray(value)) for (const x of Object.values(value as object)) collectFiles(shape.value, x, out, inUnion);
      break;
    case "union": {
      // A value may match several members: count each distinct id once per position.
      const seen = new Map<string, number>();
      for (const m of shape.members) {
        const local: string[] = [];
        collectFiles(m, value, local, true);
        const counts = new Map<string, number>();
        for (const id of local) counts.set(id, (counts.get(id) ?? 0) + 1);
        for (const [id, n] of counts) seen.set(id, Math.max(seen.get(id) ?? 0, n));
      }
      for (const [id, n] of seen) for (let i = 0; i < n; i++) out.push(id);
      break;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ store

type Exec = (sql: string, ...params: SqlValue[]) => SqlRow[];

export interface FileStoreOptions {
  /** This shard's name (`<kind>:<key>`): the object key prefix. */
  shard: () => string | null;
  signer?: FileSigner | null;
  /** Grace before an unreferenced file is collected (default 24 h). */
  gcGraceMs?: number;
  urlTtlSeconds?: number;
}

export interface FileRow {
  id: string;
  sha256: string | null;
  size: number | null;
  contentType: string | null;
  refcount: number;
  state: FileState;
  key: string;
  etag: string | null;
  token: string;
  multipart: boolean;
  createdAt: number;
  zeroSince: number | null;
}

const toRow = (r: SqlRow): FileRow => ({
  id: r.id as string,
  sha256: (r.sha256 as string | null) ?? null,
  size: r.size === null || r.size === undefined ? null : Number(r.size),
  contentType: (r.content_type as string | null) ?? null,
  refcount: Number(r.refcount),
  state: r.state as FileState,
  key: r.key as string,
  etag: (r.etag as string | null) ?? null,
  token: r.token as string,
  multipart: Number(r.multipart) === 1,
  createdAt: Number(r.created_at),
  zeroSince: r.zero_since === null || r.zero_since === undefined ? null : Number(r.zero_since),
});

export const fileMetadata = (r: FileRow): FileMetadata => ({ storageId: r.id, sha256: r.sha256, size: r.size, contentType: r.contentType, state: r.state, createdAt: r.createdAt });

const err = (code: EmberErrorCode, message: string) => new EmberError(code, message);

/**
 * `_files` operations over an exec function (the engine's transaction-counting exec, or a raw driver). All
 * synchronous; the caller owns the transaction.
 */
export class FileStore {
  constructor(
    private readonly exec: Exec,
    readonly options: FileStoreOptions,
  ) {}

  static ofDriver(driver: SqlDriver, options: FileStoreOptions): FileStore {
    return new FileStore((sql, ...p) => driver.exec(sql, ...p).rows, options);
  }

  static ensureTable(driver: SqlDriver): void {
    for (const s of FILES_DDL) driver.exec(s);
  }

  get graceMs(): number {
    return this.options.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
  }

  private shardName(): string {
    const s = this.options.shard();
    if (!s) throw err("StorageError", "storage: this shard's name is not known yet");
    return s;
  }

  private signer(): FileSigner {
    if (!this.options.signer) throw err("StorageError", "storage is not configured (no EMBER_FILES bucket binding)");
    return this.options.signer;
  }

  get(id: string): FileRow | null {
    if (typeof id !== "string") return null;
    const r = this.exec(`SELECT * FROM ${q(FILES_TABLE)} WHERE "id" = ?`, id)[0];
    return r ? toRow(r) : null;
  }

  byKey(key: string): FileRow[] {
    return this.exec(`SELECT * FROM ${q(FILES_TABLE)} WHERE "key" = ? ORDER BY "created_at"`, key).map(toRow);
  }

  generateUploadUrl(opts: UploadOptions = {}, now: number): UploadTicket {
    const o = checkUploadOptions(opts);
    const shard = this.shardName();
    const signer = this.signer();
    const ttl = this.options.urlTtlSeconds ?? DEFAULT_URL_TTL_S;
    const multipart = !!o.multipart || (o.size !== undefined && o.size > MAX_SINGLE_PUT);
    if (o.sha256) {
      const same = this.exec(`SELECT * FROM ${q(FILES_TABLE)} WHERE "sha256" = ? AND "state" IN ('ready', 'pending') ORDER BY "state" = 'ready' DESC, "created_at" LIMIT 1`, o.sha256)[0];
      if (same && same.state === "ready") {
        const r = toRow(same);
        return { storageId: r.id, token: r.token, exists: true, expiresAt: now + ttl * 1000 };
      }
    }
    const id = newStorageId(now);
    const token = randomToken();
    // A sha-keyed object being garbage collected must not be overwritten by a new upload: go through t/ instead.
    const direct = !!o.sha256 && !multipart && !this.exec(`SELECT 1 AS x FROM ${q(FILES_TABLE)} WHERE "key" = ? AND "state" = 'deleting' LIMIT 1`, fileKey(shard, o.sha256)).length;
    const key = direct ? fileKey(shard, o.sha256!) : tmpKey(shard, id);
    this.exec(
      `INSERT INTO ${q(FILES_TABLE)} ("id", "sha256", "size", "content_type", "refcount", "state", "key", "token", "multipart", "created_at", "updated_at", "zero_since") VALUES (?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?, ?, ?)`,
      id, o.sha256 ?? null, o.size ?? null, o.contentType ?? null, key, token, multipart ? 1 : 0, now, now, now,
    );
    const ticket: UploadTicket = { storageId: id, token, expiresAt: now + ttl * 1000 };
    if (multipart) ticket.multipart = { partSize: DEFAULT_PART_SIZE };
    else {
      const put = signer.putUrl(key, {
        storageId: id,
        token,
        shard,
        now,
        expiresIn: ttl,
        ...(o.contentType ? { contentType: o.contentType } : {}),
        ...(o.size !== undefined ? { size: o.size } : {}),
        ...(direct ? { sha256: o.sha256! } : {}),
      });
      ticket.url = put.url;
      ticket.method = "PUT";
      ticket.headers = put.headers;
    }
    return ticket;
  }

  getUrl(id: string, opts: GetUrlOptions = {}, now: number): string | null {
    const r = this.get(id);
    if (!r || r.state !== "ready") return null;
    const window = Math.floor(now / URL_TIME_WINDOW_MS) * URL_TIME_WINDOW_MS;
    const ttl = Math.max(1, Math.min(604_800, Math.floor(opts.expiresIn ?? this.options.urlTtlSeconds ?? DEFAULT_URL_TTL_S)));
    // Signed at the window start, valid for ttl + window: identical within the window (stable query values) and
    // always valid for at least `ttl` seconds after `now`.
    const expiresIn = Math.min(604_800, ttl + URL_TIME_WINDOW_MS / 1000);
    return this.signer().getUrl(r.key, { contentType: r.contentType, ...(opts.download ? { download: opts.download } : {}), now: window, expiresIn });
  }

  getMetadata(id: string): FileMetadata | null {
    const r = this.get(id);
    return r && (r.state === "ready" || r.state === "pending") ? fileMetadata(r) : null;
  }

  delete(id: string, now: number): void {
    const r = this.get(id);
    if (!r || r.state === "deleting") return;
    if (r.refcount > 0) throw err("FileInUse", `File ${id} is referenced by ${r.refcount} document field(s)`);
    // zero_since = 0: due on the next GC turn, grace or not.
    this.exec(`UPDATE ${q(FILES_TABLE)} SET "zero_since" = 0, "updated_at" = ? WHERE "id" = ?`, now, id);
  }

  /** Applies refcount deltas (same transaction as the document write). A new reference needs a live file. */
  adjust(deltas: Map<string, number>, now: number): void {
    for (const [id, d] of deltas) {
      if (!d) continue;
      if (d > 0) {
        const r = this.exec(
          `UPDATE ${q(FILES_TABLE)} SET "refcount" = "refcount" + ?, "zero_since" = NULL, "updated_at" = ? WHERE "id" = ? AND "state" IN ('pending', 'ready') RETURNING "refcount"`,
          d, now, id,
        );
        if (!r.length) throw err("FileNotFound", `File ${id} does not exist in this shard (or was deleted)`);
      } else {
        this.exec(
          `UPDATE ${q(FILES_TABLE)} SET "refcount" = max(0, "refcount" + ?), "zero_since" = CASE WHEN "refcount" + ? <= 0 THEN ? ELSE "zero_since" END, "updated_at" = ? WHERE "id" = ?`,
          d, d, now, now, id,
        );
      }
    }
  }

  // -------------------------------------------------------------------- runtime (Shard RPC) side

  /** The pending upload behind (id, token); throws on a bad token. `token: null` = trusted caller. */
  uploadTarget(id: string, token: string | null): FileRow {
    const r = this.get(id);
    if (!r || (token !== null && !sameToken(r.token, token))) throw err("FileNotFound", `Upload ${id} not found`);
    return r;
  }

  markReady(id: string, info: { size: number; etag: string | null; sha256?: string; key?: string }, now: number): FileRow {
    this.exec(
      `UPDATE ${q(FILES_TABLE)} SET "state" = 'ready', "size" = ?, "etag" = ?, "sha256" = coalesce(?, "sha256"), "key" = coalesce(?, "key"), "updated_at" = ? WHERE "id" = ? AND "state" = 'pending'`,
      info.size, info.etag, info.sha256 ?? null, info.key ?? null, now, id,
    );
    return this.get(id)!;
  }

  markFailed(id: string, now: number): void {
    this.exec(`UPDATE ${q(FILES_TABLE)} SET "state" = 'failed', "zero_since" = 0, "updated_at" = ? WHERE "id" = ? AND "state" = 'pending'`, now, id);
  }

  /** A ready row for content stored directly by the Worker (`ctx.storage.store` in actions). */
  register(info: { sha256: string; size: number; contentType: string | null; etag: string | null }, now: number): FileRow {
    const shard = this.shardName();
    const same = this.exec(`SELECT * FROM ${q(FILES_TABLE)} WHERE "sha256" = ? AND "state" = 'ready' ORDER BY "created_at" LIMIT 1`, info.sha256)[0];
    if (same) return toRow(same);
    const id = newStorageId(now);
    this.exec(
      `INSERT INTO ${q(FILES_TABLE)} ("id", "sha256", "size", "content_type", "refcount", "state", "key", "etag", "token", "multipart", "created_at", "updated_at", "zero_since") VALUES (?, ?, ?, ?, 0, 'ready', ?, ?, ?, 0, ?, ?, ?)`,
      id, info.sha256, info.size, info.contentType, fileKey(shard, info.sha256), info.etag, randomToken(), now, now, now,
    );
    return this.get(id)!;
  }

  /** When the next GC turn is due (ms), or null when nothing is collectable. */
  nextGcAt(): number | null {
    const d = this.exec(`SELECT 1 AS x FROM ${q(FILES_TABLE)} WHERE "state" = 'deleting' LIMIT 1`);
    if (d.length) return 0;
    const r = this.exec(`SELECT min("zero_since") AS m FROM ${q(FILES_TABLE)} WHERE "refcount" = 0 AND "zero_since" IS NOT NULL`)[0];
    return r && r.m !== null && r.m !== undefined ? Number(r.m) + this.graceMs : null;
  }

  /**
   * GC phase 1 (in a transaction): rows unreferenced for longer than the grace period become `deleting`. Returns
   * them with whether their object may be deleted (no live row shares the key). Rows left `deleting` by a crashed
   * turn are returned again.
   */
  gcBegin(now: number, limit = 100): Array<{ id: string; key: string; deleteObject: boolean }> {
    this.exec(
      `UPDATE ${q(FILES_TABLE)} SET "state" = 'deleting', "updated_at" = ? WHERE "id" IN (SELECT "id" FROM ${q(FILES_TABLE)} WHERE "refcount" = 0 AND "zero_since" IS NOT NULL AND "zero_since" <= ? AND "state" != 'deleting' LIMIT ?)`,
      now, now - this.graceMs, limit,
    );
    const rows = this.exec(`SELECT "id", "key" FROM ${q(FILES_TABLE)} WHERE "state" = 'deleting' LIMIT ?`, limit);
    return rows.map((r) => ({
      id: r.id as string,
      key: r.key as string,
      deleteObject: !this.exec(`SELECT 1 AS x FROM ${q(FILES_TABLE)} WHERE "key" = ? AND "state" != 'deleting' LIMIT 1`, r.key as string).length,
    }));
  }

  /** GC phase 2: the objects are gone (or shared); drop the rows. */
  gcFinish(ids: string[]): void {
    for (const id of ids) this.exec(`DELETE FROM ${q(FILES_TABLE)} WHERE "id" = ? AND "state" = 'deleting'`, id);
  }

  stats(): { total: number; ready: number; pending: number; deleting: number; unreferenced: number } {
    const r = this.exec(
      `SELECT count(*) AS total, sum("state" = 'ready') AS ready, sum("state" = 'pending') AS pending, sum("state" = 'deleting') AS deleting, sum("refcount" = 0) AS unreferenced FROM ${q(FILES_TABLE)}`,
    )[0]!;
    return { total: Number(r.total ?? 0), ready: Number(r.ready ?? 0), pending: Number(r.pending ?? 0), deleting: Number(r.deleting ?? 0), unreferenced: Number(r.unreferenced ?? 0) };
  }
}

function sameToken(a: string, b: string): boolean {
  if (typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function checkUploadOptions(o: UploadOptions): UploadOptions {
  if (typeof o !== "object" || o === null) throw err("ValidationError", "generateUploadUrl: options must be an object");
  const out: UploadOptions = {};
  if (o.contentType !== undefined) {
    if (typeof o.contentType !== "string" || o.contentType.length > 255 || /[\r\n]/.test(o.contentType)) throw err("ValidationError", "generateUploadUrl: bad contentType");
    out.contentType = o.contentType;
  }
  if (o.size !== undefined) {
    if (!Number.isSafeInteger(o.size) || o.size < 0) throw err("ValidationError", "generateUploadUrl: size must be a non-negative integer");
    out.size = o.size;
  }
  if (o.sha256 !== undefined) {
    if (typeof o.sha256 !== "string" || !SHA_RE.test(o.sha256.toLowerCase())) throw err("ValidationError", "generateUploadUrl: sha256 must be 64 hex chars");
    out.sha256 = o.sha256.toLowerCase();
  }
  if (o.multipart !== undefined) out.multipart = !!o.multipart;
  return out;
}

/** Part numbers and sizes for a multipart upload of `size` bytes (R2: equal parts except the last). */
export function partPlan(size: number, partSize = DEFAULT_PART_SIZE): { partSize: number; parts: number } {
  let ps = Math.max(MIN_PART_SIZE, partSize);
  while (Math.ceil(size / ps) > MAX_PARTS) ps *= 2;
  return { partSize: ps, parts: Math.max(1, Math.ceil(size / ps)) };
}

