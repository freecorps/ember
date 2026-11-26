// Real-user latency (contracts.md "RUM"), opt-in: one draw per client; a drawn session announces feature "rum",
// measures connect / rtt / ack / first_value per shard kind and DO colo, and posts small histograms to
// /api/_ember/rum (on close here). Nothing personal: no shard key, client id, args or user.
import { describe, expect, it } from "vitest";
import { anyApi, type FunctionReference } from "../src/index.ts";
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
    expect(c.take()).not.toBeNull();
    c.stop();
    expect(sent.length).toBe(0); // stop() flushed nothing left
  });
});
