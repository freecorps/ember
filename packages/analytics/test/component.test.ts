// The component over the real engine (@freecorps/ember-testing): server-side tracking writes data points and no row,
// the raw archive, the HTTP ingest handler (caps, identity, rate limit, CORS), queries through the SQL API with the
// dashboard's saved reports, and the install's bindings, cron and screen.
import { actionGeneric, anyComponents, componentsOf, composeApp, defineApp, defineSchema, unsafeRef, v } from "@freecorps/ember-server";
import { emberTest } from "@freecorps/ember-testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Analytics, analytics, clearSqlCache, gunzipNdjson, handleTrack, MAX_BODY_BYTES, type AnalyticsComponentApi, type AnalyticsInstallConfig, type FunnelResult } from "../src/index.ts";
import { fakeDataset, fakeRateLimit, memoryBucket } from "./fakes.ts";

const config: AnalyticsInstallConfig = { dimensions: ["plan"], measures: ["amount"], archive: true };
const app = defineApp().use(analytics, { config });
// What codegen's `components` gives the app is what the helper takes.
const typed: { analytics: AnalyticsComponentApi } = componentsOf(app);
void typed;
const schema = defineSchema({ tables: {} });
const tracker = new Analytics(anyComponents.analytics);

const events = {
  signup: actionGeneric({ args: { plan: v.string() }, handler: (ctx: any, a: { plan: string }) => tracker.track(ctx, "signed_up", { plan: a.plan, amount: 49, coupon: "X" }) }),
  webhook: actionGeneric({ args: {}, handler: (ctx: any) => tracker.trackMany(ctx, [{ name: "paid" }, { name: "renewed", userId: "u9" }], { userId: "u7" }) }),
  bad: actionGeneric({ args: {}, handler: (ctx: any) => tracker.track(ctx, "bad'name") }),
  funnel: actionGeneric({ args: {}, handler: (ctx: any) => tracker.funnel(ctx, { steps: ["view", "paid"], windowHours: 2 }) }),
  retention: actionGeneric({ args: {}, handler: (ctx: any) => tracker.retention(ctx, { period: "day", periods: 3 }) }),
  top: actionGeneric({ args: {}, handler: (ctx: any) => tracker.topEvents(ctx, { limit: 5 }) }),
};

function setup(extraEnv: Record<string, unknown> = {}) {
  const ds = fakeDataset();
  const bucket = memoryBucket();
  const t = emberTest({ schema, modules: { events }, app, env: { EMBER_ANALYTICS: ds, EMBER_FILES: bucket, ...extraEnv } });
  return { t, ds, bucket };
}

/** A SQL API double: answers by what the statement asks for, records every call. */
function sqlApi(answer: (sql: string) => unknown) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (!String(url).endsWith("/accounts/acc/analytics_engine/sql")) return new Response("not found", { status: 404 });
    calls.push(String(init.body));
    return new Response(JSON.stringify(answer(String(init.body))));
  });
  return calls;
}
const CREDS = { EMBER_ANALYTICS_ACCOUNT_ID: "acc", EMBER_ANALYTICS_API_TOKEN: "tok" };

afterEach(() => {
  vi.unstubAllGlobals();
  clearSqlCache();
});

describe("server-side tracking", () => {
  test("one data point per event, the identity as the user, zero rows written", async () => {
    const { t, ds } = setup();
    const r = await t.withIdentity({ subject: "user_1" }).action(unsafeRef<"action">("events:signup"), { plan: "pro" });
    expect(r).toMatchObject({ accepted: 1, written: true });
    // A measured zero, not a missing measurement.
    expect(t.lastStats()).toMatchObject({ rowsWritten: 0 });
    expect(ds.points).toHaveLength(1);
    const p = ds.points[0]!;
    expect(p.indexes).toEqual(["signed_up"]);
    expect(p.blobs.slice(0, 7)).toEqual(["signed_up", "user_1", "", "server", "", "analytics", JSON.stringify({ coupon: "X" })]);
    expect(p.blobs[7]).toBe("pro");
    expect(p.doubles[1]).toBe(49);
  });

  test("without an identity, server code names the user; the per-event userId wins over the call's", async () => {
    const { t, ds } = setup();
    await t.action(unsafeRef<"action">("events:webhook"), {});
    expect(ds.points.map((p) => [p.blobs[0], p.blobs[1]])).toEqual([["paid", "u7"], ["renewed", "u9"]]);
    await expect(t.action(unsafeRef<"action">("events:bad"), {})).rejects.toThrow(/invalid event name/);
    expect(ds.points).toHaveLength(2);
  });

  test("signed in: the identity wins over a userId the call or the event names", async () => {
    const { t, ds } = setup();
    await t.withIdentity({ subject: "user_1" }).action(unsafeRef<"action">("events:webhook"), {});
    expect(ds.points.map((p) => [p.blobs[0], p.blobs[1]])).toEqual([["paid", "user_1"], ["renewed", "user_1"]]);
  });

  test("archive: the batch is one gzip NDJSON object under analytics/YYYY/MM/DD/HH/", async () => {
    const { t, bucket } = setup();
    await t.action(unsafeRef<"action">("events:webhook"), {});
    const [obj] = [...bucket.objects.values()];
    expect(obj!.key).toMatch(/^analytics\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.ndjson\.gz$/);
    expect(obj!.httpMetadata).toMatchObject({ contentType: "application/x-ndjson", contentEncoding: "gzip" });
    expect(obj!.customMetadata).toEqual({ count: "2" });
    const lines = (await gunzipNdjson(obj!.body)) as Array<{ name: string; userId: string; install: string; source: string }>;
    expect(lines.map((l) => [l.name, l.userId, l.install, l.source])).toEqual([["paid", "u7", "analytics", "server"], ["renewed", "u9", "analytics", "server"]]);
  });

  test("no dataset binding: events are dropped (written: false), nothing throws", async () => {
    const t = emberTest({ schema, modules: { events }, app: defineApp().use(analytics), env: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await t.action(unsafeRef<"action">("events:webhook"), {})).toMatchObject({ accepted: 2, written: false, archived: null });
    warn.mockRestore();
  });
});

describe("HTTP ingest (handleTrack)", () => {
  const ctxOf = (cfg: AnalyticsInstallConfig, env: Record<string, unknown>, subject: string | null = null) =>
    ({ component: { name: "analytics", config: cfg }, env, auth: { getUserIdentity: async () => (subject ? { subject, tokenIdentifier: subject } : null) } }) as never;
  const post = (body: string, headers: Record<string, string> = {}) => new Request("https://app.test/analytics/track", { method: "POST", headers: { "content-type": "text/plain", ...headers }, body });

  test("a batch: 204 with CORS, one point per event, country from the edge, the body's userId dropped", async () => {
    const ds = fakeDataset();
    const res = await handleTrack(ctxOf({}, { EMBER_ANALYTICS: ds }), post(JSON.stringify({ events: [{ name: "view", anonymousId: "a1", userId: "mallory" }, { name: "click", anonymousId: "a1" }] }), { "cf-ipcountry": "BR" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(ds.points.map((p) => p.blobs.slice(0, 6))).toEqual([
      ["view", "", "a1", "client", "BR", "analytics"],
      ["click", "", "a1", "client", "BR", "analytics"],
    ]);
  });

  test("signed in (a bearer token): the user is the identity, whatever the body says", async () => {
    const ds = fakeDataset();
    await handleTrack(ctxOf({ trustClientUserId: true }, { EMBER_ANALYTICS: ds }, "user_42"), post(JSON.stringify({ events: [{ name: "view", userId: "mallory" }] })));
    expect(ds.points[0]!.blobs[1]).toBe("user_42");
    // trustClientUserId without an identity keeps it (an app that knows what it does).
    await handleTrack(ctxOf({ trustClientUserId: true }, { EMBER_ANALYTICS: ds }), post(JSON.stringify({ events: [{ name: "view", userId: "u5" }] })));
    expect(ds.points[1]!.blobs[1]).toBe("u5");
  });

  test("refusals: 400 for a bad batch, 413 past the size cap, nothing written; OPTIONS answers the preflight", async () => {
    const ds = fakeDataset();
    const ctx = ctxOf({ maxEvents: 2 }, { EMBER_ANALYTICS: ds });
    const bad = await handleTrack(ctx, post(JSON.stringify({ events: [{ name: "x'--" }] })));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, error: { code: "bad_batch" } });
    expect((await handleTrack(ctx, post(JSON.stringify({ events: [{ name: "a" }, { name: "b" }, { name: "c" }] })))).status).toBe(400);
    expect((await handleTrack(ctx, post("not json"))).status).toBe(400);
    const big = await handleTrack(ctx, post(JSON.stringify({ events: [{ name: "a", props: { s: "x".repeat(MAX_BODY_BYTES) } }] })));
    expect(big.status).toBe(413);
    expect(ds.points).toHaveLength(0);
    const pre = await handleTrack(ctx, new Request("https://app.test/analytics/track", { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  test("rate limit: per IP (or signed-in user) through the edge binding; 429 writes nothing", async () => {
    const ds = fakeDataset();
    const rl = fakeRateLimit(1);
    const ctx = ctxOf({ rateLimit: { binding: "RL_ANALYTICS" } }, { EMBER_ANALYTICS: ds, RL_ANALYTICS: rl });
    const body = JSON.stringify({ events: [{ name: "view" }] });
    expect((await handleTrack(ctx, post(body, { "cf-connecting-ip": "1.2.3.4" }))).status).toBe(204);
    const limited = await handleTrack(ctx, post(body, { "cf-connecting-ip": "1.2.3.4" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
    expect((await handleTrack(ctx, post(body, { "cf-connecting-ip": "5.6.7.8" }))).status).toBe(204);
    expect(rl.keys).toEqual(["analytics:ip:1.2.3.4", "analytics:ip:1.2.3.4", "analytics:ip:5.6.7.8"]);
    expect(ds.points).toHaveLength(2);
    // The key is never the client's to pick: a fresh anonymousId per batch, or an x-real-ip / x-forwarded-for of its
    // own, lands in the same IP bucket.
    for (const [i, h] of [{}, { "x-real-ip": "9.9.9.9" }, { "x-forwarded-for": "8.8.8.8" }].entries()) {
      await handleTrack(ctx, post(JSON.stringify({ events: [{ name: "view", anonymousId: `fresh-${i}` }] }), { "cf-connecting-ip": "5.6.7.8", ...h }));
    }
    expect(rl.keys.slice(-3)).toEqual(["analytics:ip:5.6.7.8", "analytics:ip:5.6.7.8", "analytics:ip:5.6.7.8"]);
    // key: "user": the signed-in user (the identity, never a body field); anonymous callers by IP.
    const byUser = ctxOf({ rateLimit: { binding: "RL_ANALYTICS", key: "user" } }, { EMBER_ANALYTICS: ds, RL_ANALYTICS: rl }, "user_42");
    await handleTrack(byUser, post(JSON.stringify({ events: [{ name: "view", anonymousId: "dev-1", userId: "mallory" }] }), { "cf-connecting-ip": "1.2.3.4" }));
    expect(rl.keys.at(-1)).toBe("analytics:user:user_42");
    const anonUser = ctxOf({ rateLimit: { binding: "RL_ANALYTICS", key: "user" } }, { EMBER_ANALYTICS: ds, RL_ANALYTICS: rl });
    await handleTrack(anonUser, post(JSON.stringify({ events: [{ name: "view", anonymousId: "dev-1" }] }), { "cf-connecting-ip": "1.2.3.4" }));
    expect(rl.keys.at(-1)).toBe("analytics:ip:1.2.3.4");
    // A binding that is not there (not deployed yet): size caps only, the event is kept.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await handleTrack(ctxOf({ rateLimit: { binding: "RL_MISSING" } }, { EMBER_ANALYTICS: ds }), post(body))).status).toBe(204);
    warn.mockRestore();
  });

  test("rate limit: a deployed limiter that fails is not skipped (503 + Retry-After, nothing written)", async () => {
    const ds = fakeDataset();
    const broken = { limit: async () => Promise.reject(new Error("limiter down")) };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleTrack(ctxOf({ rateLimit: { binding: "RL_ANALYTICS" } }, { EMBER_ANALYTICS: ds, RL_ANALYTICS: broken }), post(JSON.stringify({ events: [{ name: "view" }] })));
    err.mockRestore();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "rate_limit_unavailable" } });
    expect(ds.points).toHaveLength(0);
  });

  test("deployments: blob6 carries EMBER_PROJECT/EMBER_ENV, so two deployments on one dataset stay apart", async () => {
    const ds = fakeDataset();
    const body = JSON.stringify({ events: [{ name: "view" }] });
    await handleTrack(ctxOf({}, { EMBER_ANALYTICS: ds, EMBER_PROJECT: "shop", EMBER_ENV: "production" }), post(body));
    await handleTrack(ctxOf({}, { EMBER_ANALYTICS: ds, EMBER_PROJECT: "shop", EMBER_ENV: "staging" }), post(body));
    expect(ds.points.map((p) => p.blobs[5])).toEqual(["shop/production:analytics", "shop/staging:analytics"]);
  });
});

describe("queries", () => {
  test("not configured: AnalyticsNotConfigured names the missing env", async () => {
    const { t } = setup();
    await expect(t.action(unsafeRef<"action">("events:top"), {})).rejects.toMatchObject({ code: "AnalyticsNotConfigured", data: { missing: ["EMBER_ANALYTICS_ACCOUNT_ID", "EMBER_ANALYTICS_API_TOKEN"] } });
  });

  test("funnel and retention through the SQL API, cached briefly; API errors become AnalyticsQueryFailed", async () => {
    const calls = sqlApi((sql) => (sql.includes("step1") ? { data: [{ step0: 10, step1: 4 }] } : sql.includes("cohort") ? { data: [{ cohort: 0, users: 5, r1: 2, r2: 1 }] } : { data: [{ name: "view", events: 9, users: 3 }] }));
    const { t } = setup(CREDS);
    const f = (await t.action(unsafeRef<"action">("events:funnel"), {})) as FunnelResult;
    expect(f.steps.map((s) => [s.name, s.users, s.conversion])).toEqual([["view", 10, 1], ["paid", 4, 0.4]]);
    expect(f.windowSeconds).toBe(7200);
    expect(calls[0]).toContain("t1 - t0 <= 7200");
    await t.action(unsafeRef<"action">("events:funnel"), {});
    expect(calls).toHaveLength(1); // cached
    const r = (await t.action(unsafeRef<"action">("events:retention"), {})) as { cohorts: Array<{ users: number; rates: number[] }> };
    expect(r.cohorts[0]).toMatchObject({ users: 5, rates: [0.4, 0.2] });
    expect(await t.action(unsafeRef<"action">("events:top"), {})).toEqual([{ name: "view", events: 9, users: 3 }]);
    vi.stubGlobal("fetch", async () => new Response("bad token", { status: 403 }));
    clearSqlCache();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(t.action(unsafeRef<"action">("events:top"), {})).rejects.toMatchObject({ code: "AnalyticsQueryFailed", data: { status: 403 } });
    err.mockRestore();
  });

  test("the dashboard: refresh, funnel and retention save one report row each; the screen's queries read them", async () => {
    sqlApi((sql) =>
      sql.includes("step1")
        ? { data: [{ step0: 8, step1: 2 }] }
        : sql.includes("cohort")
          ? { data: [{ cohort: 0, users: 4, r1: 1 }] }
          : sql.includes("GROUP BY name")
            ? { data: [{ name: "view", events: "12", users: "4" }] }
            : { data: [{ events: "30", users: "7" }] },
    );
    const { t } = setup(CREDS);
    // The dashboard runs its functions by name as the executor (internal), as the harness's `_action` does.
    const run = (name: string, args: unknown = {}) => (t as unknown as { _action(n: string, a: unknown, s: string): Promise<unknown> })._action(`@analytics/dashboard:${name}`, args, "global:main");
    const read = (name: string) => t.query(unsafeRef<"query">(`@analytics/dashboard:${name}`), {});
    expect(await read("overview")).toMatchObject({ eventsToday: 0, configured: false, at: null });
    await run("refresh");
    expect(await read("overview")).toMatchObject({ eventsToday: 30, usersToday: 7, top: [{ name: "view", events: 12, users: 4 }], configured: true });
    expect(await run("funnel", { steps: ["view", "paid"] })).toBe("2 of 8 users finished");
    expect(await read("lastFunnel")).toMatchObject({ steps: [{ step: 1, users: 8 }, { step: 2, users: 2, conversion: 0.25 }] });
    expect(await run("retention", { period: "week", periods: 2 })).toBe("1 cohorts");
    expect(await read("lastRetention")).toMatchObject({ period: "week", cohorts: [{ users: 4, rates: [0.25] }] });
    // Refreshed again: the report is replaced (one row per key), with the new values.
    clearSqlCache();
    const before = ((await read("overview")) as { at: number }).at;
    await t.advance(60_000);
    await run("refresh");
    expect(((await read("overview")) as { at: number }).at).toBeGreaterThan(before);
  });

  test("credentials removed after a refresh: the saved overview stops showing the old numbers as configured", async () => {
    sqlApi((sql) => (sql.includes("GROUP BY name") ? { data: [] } : { data: [{ events: "30", users: "7" }] }));
    const env: Record<string, unknown> = { EMBER_ANALYTICS: fakeDataset(), ...CREDS };
    const t = emberTest({ schema, modules: { events }, app, env });
    const run = () => (t as unknown as { _action(n: string, a: unknown, s: string): Promise<unknown> })._action("@analytics/dashboard:refresh", {}, "global:main");
    const read = () => t.query(unsafeRef<"query">("@analytics/dashboard:overview"), {});
    await run();
    expect(await read()).toMatchObject({ eventsToday: 30, configured: true });
    delete env.EMBER_ANALYTICS_API_TOKEN;
    expect(await run()).toMatchObject({ configured: false });
    expect(await read()).toEqual({ eventsToday: 0, usersToday: 0, top: [], at: null, configured: false });
  });

  test("counts: oldest first, from the newest-first statement (a long range keeps its recent buckets)", async () => {
    const calls = sqlApi(() => ({ data: [{ t: "2026-11-26 10:00:00", name: "b", events: "1" }, { t: "2026-11-26 10:00:00", name: "a", events: "2" }, { t: "2026-11-26 09:00:00", name: "a", events: "3" }] }));
    const t = emberTest({ schema, modules: { events: { ...events, counts: actionGeneric({ args: {}, handler: (ctx: any) => tracker.counts(ctx, { bucket: "hour" }) }) } }, app, env: { EMBER_ANALYTICS: fakeDataset(), ...CREDS } });
    expect(await t.action(unsafeRef<"action">("events:counts"), {})).toEqual([
      { t: "2026-11-26 09:00:00", name: "a", events: 3 },
      { t: "2026-11-26 10:00:00", name: "a", events: 2 },
      { t: "2026-11-26 10:00:00", name: "b", events: 1 },
    ]);
    expect(calls[0]).toContain("ORDER BY t DESC, name");
  });

  test("refresh without the SQL API: nothing queried, nothing written", async () => {
    const calls = sqlApi(() => ({ data: [] }));
    const { t } = setup();
    // Measured around the call: a measured zero (the refresh, its saveReport with onlyIfExists, wrote nothing).
    const { value, stats } = await t.measure(() => (t as unknown as { _action(n: string, a: unknown, s: string): Promise<unknown> })._action("@analytics/dashboard:refresh", {}, "global:main"));
    expect(value).toMatchObject({ configured: false });
    expect(stats).toMatchObject({ rowsWritten: 0 });
    expect(calls).toHaveLength(0);
    // No report was saved.
    expect(await t.query(unsafeRef<"query">("@analytics/dashboard:overview"), {})).toMatchObject({ at: null, configured: false });
  });
});

describe("the install", () => {
  test("bindings: the dataset (and a Rate Limiting binding when asked); the summary cron; the screen", () => {
    const composed = composeApp({ schema, functions: { events }, app: defineApp().use(analytics, { config: { binding: "PRODUCT", dataset: "product_events", rateLimit: { binding: "RL_EVENTS", limit: 100, period: 60 }, summary: { everyMinutes: 15 } } }) });
    expect(composed.schema.manifest.components?.analytics?.bindings).toEqual([
      { type: "analytics_engine", name: "PRODUCT", dataset: "product_events" },
      { type: "ratelimit", name: "RL_EVENTS", limit: 100, period: 60 },
    ]);
    expect(composed.crons.map((c) => [c.name, c.fn, c.shard])).toEqual([["@analytics/summary", "@analytics/lib:refresh", "global:main"]]);
    expect(composed.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /analytics/track", "OPTIONS /analytics/track"]);
    const [spec] = composed.dashboards;
    expect(spec).toMatchObject({ key: "analytics", component: "analytics", scope: "global", icon: "chart" });
    expect(Object.keys(spec!.functions).sort()).toEqual([
      "@analytics/dashboard:funnel",
      "@analytics/dashboard:lastFunnel",
      "@analytics/dashboard:lastRetention",
      "@analytics/dashboard:overview",
      "@analytics/dashboard:refresh",
      "@analytics/dashboard:retention",
    ]);
    // The retention table has a column for every return a run can have (13 periods: +1..+12).
    const cohorts = spec!.tabs.find((x) => x.id === "retention")!.blocks.find((b) => b.id === "cohorts") as { columns: Array<{ label: string }> };
    expect(cohorts.columns.map((c) => c.label).slice(2)).toEqual(Array.from({ length: 12 }, (_, i) => `+${i + 1}`));
    expect(composeApp({ schema, functions: {}, app: defineApp().use(analytics, { config: { summary: false } }) }).crons).toEqual([]);
    expect(() => composeApp({ schema, functions: {}, app: defineApp().use(analytics, { config: { binding: "bad-name" } }) })).toThrow(/binding/);
    expect(() => composeApp({ schema, functions: {}, app: defineApp().use(analytics, { config: { rateLimit: { binding: "RL", limit: 5 } } }) })).toThrow(/limit and period/);
  });
});
