/**
 * Ephemeral channels (`client.channel()`, feature "ephemeral") against the real runtime: separate clients in a room,
 * refusals and an identity change, and `multiTab` (tabs of one identity share the socket and its member; the leader
 * joins once, leaves with the last tab and hands one tab's messages to the others).
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EmberClient, type Channel, type ChannelMessage, type WebSocketLike } from "../../src/index.ts";
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

function client(shard: string, token: string | null, extra: Record<string, unknown> = {}) {
  let current = token;
  const c = new EmberClient({
    url: "http://ember",
    WebSocket: SelfWebSocket,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as any, init as any)) as typeof fetch,
    connectivity: null,
    defaultShard: shard,
    heartbeat: false,
    httpFirst: false,
    backoff: { initialMs: 5, maxMs: 20 },
    auth: () => current,
    ...extra,
  });
  return {
    c,
    signIn(next: string | null) {
      current = next;
      c.setAuth(() => current);
    },
  };
}

function inbox<T>(ch: Channel<T, unknown>) {
  const got: Array<ChannelMessage<T>> = [];
  ch.subscribe((m) => got.push(m));
  return got;
}

describe("channels against the real runtime", () => {
  it("members, messages, state and leave between two clients", async () => {
    const shard = `room:${crypto.randomUUID()}`;
    const a = client(shard, "good:alice");
    const b = client(shard, "good:bob");
    const ca = a.c.channel<{ x: number }, { name: string }>("room:1", { state: { name: "Alice" } });
    const cb = b.c.channel<{ x: number }, { name: string }>("room:1");
    const ga = inbox(ca);
    const gb = inbox(cb);
    await expect.poll(() => [ca.status(), cb.status()]).toEqual(["joined", "joined"]);
    await expect.poll(() => ca.members().map((m) => m.user)).toEqual(["alice", "bob"]);
    expect(cb.members().find((m) => m.user === "alice")?.state).toEqual({ name: "Alice" });
    expect(ca.members().find((m) => m.self)?.id).toBe(ca.self());
    const before = ca.members();
    expect(ca.members()).toBe(before); // same array while nothing changes

    expect(ca.publish({ x: 1 })).toBe(true);
    await expect.poll(() => gb.map((m) => m.data)).toEqual([{ x: 1 }]);
    expect(gb[0]).toMatchObject({ from: ca.self(), user: "alice" });
    expect(ga).toEqual([]);
    cb.setState({ name: "Bob" });
    await expect.poll(() => ca.members().find((m) => m.user === "bob")?.state).toEqual({ name: "Bob" });
    cb.leave();
    expect(cb.status()).toBe("closed");
    await expect.poll(() => ca.members().map((m) => m.user)).toEqual(["alice"]);
    expect(cb.publish({ x: 2 })).toBe(false);
    a.c.close();
    b.c.close();
  });

  it("a refused join, then an identity change lets it in; a sign-out takes it out", async () => {
    const shard = `room:${crypto.randomUUID()}`;
    const x = client(shard, "good:bob");
    const vip = x.c.channel("vip");
    await expect.poll(() => vip.status()).toBe("refused");
    expect(vip.error()?.code).toBe("channel_denied");
    x.signIn("good:alice");
    await expect.poll(() => vip.status()).toBe("joined");
    expect(vip.members().map((m) => m.user)).toEqual(["alice"]);
    x.signIn(null);
    await expect.poll(() => vip.status()).toBe("refused");
    x.c.close();
  });

  it("multiTab: tabs of one identity share the socket and its member; the last tab out leaves", async () => {
    const shard = `room:${crypto.randomUUID()}`;
    SelfWebSocket.log = [];
    const browser = new FakeBrowser();
    const tab = (token: string) => {
      const t = browser.tab();
      return client(shard, token, { multiTab: { locks: t.locks, BroadcastChannel: t.BroadcastChannel, lifecycle: false, clientIdTimeoutMs: 200 } });
    };
    const a = tab("good:alice");
    await expect.poll(() => a.c.tabRole).toBe("leader");
    const b = tab("good:alice");
    const c = tab("good:bob");
    const [ca, cb, cc] = [a, b, c].map((x) => x.c.channel<string>("room:mt"));
    const [ga, gb, gc] = [ca!, cb!, cc!].map((ch) => inbox(ch));
    await expect.poll(() => [ca!, cb!, cc!].map((ch) => ch.status())).toEqual(["joined", "joined", "joined"]);
    // Two real sockets (alice's, bob's), two members: a and b are one.
    expect(SelfWebSocket.log).toHaveLength(2);
    await expect.poll(() => cc!.members().map((m) => m.user).sort()).toEqual(["alice", "bob"]);
    expect(ca!.self()).toBe(cb!.self());
    const aliceWs = SelfWebSocket.log.find((s) => flat(s.sent).some((m) => m.t === "hello" && m.token === "good:alice"))!;
    expect(flat(aliceWs.sent).filter((m) => m.t === "join")).toHaveLength(1);

    // a publishes: c gets it from the shard, b from the leader.
    ca!.publish("from a");
    await expect.poll(() => [gb.map((m) => m.data), gc.map((m) => m.data)]).toEqual([["from a"], ["from a"]]);
    expect(ga).toEqual([]);
    cc!.publish("from c");
    await expect.poll(() => [ga.map((m) => m.data), gb.map((m) => m.data)]).toEqual([["from c"], ["from a", "from c"]]);

    // b leaves: alice is still in (a), nobody else sees a change, no `leave` on the shard.
    cb!.leave();
    await new Promise((r) => setTimeout(r, 50));
    expect(cc!.members()).toHaveLength(2);
    expect(flat(aliceWs.sent).filter((m) => m.t === "leave")).toHaveLength(0);
    // a leaves too: the shared socket leaves; bob sees alice go.
    ca!.leave();
    await expect.poll(() => cc!.members().map((m) => m.user)).toEqual(["bob"]);
    expect(flat(aliceWs.sent).filter((m) => m.t === "leave")).toHaveLength(1);
    for (const x of [a, b, c]) x.c.close();
  });
});
