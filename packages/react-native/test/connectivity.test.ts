import { EmberClient, type ConnectivityEvent, unsafeRef } from "@freecorps/ember-client";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmberClient, createExpoConnectivity } from "../src/index.ts";
import { fakeAppState, fakeNetInfo } from "./fakes.ts";

afterEach(() => vi.useRealTimers());

function record(opts: Parameters<typeof createExpoConnectivity>[0]) {
  const events: ConnectivityEvent[] = [];
  const source = createExpoConnectivity(opts);
  const stop = source.subscribe((e) => events.push(e));
  return { events, stop, source };
}

describe("createExpoConnectivity", () => {
  it("background → close after the grace period; foreground → online (reconnect)", () => {
    vi.useFakeTimers();
    const appState = fakeAppState();
    const { events } = record({ appState, netInfo: null, backgroundGraceMs: 1000 });
    appState.set("inactive"); // iOS transient state: ignored
    appState.set("background");
    expect(events).toEqual(["background"]);
    vi.advanceTimersByTime(999);
    expect(events).toEqual(["background"]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["background", "offline"]);
    appState.set("active");
    expect(events).toEqual(["background", "offline", "online"]);
  });

  it("foreground within the grace period keeps the sockets (foreground → ping)", () => {
    vi.useFakeTimers();
    const appState = fakeAppState();
    const { events } = record({ appState, netInfo: null, backgroundGraceMs: 1000 });
    appState.set("background");
    vi.advanceTimersByTime(500);
    appState.set("active");
    vi.advanceTimersByTime(5000);
    expect(events).toEqual(["background", "foreground"]);
  });

  it("network changes map to online/offline and are held back while suspended", () => {
    vi.useFakeTimers();
    const appState = fakeAppState();
    const netInfo = fakeNetInfo();
    const { events } = record({ appState, netInfo, backgroundGraceMs: 0 });
    netInfo.set({ isConnected: false });
    netInfo.set({ isConnected: false }); // no duplicate
    netInfo.set({ isConnected: true, isInternetReachable: null }); // unknown reachability counts as online
    expect(events).toEqual(["offline", "online"]);
    netInfo.set({ isInternetReachable: false });
    expect(events).toEqual(["offline", "online", "offline"]);
    netInfo.set({ isInternetReachable: true });

    events.length = 0;
    appState.set("background"); // grace 0: suspended at once
    expect(events).toEqual(["background", "offline"]);
    netInfo.set({ isConnected: false });
    netInfo.set({ isConnected: true });
    expect(events).toEqual(["background", "offline"]);
    // Back to the foreground while the network is down: stays offline until it returns.
    netInfo.set({ isConnected: false });
    appState.set("active");
    expect(events).toEqual(["background", "offline"]);
    netInfo.set({ isConnected: true });
    expect(events).toEqual(["background", "offline", "online"]);
  });

  it("starts the grace timer when launched in the background, and unsubscribes cleanly", () => {
    vi.useFakeTimers();
    const appState = fakeAppState("background");
    const netInfo = fakeNetInfo();
    const { events, stop } = record({ appState, netInfo, backgroundGraceMs: 100 });
    expect(appState.listeners()).toBe(1);
    expect(netInfo.listeners()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(events).toEqual(["offline"]);
    stop();
    expect(appState.listeners()).toBe(0);
    expect(netInfo.listeners()).toBe(0);
    appState.set("active");
    expect(events).toEqual(["offline"]);
  });

  it("applies NetInfo.fetch() at subscribe time", async () => {
    const netInfo = fakeNetInfo({ isConnected: false });
    const { events } = record({ appState: null, netInfo });
    await vi.waitFor(() => expect(events).toEqual(["offline"]));
  });

  it("works without any native module (Infinity grace never closes)", () => {
    vi.useFakeTimers();
    const appState = fakeAppState();
    const { events } = record({ appState, backgroundGraceMs: Infinity });
    appState.set("background");
    vi.advanceTimersByTime(1e9);
    expect(events).toEqual(["background"]);
    expect(() => createExpoConnectivity().subscribe(() => {})()).not.toThrow();
  });
});

describe("EmberClient + createExpoConnectivity", () => {
  it("closes sockets in the background and resumes live queries on foreground", async () => {
    const server = new FakeEmberServer({
      queries: { "messages:list": (db, { channel }) => db.where<{ body: string }>("messages", "channel", channel).map((m) => m.body) },
      mutations: { "messages:send": (db, args) => db.insert("messages", args) },
    });
    const appState = fakeAppState();
    const netInfo = fakeNetInfo();
    const client = createEmberClient({
      url: "https://ember.test",
      WebSocket: server.WebSocket,
      fetch: server.fetch,
      connectivity: { appState, netInfo, backgroundGraceMs: 20 },
      storage: "memory",
      heartbeat: false,
      defaultShard: "global:main",
      backoff: { initialMs: 5, maxMs: 10 },
    });
    expect(client).toBeInstanceOf(EmberClient);
    const q = client.watchQuery(unsafeRef("messages:list"), { channel: "a" });
    const off = q.subscribe(() => {});
    await vi.waitFor(() => expect(q.getSnapshot().value).toEqual([]));
    expect(server.open()).toHaveLength(1);

    appState.set("background");
    await vi.waitFor(() => expect(server.open()).toHaveLength(0));
    expect(client.connectionState().online).toBe(false);
    server.mutateDirect("global:main", "messages:send", { channel: "a", body: "while away" });

    // A mutation issued while suspended waits in the queue.
    const sent = client.mutation(unsafeRef("messages:send"), { channel: "a", body: "queued" });
    await new Promise((r) => setTimeout(r, 30));
    expect(server.open()).toHaveLength(0);

    appState.set("active");
    await sent;
    await vi.waitFor(() => expect(q.getSnapshot().value).toEqual(["while away", "queued"]));
    expect(server.open()).toHaveLength(1);
    const sub = server.open()[0]!.sent.find((m) => m !== "ping" && m.t === "sub");
    expect(sub).toMatchObject({ t: "sub", resume: expect.objectContaining({ version: expect.any(Number) }) });
    off();
    client.close();
    expect(appState.listeners()).toBe(0);
  });
});
