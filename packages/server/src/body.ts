// Bounded request bodies (CWE-770): Web APIs only (Request, ReadableStream, TextDecoder), so this runs in workerd,
// browsers and React Native. The runtime reads its own endpoints' bodies with these (packages/runtime/src/body.ts
// re-exports them) and typed HTTP routes (http.ts) read theirs.

/**
 * Largest request body in bytes the Worker reads: `POST /api/query|mutation|action` (and `/api/<kind>/<fn>`), the
 * storage JSON calls and typed HTTP routes. The WebSocket frame limit (the runtime's `MAX_FRAME_BYTES`, 1 MiB), so
 * whatever a client can send over the socket also fits over HTTP. Past it: 413 `too_large`.
 */
export const MAX_HTTP_BODY_BYTES = 1 << 20;

/**
 * Reads a request body up to `max` bytes (the actual bytes on the wire, never a decoded string's length), stopping and
 * cancelling the stream as soon as it passes the limit: a body without `content-length` (streamed, chunked) is never
 * buffered past `max`. Null: too large.
 */
export async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * A request's body as text, at most `max` bytes: refused by a `content-length` over `max` before anything is read and,
 * without one (or with a wrong one), while reading (`readLimited`). Null: too large (answer 413).
 */
export async function readLimitedText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > max) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readLimited(request.body, max);
  return bytes ? new TextDecoder().decode(bytes) : null;
}
