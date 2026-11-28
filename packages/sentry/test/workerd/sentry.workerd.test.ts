/**
 * The sentry component in workerd, on the real runtime: an SDK-shaped envelope over HTTP, then the Queue batch.
 *   - ingest writes nothing to any Durable Object (no shard exists after it, and no execution logs rows);
 *   - the consumer batch writes one row per issue (measured from the runtime's own execution trace);
 *   - R2 holds the gzipped payloads (the batch object, the attachment);
 *   - source maps uploaded over the admin routes symbolicate the next event.
 */
import { createExecutionContext, createMessageBatch, env, getQueueResult, listDurableObjectIds, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { KEY, probes } from "./worker.ts";
import { gzip, serializeEnvelope } from "../../src/envelope.ts";
import { sha256Hex } from "../../src/index.ts";

const QUEUE = "ember-it-test-sentry-events";
const stub = () => env.SHARD.get(env.SHARD.idFromName("global:main"));

function errorEvent(type: string, i: number, extra: object = {}) {
  return {
    event_id: `${type.toLowerCase().padEnd(8, "0").slice(0, 8)}${String(i).padStart(24, "0")}`,
    level: "error",
    platform: "javascript",
    release: "1.0.0",
    exception: { values: [{ type, value: `failed #${i}`, stacktrace: { frames: [{ filename: "app.js", abs_path: "https://app.test/app.js", function: "run", lineno: 3, colno: 7, in_app: true }] } }] },
    breadcrumbs: { values: [{ timestamp: 1, category: "ui.click", message: `click ${i}` }] },
    ...extra,
  };
}

/** Executions the runtime traced (`EMBER_TRACE=1`: one `ember:exec {...}` line each, with rows read and written). */
function traceLog() {
  const rows: Array<{ fn: string; kind: string; rowsWritten: number }> = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    const s = String(a[0]);
    if (s.startsWith("ember:exec ")) rows.push(JSON.parse(s.slice("ember:exec ".length)));
  });
  return { rows, spy };
}

afterEach(() => vi.restoreAllMocks());

async function deliver(bodies: unknown[]) {
  const batch = createMessageBatch(QUEUE, bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch as never, env as never, ctx);
  return getQueueResult(batch, ctx);
}

describe("sentry in workerd", () => {
  it("ingest over HTTP writes 0 rows to any Durable Object; the batch writes one row per issue; R2 holds the gzip", async () => {
    const { rows } = traceLog();
    // 30 events of 2 issues, in 3 gzip envelopes (as @sentry/react sends them, key in the query), plus an attachment.
    for (let n = 0; n < 3; n++) {
      const items = Array.from({ length: 10 }, (_, i) => ({ header: { type: "event" }, payload: errorEvent(i % 2 ? "RangeError" : "TypeError", n * 10 + i) }));
      const body = await gzip(serializeEnvelope({ event_id: errorEvent("TypeError", n * 10).event_id, sent_at: new Date().toISOString() }, [...items, { header: { type: "attachment", filename: "state.json" }, payload: '{"cart":3}' }]));
      const res = await SELF.fetch(`http://ember/sentry/api/web/envelope/?sentry_key=${KEY}&sentry_version=7`, { method: "POST", body, headers: { "content-type": "application/x-sentry-envelope", "content-encoding": "gzip" } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { id: string }).id).toBe(errorEvent("TypeError", n * 10).event_id);
    }
    expect(probes.sent).toHaveLength(30);
    expect(probes.batches).toBe(3);
    // 0 rows at ingest: no shard was even created, and nothing traced wrote a row.
    expect(await listDurableObjectIds(env.SHARD)).toEqual([]);
    expect(rows.filter((r) => r.rowsWritten > 0)).toEqual([]);
    expect(rows.map((r) => r.fn)).toEqual(Array(3).fill("http:POST /sentry/api/*"));

    // The Queue delivers the 30 messages in one batch: one statement per issue.
    rows.length = 0;
    const result = await deliver(probes.sent.splice(0));
    expect(result.retryBatch.retry).toBe(false);
    const apply = rows.filter((r) => r.fn === "@sentry/lib:apply");
    expect(apply).toHaveLength(1);
    // DO SQLite counts index entries too: an issue row is the row and its 4 index entries (by_fingerprint, by_seen,
    // by_status_seen, by_release_seen). Two new issues: 2 × 5, whatever the 30 events.
    expect(apply[0]!.rowsWritten).toBe(2 * 5);
    const issues = await runInDurableObject(stub(), async (_o, state) => state.storage.sql.exec(`SELECT * FROM "sentry$issues"`).toArray());
    expect(issues).toHaveLength(2);

    // R2: the batch object (gzip), and the three attachments.
    const listed = await env.EMBER_FILES.list({ prefix: "sentry/sentry/" });
    const keys = listed.objects.map((o) => o.key);
    expect(keys.filter((k) => k.includes("/events/"))).toHaveLength(1);
    expect(keys.filter((k) => k.includes("/attachments/"))).toHaveLength(3);
    const obj = await env.EMBER_FILES.get(keys.find((k) => k.includes("/events/"))!);
    const head = new Uint8Array(await obj!.arrayBuffer()).slice(0, 2);
    expect([...head]).toEqual([0x1f, 0x8b]);
    expect(obj!.httpMetadata?.contentEncoding).toBe("gzip");

    // Updates: one event of one issue, then 40 events of both issues: the same cost per issue either way.
    rows.length = 0;
    await deliver([{ v: 1, project: "web", id: "f".repeat(32), receivedAt: Date.now(), event: errorEvent("TypeError", 99) }]);
    await deliver(Array.from({ length: 40 }, (_, i) => ({ v: 1, project: "web", id: `${i}`.padStart(32, "a"), receivedAt: Date.now(), event: errorEvent(i % 2 ? "RangeError" : "TypeError", 100 + i) })));
    const [one, forty] = rows.filter((r) => r.fn === "@sentry/lib:apply").map((r) => r.rowsWritten);
    // An update rewrites the row and the 3 indexes that hold lastSeen (by_fingerprint does not move): 4 per issue.
    expect([one, forty]).toEqual([4, 8]);
  });

  it("refusals are Sentry-shaped: a bad key 403, an oversized body 413", async () => {
    const bad = await SELF.fetch("http://ember/sentry/api/web/envelope/", { method: "POST", body: "{}\n", headers: { "x-sentry-auth": "Sentry sentry_key=wrongkey99, sentry_version=7" } });
    expect([bad.status, bad.headers.get("x-sentry-error")]).toEqual([403, "invalid sentry_key"]);
    const big = await SELF.fetch(`http://ember/sentry/api/web/envelope/?sentry_key=${KEY}`, { method: "POST", body: new Uint8Array(11 * 1024 * 1024) });
    expect(big.status).toBe(413);
    const pre = await SELF.fetch("http://ember/sentry/api/web/envelope/", { method: "OPTIONS" });
    expect([pre.status, pre.headers.get("access-control-allow-origin")]).toEqual([204, "*"]);
  });

  it("source maps uploaded over the admin routes symbolicate the next event; the latest event reads back from R2", async () => {
    const source = 'function greet(name) {\n  throw new Error("boom " + name);\n}\ngreet("x");\n';
    const map = JSON.stringify({ version: 3, sources: ["src/app.ts"], sourcesContent: [source], names: ["greet"], mappings: "AAAA,SAASA,KACP,MAAM,qBAERA" });
    const bytes = new TextEncoder().encode(map);
    const sha = await sha256Hex(bytes);
    const auth = { authorization: "Bearer upload-token-for-tests" };
    const manifest = { project: "web", release: "2.0.0", files: [{ name: "~/assets/app.min.js", sha256: sha, size: bytes.length }] };
    expect((await SELF.fetch("http://ember/sentry/admin/sourcemaps", { method: "POST", body: JSON.stringify(manifest) })).status).toBe(401);
    expect(await (await SELF.fetch("http://ember/sentry/admin/sourcemaps", { method: "POST", headers: auth, body: JSON.stringify(manifest) })).json()).toEqual({ ok: false, missing: [sha] });
    const put = await SELF.fetch(`http://ember/sentry/admin/sourcemaps/blobs/${sha}`, { method: "PUT", headers: { ...auth, "content-encoding": "gzip" }, body: await gzip(bytes) });
    expect(await put.json()).toEqual({ ok: true, sha256: sha, stored: true });
    expect(await (await SELF.fetch(`http://ember/sentry/admin/sourcemaps/blobs/${"0".repeat(64)}`, { method: "PUT", headers: auth, body: bytes })).json()).toMatchObject({ error: { code: "hash_mismatch" } });
    expect(await (await SELF.fetch("http://ember/sentry/admin/sourcemaps", { method: "POST", headers: auth, body: JSON.stringify(manifest) })).json()).toEqual({ ok: true, added: 1, files: 1 });

    const minified = { event_id: "e".repeat(32), release: "2.0.0", exception: { values: [{ type: "Error", value: "boom x", stacktrace: { frames: [{ abs_path: "https://cdn.test/assets/app.min.js", lineno: 1, colno: 42 }, { abs_path: "https://cdn.test/assets/app.min.js", function: "g", lineno: 1, colno: 21 }] } }] } };
    const res = await SELF.fetch(`http://ember/sentry/api/web/envelope/?sentry_key=${KEY}`, { method: "POST", body: serializeEnvelope({ event_id: minified.event_id }, [{ header: { type: "event" }, payload: minified }]) });
    expect(res.status).toBe(200);
    await deliver(probes.sent.splice(0));
    const issue = await runInDurableObject(stub(), async (_o, state) => state.storage.sql.exec(`SELECT * FROM "sentry$issues" WHERE "release" = '2.0.0'`).toArray()[0]);
    expect(JSON.stringify(issue)).toContain("at greet (src/app.ts:2:9)");
  });

  it("defineApp({ onError }): Ember's unhandled errors (mutation, query, action) become events; app errors and refusals do not", async () => {
    probes.sent.length = 0;
    probes.reports.length = 0;
    const call = (kind: string, fn: string, args: object = {}) => SELF.fetch(`http://ember/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard: "global:main" }) });
    // The caller's answer is what it was without the hook.
    const m = await call("mutation", "boom:mutation");
    expect(((await m.json()) as { ok: boolean; error: { code: string } }).error.code).toBe("Error");
    // Bodies read to the end (the report does not depend on it: shards report after answering, through waitUntil).
    await (await call("query", "boom:query")).text();
    const a = (await (await call("action", "boom:action")).json()) as { ok: boolean };
    expect(a.ok).toBe(false);
    await (await call("mutation", "boom:appError")).text();
    await (await call("mutation", "boom:validated", { n: "x" })).text();
    await vi.waitFor(() => expect(probes.reports.map((r) => `${r.kind} ${r.fn}`).sort()).toEqual(["action boom:action", "mutation boom:mutation", "query boom:query"]), { timeout: 5000 });
    const action = probes.reports.find((r) => r.kind === "action")!;
    expect(action.stack).toContain("TypeError");
    expect(probes.reports.find((r) => r.kind === "mutation")).toMatchObject({ shard: "global:main", code: "Error", message: expect.stringContaining("null") });
    // One event per report, on the sentry queue: grouped by the function and tagged.
    await vi.waitFor(() => expect(probes.sent).toHaveLength(3));
    const ev = probes.sent.find((q) => (q.event?.tags as Record<string, string> | undefined)?.["ember.function"] === "boom:mutation")!;
    expect(ev.event).toMatchObject({ release: "api@1", fingerprint: ["{{ default }}", "boom:mutation"], transaction: "boom:mutation", tags: { "ember.kind": "mutation", "ember.shard": "global:main" } });
    // The consumer groups them into three issues.
    await deliver(probes.sent.splice(0));
    const n = await runInDurableObject(stub(), async (_o, state) => state.storage.sql.exec(`SELECT COUNT(*) AS n FROM "sentry$issues" WHERE "release" = 'api@1'`).one().n);
    expect(n).toBe(3);
  });

  it("onError hears of a lazy action whose module fails to load, and of an HTTP route's throw without delaying its 500", async () => {
    probes.sent.length = 0;
    probes.reports.length = 0;
    probes.httpReportsDone = 0;
    const r = await SELF.fetch("http://ember/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "lazy:broken", args: {}, shard: "global:main" }) });
    expect(((await r.json()) as { ok: boolean }).ok).toBe(false);
    await vi.waitFor(() => expect(probes.reports.map((x) => `${x.kind} ${x.fn}`)).toContain("action lazy:broken"));
    expect(probes.reports.find((x) => x.fn === "lazy:broken")!.message).toContain("the module failed to load");
    // The route's onError takes a second: the 500 is back while it still runs (waitUntil), then it finishes.
    const res = await SELF.fetch("http://ember/hooks/boom", { method: "POST" });
    expect(res.status).toBe(500);
    await res.text();
    expect(probes.reports.find((x) => x.kind === "http")).toMatchObject({ fn: "http:POST /hooks/boom", message: "hook failed" });
    expect(probes.httpReportsDone).toBe(0);
    await vi.waitFor(() => expect(probes.httpReportsDone).toBe(1), { timeout: 5000 });
  });
});
