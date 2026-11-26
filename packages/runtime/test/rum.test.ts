// Real-user latency (rum.ts, contracts.md "RUM"): the public batch endpoint (validation, size limit, Analytics Engine
// only, no personal data, CORS), the bucket formula, and the shard's colo for sockets that negotiated "rum".
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setMetricsSink, type AnalyticsEngineDatasetLike } from "../src/metrics.ts";
import { parseRumBatch, rumBucket, rumBucketMs, RUM_MAX_BYTES, writeRum } from "../src/rum.ts";
import { probeColo } from "../src/colo.ts";
import { connect, hello, is } from "./helpers.ts";

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
    const a = await connect("rum:colo");
    const ready = await hello(a, undefined, undefined, ["rum", "batch"]);
    // EMBER_COLO (vitest config) stands for the /cdn-cgi/trace probe; first socket: the probe answers after ready.
    const colo = ready.colo ?? ((await a.waitFor(is("colo"))) as { colo: string }).colo;
    expect(colo).toBe("TST");
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
});
