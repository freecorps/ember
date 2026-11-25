/**
 * Option `multiTab` against the real runtime (Shard DO, hibernation WebSockets, real dedup) in workerd: several "tabs"
 * (clients with their own fake BroadcastChannel endpoints and Web Lock scopes, `FakeBrowser`) share one socket per
 * identity, a tab that switches account moves to a socket of its own, and a leader that dies with a follower's mutation
 * in flight hands over without losing it or running it twice.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EmberClient, unsafeRef, type QuerySnapshot, type WebSocketLike } from "../../src/index.ts";
import { FakeBrowser } from "../../src/testing.ts";

/** WHATWG-style socket over `SELF.fetch` + `Upgrade: websocket`; every one opened is logged with its frames. */
class SelfWebSocket implements WebSocketLike {
  static log: SelfWebSocket[] = [];
  readonly sent: any[] = [];
  readonly received: any[] = [];
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  private ws: WebSocket | null = null;

  constructor(readonly url: string) {
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

  /** The connection drops (the tab holding it died). */
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

const flat = (frames: any[]) => frames.flatMap((m) => (Array.isArray(m) ? m : [m]));
type Row = { _id: string; body: string; author?: string };

function tab(browser: FakeBrowser, shard: string, token: string) {
  const t = browser.tab();
  const sockets: SelfWebSocket[] = [];
  const WS = class extends SelfWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  };
  let current = token;
  const client = new EmberClient({
    url: "http://ember",
    WebSocket: WS,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as any, init as any)) as typeof fetch,
    connectivity: null,
    defaultShard: shard,
    heartbeat: false,
    httpFirst: false,
    backoff: { initialMs: 5, maxMs: 20 },
    auth: () => current,
    multiTab: { locks: t.locks, BroadcastChannel: t.BroadcastChannel, lifecycle: false, clientIdTimeoutMs: 200 },
  });
  const watch = <T,>(fn: string, args: Record<string, unknown>) => {
    const seen: Array<QuerySnapshot<T>> = [];
    client.subscribe(unsafeRef(fn), args, {}, (s: QuerySnapshot<T>) => seen.push(s));
    return seen;
  };
  return {
    t,
    client,
    sockets,
    watch,
    signIn(next: string) {
      current = next;
      client.setAuth(() => current);
    },
    crash() {
      t.crash();
      for (const s of sockets) s.drop();
      client.close();
    },
  };
}

describe("multiTab against the real runtime", () => {
  it("one socket per identity; a follower's account switch moves it; a leader crash hands over a pending mutation exactly once", async () => {
    const shard = `org:mt-${crypto.randomUUID()}`;
    SelfWebSocket.log = [];
    const browser = new FakeBrowser();
    const a = tab(browser, shard, "good:alice");
    await expect.poll(() => a.client.tabRole).toBe("leader");
    const b = tab(browser, shard, "good:alice");
    const c = tab(browser, shard, "good:bob");
    const lists = [a, b, c].map((x) => x.watch<Row[]>("messages:list", { channel: "mt" }));
    const whos = [a, b, c].map((x) => x.watch<string>("auth:whoami", {}));
    await expect.poll(() => whos.map((w) => w.at(-1)?.value)).toEqual(["alice", "alice", "bob"]);
    await expect.poll(() => lists.every((l) => l.at(-1)?.status === "success")).toBe(true);
    // Two real sockets for three tabs: alice's (a, b) and bob's (c), both held by the leader.
    expect(SelfWebSocket.log).toHaveLength(2);
    expect(a.sockets).toHaveLength(2);
    expect(b.client.clientId).toBe(a.client.clientId);

    const id = await b.client.mutation(unsafeRef("messages:send"), { channel: "mt", body: "from b" });
    await expect.poll(() => lists.map((l) => l.at(-1)?.value?.map((r) => r._id))).toEqual([[id], [id], [id]]);
    expect(lists[0]!.at(-1)!.value![0]).toMatchObject({ body: "from b", author: "alice" });
    const aliceSocket = a.sockets.find((s) => flat(s.sent).some((m) => m.t === "hello" && m.token === "good:alice"))!;

    // b switches to bob: from then on only bob's values; the shared alice socket never carries b's sign-in.
    const from = whos[1]!.length;
    b.signIn("good:bob");
    await expect.poll(() => whos[1]!.at(-1)?.value).toBe("bob");
    expect(whos[1]!.slice(from).every((s) => s.value === undefined || s.value === "bob")).toBe(true);
    expect(whos[0]!.at(-1)?.value).toBe("alice");
    expect(flat(aliceSocket.sent).filter((m) => m.t === "auth")).toHaveLength(0);
    expect(SelfWebSocket.log).toHaveLength(2); // b joined bob's shared socket

    // The leader dies right after b sent a mutation through it: b or c leads next, the mutation lands once.
    const p = b.client.mutation(unsafeRef("messages:send"), { channel: "mt", body: "survives" });
    await new Promise((r) => setTimeout(r, 0));
    a.crash();
    await expect.poll(() => [b.client.tabRole, c.client.tabRole].includes("leader")).toBe(true);
    const id2 = await p;
    await expect.poll(() => lists[1]!.at(-1)?.value?.map((r) => r._id)).toEqual([id, id2]);
    await expect.poll(() => lists[2]!.at(-1)?.value?.map((r) => r._id)).toEqual([id, id2]);
    const rows = (await b.client.query(unsafeRef("messages:list"), { channel: "mt" }, { transport: "http" })) as Row[];
    expect(rows.filter((r) => r.body === "survives")).toHaveLength(1);
    expect(rows.find((r) => r.body === "survives")).toMatchObject({ author: "bob" });
    // After the handover: one socket for both bob tabs again.
    const live = SelfWebSocket.log.filter((s) => s.readyState === 1);
    expect(live).toHaveLength(1);
    b.client.close();
    c.client.close();
  });
});
