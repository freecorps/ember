// `client.channel()` (feature "ephemeral") over the fake server: members and messages, handles of one channel, joins
// again on a new socket and after an identity change, an older runtime, the keep-alive ping of a listening socket, and
// the multiTab leader (one join for the tabs of a group, messages handed between them, the last tab out leaves).
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClient, messagesServer, tick, until } from "./helpers.ts";
import { FakeBrowser, FakeEmberServer, type FakeServerOptions, type FakeSocket } from "../src/testing.ts";
import type { ChannelMessage, EmberClient } from "../src/index.ts";

const open: EmberClient[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

const server = (opts: Parameters<typeof messagesServer>[0] = {}) =>
  messagesServer({ ephemeral: { authorize: (identity, name) => name !== "vip" || identity?.subject === "ana" }, ...opts });

function client(s: ReturnType<typeof server>, token: string | null, opts: Parameters<typeof makeClient>[1] = {}) {
  let current = token;
  const c = makeClient(s, { auth: () => current, ...opts });
  open.push(c);
  return Object.assign(c, {
    signIn(next: string | null) {
      current = next;
      c.setAuth(() => current);
    },
  });
}

const sent = (s: { history: FakeSocket[] }, t: string) => s.history.flatMap((ws) => ws.sent).filter((m) => typeof m === "object" && m.t === t);

describe("client.channel()", () => {
  it("members and messages between two clients; publish needs to be joined; state updates", async () => {
    const s = server();
    const a = client(s, "user:ana");
    const b = client(s, "user:bia");
    const ca = a.channel<string, { color: string }>("room:1", { state: { color: "red" } });
    const got: ChannelMessage<string>[] = [];
    const cb = b.channel<string, { color: string }>("room:1");
    cb.subscribe((m) => got.push(m));
    expect(ca.publish("too early")).toBe(false);
    await until(() => ca.status() === "joined" && cb.status() === "joined");
    await until(() => ca.members().length === 2);
    expect(ca.members().map((m) => [m.user, m.self, m.state])).toEqual([
      ["ana", true, { color: "red" }],
      ["bia", false, undefined],
    ]);
    expect(ca.publish("hi")).toBe(true);
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ data: "hi", from: ca.self(), user: "ana" });
    let changes = 0;
    cb.onChange(() => changes++);
    ca.setState({ color: "blue" });
    await until(() => cb.members().find((m) => m.user === "ana")?.state?.color === "blue");
    expect(changes).toBeGreaterThan(0);
  });

  it("handles of one channel share it; it is left when the last one leaves", async () => {
    const s = server();
    const a = client(s, "user:ana");
    const h1 = a.channel("room:2");
    const h2 = a.channel("room:2");
    await until(() => h2.status() === "joined");
    expect(sent(s, "join")).toHaveLength(1);
    h1.leave();
    expect(h1.status()).toBe("closed");
    expect(h2.status()).toBe("joined");
    await tick(5);
    expect(sent(s, "leave")).toHaveLength(0);
    h2.leave();
    await until(() => sent(s, "leave").length === 1);
  });

  it("joins again (with its state) on a new socket; refused channels try again after an identity change", async () => {
    const s = server();
    const a = client(s, "user:bia");
    const room = a.channel("room:3", { state: { n: 1 } });
    const vip = a.channel("vip");
    await until(() => room.status() === "joined" && vip.status() === "refused");
    expect(vip.error()?.code).toBe("channel_denied");
    s.history.at(-1)!.drop();
    await until(() => room.status() === "connecting");
    await until(() => room.status() === "joined" && s.history.length === 2);
    // On the new socket (not by its order among the channels' joins).
    expect(s.history[1]!.sent.filter((m) => typeof m === "object" && m.t === "join" && m.ch === "room:3")).toEqual([{ t: "join", ch: "room:3", state: { n: 1 }, ref: expect.any(Number) }]);
    a.signIn("user:ana");
    await until(() => vip.status() === "joined");
    expect(vip.members().map((m) => m.user)).toEqual(["ana"]);
    a.signIn(null);
    await until(() => vip.status() === "refused");
  });

  it("self() is the member id only while joined: not the dropped socket's while it reconnects", async () => {
    const s = server();
    const a = client(s, "user:ana");
    const ch = a.channel("room:self");
    await until(() => ch.status() === "joined");
    const first = ch.self();
    expect(first).toBe(s.history[0]!.memberId);
    s.refuseConnections = 1_000;
    s.history[0]!.drop();
    await until(() => ch.status() === "connecting");
    expect(ch.self()).toBeNull();
    // The member list stays until the next socket's `joined`.
    expect(ch.members().map((m) => m.user)).toEqual(["ana"]);
    s.refuseConnections = 0;
    await until(() => ch.status() === "joined");
    expect(ch.self()).toBe(s.history.at(-1)!.memberId);
    expect(ch.self()).not.toBe(first);
  });

  it("a state update the shard refused is not sent again on the next socket: the one it accepted is", async () => {
    const s = server({
      ephemeral: {
        authorize: () => true,
        state: (st) => (typeof (st as { color?: unknown } | undefined)?.color === "string" ? undefined : "invalid_state"),
      },
    });
    const a = client(s, "user:ana");
    const ch = a.channel<unknown, { color: unknown }>("room:st", { state: { color: "red" } });
    await until(() => ch.status() === "joined");
    ch.setState({ color: 42 });
    await until(() => ch.error()?.code === "invalid_state");
    expect(ch.status()).toBe("joined");
    const joins = (ws: FakeSocket) => ws.sent.filter((m) => typeof m === "object" && m.t === "join").map((m) => (m as { state?: unknown }).state);
    s.history[0]!.drop();
    await until(() => ch.status() === "joined" && s.history.length === 2);
    expect(joins(s.history[1]!)).toEqual([{ color: "red" }]);
    expect(ch.members()[0]!.state).toEqual({ color: "red" });

    // One made while there is no socket has not been tried: it goes out on the next one.
    s.refuseConnections = 1_000;
    s.history[1]!.drop();
    await until(() => ch.status() === "connecting");
    ch.setState({ color: "green" });
    s.refuseConnections = 0;
    await until(() => ch.status() === "joined" && ch.members()[0]?.state?.color === "green");
    expect(joins(s.history.at(-1)!)).toEqual([{ color: "green" }]);

    // Refused on a new socket (so not in: `left`): in again with the one the shard accepted last.
    s.refuseConnections = 1_000;
    s.history.at(-1)!.drop();
    await until(() => ch.status() === "connecting");
    ch.setState({ color: null });
    s.refuseConnections = 0;
    await until(() => joins(s.history.at(-1)!).length === 2 && ch.status() === "joined");
    expect(joins(s.history.at(-1)!)).toEqual([{ color: null }, { color: "green" }]);
    expect(ch.members()[0]!.state).toEqual({ color: "green" });
  });

  it("unsupported on an older runtime, joined once a socket speaks ephemeral", async () => {
    const s = messagesServer();
    const a = client(s, "user:ana");
    const ch = a.channel("room:up");
    await until(() => ch.status() === "unsupported");
    (s as unknown as { opts: FakeServerOptions }).opts.ephemeral = true;
    s.history.at(-1)!.drop();
    await until(() => ch.status() === "joined");
    expect(ch.error()).toBeNull();
    expect(ch.self()).toBe(s.history.at(-1)!.memberId);
  });

  it("a heartbeat interval above the channel keepalive: the first ping moves up to it once a channel joins", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const s = server();
      const a = client(s, "user:ana", { heartbeat: { intervalMs: 200_000, timeoutMs: 10_000 } });
      const ch = a.channel("room:hb");
      await vi.advanceTimersByTimeAsync(20);
      expect(ch.status()).toBe("joined");
      const pings = () => s.history[0]!.sent.filter((m) => m === "ping").length;
      await vi.advanceTimersByTimeAsync(29_000);
      expect(pings()).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(pings()).toBe(1);
      a.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("channel frames that arrived compressed under the identity before an auth are dropped; the channel is joined again", async () => {
    // A compressed frame decodes asynchronously: here it waits on `gate`, so the `auth` surely goes out meanwhile.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const Real = globalThis.DecompressionStream;
    class Gated {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor() {
        const ts = new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, c) {
            await gate;
            c.enqueue(chunk);
          },
        });
        this.readable = ts.readable;
        this.writable = ts.writable;
      }
    }
    globalThis.DecompressionStream = Gated as unknown as typeof DecompressionStream;
    try {
      const s = server();
      const a = client(s, "user:ana");
      const b = client(s, "user:bia");
      const ca = a.channel<string>("room:z");
      const cb = b.channel<string>("room:z");
      const got: string[] = [];
      ca.subscribe((m) => got.push(m.data));
      await until(() => ca.status() === "joined" && cb.status() === "joined" && ca.members().length === 2);
      const ws = s.history.find((x) => x.identity?.subject === "ana")!;
      const joinsBefore = ws.sent.filter((m) => typeof m === "object" && m.t === "join").length;
      // Sent to ana (a message, a member list) and compressed; decoded only once the socket runs as carl.
      const frame = JSON.stringify([
        { t: "msg", ch: "room:z", from: "m-bia", user: "bia", data: "for ana only" },
        { t: "members", ch: "room:z", join: [{ id: "m-x", user: "secret" }] },
      ]);
      ws.onmessage?.({ data: new TextEncoder().encode(frame).buffer });
      a.signIn("user:carl");
      await until(() => ws.sent.some((m) => typeof m === "object" && m.t === "auth"));
      open();
      await until(() => ws.sent.filter((m) => typeof m === "object" && m.t === "join").length > joinsBefore);
      await until(() => ca.members().some((m) => m.self && m.user === "carl"));
      expect(got).toEqual([]);
      expect(ca.members().map((m) => m.user).sort()).toEqual(["bia", "carl"]);
    } finally {
      globalThis.DecompressionStream = Real;
    }
  });

  it("the fake server's own decoder takes ref on join and pub (a non-negative integer, as the runtime's)", async () => {
    const s = new FakeEmberServer({ ephemeral: true });
    const a = client(s, null);
    const ch = a.channel("room:ref");
    await until(() => ch.status() === "joined");
    const ws = s.history[0]!;
    ws.send(JSON.stringify({ t: "pub", ch: "room:ref", data: 1, ref: 7 }));
    await until(() => ws.received.some((m) => m !== "pong" && m.t === "published" && m.ref === 7));
    ws.send(JSON.stringify({ t: "join", ch: "room:ref", ref: -1 }));
    await until(() => ws.received.some((m) => m !== "pong" && m.t === "err" && m.code === "bad_frame" && m.message.includes("ref")));
  });

  it("an older runtime: unsupported, nothing sent; a stray joined does not make it joined", async () => {
    const s = messagesServer();
    const a = client(s, "user:ana");
    const ch = a.channel("room:1");
    await until(() => ch.status() === "unsupported");
    expect(ch.error()?.code).toBe("unsupported");
    expect(ch.publish("x")).toBe(false);
    expect(sent(s, "join")).toHaveLength(0);
    s.history.at(-1)!.deliver(JSON.stringify({ t: "joined", ch: "room:1", self: "m9", members: [{ id: "m9", user: "ana" }] }));
    await tick(5);
    expect(ch.status()).toBe("unsupported");
    expect(ch.members()).toEqual([]);
    expect(ch.self()).toBeNull();
  });

  it("a join refused under the identity before an auth that went out meanwhile is tried again under the new one", async () => {
    const s = server();
    const a = client(s, null);
    const lobby = a.channel("room:0");
    await until(() => lobby.status() === "joined");
    const ws = s.history.at(-1)!;
    // The shard's answers wait: the join goes out anonymous, the sign-in's auth right behind it.
    ws.hold();
    const vip = a.channel("vip");
    await until(() => ws.sent.some((m) => typeof m === "object" && m.t === "join" && m.ch === "vip"));
    a.signIn("user:ana");
    await until(() => ws.sent.some((m) => typeof m === "object" && m.t === "auth"));
    ws.release();
    await until(() => vip.status() === "joined");
    expect(vip.members().map((m) => m.user)).toEqual(["ana"]);
    expect(ws.sent.filter((m) => typeof m === "object" && m.t === "join" && m.ch === "vip")).toHaveLength(2);
  });

  it("rate_limited: joins again a second later", async () => {
    const s = server();
    const a = client(s, "user:ana");
    const ch = a.channel("room:rl");
    await until(() => ch.status() === "joined");
    const ws = s.history.at(-1)!;
    ws.deliver(JSON.stringify({ t: "left", ch: "room:rl", code: "rate_limited", message: "slow down" }));
    await until(() => ch.status() === "refused");
    expect(ch.error()?.code).toBe("rate_limited");
    await until(() => ch.status() === "joined", 3_000);
    expect(ws.sent.filter((m) => typeof m === "object" && m.t === "join")).toHaveLength(2);
  });

  it("an err about a channel this client does not have is not reported as an error", async () => {
    const s = server();
    const errors: unknown[] = [];
    const a = client(s, "user:ana", { onError: (e) => errors.push(e) });
    const ch = a.channel("room:e");
    await until(() => ch.status() === "joined");
    s.history.at(-1)!.deliver(JSON.stringify({ t: "err", code: "not_joined", message: "x", ch: "room:gone" }));
    s.history.at(-1)!.deliver(JSON.stringify({ t: "msg", ch: "room:gone", from: "m9", user: null, data: 1 }));
    await tick(5);
    expect(errors).toEqual([]);
  });

  it("a socket that only listens to a busy channel still pings every interval", async () => {
    const s = server();
    const listener = client(s, "user:ana", { heartbeat: { intervalMs: 30, timeoutMs: 1_000 } });
    const talker = client(s, "user:bia");
    const l = listener.channel("room:busy");
    const t = talker.channel("room:busy");
    await until(() => l.status() === "joined" && t.status() === "joined");
    const ws = s.history.find((x) => x.identity?.subject === "ana")!;
    const timer = setInterval(() => t.publish("tick"), 5);
    try {
      await until(() => ws.sent.filter((m) => m === "ping").length >= 2, 2_000);
    } finally {
      clearInterval(timer);
    }
  });

  it("a socket in a channel that also publishes does not ping: what it sends keeps it alive", async () => {
    const s = server();
    const hb = { heartbeat: { intervalMs: 30, timeoutMs: 1_000 } };
    const a = client(s, "user:ana", hb);
    const b = client(s, "user:bia", hb);
    const ca = a.channel("room:chat");
    const cb = b.channel("room:chat");
    await until(() => ca.status() === "joined" && cb.status() === "joined");
    const timer = setInterval(() => {
      ca.publish("a");
      cb.publish("b");
    }, 5);
    try {
      await tick(300);
    } finally {
      clearInterval(timer);
    }
    expect(s.history.flatMap((ws) => ws.sent).filter((m) => m === "ping")).toEqual([]);
  });

  it("multiTab: the leader's shared socket that also publishes does not ping", async () => {
    const s = server();
    const browser = new FakeBrowser();
    const t = browser.tab();
    const hb = { heartbeat: { intervalMs: 30, timeoutMs: 1_000 } };
    const a = client(s, "user:ana", { ...hb, multiTab: { locks: t.locks, BroadcastChannel: t.BroadcastChannel, lifecycle: false, clientIdTimeoutMs: 100 } });
    await until(() => a.tabRole === "leader");
    const b = client(s, "user:bia", hb);
    const ca = a.channel("room:chat");
    const cb = b.channel("room:chat");
    await until(() => ca.status() === "joined" && cb.status() === "joined");
    const timer = setInterval(() => {
      ca.publish("a");
      cb.publish("b");
    }, 5);
    try {
      await tick(300);
    } finally {
      clearInterval(timer);
    }
    expect(s.history.flatMap((ws) => ws.sent).filter((m) => m === "ping")).toEqual([]);
  });

  it("multiTab: the leader's shared socket pings every interval while its tabs are in a channel", async () => {
    const s = server();
    const browser = new FakeBrowser();
    const t = browser.tab();
    const a = client(s, "user:ana", { heartbeat: { intervalMs: 30, timeoutMs: 1_000 }, multiTab: { locks: t.locks, BroadcastChannel: t.BroadcastChannel, lifecycle: false, clientIdTimeoutMs: 100 } });
    await until(() => a.tabRole === "leader");
    const talker = client(s, "user:bia");
    const l = a.channel("room:busy");
    const tc = talker.channel("room:busy");
    await until(() => l.status() === "joined" && tc.status() === "joined");
    const ws = s.history.find((x) => x.identity?.subject === "ana")!;
    const timer = setInterval(() => tc.publish("tick"), 5);
    try {
      await until(() => ws.sent.filter((m) => m === "ping").length >= 2, 2_000);
    } finally {
      clearInterval(timer);
    }
  });

  it("multiTab: a tab's state update the shard refused is not sent again on the next shared socket", async () => {
    const s = server({
      ephemeral: {
        authorize: () => true,
        state: (st) => (typeof (st as { color?: unknown } | undefined)?.color === "string" ? undefined : "invalid_state"),
      },
    });
    const t = new FakeBrowser().tab();
    const a = client(s, "user:ana", { multiTab: { locks: t.locks, BroadcastChannel: t.BroadcastChannel, lifecycle: false, clientIdTimeoutMs: 100 } });
    await until(() => a.tabRole === "leader");
    const ch = a.channel<unknown, { color: unknown }>("room:mts", { state: { color: "red" } });
    await until(() => ch.status() === "joined");
    ch.setState({ color: 42 });
    await until(() => ch.error()?.code === "invalid_state");
    const n = s.history.length;
    s.history.at(-1)!.drop();
    await until(() => s.history.length > n && ch.status() === "joined");
    const joins = s.history.at(-1)!.sent.filter((m) => typeof m === "object" && m.t === "join").map((m) => (m as { state?: unknown }).state);
    expect(joins).toEqual([{ color: "red" }]);
  });

  it("multiTab: one join for the tabs of an identity; messages between them come from the leader; the last tab out leaves", async () => {
    const s = server();
    const browser = new FakeBrowser();
    const tab = (token: string) => {
      const t = browser.tab();
      return client(s, token, { multiTab: { locks: t.locks, BroadcastChannel: t.BroadcastChannel, lifecycle: false, openTimeoutMs: 2_000, clientIdTimeoutMs: 100 } });
    };
    const a = tab("user:ana");
    await until(() => a.tabRole === "leader");
    const b = tab("user:ana");
    const c = tab("user:bia");
    const [ca, cb, cc] = [a, b, c].map((x) => x.channel<string>("room:mt"));
    const inbox = [ca!, cb!, cc!].map((ch) => {
      const got: string[] = [];
      ch.subscribe((m) => got.push(m.data));
      return got;
    });
    await until(() => [ca!, cb!, cc!].every((ch) => ch.status() === "joined"));
    expect(s.history.filter((x) => x.readyState === 1)).toHaveLength(2);
    expect(sent(s, "join")).toHaveLength(2); // one per real socket
    await until(() => cc!.members().length === 2);
    expect(ca!.self()).toBe(cb!.self());

    cb!.publish("from b");
    await until(() => inbox[0]!.length === 1 && inbox[2]!.length === 1);
    expect(inbox).toEqual([["from b"], [], ["from b"]]);

    ca!.leave();
    await tick(10);
    expect(sent(s, "leave")).toHaveLength(0);
    expect(cc!.members()).toHaveLength(2);
    b.close();
    await until(() => cc!.members().length === 1);
    expect(cc!.members()[0]!.user).toBe("bia");
  });
});

