// The consumer over the real engine: grouping by fingerprint with one write per issue per batch (the rows written do
// not grow with the events), counts and first/last seen, a regression reopening a resolved issue, spikes, the
// throttles, alerts delivered through fakes of the email and push components and a signed webhook, source maps end to
// end, R2 retention and the dashboard's queries.
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeApp, defineSchema, unsafeRef } from "@freecorps/ember-server";
import { gzip, utf8 } from "../src/envelope.ts";
import { bumpHourly, consume as consumeBatch, sha256Hex, storageKeys, verifyWebhook, type QueuedEvent, type SentryAlert } from "../src/index.ts";
import { chunkLookups, LOOKUP_LIMITS, type ArtifactLookup } from "../src/consumer.ts";
import { checkConfig } from "../src/config.ts";
import { postWebhook } from "../src/alerts.ts";
import { MemoryR2 } from "./fakes.ts";
import { errorEvent, fn, harness } from "./harness.ts";

afterEach(() => vi.unstubAllGlobals());

const noAlerts = { projects: [{ id: "web", keys: ["pubkey0123456789"], alerts: false as const }] };

describe("grouping and the batched write", () => {
  it("N events of one issue: one row, one write per batch whatever N; count, first and last seen", async () => {
    const { t, consume, issues } = harness(noAlerts);
    const at = (m: number) => Date.UTC(2026, 10, 20, 11, m);
    const first = await t.measure(() => consume([errorEvent({ at: at(5) })]));
    expect(first.value).toMatchObject({ events: 1, issues: 1, created: 1 });
    const one = await t.measure(() => consume([errorEvent({ at: at(6) })]));
    const many = await t.measure(() => consume(Array.from({ length: 50 }, (_, i) => errorEvent({ at: at(10 + (i % 7)) }))));
    expect(many.value).toMatchObject({ events: 50, issues: 1, created: 0 });
    // 1 row written for 1 event and for 50: the one statement on the issue row.
    expect([first.stats.rowsWritten, one.stats.rowsWritten, many.stats.rowsWritten]).toEqual([1, 1, 1]);
    const [issue, ...rest] = await issues();
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ count: 52, firstSeen: at(5), lastSeen: at(16), status: "unresolved", level: "error", title: "TypeError: Cannot read properties of undefined (reading 'id')" });
    // An older event arriving late moves firstSeen back, not lastSeen.
    await consume([errorEvent({ at: at(1) })]);
    expect((await issues())[0]).toMatchObject({ count: 53, firstSeen: at(1), lastSeen: at(16) });
    // Two issues in one batch: two rows.
    const two = await t.measure(() => consume([...Array.from({ length: 20 }, () => errorEvent({ at: at(20) })), ...Array.from({ length: 20 }, () => errorEvent({ type: "RangeError", at: at(20) }))]));
    expect([two.value.issues, two.value.created, two.stats.rowsWritten]).toEqual([2, 1, 2]);
  });

  it("different exceptions or in-app frames are different issues; line numbers and messages with ids are not", async () => {
    const { consume, issues } = harness(noAlerts);
    const r = await consume([
      errorEvent({ line: 10 }),
      errorEvent({ line: 99 }),
      errorEvent({ value: "Cannot read properties of undefined (reading 'name')" }),
      errorEvent({ type: "RangeError" }),
      errorEvent({ fn: "saveUser" }),
      { message: "User 42 not found", level: "warning" },
      { message: "User 7 not found", level: "warning" },
    ]);
    expect(r).toMatchObject({ events: 7, issues: 4, created: 4 });
    const counts = (await issues()).map((i) => [i.title, i.count]).sort();
    // Titles are the latest event's: the first group's latest event read 'name'.
    expect(counts).toEqual([
      ["RangeError: Cannot read properties of undefined (reading 'id')", 1],
      ["TypeError: Cannot read properties of undefined (reading 'id')", 1],
      ["TypeError: Cannot read properties of undefined (reading 'name')", 3],
      ["User 7 not found", 2],
    ]);
  });

  it("a custom fingerprint groups as asked; projects never share issues", async () => {
    const { consume, issues } = harness({ projects: [{ id: "web", keys: ["pubkey0123456789"], alerts: false }, { id: "api", keys: ["pubkey0123456789"], alerts: false }] });
    await consume([{ ...errorEvent(), fingerprint: ["checkout"] }, { ...errorEvent({ type: "X" }), fingerprint: ["checkout"] }]);
    await consume([errorEvent()], "api");
    expect((await issues()).map((i) => i.count).sort()).toEqual([1, 2]);
  });

  it("the batch goes to R2 as one object; each event reads back by range; Analytics Engine gets a point per event", async () => {
    const { t, consume, issues, bucket, ae } = harness(noAlerts);
    const r = await consume([errorEvent({ release: "1.0.0" }), errorEvent({ release: "1.0.0", type: "RangeError" }), errorEvent({ release: "1.0.0" })]);
    expect(r.object).toMatch(/^sentry\/sentry\/events\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+\.ndjson\.gz$/);
    expect(bucket.keys("sentry/sentry/events/")).toEqual([r.object]);
    // The whole object is plain NDJSON once decompressed (gzip members concatenated: what zcat and zlib read; the
    // component itself only ever reads one member by range).
    const lines = gunzipSync(bucket.objects.get(r.object!)!.bytes).toString("utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const latest = (await t.action(fn("lib:latestEvent"), { id: (await issues()).find((i) => i.title.startsWith("RangeError"))!._id })) as { event: { exception: { values: Array<{ type: string }> } } };
    expect(latest.event.exception.values[0]!.type).toBe("RangeError");
    expect(ae.of("event").map((p) => [p.indexes, p.blobs?.slice(0, 5)])).toEqual(Array(3).fill([["web"], ["event", "web", "1.0.0", "", "error"]]));
  });

  it("a newer event with no raw pointer clears the issue's lastEvent; an older one leaves it", async () => {
    const { t, consume, issues } = harness(noAlerts);
    await consume([errorEvent({ at: Date.UTC(2026, 10, 20, 11) })]);
    const [issue] = await issues();
    const detail = (await t.query(fn("dashboard:issue"), { id: issue!._id })) as { fingerprint: string; lastEvent: object | null };
    expect(detail.lastEvent).not.toBeNull();
    const group = (lastSeen: number, eventId: string) => ({ project: "web", fingerprint: detail.fingerprint, n: 1, firstSeen: lastSeen, lastSeen, title: "t", culprit: "c", level: "error", release: "", environment: "", platform: "", eventId, stack: "" });
    await t.mutation(fn("lib:apply"), { groups: [group(Date.UTC(2026, 10, 20, 10), "older")] });
    expect(((await t.query(fn("dashboard:issue"), { id: issue!._id })) as { lastEvent: object | null }).lastEvent).not.toBeNull();
    await t.mutation(fn("lib:apply"), { groups: [group(Date.UTC(2026, 10, 20, 12), "newer")] });
    const after = (await t.query(fn("dashboard:issue"), { id: issue!._id })) as { lastEventId: string; lastEvent: object | null };
    expect(after).toMatchObject({ lastEventId: "newer", lastEvent: null });
    expect(await t.action(fn("lib:latestEvent"), { id: issue!._id })).toBeNull();
  });

  it("malformed events never fail the batch: shapes are normalized, an unreadable spill is dropped, the rest is stored", async () => {
    const { consume, issues, internalAction, msg } = harness(noAlerts);
    const bad = [
      { exception: { values: [null, 5, "x", { type: 7, value: { a: 1 }, stacktrace: { frames: [null, { abs_path: 7, lineno: "x" }, { abs_path: "https://app.test/a.js", lineno: 1, colno: 2, in_app: "yes" }] } }] } },
      { exception: "nope", stacktrace: { frames: "x" }, threads: { values: [null, { crashed: true, stacktrace: { frames: [3] } }] } },
      { message: 5, logentry: { message: { x: 1 } }, fingerprint: "not-an-array", release: 3, debug_meta: { images: [null, { type: "sourcemap", debug_id: 5, code_file: {} }] } },
    ] as never[];
    const r = await consume([...bad, errorEvent()]);
    expect(r).toMatchObject({ events: 4 });
    expect((await issues()).reduce((n, i) => n + i.count, 0)).toBe(4);
    // A spill object that is gone or not JSON: that message is dropped, its batch goes on.
    const out = (await internalAction("lib:consume", { messages: [{ v: 1, project: "web", id: "gone", receivedAt: 1, spill: "sentry/sentry/spill/x/web/gone.json.gz" }, msg(errorEvent({ type: "Fine" }))] })) as { events: number };
    expect(out.events).toBe(1);
  });

  it("a batch is consumed in slices bounded by bytes: one object and one apply per slice, every event counted", async () => {
    const bucket = new MemoryR2();
    const applied: number[] = [];
    const deps = { install: "sentry", config: noAlerts, env: { EMBER_FILES: bucket }, now: Date.UTC(2026, 10, 20, 12), findArtifacts: async () => ({}), apply: async (g: Array<{ n: number }>) => (applied.push(g.reduce((n, x) => n + x.n, 0)), { issues: g.length, created: 0, alerts: 0 }), maxSliceBytes: 4096 };
    const big = (i: number): QueuedEvent => ({ v: 1, project: "web", id: String(i).padStart(32, "0"), receivedAt: 1, event: { ...errorEvent(), extra: { pad: "x".repeat(1500) } } });
    const r = await consumeBatch(deps, Array.from({ length: 10 }, (_, i) => big(i)));
    expect(r.events).toBe(10);
    expect(r.objects.length).toBeGreaterThanOrEqual(4);
    expect(bucket.keys("sentry/sentry/events/")).toHaveLength(r.objects.length);
    expect(applied.reduce((a, b) => a + b, 0)).toBe(10);
    expect(applied.length).toBe(r.objects.length);
  });

  it("hourly buckets shift with time and keep 24 hours", () => {
    expect(bumpHourly([], 10, 10, 3).slice(-2)).toEqual([0, 3]);
    const h = bumpHourly(bumpHourly([], 10, 10, 3), 10, 12, 1);
    expect(h.slice(-3)).toEqual([3, 0, 1]);
    expect(bumpHourly(h, 12, 100, 2)).toEqual([...Array(23).fill(0), 2]);
  });
});

describe("status, regression and alerts", () => {
  const signed: Array<{ url: string; body: string; sig: string | null }> = [];
  const stubFetch = () => {
    signed.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      signed.push({ url: String(url), body: String(init.body), sig: new Headers(init.headers).get("x-ember-sentry-signature") });
      return new Response("ok");
    });
  };
  const config = { alerts: { handler: "&alerts:notify", webhooks: [{ url: "https://hooks.test/sentry", secretEnv: "ALERT_SECRET" }], spike: { events: 5, windowMinutes: 10 }, throttleMinutes: 30 } };

  it("a new issue alerts once: email and push (through the app's handler) and a signed webhook", async () => {
    stubFetch();
    const { t, consume } = harness(config);
    const r = await consume([errorEvent(), errorEvent()]);
    expect(r.alerts).toBe(1);
    expect(await t.finishScheduled()).toBe(1);
    expect(await t.query(unsafeRef("probe:outbox"), {})).toEqual([{ subject: "[web] New issue: TypeError: Cannot read properties of undefined (reading 'id')", text: expect.stringContaining("Events: 2") }]);
    expect(await t.query(unsafeRef("probe:pushes"), {})).toEqual([{ title: "New issue · web", body: "TypeError: Cannot read properties of undefined (reading 'id')", kind: "new" }]);
    expect(signed).toHaveLength(1);
    const body = JSON.parse(signed[0]!.body) as { type: string; alert: SentryAlert };
    expect(body).toMatchObject({ type: "ember.sentry.alert", alert: { kind: "new", project: "web", count: 2 } });
    expect(await verifyWebhook("whsec_test", signed[0]!.body, signed[0]!.sig)).toBe(true);
    expect(await verifyWebhook("other", signed[0]!.body, signed[0]!.sig)).toBe(false);
    // More events of the same issue: no new alert.
    expect((await consume([errorEvent()])).alerts).toBe(0);
  });

  it("resolve, then an event: a regression (status flips back, one alert); ignore: counted, never alerted; reopen", async () => {
    stubFetch();
    const { t, consume, issues } = harness(config);
    await consume([errorEvent()]);
    await t.finishScheduled();
    const id = (await issues())[0]!._id;
    expect(await t.mutation(fn("lib:setStatus"), { id, status: "resolved" })).toBe("resolved");
    expect((await issues())[0]!.status).toBe("resolved");
    await t.advance(60_000);
    const r = await consume([errorEvent()]);
    expect(r.alerts).toBe(1);
    const back = (await t.query(fn("dashboard:issue"), { id })) as { status: string; regressedAt: number | null; resolvedAt: number | null };
    expect(back).toMatchObject({ status: "unresolved", resolvedAt: null });
    expect(back.regressedAt).toBe(t.now());
    await t.finishScheduled();
    expect(((await t.query(unsafeRef("probe:pushes"), {})) as Array<{ kind: string }>).map((p) => p.kind)).toEqual(["new", "regression"]);
    // A second regression inside the throttle (30 min) flips the status but does not alert again.
    await t.mutation(fn("lib:setStatus"), { id, status: "resolved" });
    expect((await consume([errorEvent()])).alerts).toBe(0);
    expect((await issues())[0]!.status).toBe("unresolved");
    await t.mutation(fn("lib:setStatus"), { id, status: "ignored" });
    expect((await consume(Array.from({ length: 10 }, () => errorEvent()))).alerts).toBe(0);
    expect((await issues())[0]).toMatchObject({ status: "ignored", count: 13 });
    expect(await t.mutation(fn("lib:setStatus"), { id, status: "unresolved" })).toBe("unresolved");
  });

  it("a spike: N events inside the window alert once; the next window may alert again after the throttle", async () => {
    stubFetch();
    const { t, consume } = harness({ ...config, alerts: { ...config.alerts, newIssue: false } });
    expect((await consume(Array.from({ length: 3 }, () => errorEvent()))).alerts).toBe(0);
    await t.advance(60_000);
    expect((await consume(Array.from({ length: 3 }, () => errorEvent()))).alerts).toBe(1);
    expect((await consume(Array.from({ length: 20 }, () => errorEvent()))).alerts).toBe(0);
    await t.finishScheduled();
    const [spike] = signed.map((s) => (JSON.parse(s.body) as { alert: SentryAlert }).alert);
    expect(spike).toMatchObject({ kind: "spike", windowCount: 6, windowMinutes: 10, count: 6 });
    // A new window 11 minutes later, still inside the 30 min throttle: nothing.
    await t.advance(11 * 60_000);
    expect((await consume(Array.from({ length: 6 }, () => errorEvent()))).alerts).toBe(0);
    // After the throttle, a new window that crosses alerts again.
    await t.advance(31 * 60_000);
    expect((await consume(Array.from({ length: 6 }, () => errorEvent()))).alerts).toBe(1);
  });

  it("at most maxPerHour alerts per project; the rest are counted as suppressed", async () => {
    stubFetch();
    const { t, consume } = harness({ alerts: { webhooks: [{ url: "https://hooks.test/x" }], maxPerHour: 2 } });
    const r = await consume([errorEvent({ type: "A" }), errorEvent({ type: "B" }), errorEvent({ type: "C" })]);
    expect(r).toMatchObject({ created: 3, alerts: 2 });
    expect((await consume([errorEvent({ type: "E" })])).alerts).toBe(0);
    await t.finishScheduled();
    expect(signed.map((s) => s.sig)).toEqual([null, null]);
    // The next hour has a fresh budget.
    await t.advance(3_600_000);
    expect((await consume([errorEvent({ type: "D" })])).alerts).toBe(1);
  });

  it("webhooks must be https (http only on localhost); redirects are not followed", async () => {
    const base = { projects: [{ id: "web", keys: ["pubkey0123456789"] }] };
    expect(() => checkConfig({ ...base, alerts: { webhooks: [{ url: "http://hooks.test/x" }] } })).toThrow(/must be an https:\/\/ URL/);
    expect(() => checkConfig({ ...base, alerts: { webhooks: [{ url: "http://localhost:8787/x" }] } })).not.toThrow();
    const seen: RequestInit[] = [];
    const f = (async (_u: string, init: RequestInit) => (seen.push(init), new Response(null, { status: 302, headers: { location: "http://plain.test/" } }))) as unknown as typeof fetch;
    const alert = { kind: "new", project: "web", issueId: "i", title: "t", culprit: "c", level: "error", count: 1, release: "", environment: "", firstSeen: 1, lastSeen: 1, at: 1 } as SentryAlert;
    expect(await postWebhook("https://hooks.test/x", alert, undefined, 1, f)).toBe(302);
    expect(seen[0]!.redirect).toBe("manual");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await postWebhook("http://hooks.test/x", alert, undefined, 1, f)).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("a project with alerts: false never alerts", async () => {
    const { consume } = harness({ ...noAlerts, alerts: { webhooks: [{ url: "https://hooks.test/x" }] } });
    expect((await consume([errorEvent()])).alerts).toBe(0);
  });
});

// The same hand-made map as sourcemap.test.ts (src/app.ts → app.min.js).
const SOURCE = 'function greet(name) {\n  throw new Error("boom " + name);\n}\ngreet("x");\n';
const MAP = JSON.stringify({ version: 3, sources: ["src/app.ts"], sourcesContent: [SOURCE], names: ["greet"], mappings: "AAAA,SAASA,KACP,MAAM,qBAERA" });

describe("source maps in the consumer", () => {
  const minified = (release: string | undefined, extra: object = {}) => ({
    ...(release ? { release } : {}),
    exception: { values: [{ type: "Error", value: "boom x", stacktrace: { frames: [{ abs_path: "https://cdn.test/assets/app.min.js", lineno: 1, colno: 42 }, { abs_path: "https://cdn.test/assets/app.min.js", function: "g", lineno: 1, colno: 21 }] } }] },
    ...extra,
  });

  async function upload(h: ReturnType<typeof harness>, o: { release: string; name?: string; debugId?: string }) {
    const bytes = utf8.encode(MAP);
    const sha = await sha256Hex(bytes);
    await h.bucket.put(storageKeys.map("sentry", sha), await gzip(bytes));
    await h.t.mutation(fn("lib:registerArtifacts"), { project: "web", release: o.release, dist: "", files: [{ name: o.name ?? "~/assets/app.min.js", sha256: sha, size: bytes.length, ...(o.debugId ? { debugId: o.debugId } : {}) }] });
    return sha;
  }

  it("a minified event of a release with uploaded maps is grouped and stored symbolicated", async () => {
    const h = harness(noAlerts);
    await upload(h, { release: "1.0.0" });
    const r = await h.consume([minified("1.0.0")]);
    expect(r.symbolicated).toBe(2);
    const [issue] = await h.issues();
    const detail = (await h.t.query(fn("dashboard:issue"), { id: issue!._id })) as { stack: string; culprit: string };
    expect(detail.stack).toContain("at greet (src/app.ts:2:9)");
    expect(detail.stack).toContain('> throw new Error("boom " + name);');
    expect(issue).toMatchObject({ release: "1.0.0" });
    const ev = (await h.t.action(fn("lib:latestEvent"), { id: issue!._id })) as { event: { exception: { values: Array<{ stacktrace: { frames: Array<{ filename: string; lineno: number; function?: string }> } }> } } };
    expect(ev.event.exception.values[0]!.stacktrace.frames.at(-1)).toMatchObject({ filename: "src/app.ts", lineno: 2, function: "greet" });
    // Another release without maps stays minified.
    expect((await h.consume([minified("2.0.0")])).symbolicated).toBe(0);
  });

  it("by debug id (debug_meta), even without a release", async () => {
    const h = harness(noAlerts);
    await upload(h, { release: "any", name: "~/other.js", debugId: "8a0b6f4c-1e2d-4f3a-9b8c-7d6e5f4a3b2c" });
    const r = await h.consume([minified(undefined, { debug_meta: { images: [{ type: "sourcemap", code_file: "https://cdn.test/assets/app.min.js", debug_id: "8A0B6F4C-1E2D-4F3A-9B8C-7D6E5F4A3B2C" }] } })]);
    expect(r.symbolicated).toBe(2);
  });

  it("a debug id never resolves to another project's map", async () => {
    const h = harness({ projects: [{ id: "web", keys: ["pubkey0123456789"], alerts: false }, { id: "api", keys: ["pubkey0123456789"], alerts: false }] });
    const id = "8a0b6f4c-1e2d-4f3a-9b8c-7d6e5f4a3b2c";
    await upload(h, { release: "any", name: "~/other.js", debugId: id });
    const ev = () => minified(undefined, { debug_meta: { images: [{ type: "sourcemap", code_file: "https://cdn.test/assets/app.min.js", debug_id: id }] } });
    expect((await h.consume([ev()], "api")).symbolicated).toBe(0);
    expect((await h.consume([ev()], "web")).symbolicated).toBe(2);
  });

  it("every release of a big batch is looked up (split into bounded calls, never cut short)", async () => {
    const h = harness(noAlerts);
    for (let i = 0; i < 55; i++) await upload(h, { release: `r${i}` });
    const r = await h.consume(Array.from({ length: 55 }, (_, i) => minified(`r${i}`)));
    expect(r.symbolicated).toBe(110);
    // The query refuses a call over its limits instead of skipping part of it.
    const many = Array.from({ length: LOOKUP_LIMITS.lookups + 1 }, (_, i): ArtifactLookup => ({ project: "web", release: `r${i}`, dist: "", names: ["~/a.js"], debugIds: [] }));
    await expect(h.t.query(fn("lib:findArtifacts"), { lookups: many })).rejects.toThrow(/at most 50 lookups/);
    const chunks = chunkLookups([...many, { project: "web", release: "x", dist: "", names: Array.from({ length: 450 }, (_, i) => `~/${i}.js`), debugIds: [] }]);
    expect(chunks.every((c) => c.length <= LOOKUP_LIMITS.lookups && c.every((l) => l.names.length <= LOOKUP_LIMITS.names && l.debugIds.length <= LOOKUP_LIMITS.debugIds))).toBe(true);
    expect(chunks.flat().reduce((n, l) => n + l.names.length, 0)).toBe(51 + 450);
  });

  it("registerArtifacts dedups by name and hash and keeps per-release totals for the Releases tab", async () => {
    const h = harness(noAlerts);
    await upload(h, { release: "1.0.0" });
    await upload(h, { release: "1.0.0" });
    await upload(h, { release: "1.0.0", name: "~/assets/vendor.js" });
    const rel = (await h.t.query(fn("dashboard:releases"), { paginationOpts: { numItems: 10, cursor: null } })) as { page: Array<{ release: string; files: number; bytes: number }> };
    expect(rel.page).toMatchObject([{ release: "1.0.0", files: 2, bytes: 2 * utf8.encode(MAP).length }]);
    const files = (await h.t.query(fn("dashboard:artifacts"), { project: "web", release: "1.0.0", paginationOpts: { numItems: 10, cursor: null } })) as { page: Array<{ name: string }> };
    expect(files.page.map((f) => f.name)).toEqual(["~/assets/app.min.js", "~/assets/vendor.js"]);
  });
});

describe("retention", () => {
  it("deletes date prefixes older than retentionDays in bounded runs; maps and recent days stay", async () => {
    const now = Date.UTC(2026, 10, 20, 12);
    const h = harness({ ...noAlerts, retentionDays: 30 }, now);
    const old = "2026-10-01", recent = "2026-11-19";
    for (let i = 0; i < 30; i++) await h.bucket.put(`sentry/sentry/events/${old}/b${i}.ndjson.gz`, "x");
    await h.bucket.put(`sentry/sentry/replays/${old}/web/r/0-event.gz`, "x");
    await h.bucket.put(`sentry/sentry/events/${recent}/b.ndjson.gz`, "x");
    await h.bucket.put(`sentry/sentry/maps/${"a".repeat(64)}.map.gz`, "x");
    await h.bucket.put(`f/c2hhcmQ/${"b".repeat(64)}`, "app file");
    const { sweepExpired } = await import("../src/storage.ts");
    const first = await sweepExpired(h.bucket, "sentry", now, 30, 20);
    expect(first).toMatchObject({ deleted: 20, more: true });
    const rest = (await h.internalAction("lib:retention", {})) as { deleted: number; more: boolean };
    expect(rest).toMatchObject({ deleted: 11, more: false });
    expect(h.bucket.keys()).toEqual([`f/c2hhcmQ/${"b".repeat(64)}`, `sentry/sentry/events/${recent}/b.ndjson.gz`, `sentry/sentry/maps/${"a".repeat(64)}.map.gz`]);
  });
});

describe("dashboard", () => {
  it("the spec composes under the install's name, with the queries, row actions and the embed", () => {
    const { app } = harness();
    const [spec] = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app }).dashboards;
    expect(spec).toMatchObject({ key: "sentry", component: "sentry", scope: "global", icon: "flag" });
    expect(Object.keys(spec!.functions).sort()).toEqual(["@sentry/dashboard:artifacts", "@sentry/dashboard:issue", "@sentry/dashboard:issues", "@sentry/dashboard:releases", "@sentry/lib:latestEvent", "@sentry/lib:setStatus"]);
    expect(spec!.tabs[0]!.blocks[0]).toMatchObject({ kind: "table", query: "@sentry/dashboard:issues", filters: ["status", "level", "release", "project"] });
    expect(spec!.tabs[1]!.blocks[0]).toMatchObject({ kind: "embed", path: "/sentry/dashboard/event" });
    expect(spec!.shard).toBeUndefined();
    // config.shard moves the issue tables: the screens run there too.
    const moved = harness({ shard: "global:errors" });
    expect(composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: moved.app }).dashboards[0]).toMatchObject({ scope: "global", shard: "global:errors" });
  });

  it("issues filter by status, level, release and project, last seen first, each a range of an index", async () => {
    const { t, consume } = harness(noAlerts);
    await consume([errorEvent({ release: "1.0.0", type: "A" }), errorEvent({ release: "2.0.0", type: "B", level: "warning" }), errorEvent({ release: "2.0.0", type: "C" })]);
    const list = async (a: object) => ((await t.query(fn("dashboard:issues"), { ...a, paginationOpts: { numItems: 10, cursor: null } })) as { page: Array<{ title: string }> }).page.map((i) => i.title.split(":")[0]);
    expect((await list({})).sort()).toEqual(["A", "B", "C"]);
    expect((await list({ release: "2.0.0" })).sort()).toEqual(["B", "C"]);
    expect(await list({ release: "2.0.0", level: "warning" })).toEqual(["B"]);
    expect(await list({ status: "resolved" })).toEqual([]);
    expect(await list({ project: "api" })).toEqual([]);
  });

  it("the embed page route serves a static document with the dashboard SDK inlined", async () => {
    const { EVENT_PAGE } = await import("../src/page.ts");
    expect(EVENT_PAGE).toContain("EmberDashboard");
    expect(EVENT_PAGE).toContain("lib:latestEvent");
  });
});
