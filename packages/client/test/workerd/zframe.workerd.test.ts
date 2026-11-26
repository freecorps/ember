/**
 * Option `zframe` (feature "zframe", protocol v1.5) against the real runtime in workerd: the client announces it, the
 * shard sends frames above 2 KiB as raw-DEFLATE binary messages, the client decodes them in order (and so does a
 * multi-tab leader, for its tabs); small frames, and every frame to a client without the option, stay text.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EmberClient, unsafeRef, type QuerySnapshot, type WebSocketLike } from "../../src/index.ts";
import { multiTab } from "../../src/multitab.ts";
import { FakeBrowser } from "../../src/testing.ts";

/** WHATWG-style socket over `SELF.fetch`; logs each server frame as it came over the wire (text or binary). */
class WireSocket implements WebSocketLike {
  static log: WireSocket[] = [];
  readonly sent: string[] = [];
  /** Server frames: binary (and its size in bytes) or text (its length). */
  readonly wire: Array<{ binary: boolean; size: number }> = [];
  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private ws: WebSocket | null = null;

  constructor(url: string) {
    WireSocket.log.push(this);
    SELF.fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } }).then(
      (res) => {
        const ws = res.webSocket;
        if (!ws || this.readyState !== 0) return this.closed();
        ws.accept();
        this.ws = ws;
        this.readyState = 1;
        ws.addEventListener("message", (e) => {
          const data = e.data;
          this.wire.push(typeof data === "string" ? { binary: false, size: data.length } : { binary: true, size: (data as ArrayBuffer).byteLength ?? (data as Blob).size });
          this.onmessage?.({ data });
        });
        ws.addEventListener("close", () => this.closed());
        this.onopen?.({});
      },
      () => this.closed(),
    );
  }

  private closed(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  send(data: string): void {
    this.sent.push(data);
    this.ws!.send(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    try {
      this.ws?.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}

type Row = { _id: string; body: string };
const list = unsafeRef<"query">("messages:list");
const send = unsafeRef<"mutation">("messages:send");
const fetchSelf = ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as never, init as never)) as typeof fetch;

function client(shard: string, extra: Partial<ConstructorParameters<typeof EmberClient>[0]> = {}) {
  return new EmberClient({ url: "http://ember", WebSocket: WireSocket, fetch: fetchSelf, connectivity: null, defaultShard: shard, heartbeat: false, httpFirst: false, ...extra });
}

function watch<T>(c: EmberClient, args: Record<string, unknown>) {
  const seen: Array<QuerySnapshot<T>> = [];
  c.subscribe(list, args, {}, (s) => seen.push(s as QuerySnapshot<T>));
  return seen;
}

async function seed(shard: string, channel: string, n: number) {
  const w = client(shard);
  const body = (i: number) => `message ${i} of the channel, with some text to make the row a realistic size`;
  await Promise.all(Array.from({ length: n }, (_, i) => w.mutation(send, { channel, body: body(i) })));
  w.close();
}

const helloOf = (s: WireSocket) => JSON.parse(s.sent.find((f) => f.includes('"hello"'))!) as { features: string[] };

describe("zframe against the real runtime", () => {
  it("a large snap arrives compressed and decodes; small frames and a client without the option get text", async () => {
    const shard = `org:z-${crypto.randomUUID()}`;
    await seed(shard, "big", 120);
    WireSocket.log = [];
    const z = client(shard, { zframe: true });
    const plain = client(shard);
    const [zBig, pBig] = [watch<Row[]>(z, { channel: "big" }), watch<Row[]>(plain, { channel: "big" })];
    const zSmall = watch<Row[]>(z, { channel: "none" });
    await expect.poll(() => [zBig, pBig, zSmall].every((s) => s.at(-1)?.status === "success")).toBe(true);
    expect(zBig.at(-1)!.value).toEqual(pBig.at(-1)!.value);
    expect(zBig.at(-1)!.value).toHaveLength(120);
    const [zs, ps] = WireSocket.log;
    expect(helloOf(zs!).features).toContain("zframe");
    expect(helloOf(ps!).features).not.toContain("zframe");
    const compressed = zs!.wire.filter((f) => f.binary);
    expect(compressed).toHaveLength(1);
    expect(zs!.wire.filter((f) => !f.binary).every((f) => f.size <= 2048)).toBe(true);
    expect(ps!.wire.every((f) => !f.binary)).toBe(true);
    const text = Math.max(...ps!.wire.map((f) => f.size));
    expect(compressed[0]!.size).toBeLessThan(text / 4);
    console.info(`zframe (client): snap of 120 rows ${text} B as text → ${compressed[0]!.size} B compressed`);

    // Patches keep flowing, in order with the small frames (the mutation's mres comes after its patch).
    await z.mutation(send, { channel: "big", body: "one more" });
    await expect.poll(() => zBig.at(-1)?.value?.length).toBe(121);
    z.close();
    plain.close();
  });

  it("multiTab: the leader decodes the shared socket's compressed frames and its tabs get the values", async () => {
    const shard = `org:zt-${crypto.randomUUID()}`;
    await seed(shard, "big", 120);
    WireSocket.log = [];
    const browser = new FakeBrowser();
    const tab = () => {
      const t = browser.tab();
      return client(shard, { zframe: true, multiTab: multiTab({ locks: t.locks, BroadcastChannel: t.BroadcastChannel, lifecycle: false, clientIdTimeoutMs: 200 }) });
    };
    const a = tab();
    await expect.poll(() => a.tabRole).toBe("leader");
    const b = tab();
    await expect.poll(() => b.tabRole).toBe("follower");
    const wb = watch<Row[]>(b, { channel: "big" });
    await expect.poll(() => wb.at(-1)?.status).toBe("success");
    expect(wb.at(-1)!.value).toHaveLength(120);
    expect(WireSocket.log).toHaveLength(1);
    expect(WireSocket.log[0]!.wire.some((f) => f.binary)).toBe(true);
    // The leader's own tab joins the same query: answered from the leader's copy.
    const wa = watch<Row[]>(a, { channel: "big" });
    await expect.poll(() => wa.at(-1)?.value?.length).toBe(120);
    await b.mutation(send, { channel: "big", body: "from b" });
    await expect.poll(() => [wa.at(-1)?.value?.length, wb.at(-1)?.value?.length]).toEqual([121, 121]);
    b.close();
    a.close();
  });
});
