// Subscription churn and liveness (PR 4C-2): a `sub` and its `unsub` of the same turn never reach the shard,
// `unsubscribeGraceMs` keeps a subscription live for a listener that comes back, any frame from the server counts as
// liveness for the heartbeat, and reconnects after `online`/`foreground` are spread.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";
import { unsafeRef, type ConnectivityEvent, type QuerySnapshot } from "../src/index.ts";
import type { FakeSocket } from "../src/testing.ts";
import { MAX_BATCH_BYTES } from "../src/protocol.ts";

const list = unsafeRef("messages:list");
const subsOf = (ws: FakeSocket) => ws.sent.filter((m) => m !== "ping" && m.t === "sub");
const unsubsOf = (ws: FakeSocket) => ws.sent.filter((m) => m !== "ping" && m.t === "unsub");

afterEach(() => {
  vi.useRealTimers();
});

describe("sub + unsub in one turn", () => {
  it("neither goes out (batch): the shard never builds that snapshot", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "keep" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    const ws = server.open()[0]!;
    const frames = ws.framesIn;
    // Mounted and unmounted within the turn (a list item rendered then filtered out).
    const off = client.subscribe(list, { channel: "gone" }, {}, () => {});
    off();
    await tick(5);
    expect(subsOf(ws)).toHaveLength(1);
    expect(unsubsOf(ws)).toHaveLength(0);
    expect(ws.framesIn).toBe(frames);
    expect(server.subscriptionCount()).toBe(1);
    // A pair cancelled next to other traffic: the rest of the frame still goes.
    const off2 = client.subscribe(list, { channel: "gone2" }, {}, () => {});
    client.subscribe(list, { channel: "stay" }, {}, () => {});
    off2();
    await until(() => server.subscriptionCount() === 2);
    expect(subsOf(ws).map((m) => (m as { args: Record<string, unknown> }).args.channel)).toEqual(["keep", "stay"]);
    expect(unsubsOf(ws)).toHaveLength(0);
    // A sub that already went out is unsubscribed as usual.
    const off3 = client.subscribe(list, { channel: "later" }, {}, () => {});
    await until(() => server.subscriptionCount() === 3);
    off3();
    await until(() => server.subscriptionCount() === 2);
    expect(unsubsOf(ws)).toHaveLength(1);
    client.close();
  });

  it("also when the `sub` left no room in the frame for its `unsub`", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "keep" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    const ws = server.open()[0]!;
    const frames = ws.framesIn;
    // The `sub` alone fills the turn's frame: the `unsub` would go past MAX_BATCH_BYTES.
    const off = client.subscribe(list, { channel: "x".repeat(MAX_BATCH_BYTES) }, {}, () => {});
    off();
    await tick(5);
    expect(subsOf(ws)).toHaveLength(1);
    expect(unsubsOf(ws)).toHaveLength(0);
    expect(ws.framesIn).toBe(frames);
    client.close();
  });
});

describe("unsubscribeGraceMs", () => {
  it("a listener back within the grace reuses the live subscription: no unsub + sub, its value at once", async () => {
    const server = messagesServer({ batch: true });
    server.mutateDirect(SHARD, "messages:send", { channel: "g", body: "hi" });
    const client = makeClient(server, { unsubscribeGraceMs: 200 });
    let last: QuerySnapshot | undefined;
    const off = client.subscribe(list, { channel: "g" }, {}, (s) => (last = s));
    await until(() => last?.status === "success");
    const ws = server.open()[0]!;
    off();
    await tick(20); // past the turn: without the grace it would be gone
    expect(server.subscriptionCount()).toBe(1);
    expect(unsubsOf(ws)).toHaveLength(0);
    let again: QuerySnapshot | undefined;
    const off2 = client.subscribe(list, { channel: "g" }, {}, (s) => (again = s));
    // Its confirmed value right away (no loading, no round trip).
    expect(client.localQueryResult(list, { channel: "g" })).toMatchObject({ status: "success", value: ["hi"] });
    // Still live: changes keep coming.
    server.mutateDirect(SHARD, "messages:send", { channel: "g", body: "more" });
    await until(() => JSON.stringify(again?.value) === JSON.stringify(["hi", "more"]));
    expect(subsOf(ws)).toHaveLength(1);
    expect(unsubsOf(ws)).toHaveLength(0);
    off2();
    // The grace runs out: then it ends as usual.
    await until(() => server.subscriptionCount() === 0);
    expect(unsubsOf(ws)).toHaveLength(1);
    client.close();
  });

  it("at most 64 wait at once: the oldest goes first", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server, { unsubscribeGraceMs: 60_000 });
    const offs: Array<() => void> = [];
    for (let i = 0; i < 65; i++) offs.push(client.subscribe(list, { channel: `c${i}` }, {}, () => {}));
    await until(() => server.subscriptionCount() === 65);
    const ws = server.open()[0]!;
    for (const off of offs) off();
    await until(() => server.subscriptionCount() === 64);
    const unsubbed = unsubsOf(ws).map((m) => (m as { qid: string }).qid);
    const first = (subsOf(ws)[0] as { qid: string }).qid;
    expect(unsubbed).toEqual([first]);
    client.close();
  });

  it("close() clears the waiting ones' timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = messagesServer({ batch: true });
    const client = makeClient(server, { unsubscribeGraceMs: 1000 });
    const off = client.subscribe(list, { channel: "c" }, {}, () => {});
    await vi.advanceTimersByTimeAsync(1);
    expect(server.subscriptionCount()).toBe(1);
    off();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1); // the grace timer (heartbeat and idle are off or not armed)
    client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  const me = unsafeRef("users:me");

  it("an identity change ends the waiting ones: the next identity never gets the previous one's value", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server, { unsubscribeGraceMs: 60_000, auth: () => "user:alice" });
    let last: QuerySnapshot | undefined;
    const off = client.subscribe(me, {}, {}, (s) => (last = s));
    await until(() => last?.value === "alice");
    const ws = server.open()[0]!;
    off();
    await tick(5);
    expect(server.subscriptionCount()).toBe(1);
    client.setAuth(() => "user:bob");
    // Ended right away (`unsub`, with this turn's frame), not kept for bob.
    await tick(5);
    expect(unsubsOf(ws)).toHaveLength(1);
    const seen: unknown[] = [];
    const off2 = client.subscribe(me, {}, {}, (s) => seen.push(s.value));
    expect(client.localQueryResult(me, {})?.value).not.toBe("alice");
    await until(() => seen.includes("bob"));
    expect(seen).not.toContain("alice");
    off2();
    client.close();
  });

  it("also offline: nothing of the previous identity while no server answers, and no timer left", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = messagesServer({ batch: true });
    const client = makeClient(server, { unsubscribeGraceMs: 60_000, auth: () => "user:alice", backoff: { initialMs: 600_000, maxMs: 600_000 } });
    let last: QuerySnapshot | undefined;
    const off = client.subscribe(me, {}, {}, (s) => (last = s));
    await vi.advanceTimersByTimeAsync(5);
    expect(last?.value).toBe("alice");
    // The network goes away.
    server.refuseConnections = 1_000;
    server.dropAll();
    await vi.advanceTimersByTimeAsync(5);
    const before = vi.getTimerCount();
    off();
    await vi.advanceTimersByTimeAsync(5);
    expect(vi.getTimerCount()).toBe(before + 1); // the grace timer
    client.setAuth(() => "user:bob");
    // The grace timer went with the subscription (and the reconnect, with nothing left to subscribe).
    expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    expect(client.localQueryResult(me, {})?.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.map((s) => s.value)).not.toContain("alice");
    client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a token for someone else from the same fetcher ends them too", async () => {
    const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, "")}.sig`;
    const server = messagesServer({ batch: true, verify: (t) => ({ subject: (JSON.parse(atob(t.split(".")[1]!)) as { sub: string }).sub }) });
    let who = "alice";
    const client = makeClient(server, { unsubscribeGraceMs: 60_000, auth: () => jwt(who) });
    let last: QuerySnapshot | undefined;
    const off = client.subscribe(me, {}, {}, (s) => (last = s));
    await until(() => last?.status === "success");
    const ws = server.open()[0]!;
    off();
    await tick(5);
    who = "bob";
    server.expireAuth(); // the client fetches a token again: the fetcher answers for bob
    await until(() => unsubsOf(ws).length === 1);
    client.close();
  });

  it("default 0: dropped at the end of the turn, as before", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server);
    const off = client.subscribe(list, { channel: "d" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    off();
    await until(() => server.subscriptionCount() === 0);
    client.close();
  });
});

describe("heartbeat", () => {
  it("any frame from the server counts as liveness: a busy socket is not pinged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = messagesServer();
    // random 0: the ping interval is exactly `intervalMs`
    const client = makeClient(server, { heartbeat: { intervalMs: 1000, timeoutMs: 500 }, random: () => 0 });
    client.subscribe(list, { channel: "h" }, {}, () => {});
    await vi.advanceTimersByTimeAsync(1);
    expect(server.subscriptionCount()).toBe(1);
    const ws = server.open()[0]!;
    const pings = () => ws.sent.filter((m) => m === "ping").length;
    await vi.advanceTimersByTimeAsync(600);
    server.mutateDirect(SHARD, "messages:send", { channel: "h", body: "x" }); // a patch arrives at ~600 ms
    await vi.advanceTimersByTimeAsync(500); // ~1100 ms: the interval passed, but the socket spoke 500 ms ago
    expect(pings()).toBe(0);
    await vi.advanceTimersByTimeAsync(550); // 1000 ms after that patch: silent long enough
    expect(pings()).toBe(1);
    // the pong came: nothing reconnects
    await vi.advanceTimersByTimeAsync(600);
    expect(server.history).toHaveLength(1);
    client.close();
  });

  it("a silent socket is still pinged on time, and dropped when no pong comes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = messagesServer();
    const client = makeClient(server, { heartbeat: { intervalMs: 1000, timeoutMs: 500 }, random: () => 0 });
    client.subscribe(list, { channel: "h" }, {}, () => {});
    await vi.advanceTimersByTimeAsync(1);
    const ws = server.open()[0]!;
    ws.silent = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.sent.filter((m) => m === "ping")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(ws.readyState).toBe(3);
    client.close();
  });
});

describe("reconnect after online / foreground", () => {
  it("is spread by a random delay (no thundering herd), short of the backoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = messagesServer();
    let emit: (e: ConnectivityEvent) => void = () => {};
    let r = 0.5;
    const client = makeClient(server, { connectivity: { subscribe: (e) => ((emit = e), () => {}) }, backoff: { initialMs: 60_000 }, random: () => r });
    client.subscribe(list, { channel: "n" }, {}, () => {});
    await vi.advanceTimersByTimeAsync(1);
    expect(server.subscriptionCount()).toBe(1);
    emit("offline");
    await vi.advanceTimersByTimeAsync(10);
    r = 0.8; // up to 250 ms: 200 ms
    emit("online");
    expect(client.connectionState().shards[SHARD]).toBe("waiting");
    await vi.advanceTimersByTimeAsync(150);
    expect(server.open()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(server.subscriptionCount()).toBe(1);
    // a second `online` while one is waiting does not stack another connect
    emit("offline");
    emit("online");
    emit("online");
    await vi.advanceTimersByTimeAsync(260);
    expect(server.open()).toHaveLength(1);
    expect(server.history).toHaveLength(3);
    client.close();
  });

  it("an attempt in flight when the network comes back: if it fails, its retry is the spread, not the backoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = messagesServer();
    let emit: (e: ConnectivityEvent) => void = () => {};
    let fail: (e: Error) => void = () => {};
    let calls = 0;
    const client = makeClient(server, {
      connectivity: { subscribe: (e) => ((emit = e), () => {}) },
      backoff: { initialMs: 60_000 },
      random: () => 0.8,
      // Serial: the attempt waits for the token before opening the socket.
      pipelineConnect: false,
      auth: () => (++calls === 1 ? new Promise<string>((_, reject) => (fail = reject)) : "user:a"),
      onError: () => {},
    });
    client.subscribe(list, { channel: "n" }, {}, () => {});
    await vi.advanceTimersByTimeAsync(1);
    expect(client.connectionState().shards[SHARD]).toBe("connecting");
    emit("foreground");
    fail(new Error("network was down"));
    await vi.advanceTimersByTimeAsync(1);
    expect(client.connectionState().shards[SHARD]).toBe("waiting");
    await vi.advanceTimersByTimeAsync(250); // 0.8 × 250 ms, not 30–60 s
    expect(server.subscriptionCount()).toBe(1);
    client.close();
  });
});
