/**
 * The Expo Updates protocol v1 (docs.expo.dev/technical-specs/expo-updates-1), the parts that need no database: the
 * request headers, Expo SFV dictionaries (`expo-expect-signature`, `expo-signature`), the manifest and directive
 * bodies, the `multipart/mixed` response and its RSA-SHA256 signature (WebCrypto only: runs in workerd, browsers and
 * Node). Behaviour follows the spec and Expo's reference server (github.com/expo/custom-expo-updates-server):
 *
 * - `expo-protocol-version` 0 or 1 (missing = 0); anything else → 406.
 * - `expo-platform` `ios` | `android` (else 400) and `expo-runtime-version` (required, else 400).
 * - A response is `multipart/mixed` (parts `manifest` + `extensions`, or `directive`) when the client accepts it, else
 *   the manifest alone as JSON (which cannot carry a directive: 406 for a rollback, 204 for "no update").
 * - Directives only in protocol 1. `noUpdateAvailable` when the client already runs the update served (or, for a
 *   rollback, already runs the embedded one); in protocol 0 "nothing to serve" is a 204 and the manifest is sent even
 *   when it is the client's current one (the client compares ids itself).
 * - `expo-signature: sig="<base64 RSA-SHA256 of the part body>", keyid="<id>"` on the `manifest`/`directive` part (an
 *   HTTP header in the JSON form) when the request sent `expo-expect-signature`.
 */

export type Platform = "ios" | "android";
export const PLATFORMS: readonly Platform[] = ["ios", "android"];

/** One asset of an update as stored: content address (hex SHA-256) and the key the bundle refers to it by. */
export interface StoredAsset {
  /** Lowercase hex SHA-256 of the bytes (the content address in R2 and in `/assets?key=`). */
  sha256: string;
  /** The asset's key in the bundle's asset registry (Metro's MD5, the file name in `dist/assets/`). */
  key: string;
  contentType: string;
  /** With the leading dot (`.png`); ignored for the launch asset. */
  fileExtension?: string;
}

/** What a manifest is built from (an update row). */
export interface UpdateEntry {
  kind: "update";
  uuid: string;
  createdAt: number;
  runtimeVersion: string;
  launchAsset: StoredAsset;
  assets: StoredAsset[];
  metadata: Record<string, string>;
  extra: unknown;
}

/** The manifest body (spec: "Manifest body"). */
export interface ExpoManifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: ExpoAsset;
  assets: ExpoAsset[];
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}
export interface ExpoAsset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension?: string;
  url: string;
}

/** What the server decided to send (before the client's current update is taken into account). */
export type Outcome = { type: "update"; update: UpdateEntry } | { type: "rollBackToEmbedded"; commitTime: number } | { type: "noUpdateAvailable" };

/** A parsed update request. */
export interface UpdateRequest {
  protocolVersion: 0 | 1;
  platform: Platform;
  runtimeVersion: string;
  channel: string | null;
  currentUpdateId: string | null;
  embeddedUpdateId: string | null;
  /** The install's id (`eas-client-id`, sent by expo-updates; `expo-eas-client-id` also read): rollout buckets. */
  clientId: string | null;
  /** `expo-expect-signature` was sent. */
  expectSignature: boolean;
  /** Response form from `accept`. */
  format: "multipart" | "json";
  /** The media type `accept` selected (the JSON form's `content-type`). */
  mediaType: MediaType;
}

/** The media types a response can have: multipart, or the manifest alone as JSON. */
export type MediaType = "multipart/mixed" | "application/json" | "application/expo+json";

export class ProtocolError extends Error {
  constructor(
    readonly status: 400 | 406,
    message: string,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s);

/** Reads the protocol headers; throws `ProtocolError` (400 / 406) for a request the protocol does not allow. */
export function parseUpdateRequest(headers: Headers, defaultChannel: string | null): UpdateRequest {
  const rawProto = headers.get("expo-protocol-version");
  const proto = rawProto === null || rawProto.trim() === "" ? 0 : Number(rawProto.trim());
  if (proto !== 0 && proto !== 1) throw new ProtocolError(406, `unsupported expo-protocol-version ${JSON.stringify(rawProto)} (0 or 1)`);
  const platform = (headers.get("expo-platform") ?? "").trim().toLowerCase();
  if (platform !== "ios" && platform !== "android") throw new ProtocolError(400, `expo-platform must be "ios" or "android"`);
  const runtimeVersion = (headers.get("expo-runtime-version") ?? "").trim();
  if (!runtimeVersion) throw new ProtocolError(400, "expo-runtime-version is required");
  if (runtimeVersion.length > 256) throw new ProtocolError(400, "expo-runtime-version is too long");
  const channel = (headers.get("expo-channel-name") ?? "").trim() || defaultChannel;
  if (channel !== null && channel.length > 128) throw new ProtocolError(400, "expo-channel-name is too long");
  const id = (name: string) => {
    const x = (headers.get(name) ?? "").trim().toLowerCase();
    return x && x.length <= 64 ? x : null;
  };
  const clientRaw = (headers.get("eas-client-id") ?? headers.get("expo-eas-client-id") ?? "").trim();
  const mediaType = negotiate(headers.get("accept"));
  if (!mediaType) throw new ProtocolError(406, "accept must allow multipart/mixed, application/expo+json or application/json");
  return {
    protocolVersion: proto,
    platform,
    runtimeVersion,
    channel,
    currentUpdateId: id("expo-current-update-id"),
    embeddedUpdateId: id("expo-embedded-update-id"),
    clientId: clientRaw && clientRaw.length <= 256 ? clientRaw : null,
    expectSignature: headers.has("expo-expect-signature"),
    format: mediaType === "multipart/mixed" ? "multipart" : "json",
    mediaType,
  };
}

/** In the order that breaks ties: multipart first (the protocol prefers it), then plain JSON. */
const MEDIA_TYPES: readonly MediaType[] = ["multipart/mixed", "application/json", "application/expo+json"];

/**
 * Proactive negotiation over `accept` (RFC 9110 §12.5.1): each media type takes the q-value of the most specific range
 * that matches it (`type/subtype` over `type/*` over `*` + `/*`, so `multipart/mixed;q=0` excludes multipart whatever
 * the wildcards say), and the highest q above 0 wins; ties go to multipart, then `application/json`. Null when nothing
 * is acceptable. A range with media parameters matches only what is sent: `charset=utf-8` on the JSON types (any other
 * parameter, or charset, makes it match nothing here); parameters after `q` are extensions and are ignored.
 */
export function negotiate(accept: string | null): MediaType | null {
  if (accept === null || accept.trim() === "") return "multipart/mixed";
  const ranges: Array<{ type: string; q: number; utf8Only: boolean; other: boolean }> = [];
  for (const item of accept.split(",")) {
    const [type, ...params] = item.split(";").map((s) => s.trim().toLowerCase());
    if (!type) continue;
    let q = 1;
    let utf8Only = false;
    let other = false;
    for (const p of params) {
      if (p.startsWith("q=")) {
        q = Math.min(1, Math.max(0, Number(p.slice(2)) || 0));
        break; // what follows q is accept-ext
      }
      if (p.replace(/\s*=\s*/, "=").replace(/"/g, "") === "charset=utf-8") utf8Only = true;
      else if (p) other = true;
    }
    ranges.push({ type, q, utf8Only, other });
  }
  let best: MediaType | null = null;
  let bestQ = 0;
  for (const t of MEDIA_TYPES) {
    const wildcard = `${t.slice(0, t.indexOf("/"))}/*`;
    let specificity = -1;
    let q = 0;
    for (const r of ranges) {
      // We send multipart with a boundary of our own and JSON as UTF-8: a range asking for something else is not this.
      if (r.other || (r.utf8Only && t === "multipart/mixed")) continue;
      const s = r.type === t ? 2 : r.type === wildcard ? 1 : r.type === "*/*" ? 0 : -1;
      if (s > specificity) [specificity, q] = [s, r.q];
      else if (s === specificity && s >= 0) q = Math.max(q, r.q);
    }
    if (specificity >= 0 && q > bestQ) [best, bestQ] = [t, q];
  }
  return best;
}

/**
 * What to send this client: the outcome, then the protocol's rules about what it already runs. In protocol 1 an update
 * it already runs, or a rollback when it already runs the embedded update, is `noUpdateAvailable`. Protocol 0 has no
 * directive for it: the manifest is sent and the client compares the ids (`protocolVersion` defaults to 1).
 */
export function finalOutcome(outcome: Outcome, req: Pick<UpdateRequest, "currentUpdateId" | "embeddedUpdateId"> & { protocolVersion?: 0 | 1 }): Outcome {
  if (outcome.type === "update" && req.protocolVersion !== 0 && req.currentUpdateId !== null && req.currentUpdateId === outcome.update.uuid.toLowerCase()) return { type: "noUpdateAvailable" };
  if (outcome.type === "rollBackToEmbedded" && req.currentUpdateId !== null && req.currentUpdateId === req.embeddedUpdateId) return { type: "noUpdateAvailable" };
  return outcome;
}

// ------------------------------------------------------------------------------------------------ Expo SFV

/** A value of an Expo SFV (RFC 8941 subset) dictionary. */
export type SfvValue = string | number | boolean | { token: string };

/** Parses an Expo SFV dictionary (`sig, keyid="main", alg="rsa-v1_5-sha256"`); parameters are ignored. Null if malformed. */
export function parseSfvDictionary(input: string): Map<string, SfvValue> | null {
  const out = new Map<string, SfvValue>();
  let i = 0;
  const s = input;
  const ws = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };
  const key = () => {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const bare = (): SfvValue | null => {
    if (s[i] === '"') {
      let str = "";
      for (i++; i < s.length; i++) {
        const c = s[i]!;
        if (c === "\\") {
          const n = s[++i];
          if (n !== '"' && n !== "\\") return null;
          str += n;
        } else if (c === '"') {
          i++;
          return str;
        } else str += c;
      }
      return null;
    }
    if (s[i] === "?") {
      const b = s[i + 1];
      if (b !== "0" && b !== "1") return null;
      i += 2;
      return b === "1";
    }
    const num = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const tok = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/.exec(s.slice(i));
    if (tok) {
      i += tok[0].length;
      return { token: tok[0] };
    }
    return null;
  };
  const params = () => {
    while (s[i] === ";") {
      i++;
      ws();
      if (key() === null) return false;
      if (s[i] === "=") {
        i++;
        if (bare() === null) return false;
      }
    }
    return true;
  };
  ws();
  if (i >= s.length) return out;
  for (;;) {
    ws();
    const k = key();
    if (k === null) return null;
    let value: SfvValue = true;
    if (s[i] === "=") {
      i++;
      const x = bare();
      if (x === null) return null;
      value = x;
    }
    if (!params()) return null;
    out.set(k, value);
    ws();
    if (i >= s.length) return out;
    if (s[i] !== ",") return null;
    i++;
    ws();
    if (i >= s.length) return null;
  }
}

/** Serializes a dictionary of strings (quoted), integers, booleans (`?0`; a bare key for true) and tokens. */
export function serializeSfvDictionary(entries: Record<string, SfvValue>): string {
  return Object.entries(entries)
    .map(([k, v]) => {
      if (v === true) return k;
      if (v === false) return `${k}=?0`;
      if (typeof v === "number") return `${k}=${v}`;
      if (typeof v === "object") return `${k}=${v.token}`;
      return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(", ");
}

// ------------------------------------------------------------------------------------------------ encodings

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]! + (b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!) + (c === undefined ? "=" : B64[c & 63]!);
  }
  return out;
}
export const base64url = (bytes: Uint8Array): string => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  // 4n+1 characters cannot come from any byte string: a truncated or corrupted input.
  if (clean.length % 4 === 1) throw new Error("invalid base64 (truncated)");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of clean) {
    const x = B64.indexOf(ch);
    if (x < 0) throw new Error("invalid base64");
    acc = (acc << 6) | x;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}
export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const isSha256Hex = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);
/** The manifest's asset `hash`: base64url (no padding) of the SHA-256 bytes. */
export const assetHash = (sha256Hex: string): string => base64url(hexToBytes(sha256Hex));

// ------------------------------------------------------------------------------------------------ signing

/** Signs part bodies: RSASSA-PKCS1-v1_5 with SHA-256 (`rsa-v1_5-sha256`, what `codeSigningMetadata.alg` names). */
export interface Signer {
  keyId: string;
  sign(body: string): Promise<string>;
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return [0x80 | bytes.length, ...bytes];
}
const der = (tag: number, body: Uint8Array): Uint8Array => {
  const head = [tag, ...derLength(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
};
/** PKCS#1 `RSAPrivateKey` (what `npx expo-updates codesigning:generate` writes) wrapped as PKCS#8 for WebCrypto. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }
  const alg = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const octets = der(0x04, pkcs1);
  const body = new Uint8Array(version.length + alg.length + octets.length);
  body.set(version);
  body.set(alg, version.length);
  body.set(octets, version.length + alg.length);
  return der(0x30, body);
}

/** PEM body bytes and whether it is PKCS#1 (`RSA PRIVATE KEY`) or PKCS#8 (`PRIVATE KEY`). */
function readPem(pem: string): { der: Uint8Array; pkcs1: boolean } {
  // Secrets set through a dashboard or `.dev.vars` often carry literal "\n".
  const text = pem.includes("\\n") && !pem.includes("\n") ? pem.replace(/\\n/g, "\n") : pem;
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/.exec(text);
  if (!m) throw new Error("the signing key must be a PEM private key (-----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----)");
  return { der: fromBase64(m[2]!), pkcs1: !!m[1] };
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** Imports an RSA private key PEM for signing (cached per PEM in the isolate). */
export function importSigningKey(pem: string): Promise<CryptoKey> {
  let key = keyCache.get(pem);
  if (!key) {
    const { der: bytes, pkcs1 } = readPem(pem);
    const pkcs8 = pkcs1 ? pkcs1ToPkcs8(bytes) : bytes;
    key = crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    key.catch(() => keyCache.delete(pem));
    // Bounded: the oldest key goes first (a Map keeps insertion order).
    if (keyCache.size >= 8) keyCache.delete(keyCache.keys().next().value!);
    keyCache.set(pem, key);
  }
  return key;
}

/** A `Signer` over a PEM private key. */
export function rsaSigner(pem: string, keyId = "main"): Signer {
  return {
    keyId,
    async sign(body) {
      const key = await importSigningKey(pem);
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body) as BufferSource);
      return base64(new Uint8Array(sig));
    },
  };
}

/** The `expo-signature` value for a part body. */
export async function signatureHeader(signer: Signer, body: string): Promise<string> {
  return serializeSfvDictionary({ sig: await signer.sign(body), keyid: signer.keyId });
}

// ------------------------------------------------------------------------------------------------ bodies

/** The manifest of an update; `assetUrl` gives each asset's URL (stable: the content address). */
export function buildManifest(u: UpdateEntry, assetUrl: (sha256: string) => string): ExpoManifest {
  const asset = (a: StoredAsset, launch: boolean): ExpoAsset => ({
    hash: assetHash(a.sha256),
    key: a.key,
    contentType: a.contentType,
    ...(!launch && a.fileExtension ? { fileExtension: a.fileExtension } : {}),
    url: assetUrl(a.sha256),
  });
  const extra = u.extra && typeof u.extra === "object" && !Array.isArray(u.extra) ? (u.extra as Record<string, unknown>) : {};
  return {
    id: u.uuid,
    createdAt: new Date(u.createdAt).toISOString(),
    runtimeVersion: u.runtimeVersion,
    launchAsset: asset(u.launchAsset, true),
    assets: u.assets.map((a) => asset(a, false)),
    metadata: u.metadata,
    extra,
  };
}

export const directiveBody = (o: Exclude<Outcome, { type: "update" }>): string =>
  JSON.stringify(o.type === "rollBackToEmbedded" ? { type: "rollBackToEmbedded", parameters: { commitTime: new Date(o.commitTime).toISOString() } } : { type: "noUpdateAvailable" });

export interface MultipartPart {
  name: string;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

/** An RFC 2046 `multipart/mixed` body; each part named by `content-disposition: form-data; name="..."`. */
export function multipartMixed(parts: readonly MultipartPart[], boundary: string): string {
  let out = "";
  for (const p of parts) {
    out += `--${boundary}\r\ncontent-type: ${p.contentType}\r\ncontent-disposition: form-data; name="${p.name}"\r\n`;
    for (const [k, v] of Object.entries(p.headers ?? {})) out += `${k}: ${v}\r\n`;
    out += `\r\n${p.body}\r\n`;
  }
  return `${out}--${boundary}--\r\n`;
}

/** A response as plain data (so it can be cached and replayed). */
export interface RenderedResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export class SigningKeyMissing extends Error {}

/**
 * The HTTP response for an outcome (already passed through `finalOutcome`). `signer` is required when the request
 * expects a signature (else `SigningKeyMissing`). `boundary` is the multipart boundary (random by default).
 */
export async function renderResponse(
  outcome: Outcome,
  req: Pick<UpdateRequest, "protocolVersion" | "expectSignature" | "format"> & { mediaType?: MediaType },
  o: { assetUrl: (sha256: string) => string; signer: Signer | null; boundary?: string },
): Promise<RenderedResponse> {
  const headers: Record<string, string> = { "expo-protocol-version": String(req.protocolVersion), "expo-sfv-version": "0", "cache-control": "private, max-age=0" };
  const sign = async (body: string): Promise<Record<string, string>> => {
    if (!req.expectSignature) return {};
    if (!o.signer) throw new SigningKeyMissing("code signing was requested (expo-expect-signature) but no signing key is configured");
    return { "expo-signature": await signatureHeader(o.signer, body) };
  };
  const empty = (): RenderedResponse => ({ status: 204, headers, body: null });
  if (outcome.type !== "update" && (req.protocolVersion === 0 || req.format === "json")) {
    // Protocol 0 has no directives; the JSON form cannot carry one. "Nothing new" is an empty answer; a rollback
    // cannot be expressed (the spec's 406 for "the newest item is not an update").
    if (outcome.type === "noUpdateAvailable") return empty();
    return { status: 406, headers: { ...headers, "content-type": "text/plain; charset=utf-8" }, body: "the update to serve is a directive (rollBackToEmbedded): it needs expo-protocol-version 1 and multipart/mixed" };
  }
  if (outcome.type === "update") {
    const manifest = JSON.stringify(buildManifest(outcome.update, o.assetUrl));
    const sig = await sign(manifest);
    if (req.format === "json") return { status: 200, headers: { ...headers, ...sig, "content-type": `${req.mediaType === "application/expo+json" ? "application/expo+json" : "application/json"}; charset=utf-8` }, body: manifest };
    const boundary = o.boundary ?? randomBoundary();
    const body = multipartMixed(
      [
        { name: "manifest", contentType: "application/json; charset=utf-8", body: manifest, headers: sig },
        { name: "extensions", contentType: "application/json", body: JSON.stringify({ assetRequestHeaders: {} }) },
      ],
      boundary,
    );
    return { status: 200, headers: { ...headers, "content-type": `multipart/mixed; boundary=${boundary}` }, body };
  }
  const directive = directiveBody(outcome);
  const boundary = o.boundary ?? randomBoundary();
  const body = multipartMixed([{ name: "directive", contentType: "application/json; charset=utf-8", body: directive, headers: await sign(directive) }], boundary);
  return { status: 200, headers: { ...headers, "content-type": `multipart/mixed; boundary=${boundary}` }, body };
}

function randomBoundary(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `ember-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Splits a `multipart/mixed` body into parts (headers lowercased): for tests and clients of this package. A delimiter
 * only counts at the start of a line (RFC 2046 §5.1.1: the CRLF before it belongs to it), so `--boundary` inside a
 * part's body leaves the part's bytes intact.
 */
export function parseMultipart(body: string, contentType: string): Array<{ name: string | null; headers: Record<string, string>; body: string }> {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  if (!m) throw new Error("no boundary in content-type");
  const delim = `\r\n--${m[2]}`;
  const out: Array<{ name: string | null; headers: Record<string, string>; body: string }> = [];
  // The first delimiter may open the body (no CRLF before it); what precedes it is the preamble. A match whose line
  // goes on with anything but `--` and transport padding (`--BOUNDARY2` for `BOUNDARY`) is part of the content.
  const chunks: string[] = [];
  let inPreamble = true;
  for (const piece of `\r\n${body}`.split(delim).slice(1)) {
    const eol = piece.indexOf("\r\n");
    const isDelimiter = /^(--)?[ \t]*$/.test(eol < 0 ? piece : piece.slice(0, eol));
    if (isDelimiter) {
      chunks.push(piece);
      inPreamble = false;
    } else if (!inPreamble) chunks[chunks.length - 1] += delim + piece;
  }
  for (const chunk of chunks) {
    if (chunk.startsWith("--")) break;
    // The rest of the delimiter line (transport padding) and its CRLF.
    const eol = chunk.indexOf("\r\n");
    if (eol < 0) continue;
    const text = chunk.slice(eol + 2);
    // No headers: the body starts right after the empty line.
    const split = text.startsWith("\r\n") ? 0 : text.indexOf("\r\n\r\n");
    const head = split < 0 ? text : text.slice(0, split);
    const headers: Record<string, string> = {};
    for (const line of head.split("\r\n")) {
      const c = line.indexOf(":");
      if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    const name = /name="([^"]*)"/.exec(headers["content-disposition"] ?? "")?.[1] ?? null;
    out.push({ name, headers, body: split < 0 ? "" : text.slice(split === 0 ? 2 : split + 4) });
  }
  return out;
}
