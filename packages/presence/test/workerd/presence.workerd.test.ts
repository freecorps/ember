/**
 * Presence end to end in workerd: clients (real EmberClient over the Worker's WebSocket upgrade) in a room of the
 * real Shard DO see each other, their typing and cursors; the shard checks the payloads (`presenceChannel`), and
 * nothing is written (rows written and version of the shard unchanged).
 */
import { env, SELF } from "cloudflare:test";
import { EmberClient, type WebSocketLike } from "@freecorps/ember-client";
import { describe, expect, it } from "vitest";
import { Presence } from "../../src/index.ts";

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

function client(shard: string, user: string) {
  return new EmberClient({
    url: "http://ember",
    WebSocket: SelfWebSocket,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as any, init as any)) as typeof fetch,
    connectivity: null,
    defaultShard: shard,
    heartbeat: false,
    httpFirst: false,
    backoff: { initialMs: 5, maxMs: 20 },
    auth: () => `good:${user}`,
  });
}

const stub = (shard: string) => env.SHARD.get(env.SHARD.idFromName(shard));

describe("presence in workerd", () => {
  it("members, typing and cursors between clients; payloads checked by the shard; nothing written", async () => {
    const shard = `room:${crypto.randomUUID()}`;
    const ca = client(shard, "ana");
    const cb = client(shard, "bia");
    const a = new Presence<{ name: string }>(ca, "room:1", { state: { name: "Ana" }, cursorThrottleMs: 20 });
    const b = new Presence<{ name: string }>(cb, "room:1", { state: { name: "Bia" }, cursorThrottleMs: 20 });
    await expect.poll(() => [a.members().length, b.members().length]).toEqual([2, 2]);
    const before = await stub(shard).inspect();

    expect(b.members().find((m) => !m.self)).toMatchObject({ user: "ana", state: { name: "Ana" } });
    a.setTyping(true);
    await expect.poll(() => b.typing().map((t) => t.user)).toEqual(["ana"]);
    for (let i = 0; i <= 10; i++) a.moveCursor({ x: i, y: 1 });
    await expect.poll(() => b.cursors()[0]?.at).toEqual({ x: 10, y: 1 });
    a.setTyping(false);
    await expect.poll(() => b.typing()).toEqual([]);
    b.setState({ name: "Bia B." });
    await expect.poll(() => a.members().find((m) => m.user === "bia")?.state).toEqual({ name: "Bia B." });

    // A payload the room's validator refuses never reaches the others.
    const raw = ca.channel("room:1");
    await expect.poll(() => raw.status()).toBe("joined");
    raw.publish({ k: "cursor", key: "x", at: { x: "nope" } });
    await expect.poll(() => raw.error()?.code).toBe("invalid_payload");
    raw.leave();

    const after = await stub(shard).inspect();
    expect(after.rows.written).toBe(before.rows.written);
    expect(after.version).toBe(before.version);
    expect(after.ephemeral.members).toBe(2);

    // ana leaves: her cursor goes from bia's view with her.
    a.close();
    await expect.poll(() => [b.members().length, b.cursors().length]).toEqual([1, 0]);
    b.close();
    ca.close();
    cb.close();
  });

  it("anonymous sockets are refused by the room's authorize", async () => {
    const shard = `room:${crypto.randomUUID()}`;
    const anon = new EmberClient({ url: "http://ember", WebSocket: SelfWebSocket, connectivity: null, defaultShard: shard, heartbeat: false, httpFirst: false, fetch: ((i: RequestInfo | URL, init?: RequestInit) => SELF.fetch(i as any, init as any)) as typeof fetch });
    const p = new Presence(anon, "room:1");
    await expect.poll(() => p.status()).toBe("refused");
    expect(p.error()?.code).toBe("channel_denied");
    p.close();
    anon.close();
  });
});
