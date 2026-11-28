// The Sentry envelope format, from its public spec (develop.sentry.dev/sdk/data-model/envelopes): newline-delimited,
//
//   Envelope = Header { "\n" Item } [ "\n" ]
//   Item     = Header "\n" Payload
//
// Every header is one line of JSON. An item header with `length` is followed by exactly that many payload bytes (then
// an optional "\n"); without it the payload runs to the next "\n" or the end. Parsed as bytes, because `length` counts
// bytes and attachments are binary.

/** Why an envelope was refused: `malformed` → 400, `too_large` → 413, `unsupported` → 415. */
export class EnvelopeError extends Error {
  constructor(
    readonly reason: "malformed" | "too_large" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export type JsonObject = { [k: string]: unknown };

export interface EnvelopeItem {
  /** `type` (`event`, `transaction`, `session`, `sessions`, `attachment`, `replay_event`, `replay_recording`, ...), `length`, `filename`... */
  header: JsonObject & { type: string; length?: number };
  payload: Uint8Array;
}

export interface Envelope {
  /** `event_id`, `dsn`, `sdk`, `sent_at`... */
  header: JsonObject;
  items: EnvelopeItem[];
}

const NL = 10;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function jsonLine(bytes: Uint8Array, what: string): JsonObject {
  let v: unknown;
  try {
    v = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new EnvelopeError("malformed", `${what} is not JSON`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new EnvelopeError("malformed", `${what} is not a JSON object`);
  return v as JsonObject;
}

/** Parses an envelope (already decompressed). Throws `EnvelopeError("malformed")`. */
export function parseEnvelope(buf: Uint8Array): Envelope {
  let pos = 0;
  const line = (): Uint8Array => {
    const end = buf.indexOf(NL, pos);
    const stop = end < 0 ? buf.length : end;
    const out = buf.subarray(pos, stop);
    pos = end < 0 ? buf.length : end + 1;
    return out;
  };
  if (!buf.length) throw new EnvelopeError("malformed", "empty envelope");
  const header = jsonLine(line(), "envelope header");
  const items: EnvelopeItem[] = [];
  while (pos < buf.length) {
    // Tolerated: blank lines between items (a trailing "\n" after a length-prefixed payload, CRLF-less padding).
    if (buf[pos] === NL) {
      pos++;
      continue;
    }
    const h = jsonLine(line(), `item ${items.length} header`);
    if (typeof h.type !== "string" || !h.type) throw new EnvelopeError("malformed", `item ${items.length} has no type`);
    let payload: Uint8Array;
    if (h.length !== undefined && h.length !== null) {
      const n = h.length;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new EnvelopeError("malformed", `item ${items.length}: bad length`);
      if (pos + n > buf.length) throw new EnvelopeError("malformed", `item ${items.length}: payload shorter than its length (${n})`);
      payload = buf.subarray(pos, pos + n);
      pos += n;
      if (pos < buf.length) {
        if (buf[pos] !== NL) throw new EnvelopeError("malformed", `item ${items.length}: payload longer than its length (${n})`);
        pos++;
      }
    } else {
      payload = line();
    }
    items.push({ header: h as EnvelopeItem["header"], payload });
  }
  return { header, items };
}

/** The payload of an item as JSON (an object), or throws `malformed`. */
export function itemJson(item: EnvelopeItem): JsonObject {
  return jsonLine(item.payload, `${item.header.type} payload`);
}

/** Serializes an envelope; every item gets a `length` (safe for binary payloads). */
export function serializeEnvelope(header: JsonObject, items: Array<{ header: JsonObject & { type: string }; payload: Uint8Array | string | JsonObject }>): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(JSON.stringify(header) + "\n")];
  for (const it of items) {
    const p = typeof it.payload === "string" ? encoder.encode(it.payload) : it.payload instanceof Uint8Array ? it.payload : encoder.encode(JSON.stringify(it.payload));
    parts.push(encoder.encode(JSON.stringify({ ...it.header, length: p.length }) + "\n"), p, encoder.encode("\n"));
  }
  return concat(parts);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Reads a stream up to `max` bytes; more is `too_large` (the rest is cancelled, never buffered). */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number, what = "body"): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new EnvelopeError("too_large", `${what} is larger than ${max} bytes`);
    }
    parts.push(value);
  }
  return concat(parts);
}

/** `content-encoding`: identity, gzip, deflate (zlib or raw). Decompressed bytes are capped too (a zip bomb is 413). */
export async function decodeBody(bytes: Uint8Array, encoding: string | null, max: number): Promise<Uint8Array> {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (!enc || enc === "identity") return bytes;
  if (enc !== "gzip" && enc !== "x-gzip" && enc !== "deflate") throw new EnvelopeError("unsupported", `content-encoding ${enc} is not supported (gzip, deflate)`);
  // `deflate` is zlib-wrapped per HTTP, but some clients send raw deflate: the zlib header (CMF 0x78) tells them apart.
  const format: CompressionFormat = enc === "deflate" ? (bytes[0] === 0x78 ? "deflate" : "deflate-raw") : "gzip";
  try {
    return await readCapped(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format)), max, "decompressed body");
  } catch (e) {
    if (e instanceof EnvelopeError) throw e;
    throw new EnvelopeError("malformed", `body is not valid ${enc}`);
  }
}

/** Gzip (one member). Members concatenated are a valid gzip file too (what the consumer writes per batch). */
export async function gzip(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

export async function gunzip(data: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

export const utf8 = { encode: (s: string) => encoder.encode(s), decode: (b: Uint8Array) => decoder.decode(b) };
