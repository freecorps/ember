/**
 * EmberClient against the real runtime (Shard DO, hibernation WebSockets) and the real `@freecorps/ember-server` engine,
 * running `packages/runtime/test/app.ts` in workerd.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EmberClient, unsafeRef, type QuerySnapshot, type WebSocketLike } from "../../src/index.ts";

/** WHATWG-style socket over `SELF.fetch` + `Upgrade: websocket` (workerd's `WebSocketPair` client end). */
class SelfWebSocket implements WebSocketLike {
  /** Every socket opened, with the frames the client sent and received on it. */
  static log: SelfWebSocket[] = [];
  readonly sent: any[] = [];
  readonly received: any[] = [];
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  private ws: WebSocket | null = null;

  constructor(url: string) {
    SelfWebSocket.log.push(this);
    SELF.fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } }).then(
      (res) => {
        const ws = res.webSocket;
        if (!ws || this.readyState !== 0) return this.closed(1006);
        ws.accept();
        this.ws = ws;
        this.readyState = 1;
        ws.addEventListener("message", (e) => {
          if (e.data !== "pong") this.received.push(JSON.parse(e.data as string));
          this.onmessage?.({ data: e.data });
        });
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
    if (data !== "ping") this.sent.push(JSON.parse(data));
    this.ws!.send(data);
  }

  /** The connection drops (network): the client sees a close and reconnects. */
  drop(): void {
    try {
      this.ws?.close(1000, "drop");
    } catch {
      /* already closed */
    }
    this.closed(1006);
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
    const off = client.subscribe(unsafeRef("messages:list"), { channel: "c" }, {}, (s: QuerySnapshot<Row[]>) =>
      seen.push({ ...s, pending: client.connectionState().pendingMutations }),
    );
    await expect.poll(() => seen.at(-1)?.status).toBe("success");
    expect(seen.at(-1)!.value).toEqual([]);

    const n = 2n ** 62n + 1n; // beyond Number.MAX_SAFE_INTEGER
    const blob = new Uint8Array([0, 1, 255]);
    const id = await client.mutation(unsafeRef("messages:send"), { channel: "c", body: "hi", n, blob }, {
      optimisticUpdate: (store, args) => {
        const cur = (store.getQuery(unsafeRef("messages:list"), { channel: "c" }) ?? []) as Row[];
        store.setQuery(unsafeRef("messages:list"), { channel: "c" }, [...cur, { _id: "optimistic", ...args }]);
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

    // HTTP and socket one-shots use the same tagged JSON.
    const viaHttp = (await client.query(unsafeRef("messages:list"), { channel: "c" }, { transport: "http" })) as Row[];
    expect(viaHttp[0]!.n).toBe(n);
    const viaSocket = await client.query(unsafeRef("messages:list"), { channel: "c" });
    expect(viaSocket).toEqual(viaHttp);
    const socket = SelfWebSocket.log.at(-1)!;
    expect(socket.sent.some((m) => m.t === "q" && m.fn === "messages:list")).toBe(true);
    expect(socket.received.some((m) => m.t === "qres" && m.ok)).toBe(true);

    // Actions run in the Worker and reach the shard through ctx.runMutation/runQuery.
    const r = (await client.action(unsafeRef("actions:combo"), { channel: "c" })) as { n: number; who: string; nested: number; shard: string };
    expect(r).toMatchObject({ n: 2, who: "alice", nested: 42, shard });
    await expect(client.action(unsafeRef("actions:broken"), {})).rejects.toMatchObject({ code: "FunctionNotFound" });
    await expect.poll(() => seen.at(-1)?.value?.length).toBe(2);
    off();
    client.close();
  });

  it('reconnect: the pipelined resume carries the "ident" tag and the shard answers unchanged', async () => {
    const shard = `org:it-${crypto.randomUUID()}`;
    SelfWebSocket.log = [];
    const client = new EmberClient({
      url: "http://ember",
      WebSocket: SelfWebSocket,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as any, init as any)) as typeof fetch,
      connectivity: null,
      defaultShard: shard,
      heartbeat: false,
      backoff: { initialMs: 5, maxMs: 20 },
      auth: () => "good:alice",
    });
    const seen: Array<QuerySnapshot<unknown>> = [];
    client.subscribe(unsafeRef("auth:whoami"), {}, {}, (s: QuerySnapshot<unknown>) => seen.push(s));
    await expect.poll(() => seen.at(-1)?.value).toBe("alice");
    const first = SelfWebSocket.log[0]!;
    expect(first.received.find((m) => m.t === "ready").features).toContain("ident");
    const ik = first.received.find((m) => m.t === "snap").ik;
    expect(typeof ik).toBe("string");

    first.drop();
    await expect.poll(() => SelfWebSocket.log[1]?.received.some((m) => m.t === "snap")).toBe(true);
    const second = SelfWebSocket.log[1]!;
    expect(second.sent.slice(0, 2).map((m) => m.t)).toEqual(["hello", "sub"]); // pipelined, before ready
    expect(second.sent[1].resume).toMatchObject({ ik });
    expect(second.received.find((m) => m.t === "snap")).toMatchObject({ unchanged: true });
    expect(seen.at(-1)!.value).toBe("alice");
    client.close();
  });
});
