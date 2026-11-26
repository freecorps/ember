// The browser client: batches, flushes on an interval and when a batch is full, beacons on pagehide (text/plain, no
// preflight), retries what failed, keeps the anonymous id in storage.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ANONYMOUS_ID_KEY, createAnalytics, type AnalyticsClient } from "../src/client.ts";

type Sent = { url: string; headers: Record<string, string>; body: { events: Array<{ name: string; props?: unknown; anonymousId: string; ts: number }> }; keepalive?: boolean };

function fakeFetch(status: number | (() => number) = 204) {
  const sent: Sent[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)), ...(init.keepalive !== undefined ? { keepalive: init.keepalive } : {}) });
    return new Response(null, { status: typeof status === "function" ? status() : status });
  });
  return { sent, fetch: f as unknown as typeof fetch };
}

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

let clients: AnalyticsClient[] = [];
const make = (...a: Parameters<typeof createAnalytics>) => {
  const c = createAnalytics(...a);
  clients.push(c);
  return c;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("analytics client", () => {
  test("batches on an interval: one text/plain POST per batch, to <url>/analytics/track", async () => {
    const { sent, fetch } = fakeFetch();
    const a = make({ url: "https://app.test/", fetch, storage: memoryStorage(), flushIntervalMs: 5000 });
    a.track("viewed", { page: "/pricing" });
    a.track("clicked", { id: 3, primary: true });
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://app.test/analytics/track");
    expect(sent[0]!.headers).toEqual({ "content-type": "text/plain" });
    expect(sent[0]!.keepalive).toBe(true);
    expect(sent[0]!.body.events.map((e) => [e.name, e.props, e.anonymousId])).toEqual([
      ["viewed", { page: "/pricing" }, a.anonymousId],
      ["clicked", { id: 3, primary: true }, a.anonymousId],
    ]);
    expect(a.pending).toBe(0);
  });

  test("a full batch goes at once; a long queue goes in batches", async () => {
    const { sent, fetch } = fakeFetch();
    const a = make({ url: "https://app.test", path: "/a/track", fetch, storage: null, batchSize: 3, flushIntervalMs: 60_000 });
    for (let i = 0; i < 7; i++) a.track("e", { i });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]!.url).toBe("https://app.test/a/track");
    await a.flush();
    expect(sent.map((s) => s.body.events.length)).toEqual([3, 3, 1]);
    expect(sent.flatMap((s) => s.body.events.map((e) => (e.props as { i: number }).i))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("a failed batch (network, 429, 5xx) comes back in order; a refused one (400) is dropped", async () => {
    let status = 503;
    const { sent, fetch } = fakeFetch(() => status);
    const a = make({ url: "https://app.test", fetch, storage: null, flushIntervalMs: 60_000 });
    a.track("first");
    a.track("second");
    await a.flush();
    expect(a.pending).toBe(2);
    status = 429;
    await a.flush();
    expect(a.pending).toBe(2);
    status = 400;
    await a.flush();
    expect(a.pending).toBe(0);
    expect(sent).toHaveLength(3);
    const throwing = make({ url: "https://app.test", fetch: (async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch, storage: null });
    throwing.track("x");
    await throwing.flush();
    expect(throwing.pending).toBe(1);
  });

  test("the queue is capped (oldest dropped); invalid names and props never leave the client", async () => {
    const { sent, fetch } = fakeFetch();
    const a = make({ url: "https://app.test", fetch, storage: null, batchSize: 50, maxQueue: 50, flushIntervalMs: 60_000 });
    for (let i = 0; i < 49; i++) a.track("ok", { i });
    a.track("bad'name");
    a.track(" lead");
    expect(a.pending).toBe(49);
    a.track("last", { nested: { x: 1 } as never, "bad key": 1, n: Number.NaN, s: "y".repeat(300), good: 1 });
    await a.flush();
    const events = sent.flatMap((s) => s.body.events);
    expect(events).toHaveLength(50);
    expect(events.at(-1)).toMatchObject({ name: "last", props: { s: "y".repeat(256), good: 1 } });
    expect(Object.keys(events.at(-1)!.props as object)).toEqual(["s", "good"]);
  });

  test("pagehide: what is queued goes as text/plain beacons (no preflight, no token)", async () => {
    const beacons: Array<{ url: string; type: string; body: string }> = [];
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("document", {});
    vi.stubGlobal("addEventListener", (t: string, f: () => void) => void listeners.set(t, f));
    vi.stubGlobal("removeEventListener", (t: string) => void listeners.delete(t));
    vi.stubGlobal("navigator", {
      sendBeacon: (url: string, data: Blob) => {
        void data.text().then((body) => beacons.push({ url, type: data.type, body }));
        return true;
      },
    });
    // The first full batch goes by fetch (with the token) and hangs: what is queued after it waits for the page to hide.
    const sent: Array<{ headers: Record<string, string> }> = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      sent.push({ headers: init.headers as Record<string, string> });
      return new Promise<Response>(() => {});
    }) as unknown as typeof globalThis.fetch;
    const a = make({ url: "https://app.test", fetch, storage: null, batchSize: 2, getToken: () => "secret" });
    a.track("a");
    a.track("b");
    await vi.advanceTimersByTimeAsync(0);
    a.track("c");
    a.track("d");
    a.track("e");
    listeners.get("pagehide")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]!.headers.authorization).toBe("Bearer secret");
    expect(beacons.map((b) => [b.url, b.type, (JSON.parse(b.body) as Sent["body"]).events.map((e) => e.name)])).toEqual([
      ["https://app.test/analytics/track", "text/plain", ["c", "d"]],
      ["https://app.test/analytics/track", "text/plain", ["e"]],
    ]);
    expect(a.pending).toBe(0);
    a.close();
    expect(listeners.has("pagehide")).toBe(false);
  });

  test("the anonymous id: kept in storage across clients, a new one after reset", () => {
    const storage = memoryStorage();
    const { fetch } = fakeFetch();
    const a = make({ url: "https://app.test", fetch, storage });
    expect(a.anonymousId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(storage.map.get(ANONYMOUS_ID_KEY)).toBe(a.anonymousId);
    const b = make({ url: "https://app.test", fetch, storage });
    expect(b.anonymousId).toBe(a.anonymousId);
    b.reset();
    expect(b.anonymousId).not.toBe(a.anonymousId);
    expect(storage.map.get(ANONYMOUS_ID_KEY)).toBe(b.anonymousId);
    // Storage that throws (blocked): memory only, still works.
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(make({ url: "https://app.test", fetch, storage: blocked }).anonymousId).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
