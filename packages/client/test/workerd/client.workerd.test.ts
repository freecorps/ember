/**
 * EmberClient against the real runtime (Shard DO, hibernation WebSockets) and the real `@ember/server` engine,
 * running `packages/runtime/test/app.ts` in workerd.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EmberClient, type QuerySnapshot, type WebSocketLike } from "../../src/index.ts";

/** WHATWG-style socket over `SELF.fetch` + `Upgrade: websocket` (workerd's `WebSocketPair` client end). */
class SelfWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  private ws: WebSocket | null = null;

  constructor(url: string) {
    SELF.fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } }).then(
      (res) => {
        const ws = res.webSocket;
        if (!ws || this.readyState !== 0) return this.closed(1006);
        ws.accept();
        this.ws = ws;
        this.readyState = 1;
        ws.addEventListener("message", (e) => this.onmessage?.({ data: e.data }));
        ws.addEventListener("close", (e) => this.closed(e.code));
        ws.addEventListener("error", (e) => this.onerror?.(e));
        this.onopen?.({});
      },
      () => this.closed(1006),
    );
  }

  private closed(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  send(data: string): void {
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

type Row = { _id: string; body: string; channel: string; n?: bigint; blob?: Uint8Array };

describe("EmberClient over a real WebSocket in workerd", () => {
  it("subscribes, confirms an optimistic mutation via patch.mids, and round-trips bigint/bytes", async () => {
    const shard = `org:it-${crypto.randomUUID()}`;
    const client = new EmberClient({
      url: "http://ember",
      WebSocket: SelfWebSocket,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as any, init as any)) as typeof fetch,
      connectivity: null,
      defaultShard: shard,
      heartbeat: false,
      auth: () => "good:alice",
    });
    const seen: Array<QuerySnapshot<Row[]> & { pending: number }> = [];
    const off = client.subscribe("messages:list", { channel: "c" }, {}, (s: QuerySnapshot<Row[]>) =>
      seen.push({ ...s, pending: client.connectionState().pendingMutations }),
    );
    await expect.poll(() => seen.at(-1)?.status).toBe("success");
    expect(seen.at(-1)!.value).toEqual([]);

    const n = 2n ** 62n + 1n; // beyond Number.MAX_SAFE_INTEGER
    const blob = new Uint8Array([0, 1, 255]);
    const id = await client.mutation("messages:send", { channel: "c", body: "hi", n, blob }, {
      optimisticUpdate: (store, args) => {
        const cur = (store.getQuery("messages:list", { channel: "c" }) ?? []) as Row[];
        store.setQuery("messages:list", { channel: "c" }, [...cur, { _id: "optimistic", ...args }]);
      },
    });
    expect(id).toMatch(/^messages_/);

    // optimistic first, then the confirmed row (from the patch listing our mid) while the mres was still pending
    const ids = seen.map((s) => s.value?.map((r) => r._id));
    expect(ids).toEqual([[], ["optimistic"], [id]]);
    expect(seen[1]!.optimistic).toBe(true);
    expect(seen[2]).toMatchObject({ optimistic: false, pending: 1 });

    const row = seen[2]!.value![0]!;
    expect(row.n).toBe(n);
    expect(row.blob).toEqual(blob);
    expect(row).toMatchObject({ body: "hi", author: "alice" });

    // HTTP one-shot through the same tagged JSON
    const viaHttp = (await client.query("messages:list", { channel: "c" })) as Row[];
    expect(viaHttp[0]!.n).toBe(n);
    off();
    client.close();
  });
});
