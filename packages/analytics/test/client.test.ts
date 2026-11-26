// The browser client: batches, flushes on an interval and when a batch is full, beacons on pagehide (text/plain, no
// preflight), retries what failed, keeps the anonymous id in storage.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ANONYMOUS_ID_KEY, BEACON_BUDGET_BYTES, createAnalytics, type AnalyticsClient } from "../src/client.ts";

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

  test("a failed batch (network, 429, 5xx) comes back in order; one refused event by event (400) is dropped", async () => {
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
    // The pair, then each event on its own (refused too: dropped).
    expect(sent.map((x) => x.body.events.map((e) => e.name))).toEqual([["first", "second"], ["first", "second"], ["first", "second"], ["first"], ["second"]]);
    const throwing = make({ url: "https://app.test", fetch: (async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch, storage: null });
    throwing.track("x");
    await throwing.flush();
    expect(throwing.pending).toBe(1);
  });

  test("a batch refused whole (400 over the install's maxEvents, 413 over 32 KiB) goes again in halves; a lone bad event is dropped", async () => {
    // A server with maxEvents 5 that refuses any batch holding the event "bad" (as it would an invalid one).
    const got: string[][] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const names = (JSON.parse(String(init.body)) as Sent["body"]).events.map((e) => e.name);
      if (names.length > 5 || names.includes("bad")) return new Response(null, { status: 400 });
      got.push(names);
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const a = make({ url: "https://app.test", fetch, storage: null, batchSize: 20, flushIntervalMs: 60_000 });
    for (let i = 0; i < 12; i++) a.track(i === 7 ? "bad" : `e${i}`);
    await a.flush();
    expect(a.pending).toBe(0);
    expect(got.flat()).toEqual(Array.from({ length: 12 }, (_, i) => `e${i}`).filter((n) => n !== "e7"));
    expect(got.every((b) => b.length <= 5)).toBe(true);
    // 413 too: the halves pass.
    const sizes: number[] = [];
    const tooBig = vi.fn(async (_url: string, init: RequestInit) => {
      const n = (JSON.parse(String(init.body)) as Sent["body"]).events.length;
      sizes.push(n);
      return new Response(null, { status: n > 4 ? 413 : 204 });
    }) as unknown as typeof globalThis.fetch;
    const b = make({ url: "https://app.test", fetch: tooBig, storage: null, batchSize: 16, flushIntervalMs: 60_000 });
    for (let i = 0; i < 16; i++) b.track("e");
    await b.flush();
    expect(b.pending).toBe(0);
    expect(sizes).toEqual([16, 8, 4, 4, 4, 4]);
    // Another 4xx (403): dropped whole, as before.
    const { fetch: forbidden } = fakeFetch(403);
    const c = make({ url: "https://app.test", fetch: forbidden, storage: null, flushIntervalMs: 60_000 });
    c.track("x");
    c.track("y");
    await c.flush();
    expect(c.pending).toBe(0);
  });

  test("a redirect is not a delivery: the batch stays queued (only 2xx is delivered)", async () => {
    let status = 301;
    const { sent, fetch } = fakeFetch(() => status);
    const a = make({ url: "https://app.test", fetch, storage: null, flushIntervalMs: 60_000 });
    a.track("first");
    await a.flush();
    expect(a.pending).toBe(1);
    status = 308;
    await a.flush();
    expect(a.pending).toBe(1);
    status = 202;
    await a.flush();
    expect(a.pending).toBe(0);
    expect(sent).toHaveLength(3);
  });

  test("one request at a time: the timer and flush() never post while a batch is in flight", async () => {
    const pending: Array<(r: Response) => void> = [];
    const bodies: string[][] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push((JSON.parse(String(init.body)) as Sent["body"]).events.map((e) => e.name));
      return new Promise<Response>((resolve) => pending.push(resolve));
    }) as unknown as typeof globalThis.fetch;
    const a = make({ url: "https://app.test", fetch, storage: null, flushIntervalMs: 1000 });
    a.track("a");
    const first = a.flush();
    await vi.advanceTimersByTimeAsync(0);
    a.track("b");
    // Ticks of the timer and more flush() calls while "a" is out: no second request.
    await vi.advanceTimersByTimeAsync(5000);
    const again = a.flush();
    expect(again).toBe(first);
    expect(bodies).toEqual([["a"]]);
    // "a" fails: it comes back in front of "b", and the same flush stops (the next tick retries, in order).
    pending.shift()!(new Response(null, { status: 503 }));
    await first;
    expect(a.pending).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bodies).toEqual([["a"], ["a", "b"]]);
    pending.shift()!(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.pending).toBe(0);
  });

  test("the prop cap counts the props kept: invalid keys do not use a slot", async () => {
    const { sent, fetch } = fakeFetch();
    const a = make({ url: "https://app.test", fetch, storage: null, flushIntervalMs: 60_000 });
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) props[`bad key ${i}`] = 1;
    props.obj = { nested: 1 };
    for (let i = 0; i < 25; i++) props[`k${i}`] = i;
    a.track("e", props as never);
    await a.flush();
    expect(Object.keys(sent[0]!.body.events[0]!.props as object)).toEqual(Array.from({ length: 20 }, (_, i) => `k${i}`));
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

  test("pagehide: the beacons stay within the keepalive budget (the fetch in flight counts); the rest stays queued", async () => {
    const beacons: number[] = [];
    const listeners = new Map<string, () => void>();
    let accept = true;
    vi.stubGlobal("document", {});
    vi.stubGlobal("addEventListener", (t: string, f: () => void) => void listeners.set(t, f));
    vi.stubGlobal("removeEventListener", (t: string) => void listeners.delete(t));
    vi.stubGlobal("navigator", { sendBeacon: (_url: string, data: Blob) => (accept ? (beacons.push(data.size), true) : false) });
    const fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;
    // 20 events × ~5 KiB of props per batch ≈ 100 KiB queued: more than one page may have in flight.
    const a = make({ url: "https://app.test", fetch, storage: null, batchSize: 2, maxQueue: 500, flushIntervalMs: 60_000 });
    const big = (i: number) => Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`p${j}`, `${i}`.padEnd(256, "x")]));
    for (let i = 0; i < 40; i++) a.track("e", big(i));
    await vi.advanceTimersByTimeAsync(0); // the first batch is out by fetch (and hangs)
    const left = a.pending;
    listeners.get("pagehide")!();
    expect(beacons.length).toBeGreaterThan(0);
    const inFlight = 2 * 20 * 256; // at least the props of the fetched batch
    expect(beacons.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(BEACON_BUDGET_BYTES - inFlight);
    expect(a.pending).toBe(left - 2 * beacons.length);
    expect(a.pending).toBeGreaterThan(0);
    // A beacon the browser refuses (its own quota) keeps the batch.
    accept = false;
    const before = a.pending;
    listeners.get("pagehide")!();
    expect(a.pending).toBe(before);
  });

  test("no pagehide listener without a navigator to beacon with (SSR, a stubbed document)", () => {
    const added: string[] = [];
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("addEventListener", (t: string) => void added.push(t));
    vi.stubGlobal("removeEventListener", () => {});
    const { fetch } = fakeFetch();
    make({ url: "https://app.test", fetch, storage: null }).close();
    expect(added).toEqual([]);
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
