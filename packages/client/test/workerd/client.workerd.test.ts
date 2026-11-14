/**
 * EmberClient against the real runtime (Shard DO, hibernation WebSockets) and the real `@freecorps/ember-server` engine,
 * running `packages/runtime/test/app.ts` in workerd.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { EmberClient, memorySnapshotCache, unsafeRef, watchPaginatedQuery, type QuerySnapshot, type WebSocketLike } from "../../src/index.ts";

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
      // These follow the socket's frames exactly; the HTTP-first path has its own test below.
      httpFirst: false,
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

    // optimistic first, then the confirmed row (from the patch listing our mid), never both. The patch and the mres
    // come in one batch frame, and listeners see the frame's final state: the mutation is already settled by then.
    const ids = seen.map((s) => s.value?.map((r) => r._id));
    expect(ids).toEqual([[], ["optimistic"], [id]]);
    expect(seen[1]!.optimistic).toBe(true);
    expect(seen[2]).toMatchObject({ optimistic: false });
    expect(seen[2]!.pending).toBeLessThanOrEqual(1);

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
      httpFirst: false,
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

  it("httpFirst: the first value over HTTP, then the socket resumes from it (unchanged), against the real shard", async () => {
    const shard = `org:hf-${crypto.randomUUID()}`;
    const seed = new EmberClient({ url: "http://ember", WebSocket: SelfWebSocket, fetch: ((i: RequestInfo | URL, init?: RequestInit) => SELF.fetch(i as any, init as any)) as typeof fetch, connectivity: null, defaultShard: shard, heartbeat: false });
    await seed.mutation(unsafeRef("messages:send"), { channel: "hf", body: "first" });
    seed.close();
    const httpCalls: string[] = [];
    const client = new EmberClient({
      url: "http://ember",
      WebSocket: SelfWebSocket,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        httpCalls.push(new URL(String(input)).pathname);
        return SELF.fetch(input as any, init as any);
      }) as typeof fetch,
      connectivity: null,
      defaultShard: shard,
      heartbeat: false,
      auth: () => "good:alice",
    });
    const log = SelfWebSocket.log.length;
    const seen: unknown[] = [];
    client.subscribe(unsafeRef("messages:list"), { channel: "hf" }, {}, (s) => s.status === "success" && seen.push((s.value as Row[]).map((r) => r.body)));
    await vi.waitFor(() => {
      const ws = SelfWebSocket.log.slice(log).at(-1);
      if (!ws?.received.some((m) => m.t === "snap")) throw new Error("no snap yet");
    });
    expect(httpCalls).toContain("/api/query");
    expect(seen[0]).toEqual(["first"]);
    const ws = SelfWebSocket.log.slice(log).at(-1)!;
    expect(ws.sent.find((m) => m.t === "sub")).toMatchObject({ resume: { epoch: expect.any(String), ik: expect.any(String) } });
    expect(ws.received.find((m) => m.t === "snap")).toMatchObject({ unchanged: true });
    await client.mutation(unsafeRef("messages:send"), { channel: "hf", body: "second" });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["first", "second"]));
    client.close();
  });

  it("pagination: a new message on top patches the first page only (real read sets), pins answered unchanged", async () => {
    const shard = `org:it-${crypto.randomUUID()}`;
    SelfWebSocket.log = [];
    const client = new EmberClient({
      url: "http://ember",
      WebSocket: SelfWebSocket,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as any, init as any)) as typeof fetch,
      connectivity: null,
      defaultShard: shard,
      heartbeat: false,
      httpFirst: false,
    });
    for (let i = 0; i < 22; i++) await client.mutation(unsafeRef("messages:send"), { channel: "p", body: `m${i}` });
    const h = watchPaginatedQuery<Row>(client, unsafeRef("messages:paged"), { channel: "p" }, { initialNumItems: 5 });
    const lengths: number[] = [];
    const off = h.subscribe(() => lengths.push(h.getSnapshot().results.length));
    const bodies = () => h.getSnapshot().results.map((r) => r.body);
    for (let k = 1; k <= 4; k++) {
      await expect.poll(() => h.getSnapshot().status === "CanLoadMore" && h.getSnapshot().results.length >= k * 5).toBe(true);
      if (k < 4) h.loadMore(5);
    }
    const ws = SelfWebSocket.log.at(-1)!;
    // Four unpinned loads, four pins resumed from the value already held.
    await expect.poll(() => ws.received.filter((m) => m.t === "snap" && m.unchanged).length).toBe(4);
    expect(ws.received.filter((m) => m.t === "snap" && !m.unchanged).length).toBe(4);
    const sent0 = ws.sent.length;
    const recv0 = ws.received.length;
    lengths.length = 0;
    await client.mutation(unsafeRef("messages:send"), { channel: "p", body: "new" });
    await expect.poll(() => bodies()[0]).toBe("new");
    const sentAfter = ws.sent.slice(sent0).filter((m) => m.t === "sub" || m.t === "unsub");
    expect(sentAfter).toEqual([]);
    const received = ws.received.slice(recv0).flatMap((m) => (Array.isArray(m) ? m : [m]));
    expect(received.filter((m) => m.t === "snap")).toEqual([]);
    const patches = received.filter((m) => m.t === "patch");
    expect(patches.flatMap((p) => p.changes).length).toBe(1);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(20);
    expect(bodies()).toEqual(["new", ...Array.from({ length: 20 }, (_, i) => `m${21 - i}`)]);
    off();
    client.close();
  });

  it("snapshot cache: a reopened client resumes from its cached value over HTTP and the socket (real shard): unchanged both", async () => {
    const shard = `org:it-${crypto.randomUUID()}`;
    const cache = memorySnapshotCache();
    const requests: Array<Record<string, unknown>> = [];
    const responses: Array<Record<string, unknown>> = [];
    const make = () =>
      new EmberClient({
        url: "http://ember",
        WebSocket: SelfWebSocket,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body ?? "{}")));
          const res = await SELF.fetch(input as any, init as any);
          const text = await res.text();
          responses.push(JSON.parse(text));
          return new Response(text, { status: res.status, headers: res.headers as any });
        }) as typeof fetch,
        connectivity: null,
        defaultShard: shard,
        heartbeat: false,
        snapshotCache: cache,
      });
    const a = make();
    await a.mutation(unsafeRef("messages:send"), { channel: "k", body: "kept" });
    const s1: QuerySnapshot[] = [];
    a.subscribe(unsafeRef("messages:list"), { channel: "k" }, {}, (s) => s1.push(s));
    await expect.poll(() => s1.some((s) => s.status === "success" && !s.source)).toBe(true);
    a.close();
    SelfWebSocket.log = [];
    requests.length = 0;
    responses.length = 0;
    const b = make();
    const s2: QuerySnapshot[] = [];
    b.subscribe(unsafeRef("messages:list"), { channel: "k" }, {}, (s) => s2.push(s));
    expect(s2[0]).toMatchObject({ status: "success", source: "cache" });
    await expect.poll(() => s2.some((s) => s.status === "success" && !s.source)).toBe(true);
    expect(requests).toEqual([expect.objectContaining({ fn: "messages:list", resume: expect.objectContaining({ ik: expect.any(String) }) })]);
    expect(responses[0]).toMatchObject({ ok: true, unchanged: true });
    expect(responses[0]!.value).toBeUndefined();
    const ws = SelfWebSocket.log.at(-1)!;
    await expect.poll(() => ws.received.flatMap((m) => (Array.isArray(m) ? m : [m])).filter((m) => m.t === "snap").map((m) => m.unchanged)).toEqual([true]);
    expect((s2.at(-1)!.value as Row[]).map((r) => r.body)).toEqual(["kept"]);
    b.close();
  });
});
