// Feature "zframe" (protocol v1.5), the client's side: a binary message from the shard is a frame's UTF-8 text
// compressed with raw DEFLATE, decoded with the platform's `DecompressionStream("deflate-raw")` (browsers, workerd,
// Node 22+, Deno, Bun; not Hermes: React Native never announces the feature). No dependency, and no import: the
// multi-tab hub (loaded with `import()`) uses it too.

let supported: boolean | undefined;

/** This platform can decode zframes (`DecompressionStream("deflate-raw")` and `Response`). Checked once. */
export function zframeSupported(): boolean {
  if (supported !== undefined) return supported;
  try {
    supported = typeof DecompressionStream === "function" && typeof Response === "function" && !!new DecompressionStream("deflate-raw");
  } catch {
    supported = false;
  }
  return supported;
}

/** The text of a binary frame (ArrayBuffer, a typed array, or a Blob, as a socket may deliver it). */
export async function inflateFrame(data: unknown): Promise<string> {
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else if (typeof Blob !== "undefined" && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
  else throw new Error("zframe: not a binary frame");
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
  void writer.close().catch(() => undefined);
  return await new Response(ds.readable).text();
}

/**
 * Frames of one socket, handled in the order they came: text at once while no binary frame is being decoded, else
 * behind it. `handle` gets each frame's text; `failed` a binary frame that did not decode.
 */
export class FrameQueue {
  private behind: Promise<void> | null = null;

  constructor(
    private readonly handle: (text: string) => void,
    private readonly failed: (e: unknown) => void,
  ) {}

  push(data: unknown): void {
    if (typeof data === "string" && !this.behind) return this.handle(data);
    const text = typeof data === "string" ? Promise.resolve(data) : inflateFrame(data);
    // Decoded meanwhile (in parallel), handled in order.
    text.catch(() => undefined);
    const next: Promise<void> = (this.behind ?? Promise.resolve())
      .then(() => text)
      .then(
        (t) => this.handle(t),
        (e: unknown) => this.failed(e),
      )
      .catch((e: unknown) => this.failed(e));
    this.behind = next;
    void next.finally(() => {
      if (this.behind === next) this.behind = null;
    });
  }
}
