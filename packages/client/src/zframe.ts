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
 * behind it. `handle` gets each frame's text, with the `tag` it was pushed with (what held when it arrived: a frame
 * decoded later is still of then); `failed` a binary frame that did not decode.
 */
export class FrameQueue<T = undefined> {
  private behind: Promise<void> | null = null;

  constructor(
    private readonly handle: (text: string, tag: T) => void,
    private readonly failed: (e: unknown) => void,
  ) {}

  push(data: unknown, tag?: T): void {
    const t = tag as T;
    if (typeof data === "string" && !this.behind) return this.handle(data, t);
    const text = typeof data === "string" ? Promise.resolve(data) : inflateFrame(data);
    // Decoded meanwhile (in parallel), handled in order. The chain below reads `text` only once the frames ahead are
    // handled: a decode that fails before then would be an unhandled rejection meanwhile (the chain reports it).
    text.catch(() => undefined);
    const next: Promise<void> = (this.behind ?? Promise.resolve())
      .then(() => text)
      .then(
        (text_) => this.handle(text_, t),
        (e: unknown) => this.failed(e),
      )
      .catch((e: unknown) => this.failed(e));
    this.behind = next;
    void next.finally(() => {
      if (this.behind === next) this.behind = null;
    });
  }
}

/** What `withoutStale` keeps of a frame, and the channels whose member list it dropped (to ask for again). */
export interface StaleFiltered {
  text: string | null;
  channels: string[];
}

/**
 * A frame that arrived under an identity replaced since (see the socket's `FrameQueue`), without what was that
 * identity's to see: subscription deliveries (`snap`, `patch`) and channel traffic (`msg`, and the member lists of
 * `joined` and `members`, named in `channels`: the caller asks for them again, as the identity now). `text` is null
 * when nothing is left. The rest stays: `mres`, `qres`, … are not tied to whose values a subscription holds, and a
 * channel's `left`, `err` and `published` only drive its join (a refusal of a join sent as the identity before is
 * tried again as the one now) and carry nothing of the others.
 */
export function withoutStale(text: string): StaleFiltered {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, channels: [] }; // not ours to judge: `onFrame` reports it
  }
  const channels = new Set<string>();
  const stale = (m: unknown): boolean => {
    if (typeof m !== "object" || m === null) return false;
    const { t, ch } = m as { t?: unknown; ch?: unknown };
    if (t === "snap" || t === "patch" || t === "msg") return true;
    if (t === "joined" || t === "members") {
      if (typeof ch === "string") channels.add(ch);
      return true;
    }
    return false;
  };
  if (!Array.isArray(parsed)) return stale(parsed) ? { text: null, channels: [...channels] } : { text, channels: [] };
  const kept = parsed.filter((m) => !stale(m));
  const out = !kept.length ? null : kept.length === parsed.length ? text : JSON.stringify(kept);
  return { text: out, channels: [...channels] };
}
