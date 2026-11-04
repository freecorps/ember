// AWS Signature Version 4 for the S3 API of R2 (PLAN §7): presigned URLs (query auth) and signed requests
// (header auth). Synchronous on purpose: mutations are synchronous inside (D6), and `ctx.storage.generateUploadUrl`
// / `getUrl` sign inside them, so WebCrypto's async HMAC cannot be used here. HMAC-SHA256 runs on the pure-JS
// SHA-256 of sha256.ts (a few short strings per signature); tests cross-check it against WebCrypto and the AWS
// test vectors. S3 rules: the path is URI-encoded once (no double encoding, no normalization).

import { sha256 } from "./sha256.ts";

const enc = new TextEncoder();

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hmacSha256(key: Uint8Array | string, message: Uint8Array | string): Uint8Array {
  let k = typeof key === "string" ? enc.encode(key) : key;
  const m = typeof message === "string" ? enc.encode(message) : message;
  if (k.length > 64) k = sha256(k);
  const ipad = new Uint8Array(64 + m.length);
  const opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    const b = k[i] ?? 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  ipad.set(m, 64);
  opad.set(sha256(ipad), 64);
  return sha256(opad);
}

export const sha256HexOf = (data: Uint8Array | string): string => hex(sha256(typeof data === "string" ? enc.encode(data) : data));

/** RFC 3986 percent-encoding (what SigV4 wants for query keys/values and path segments). */
export function uriEncode(s: string, keepSlash = false): string {
  let out = "";
  for (const ch of enc.encode(s)) {
    const c = String.fromCharCode(ch);
    if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39) || c === "-" || c === "_" || c === "." || c === "~") out += c;
    else if (keepSlash && c === "/") out += c;
    else out += `%${ch.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** An S3 object key as a URL path (each segment encoded once). */
export const encodeKeyPath = (key: string): string => uriEncode(key, true);

/** `YYYYMMDDTHHMMSSZ` */
export function amzDate(t: number | Date): string {
  return new Date(t).toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signingKey(secret: string, date: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256(`AWS4${secret}`, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function canonicalQuery(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Query params of a URL as raw (decoded) pairs, keeping valueless keys (`?uploads`) as "". */
function queryPairs(url: URL): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  url.searchParams.forEach((v, k) => out.push([k, v]));
  return out;
}

function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(""), signed: entries.map(([k]) => k).join(";") };
}

export interface SignInput {
  method: string;
  /** Absolute URL; its path must already be URI-encoded (see `encodeKeyPath`). */
  url: string;
  /** Headers to sign besides `host` (and the x-amz-* the signer adds). */
  headers?: Record<string, string>;
  credentials: SigV4Credentials;
  /** R2: "auto". */
  region?: string;
  service?: string;
  /** Signing time. */
  date: number | Date;
}

function stringToSign(i: SignInput, canonicalRequest: string): { scope: string; sts: string; datetime: string } {
  const datetime = amzDate(i.date);
  const scope = `${datetime.slice(0, 8)}/${i.region ?? "auto"}/${i.service ?? "s3"}/aws4_request`;
  return { scope, datetime, sts: ["AWS4-HMAC-SHA256", datetime, scope, sha256HexOf(canonicalRequest)].join("\n") };
}

/**
 * Presigned URL (query auth). `headers` (e.g. content-type, content-length, x-amz-checksum-sha256) become signed
 * headers: the client must send exactly those values. Expiry 1 s – 7 days.
 */
export function presignUrl(i: SignInput & { expiresIn: number; payloadHash?: string }): string {
  const url = new URL(i.url);
  const expires = Math.max(1, Math.min(604_800, Math.floor(i.expiresIn)));
  const headers: Record<string, string> = { host: url.host, ...lower(i.headers ?? {}) };
  const { canonical, signed } = canonicalHeaders(headers);
  const datetime = amzDate(i.date);
  const region = i.region ?? "auto";
  const service = i.service ?? "s3";
  const scope = `${datetime.slice(0, 8)}/${region}/${service}/aws4_request`;
  const params: Array<[string, string]> = [
    ...queryPairs(url),
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${i.credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", datetime],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", signed],
  ];
  if (i.credentials.sessionToken) params.push(["X-Amz-Security-Token", i.credentials.sessionToken]);
  const query = canonicalQuery(params);
  const canonicalRequest = [i.method.toUpperCase(), url.pathname || "/", query, canonical, signed, i.payloadHash ?? UNSIGNED_PAYLOAD].join("\n");
  const { sts } = stringToSign(i, canonicalRequest);
  const signature = hex(hmacSha256(signingKey(i.credentials.secretAccessKey, datetime.slice(0, 8), region, service), sts));
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`;
}

/**
 * Header auth: returns the headers to send (`x-amz-date`, `x-amz-content-sha256`, `authorization`, plus `headers`).
 * `payloadHash`: hex SHA-256 of the body (default: empty body) or UNSIGNED-PAYLOAD.
 */
export function signRequest(i: SignInput & { payloadHash?: string; /** Generic (non-S3) services: no x-amz-content-sha256 header. */ omitContentSha256?: boolean }): Record<string, string> {
  const url = new URL(i.url);
  const datetime = amzDate(i.date);
  const payloadHash = i.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = {
    ...lower(i.headers ?? {}),
    host: url.host,
    "x-amz-date": datetime,
    ...(i.omitContentSha256 ? {} : { "x-amz-content-sha256": payloadHash }),
    ...(i.credentials.sessionToken ? { "x-amz-security-token": i.credentials.sessionToken } : {}),
  };
  const { canonical, signed } = canonicalHeaders(headers);
  const canonicalRequest = [i.method.toUpperCase(), url.pathname || "/", canonicalQuery(queryPairs(url)), canonical, signed, payloadHash].join("\n");
  const { scope, sts } = stringToSign(i, canonicalRequest);
  const region = i.region ?? "auto";
  const service = i.service ?? "s3";
  const signature = hex(hmacSha256(signingKey(i.credentials.secretAccessKey, datetime.slice(0, 8), region, service), sts));
  const out: Record<string, string> = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
  delete out.host; // fetch sets it
  return out;
}

function lower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/** base64 of bytes (the form of `x-amz-checksum-sha256`). */
export function base64(bytes: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + (i + 1 < bytes.length ? A[(n >> 6) & 63]! : "=") + (i + 2 < bytes.length ? A[n & 63]! : "=");
  }
  return out;
}

export function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
