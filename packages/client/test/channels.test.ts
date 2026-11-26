// `client.channel()` (feature "ephemeral") over the fake server: members and messages, handles of one channel, joins
// again on a new socket and after an identity change, an older runtime, the keep-alive ping of a listening socket, and
// the multiTab leader (one join for the tabs of a group, messages handed between them, the last tab out leaves).
import { afterEach, describe, expect, it } from "vitest";
import { makeClient, messagesServer, tick, until } from "./helpers.ts";
import { FakeBrowser, type FakeSocket } from "../src/testing.ts";
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
    expect(sent(s, "join").at(-2)).toEqual({ t: "join", ch: "room:3", state: { n: 1 } });
    a.signIn("user:ana");
    await until(() => vip.status() === "joined");
    expect(vip.members().map((m) => m.user)).toEqual(["ana"]);
    a.signIn(null);
    await until(() => vip.status() === "refused");
  });

  it("an older runtime: unsupported, nothing sent", async () => {
    const s = messagesServer();
    const a = client(s, "user:ana");
    const ch = a.channel("room:1");
    await until(() => ch.status() === "unsupported");
    expect(ch.error()?.code).toBe("unsupported");
    expect(ch.publish("x")).toBe(false);
    expect(sent(s, "join")).toHaveLength(0);
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

