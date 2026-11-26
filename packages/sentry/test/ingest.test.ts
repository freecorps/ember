// The envelope endpoint as an SDK sees it: auth (X-Sentry-Auth, ?sentry_key=, the envelope's dsn), Sentry-shaped
// responses (200 { id }, 401/403/404, 413, 429 with Retry-After and X-Sentry-Rate-Limits, 400, 415), and where each item
// goes (events to the queue, spilled to R2 when big; attachments and replays to R2; sessions and transactions to
// Analytics Engine). No shard is involved anywhere here.
import { describe, expect, it } from "vitest";
import { gunzip, gzip, serializeEnvelope, utf8 } from "../src/envelope.ts";
import { handleIngest, keyFromRequest, TokenBuckets, type IngestDeps, type QueuedEvent } from "../src/ingest.ts";
import type { SentryInstallConfig } from "../src/config.ts";
import { FakeAnalytics, FakeQueue, KEY, MemoryR2 } from "./fakes.ts";

const URL0 = "https://app.test/sentry/api/web/envelope/";
const NOW = Date.UTC(2026, 10, 20, 12);

function setup(config: Partial<SentryInstallConfig> = {}, envExtra: Record<string, unknown> = {}) {
  const queue = new FakeQueue<QueuedEvent>();
  const bucket = new MemoryR2();
  const ae = new FakeAnalytics();
  const env = { EMBER_Q_SENTRY_EVENTS: queue, EMBER_FILES: bucket, EMBER_SENTRY_SENTRY_AE: ae, ...envExtra };
  const deps: IngestDeps = { config: { projects: [{ id: "web", keys: [KEY] }], ...config }, install: "sentry", env, now: NOW, random: () => 0.5, buckets: new TokenBuckets() };
  return { queue, bucket, ae, env, deps };
}

const ev = (extra: Record<string, unknown> = {}) => ({ event_id: "0123456789abcdef0123456789abcdef", level: "error", exception: { values: [{ type: "TypeError", value: "x is undefined" }] }, ...extra });
const envelope = (items: Parameters<typeof serializeEnvelope>[1], header: Record<string, unknown> = { event_id: "0123456789abcdef0123456789abcdef" }) => serializeEnvelope(header, items);
const post = (body: Uint8Array | string, headers: Record<string, string> = {}, url = `${URL0}?sentry_key=${KEY}&sentry_version=7`) => new Request(url, { method: "POST", body: body as BodyInit, headers });

describe("ingest: auth", () => {
  it("accepts the key in X-Sentry-Auth, in ?sentry_key= and in the envelope's dsn", async () => {
    const { deps, queue } = setup();
    const body = envelope([{ header: { type: "event" }, payload: ev() }]);
    const viaHeader = await handleIngest(post(body, { "x-sentry-auth": `Sentry sentry_version=7, sentry_client=sentry.javascript.react/9.0.0, sentry_key=${KEY}` }, URL0), deps);
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.json()).toEqual({ id: "0123456789abcdef0123456789abcdef" });
    expect((await handleIngest(post(body), deps)).status).toBe(200);
    const withDsn = envelope([{ header: { type: "event" }, payload: ev() }], { dsn: `https://${KEY}@app.test/sentry/web` });
    expect((await handleIngest(post(withDsn, {}, URL0), deps)).status).toBe(200);
    expect(queue.sent).toHaveLength(3);
    expect(keyFromRequest(new Request(URL0, { headers: { "x-sentry-auth": "Sentry sentry_key=abc,sentry_secret=s" } }))).toBe("abc");
  });

  it("a wrong key is 403 before the body is read; no key at all is 401; an unknown project is 404", async () => {
    const { deps, queue } = setup();
    const body = envelope([{ header: { type: "event" }, payload: ev() }]);
    let read = false;
    const stream = new ReadableStream({ pull: (c) => { read = true; c.enqueue(body); c.close(); } }, { highWaterMark: 0 });
    const bad = await handleIngest(new Request(`${URL0}?sentry_key=wrongkey123`, { method: "POST", body: stream, duplex: "half" } as RequestInit), deps);
    expect(bad.status).toBe(403);
    expect(read).toBe(false);
    expect(bad.headers.get("x-sentry-error")).toBe("invalid sentry_key");
    expect((await handleIngest(post(body, {}, URL0), deps)).status).toBe(401);
    expect((await handleIngest(post(body, {}, `https://app.test/sentry/api/nope/envelope/?sentry_key=${KEY}`), deps)).status).toBe(404);
    expect(queue.sent).toHaveLength(0);
  });

  it("CORS: a preflight answers 204; responses expose the rate-limit headers", async () => {
    const { deps } = setup();
    const pre = await handleIngest(new Request(URL0, { method: "OPTIONS" }), deps);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-sentry-auth");
    const ok = await handleIngest(post(envelope([{ header: { type: "event" }, payload: ev() }])), deps);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(ok.headers.get("access-control-expose-headers")).toContain("x-sentry-rate-limits");
  });
});

describe("ingest: responses", () => {
  it("429 with Retry-After and X-Sentry-Rate-Limits once the per-isolate bucket is empty", async () => {
    const { deps, ae } = setup({ rateLimit: { perMinute: 60, burst: 2 } });
    const body = envelope([{ header: { type: "event" }, payload: ev() }]);
    expect((await handleIngest(post(body), deps)).status).toBe(200);
    expect((await handleIngest(post(body), deps)).status).toBe(200);
    const r = await handleIngest(post(body), deps);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
    expect(r.headers.get("x-sentry-rate-limits")).toBe("1::project:ember_rate_limit");
    expect(ae.of("dropped").map((p) => p.blobs?.[4])).toEqual(["rate_limited"]);
    // A minute later the bucket has refilled.
    expect((await handleIngest(post(body), { ...deps, now: NOW + 60_000 })).status).toBe(200);
  });

  it("the Rate Limiting binding, when configured, decides instead (keyed by project)", async () => {
    const keys: string[] = [];
    const binding = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: keys.length < 2 }) };
    const { deps } = setup({ rateLimit: { binding: "SENTRY_RL" } }, { SENTRY_RL: binding });
    const body = envelope([{ header: { type: "event" }, payload: ev() }]);
    expect((await handleIngest(post(body), deps)).status).toBe(200);
    const r = await handleIngest(post(body), deps);
    expect([r.status, r.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(keys).toEqual(["sentry:sentry:web", "sentry:sentry:web"]);
  });

  it("413: by content-length, by bytes read, after decompression, and for one oversized event", async () => {
    const { deps } = setup({ limits: { maxEnvelopeBytes: 1000, maxDecompressedBytes: 4000, maxEventBytes: 500 } });
    const big = new Uint8Array(2000);
    expect((await handleIngest(post(big, { "content-length": "2000" }), deps)).status).toBe(413);
    const streamed = new ReadableStream({ start: (c) => { c.enqueue(big); c.close(); } });
    expect((await handleIngest(new Request(`${URL0}?sentry_key=${KEY}`, { method: "POST", body: streamed, duplex: "half" } as RequestInit), deps)).status).toBe(413);
    const bomb = await gzip(envelope([{ header: { type: "attachment" }, payload: new Uint8Array(10_000) }]));
    expect(bomb.length).toBeLessThan(1000);
    expect((await handleIngest(post(bomb, { "content-encoding": "gzip" }), deps)).status).toBe(413);
    const fat = envelope([{ header: { type: "event" }, payload: ev({ extra: { pad: "x".repeat(600) } }) }]);
    expect((await handleIngest(post(fat), deps)).status).toBe(413);
  });

  it("400 for a malformed envelope or event payload, 415 for an unknown encoding, 405 for GET", async () => {
    const { deps } = setup();
    expect((await handleIngest(post("not an envelope"), deps)).status).toBe(400);
    expect((await handleIngest(post('{}\n{"type":"event"}\n{broken\n'), deps)).status).toBe(400);
    expect((await handleIngest(post(envelope([{ header: { type: "event" }, payload: ev() }]), { "content-encoding": "br" }), deps)).status).toBe(415);
    expect((await handleIngest(new Request(URL0), deps)).status).toBe(405);
  });

  it("a gzip body is accepted like the official SDKs send it", async () => {
    const { deps, queue } = setup();
    const r = await handleIngest(post(await gzip(envelope([{ header: { type: "event" }, payload: ev() }])), { "content-encoding": "gzip" }), deps);
    expect(r.status).toBe(200);
    expect(queue.sent[0]!.event!.exception!.values![0]!.type).toBe("TypeError");
  });
});

describe("ingest: items", () => {
  it("events go to the queue (one sendBatch), sessions and kept transactions to Analytics Engine", async () => {
    const { deps, queue, ae } = setup({ projects: [{ id: "web", keys: [KEY], transactionSampleRate: 1 }] });
    const body = envelope([
      { header: { type: "event" }, payload: ev({ event_id: "a".repeat(32) }) },
      { header: { type: "event" }, payload: ev({ event_id: "b".repeat(32) }) },
      { header: { type: "session" }, payload: { sid: "s1", init: true, status: "ok", attrs: { release: "1.0.0", environment: "prod" } } },
      { header: { type: "session" }, payload: { sid: "s1", status: "crashed", errors: 1, attrs: { release: "1.0.0" } } },
      { header: { type: "sessions" }, payload: { aggregates: [{ started: "2026-01-01T00:00:00Z", exited: 8, crashed: 1, errored: 1 }], attrs: { release: "1.0.0" } } },
      { header: { type: "transaction" }, payload: { event_id: "c".repeat(32), transaction: "GET /", start_timestamp: 100, timestamp: 100.25, contexts: { trace: { op: "http.server", status: "ok" } } } },
      { header: { type: "client_report" }, payload: { discarded_events: [] } },
    ]);
    const r = await handleIngest(post(body), deps);
    expect(r.status).toBe(200);
    expect(queue.calls).toBe(1);
    expect(queue.sent.map((m) => [m.project, m.id, m.receivedAt])).toEqual([
      ["web", "a".repeat(32), NOW],
      ["web", "b".repeat(32), NOW],
    ]);
    expect(ae.of("session").map((p) => [p.blobs?.[4], p.doubles])).toEqual([
      ["ok", [1, 0, 0, 0, 0]],
      ["crashed", [0, 1, 0, 0, 0]],
      ["aggregate", [10, 1, 1, 0, 8]],
    ]);
    expect(ae.of("transaction").map((p) => [p.blobs?.[4], p.blobs?.[5], p.doubles])).toEqual([["GET /", "http.server", [1, 250]]]);
  });

  it("transactions are dropped by default; events are sampled by sampleRate", async () => {
    const { deps, queue, ae } = setup({ projects: [{ id: "web", keys: [KEY], sampleRate: 0.25 }] });
    const body = envelope([
      { header: { type: "event" }, payload: ev() },
      { header: { type: "transaction" }, payload: { transaction: "GET /" } },
    ]);
    expect((await handleIngest(post(body), { ...deps, random: () => 0.5 })).status).toBe(200);
    expect(queue.sent).toHaveLength(0);
    expect(ae.of("dropped").map((p) => [p.blobs?.[4], p.blobs?.[5]])).toEqual([
      ["sampled", "event"],
      ["sampled", "transaction"],
    ]);
    await handleIngest(post(body), { ...deps, random: () => 0.1 });
    expect(queue.sent).toHaveLength(1);
  });

  it("attachments and replays go gzipped to date-partitioned R2 keys; an oversized attachment is dropped", async () => {
    const { deps, bucket } = setup({ limits: { maxAttachmentBytes: 64 } });
    const recording = new Uint8Array([...utf8.encode('{"segment_id":3}\n'), 1, 2, 3]);
    const body = envelope([
      { header: { type: "event" }, payload: ev() },
      { header: { type: "attachment", filename: "log.txt", content_type: "text/plain" }, payload: "line 1\nline 2" },
      { header: { type: "attachment", filename: "huge.bin" }, payload: new Uint8Array(100) },
      { header: { type: "replay_event" }, payload: { replay_id: "r".repeat(32), segment_id: 3, type: "replay_event" } },
      { header: { type: "replay_recording" }, payload: recording },
    ]);
    expect((await handleIngest(post(body), deps)).status).toBe(200);
    expect(bucket.keys()).toEqual([
      "sentry/sentry/attachments/2026-11-20/web/0123456789abcdef0123456789abcdef/0-log.txt.gz",
      `sentry/sentry/replays/2026-11-20/web/${"r".repeat(32)}/3-event.gz`,
      `sentry/sentry/replays/2026-11-20/web/${"r".repeat(32)}/3-recording.gz`,
    ]);
    const att = bucket.objects.get(bucket.keys()[0]!)!;
    expect(utf8.decode(await gunzip(att.bytes))).toBe("line 1\nline 2");
    expect(att.contentEncoding).toBe("gzip");
    expect([...(await gunzip(bucket.objects.get(bucket.keys()[2]!)!.bytes))]).toEqual([...recording]);
  });

  it("an event too big for a queue message is spilled to R2 and the message carries the key", async () => {
    const { deps, queue, bucket } = setup();
    const big = ev({ breadcrumbs: { values: Array.from({ length: 2000 }, (_, i) => ({ message: `crumb ${i} ${"x".repeat(60)}` })) } });
    expect((await handleIngest(post(envelope([{ header: { type: "event" }, payload: big }])), deps)).status).toBe(200);
    const [m] = queue.sent;
    expect(m!.event).toBeUndefined();
    expect(m!.spill).toBe("sentry/sentry/spill/2026-11-20/web/0123456789abcdef0123456789abcdef.json.gz");
    const stored = JSON.parse(utf8.decode(await gunzip(bucket.objects.get(m!.spill!)!.bytes)));
    expect(stored.breadcrumbs.values).toHaveLength(2000);
  });

  it("without the queue binding the messages go to the inline consumer", async () => {
    const { deps } = setup();
    const got: QueuedEvent[][] = [];
    const env = { ...deps.env };
    delete (env as Record<string, unknown>).EMBER_Q_SENTRY_EVENTS;
    const r = await handleIngest(post(envelope([{ header: { type: "event" }, payload: ev() }])), { ...deps, env, inline: async (m) => void got.push(m) });
    expect(r.status).toBe(200);
    expect(got).toHaveLength(1);
  });
});
