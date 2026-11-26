// Feature "zframe" (protocol v1.5): a frame the shard sends that is larger than ZFRAME_MIN_CHARS goes as a binary
// WebSocket message holding the frame's UTF-8 text compressed with raw DEFLATE (`CompressionStream("deflate-raw")`,
// native in workerd and browsers: no dependency). Only server → client, and only to a client whose hello announced the
// feature: the big frames are the shard's (`snap`, `patch` of many rows, a batch of them), while a client's frames are
// small (`sub`, `mut` args) and a Durable Object bills incoming messages by count, not size.

/** Frames up to this many UTF-16 units go as text (compressing them saves little and costs CPU). */
export const ZFRAME_MIN_CHARS = 2048;

/** `CompressionStream("deflate-raw")` exists here (every workerd that runs this runtime has it). */
export function zframeSupported(): boolean {
  try {
    return typeof CompressionStream === "function" && !!new CompressionStream("deflate-raw");
  } catch {
    return false;
  }
}

/** The frame's UTF-8 bytes, compressed with raw DEFLATE. */
export async function deflateFrame(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(text)).catch(() => undefined);
  void writer.close().catch(() => undefined);
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
