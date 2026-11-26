// Real-user latency (contracts.md "RUM"), opt-in: one draw per client; a drawn session announces feature "rum",
// measures connect / rtt / ack / first_value per shard kind and DO colo, and posts small histograms to
// /api/_ember/rum (on close here). Nothing personal: no shard key, client id, args or user.
import { describe, expect, it } from "vitest";
import { anyApi, keyValueSnapshotCache, type FunctionReference } from "../src/index.ts";
import { RumCollector, rumBucket } from "../src/rum.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

const api = anyApi as unknown as {
  messages: {
    list: FunctionReference<"query", "public", { channel: string }, string[]>;
    send: FunctionReference<"mutation", "public", { channel: string; body: string }, string>;
  };
};

function withRumSink(server: ReturnType<typeof messagesServer>) {
  const posts: Array<{ url: string; body: string; type: string | null; keepalive: boolean }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/_ember/rum")) {
      posts.push({ url, body: String(init?.body), type: new Headers(init?.headers).get("content-type"), keepalive: init?.keepalive === true });
      return new Response(null, { status: 204 });
    }
    return server.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { posts, fetch };
}

describe("RUM", () => {
  it("a drawn session measures connect, first value, ack and rtt per shard kind and colo, and posts them on close", async () => {
    const server = messagesServer({ colo: "GRU" });
    const sink = withRumSink(server);
    const client = makeClient(server, { fetch: sink.fetch, rum: { sampleRate: 0.1 }, random: () => 0.01, heartbeat: { intervalMs: 20, timeoutMs: 1000 } });
    const off = client.subscribe(api.messages.list, { channel: "secret-channel" }, { shard: SHARD }, () => {});
    await until(() => client.connectionState().connected);
    await client.mutation(api.messages.send, { channel: "secret-channel", body: "hello" }, { shard: SHARD });
    // A heartbeat round trip.
    const sock = server.open()[0]!;
    await until(() => sock.sent.includes("ping") && sock.received.includes("pong"));
    await tick(5);
    off();
    // The hello announced it (the shard's colo comes back in ready).
    const hello = sock.sent.find((m) => m !== "ping" && m.t === "hello") as { features?: string[] };
    expect(hello.features).toContain("rum");
    client.close();
    expect(sink.posts).toHaveLength(1);
    const post = sink.posts[0]!;
    expect([post.url, post.type, post.keepalive]).toEqual(["https://ember.test/api/_ember/rum", "text/plain", true]);
    const batch = JSON.parse(post.body) as { v: number; r: number; p: string; s: string; h: Array<{ m: string; k: string; c: string; b: Array<[number, number]> }> };
    expect([batch.v, batch.r, batch.p]).toEqual([1, 0.1, "node"]);
    expect(batch.h.map((x) => x.m).sort()).toEqual(["ack", "connect", "first_value", "rtt"]);
    for (const x of batch.h) {
      expect([x.k, x.c]).toEqual(["org", "GRU"]);
      expect(x.b.reduce((a, [, n]) => a + n, 0)).toBeGreaterThan(0);
    }
    // No shard key, args, client id or body.
    for (const leak of ["acme", "secret-channel", "hello", client.clientId ?? "no-client-id"]) expect(post.body).not.toContain(leak);
  });

  it("a session not drawn announces nothing and posts nothing", async () => {
    const server = messagesServer({ colo: "GRU" });
    const sink = withRumSink(server);
    const client = makeClient(server, { fetch: sink.fetch, rum: { sampleRate: 0.05 }, random: () => 0.5 });
    const off = client.subscribe(api.messages.list, { channel: "a" }, { shard: SHARD }, () => {});
    await until(() => client.connectionState().connected);
    await client.mutation(api.messages.send, { channel: "a", body: "x" }, { shard: SHARD });
    const hello = server.open()[0]!.sent.find((m) => m !== "ping" && m.t === "hello") as { features?: string[] };
    off();
    client.close();
    expect(hello.features).not.toContain("rum");
    expect(sink.posts).toEqual([]);
  });

  it("the collector: same buckets as the runtime, kind only, batches up to 2 KB (the rest waits)", () => {
    expect([0, 0.3, 1, 10, 100, 1000, 1e9].map(rumBucket)).toEqual([0, 0, 2, 6, 13, 19, 40]);
    const sent: string[] = [];
    const c = new RumCollector("https://x/api/_ember/rum", { sampleRate: 1, flushIntervalMs: 1e9 }, (async (_u: unknown, init?: RequestInit) => (sent.push(String(init?.body)), new Response(null, { status: 204 }))) as typeof fetch);
    c.record("rtt", "org:acme", "GRU", 50);
    c.record("rtt", "bad shard", "GRU", 50); // not a kind: dropped
    c.record("ack", "org:acme", "lowercase", 50); // a bad colo becomes unknown
    c.record("ack", "org:acme", "", -1); // not a duration
    const one = JSON.parse(c.take()!) as { h: Array<{ m: string; k: string; c: string; b: Array<[number, number]> }> };
    expect(one.h).toEqual([
      { m: "rtt", k: "org", c: "GRU", b: [[rumBucket(50), 1]] },
      { m: "ack", k: "org", c: "", b: [[rumBucket(50), 1]] },
    ]);
    expect(c.take()).toBeNull();
    // Many histograms: the first batch stays under 2 KB, the next flush takes the rest.
    for (let i = 0; i < 30; i++) for (let b = 0; b < 6; b++) c.record("first_value", `kind${i}:x`, "MIA", 2 ** b * 3);
    const first = c.take()!;
    expect(first.length).toBeLessThanOrEqual(2048);
    c.flush(false);
    expect(sent.length).toBe(1); // the rest went out
    c.stop();
    expect(sent.length).toBe(1); // stop() had nothing left
  });

  type Batch = { h: Array<{ m: string; k: string; c: string; b: Array<[number, number]> }> };
  const counts = (body: string) => Object.fromEntries((JSON.parse(body) as Batch).h.map((x) => [x.m, x.b.reduce((a, [, n]) => a + n, 0)]));

  it("the collector: a batch that fails (network, 429, 5xx) comes back for the next flush, counted once; a refused one (4xx) goes", async () => {
    const bodies: string[] = [];
    let answer: () => Promise<Response> = () => Promise.reject(new TypeError("offline"));
    const c = new RumCollector("https://x/api/_ember/rum", { sampleRate: 1, flushIntervalMs: 1e9 }, ((_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return answer();
    }) as typeof fetch);
    c.record("rtt", "org:a", "GRU", 10);
    c.record("rtt", "org:a", "GRU", 10);
    c.flush(false); // offline
    await tick();
    c.record("rtt", "org:a", "GRU", 10); // measured meanwhile: added to what came back
    c.record("ack", "org:a", "GRU", 10);
    answer = async () => new Response(null, { status: 503 });
    c.flush(false);
    await tick();
    answer = async () => new Response(null, { status: 429 });
    c.flush(false);
    await tick();
    answer = async () => new Response(null, { status: 204 });
    c.flush(false);
    await tick();
    expect(bodies.map(counts)).toEqual([{ rtt: 2 }, { rtt: 3, ack: 1 }, { rtt: 3, ack: 1 }, { rtt: 3, ack: 1 }]);
    c.flush(false); // sent: nothing left
    expect(bodies).toHaveLength(4);
    // Refused by the server (a 4xx): not sent again.
    c.record("connect", "org:a", "GRU", 10);
    answer = async () => new Response(null, { status: 400 });
    c.flush(false);
    await tick();
    c.flush(false);
    expect(bodies.map(counts).slice(4)).toEqual([{ connect: 1 }]);
    // A fetch that throws at once: kept too.
    c.record("connect", "org:a", "GRU", 10);
    answer = () => {
      throw new TypeError("blocked");
    };
    c.flush(false);
    answer = async () => new Response(null, { status: 204 });
    c.flush(false);
    await tick();
    expect(bodies.map(counts).slice(5)).toEqual([{ connect: 1 }, { connect: 1 }]);
    c.stop();
  });

  it("the collector: a histogram that could never fit a batch is dropped instead of blocking the rest", () => {
    const sent: string[] = [];
    const c = new RumCollector("https://x/api/_ember/rum", { sampleRate: 1, flushIntervalMs: 1e9 }, (async (_u: unknown, init?: RequestInit) => (sent.push(String(init?.body)), new Response(null, { status: 204 }))) as typeof fetch);
    // record() keeps 41 buckets at most per histogram; a bigger one (more than the server's 200) stands for any
    // histogram over a batch's limits.
    const hist = (c as unknown as { hist: Map<string, { m: string; k: string; c: string; b: Map<number, number> }> }).hist;
    hist.set("rtt\nhuge\nGRU", { m: "rtt", k: "huge", c: "GRU", b: new Map(Array.from({ length: 250 }, (_, i) => [i, 1] as [number, number])) });
    c.record("ack", "org:a", "GRU", 10);
    c.flush(false);
    expect(sent.map(counts)).toEqual([{ ack: 1 }]);
    expect(hist.size).toBe(0);
    c.stop();
  });

  it("an ack mark goes when its mutation never gets mres (closed client), and the marks in flight are bounded", async () => {
    const server = messagesServer({ colo: "GRU" });
    const sink = withRumSink(server);
    const client = makeClient(server, { fetch: sink.fetch, rum: { sampleRate: 1 }, random: () => 0.01 });
    const marks = (client as unknown as { rumMutAt: Map<string, number> }).rumMutAt;
    const off = client.subscribe(api.messages.list, { channel: "c" }, { shard: SHARD }, () => {});
    await until(() => client.connectionState().connected);
    // The shard never sees them: no mres.
    server.open()[0]!.holdIncoming();
    const settled: Array<Promise<unknown>> = [];
    for (let i = 0; i < 300; i++) settled.push(client.mutation(api.messages.send, { channel: "c", body: `m${i}` }, { shard: SHARD }).catch(() => undefined));
    await until(() => marks.size > 0);
    await tick(5);
    expect(marks.size).toBe(256);
    off();
    client.close();
    expect(marks.size).toBe(0);
    await Promise.all(settled);
  });

  it("a resume answered unchanged is no first value", async () => {
    const server = messagesServer({ colo: "GRU", ident: true });
    server.mutateDirect(SHARD, "messages:send", { channel: "c", body: "hello" });
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const sessionPosts = async () => {
      const sink = withRumSink(server);
      const client = makeClient(server, { fetch: sink.fetch, rum: { sampleRate: 1 }, random: () => 0.01, snapshotCache: keyValueSnapshotCache(store) });
      let seen = false;
      const off = client.subscribe(api.messages.list, { channel: "c" }, { shard: SHARD }, (x) => {
        if (x.status === "success" && !x.source) seen = true;
      });
      await until(() => seen);
      await tick(5);
      off();
      client.close();
      return sink.posts.flatMap((p) => Object.keys(counts(p.body)));
    };
    // The first visit downloads the value; the second resumes from the cache (`unchanged`).
    expect(await sessionPosts()).toContain("first_value");
    const second = await sessionPosts();
    expect(second).toContain("connect");
    expect(second).not.toContain("first_value");
  });
});
