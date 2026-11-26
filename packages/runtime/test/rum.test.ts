// Real-user latency (rum.ts, contracts.md "RUM"): the public batch endpoint (validation, size limit, Analytics Engine
// only, no personal data, CORS), the bucket formula, and the shard's colo for sockets that negotiated "rum".
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setMetricsSink, type AnalyticsEngineDatasetLike } from "../src/metrics.ts";
import { parseRumBatch, rumBucket, rumBucketMs, RUM_MAX_BYTES, writeRum } from "../src/rum.ts";
import { COLO_RETRY_MS, ColoCache, probeColo } from "../src/colo.ts";
import type { Shard } from "../src/shard.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { connect, hello, is, shardStub } from "./helpers.ts";

type Point = Parameters<AnalyticsEngineDatasetLike["writeDataPoint"]>[0] & {};
function sink() {
  const points: Point[] = [];
  setMetricsSink({ writeDataPoint: (p) => void points.push(p ?? {}) });
  return points;
}
afterEach(() => setMetricsSink(null));

const batch = (h: unknown = [{ m: "rtt", k: "org", c: "GRU", b: [[12, 3], [13, 1]] }], extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, r: 0.25, p: "web", s: "0.10.0", h, ...extra });
const post = (body: string, headers: Record<string, string> = {}) => SELF.fetch("http://ember/api/_ember/rum", { method: "POST", headers: { "content-type": "text/plain", ...headers }, body });

describe("RUM batches (POST /api/_ember/rum)", () => {
  it("writes one Analytics Engine point per bucket, weighted by the sample rate, with no token and nothing personal", async () => {
    const points = sink();
    const res = await post(batch(), { "cf-connecting-ip": "203.0.113.9", authorization: "Bearer someone" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(points).toHaveLength(2);
    const [p] = points;
    expect(p!.indexes).toEqual(["test/test"]);
    // blob5 "rum"; metric, platform, SDK; shard kind (never its key); country and entry colo from request.cf; DO colo.
    expect(p!.blobs!.slice(0, 9)).toEqual(["test", "test", "org", "rtt", "rum", "web", "0.10.0", "org", ""]);
    expect(p!.blobs![11]).toBe("GRU");
    expect(p!.doubles).toEqual([rumBucketMs(12), 0, 0, 0, 0, 0, 0, 0, 0, 12, 3, 4]);
    expect(JSON.stringify(points)).not.toContain("203.0.113.9");
    expect(JSON.stringify(points)).not.toContain("someone");
  });

  it("answers the CORS preflight; other methods are refused", async () => {
    const pre = await SELF.fetch("http://ember/api/_ember/rum", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    expect([pre.status, pre.headers.get("access-control-allow-methods")]).toEqual([204, "POST"]);
    expect((await SELF.fetch("http://ember/api/_ember/rum")).status).toBe(405);
  });

  it("refuses invalid batches whole (400 bad_rum), and large ones (413) before parsing", async () => {
    const points = sink();
    const bad = [
      "not json",
      "[]",
      JSON.stringify({ v: 2, r: 1, p: "web", h: [] }),
      batch(undefined, { r: 0 }),
      batch(undefined, { r: 2 }),
      batch(undefined, { p: "windows" }),
      batch([{ m: "cpu", k: "org", c: "", b: [[1, 1]] }]),
      batch([{ m: "rtt", k: "org:acme", c: "", b: [[1, 1]] }]), // a shard key, never sent
      batch([{ m: "rtt", k: "org", c: "gru", b: [[1, 1]] }]),
      batch([{ m: "rtt", k: "org", c: "", b: [[41, 1]] }]),
      batch([{ m: "rtt", k: "org", c: "", b: [[1, 0]] }]),
      batch([{ m: "rtt", k: "org", c: "", b: [[1.5, 1]] }]),
      batch([{ m: "rtt", k: "org", c: "", b: [] }]),
      batch(Array.from({ length: 33 }, () => ({ m: "rtt", k: "org", c: "", b: [[1, 1]] }))),
    ];
    for (const body of bad) {
      const res = await post(body);
      expect([body.slice(0, 60), res.status]).toEqual([body.slice(0, 60), 400]);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_rum");
    }
    expect((await post("x".repeat(RUM_MAX_BYTES + 1))).status).toBe(413);
    expect(points).toEqual([]);
    // Too many buckets in one batch (Analytics Engine takes 250 points per invocation).
    expect(parseRumBatch(batch(Array.from({ length: 6 }, () => ({ m: "ack", k: "org", c: "", b: Array.from({ length: 40 }, (_, i) => [i, 1]) }))))).toMatch(/up to 200 buckets/);
  });

  it("without the binding the batch is accepted and dropped; EMBER_RUM=0 turns the endpoint off", async () => {
    expect((await post(batch())).status).toBe(204);
    const r = parseRumBatch(batch());
    expect(typeof r).toBe("object");
    expect(writeRum(null, {}, r as Exclude<typeof r, string>, { country: "BR", entry: "GRU" })).toBe(0);
    const { handleRum } = await import("../src/rum.ts");
    expect((await handleRum(new Request("http://x/api/_ember/rum", { method: "POST", body: batch() }), { EMBER_RUM: "0" })).status).toBe(404);
  });

  it("buckets are ~√2 wide on a log scale", () => {
    expect([0, 0.3, 1, 10, 100, 1000, 1e9].map(rumBucket)).toEqual([0, 0, 2, 6, 13, 19, 40]);
    for (const ms of [1, 7, 45, 180, 900]) {
      const mid = rumBucketMs(rumBucket(ms));
      expect(mid / ms).toBeGreaterThan(0.7);
      expect(mid / ms).toBeLessThan(1.45);
    }
  });
});

describe("the shard's colo (feature rum)", () => {
  it("ready carries it only for a socket that negotiated rum", async () => {
    // The binding EMBER_COLO = "TST" (packages/runtime/vitest.config.ts) stands for the /cdn-cgi/trace probe here: the
    // object knows its colo without one, so even the first socket gets it in `ready`.
    expect((env as { EMBER_COLO?: unknown }).EMBER_COLO).toBe("TST");
    const a = await connect("rum:colo");
    const ready = await hello(a, undefined, undefined, ["rum", "batch"]);
    expect(ready.colo).toBe("TST");
    expect(ready.features).toContain("rum");
    const b = await connect("rum:colo");
    expect((await hello(b, undefined, undefined, ["rum"])).colo).toBe("TST");
    const c = await connect("rum:colo");
    const plain = await hello(c);
    expect(plain.colo).toBeUndefined();
    expect(plain.features ?? []).not.toContain("rum");
    a.close();
    b.close();
    c.close();
  });

  it("probe: EMBER_COLO, none locally, else the trace's colo line (failures are unknown, never thrown)", async () => {
    expect(await probeColo({ EMBER_COLO: "GRU" })).toBe("GRU");
    expect(await probeColo({ EMBER_COLO: "nope" })).toBeNull();
    expect(await probeColo({ EMBER_ENV: "local" }, () => Promise.reject(new Error("not called")))).toBeNull();
    const seen: string[] = [];
    const trace = (async (u: RequestInfo | URL) => (seen.push(String(u)), new Response("fl=1\nh=www.cloudflare.com\nip=203.0.113.9\ncolo=MIA\nloc=BR\n"))) as typeof fetch;
    expect(await probeColo({}, trace)).toBe("MIA");
    expect(seen).toEqual(["https://www.cloudflare.com/cdn-cgi/trace"]);
    expect(await probeColo({}, (async () => new Response("nope", { status: 500 })) as typeof fetch)).toBeNull();
    expect(await probeColo({}, (async () => Promise.reject(new Error("offline"))) as typeof fetch)).toBeNull();
  });

  it("a failed probe is not kept: a later ask tries again after a backoff (one probe at a time), a found colo stays", async () => {
    let now = 1_000;
    let answer: () => Promise<Response> = async () => Promise.reject(new Error("offline"));
    let calls = 0;
    const cache = new ColoCache({}, (async () => (calls++, answer())) as typeof fetch, () => now);
    const found: string[] = [];
    const onFound = (c: string) => void found.push(c);
    expect(cache.get(onFound)).toBeNull();
    expect(cache.get(onFound)).toBeNull(); // one probe at a time
    await cache.settled();
    expect(calls).toBe(1);
    // Backing off: no probe before the wait.
    now += COLO_RETRY_MS - 1;
    expect(cache.get(onFound)).toBeNull();
    expect(calls).toBe(1);
    // Then another try (failing again: the wait doubles).
    now += 1;
    answer = async () => new Response("nope", { status: 503 });
    cache.get(onFound);
    await cache.settled();
    expect(calls).toBe(2);
    now += COLO_RETRY_MS;
    cache.get(onFound);
    expect(calls).toBe(2);
    now += COLO_RETRY_MS;
    answer = async () => new Response("colo=MIA\n");
    expect(cache.get(onFound)).toBeNull();
    await cache.settled();
    expect([calls, found]).toEqual([3, ["MIA"]]);
    // Found: kept, no more probes.
    now += 1e9;
    expect(cache.get(onFound)).toBe("MIA");
    expect(calls).toBe(3);
    // A fetch that throws at once is a failure too, never an unhandled rejection.
    const sync = new ColoCache({}, (() => {
      throw new TypeError("no fetch here");
    }) as typeof fetch, () => now);
    expect(sync.get(onFound)).toBeNull();
    await sync.settled();
    // The environment settles it without a probe.
    expect(new ColoCache({ EMBER_ENV: "local" }, (() => Promise.reject(new Error("not called"))) as typeof fetch).get(onFound)).toBeNull();
    expect(new ColoCache({ EMBER_COLO: "GRU" }).get(onFound)).toBe("GRU");
  });

  it("a second hello (without rum) is refused: the socket keeps what its hello negotiated, and only that", async () => {
    const shard = "rum:rehello";
    const a = await connect(shard);
    // Even sent at once, both verifying a token, the second is refused: a socket negotiates its features once.
    a.send({ t: "hello", clientId: "c1", protocol: 1, token: "good:ana", features: ["rum"] });
    a.send({ t: "hello", clientId: "c1", protocol: 1, token: "good:ana" });
    const first = await a.waitFor<Extract<ServerMessage, { t: "ready" }>>(is("ready"));
    expect(first.features).toEqual(["rum"]);
    expect(await a.waitFor(is("err"))).toMatchObject({ code: "duplicate_hello" });
    const b = await connect(shard);
    await hello(b, "c2", "good:ana");
    const flags = await runInDurableObject(shardStub(shard), async (_inst: Shard, state) =>
      state.getWebSockets().map((ws) => (ws.deserializeAttachment() as { clientId?: string; rum?: true }))
        .map((x) => [x.clientId, x.rum ?? false])
        .sort(),
    );
    expect(flags).toEqual([["c1", true], ["c2", false]]);
    a.close();
    b.close();
  });
});
