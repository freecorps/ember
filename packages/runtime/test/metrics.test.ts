import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { catalogDue, CATALOG_MIN_INTERVAL_MS, recordExecution, sampleRate, setMetricsSink, type AnalyticsEngineDatasetLike } from "../src/metrics.ts";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";

type Point = Parameters<AnalyticsEngineDatasetLike["writeDataPoint"]>[0] & {};

function sink() {
  const points: Point[] = [];
  const ds: AnalyticsEngineDatasetLike = { writeDataPoint: (p) => void points.push(p ?? {}) };
  return { points, ds };
}

afterEach(() => setMetricsSink(null));

describe("metrics (Analytics Engine)", () => {
  it("is a no-op without the binding", () => {
    expect(recordExecution({}, { fn: "a:b", kind: "query", shard: "x:1", status: "ok", durationMs: 1 })).toBe(false);
  });

  it("writes the documented data point layout and samples ok points (errors always)", () => {
    const { points, ds } = sink();
    const e = { EMBER_METRICS: ds, EMBER_PROJECT: "chat", EMBER_ENV: "prod", EMBER_METRICS_SAMPLE: "0.25" };
    expect(sampleRate(e)).toBe(0.25);
    expect(recordExecution(e, { fn: "m:send", kind: "mutation", shard: "org:acme", status: "ok", durationMs: 2.5, rowsRead: 3, rowsWritten: 2, bytesOut: () => 10 }, () => 0.1)).toBe(true);
    expect(recordExecution(e, { fn: "m:send", kind: "mutation", shard: "org:acme", status: "ok", durationMs: 1 }, () => 0.9)).toBe(false);
    expect(recordExecution(e, { fn: "m:send", kind: "mutation", shard: "org:acme", status: "error", errorCode: "Boom", durationMs: 1 }, () => 0.9)).toBe(true);
    expect(points[0]).toEqual({
      indexes: ["chat/prod"],
      blobs: ["chat", "prod", "org", "m:send", "mutation", "ok", "", "org:acme", ""],
      doubles: [2.5, 3, 2, 10, 4],
    });
    expect(points[1]!.blobs!.slice(5, 7)).toEqual(["error", "Boom"]);
    expect(points[1]!.doubles![4]).toBe(1);
  });

  it("never throws into the caller", () => {
    const ds: AnalyticsEngineDatasetLike = {
      writeDataPoint: () => {
        throw new Error("quota");
      },
    };
    expect(recordExecution({ EMBER_METRICS: ds }, { fn: "a:b", kind: "query", shard: null, status: "ok", durationMs: 0 })).toBe(false);
  });

  it("shards and the Worker record queries, mutations, subscriptions-free HTTP calls and actions", async () => {
    const { points, ds } = sink();
    setMetricsSink(ds);
    const shard = "metrics:one";
    expect((await api("mutation", { fn: "messages:send", args: { channel: "m", body: "hello" }, shard }, "good:ana")).status).toBe(200);
    expect((await api("query", { fn: "messages:list", args: { channel: "m" }, shard })).status).toBe(200);
    expect((await api("query", { fn: "nope:nope", args: {}, shard })).status).toBe(400);
    expect((await SELF.fetch("http://ember/api/action", { method: "POST", body: JSON.stringify({ fn: "actions:ping", args: {}, shard }) })).status).toBe(200);
    const rows = points.map((p) => ({ fn: p.blobs![3], kind: p.blobs![4], status: p.blobs![5], shardKind: p.blobs![2], rowsRead: p.doubles![1], rowsWritten: p.doubles![2], bytes: p.doubles![3] }));
    const mut = rows.find((r) => r.kind === "mutation" && r.fn === "messages:send")!;
    expect(mut).toMatchObject({ status: "ok", shardKind: "metrics" });
    expect(mut.rowsWritten).toBeGreaterThan(0);
    const q = rows.find((r) => r.kind === "query" && r.fn === "messages:list")!;
    expect(q.status).toBe("ok");
    expect(q.rowsRead).toBeGreaterThan(0);
    expect(q.bytes).toBeGreaterThan(10);
    // A denied call never reaches the engine: no point. An action is recorded in the Worker.
    expect(rows.some((r) => r.fn === "nope:nope")).toBe(false);
    expect(rows.find((r) => r.kind === "action")).toMatchObject({ fn: "actions:ping", status: "ok" });
  });
});

describe("durations (what durationMs measures)", () => {
  const rows = (points: Point[]) => points.map((p) => ({ fn: p.blobs![3], kind: p.blobs![4], status: p.blobs![5], timing: p.blobs![8], ms: p.doubles![0], rowsRead: p.doubles![1], rowsWritten: p.doubles![2], bytes: p.doubles![3] }));

  it("HTTP calls: one point each, measured by the Worker around the RPC (timing rpc), rows from the shard; reply unchanged", async () => {
    const { points, ds } = sink();
    setMetricsSink(ds);
    const shard = "timing:http";
    const m = await api("mutation", { fn: "messages:send", args: { channel: "t", body: "x" }, shard }, "good:ana");
    expect(m.status).toBe(200);
    expect(Object.keys(m.body).sort()).toEqual(["ok", "value", "version"]); // no `metrics` leak
    const q = await api("query", { fn: "messages:list", args: { channel: "t" }, shard });
    expect(Object.keys(q.body).sort()).toEqual(["ok", "value", "version"]);
    const bad = await api("query", { fn: "messages:list", args: { channel: 1 }, shard });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body).sort()).toEqual(["error", "ok"]);
    const r = rows(points);
    expect(r.filter((x) => x.fn === "messages:send")).toEqual([expect.objectContaining({ kind: "mutation", timing: "rpc", status: "ok" })]);
    expect(r.filter((x) => x.fn === "messages:list").map((x) => [x.kind, x.timing, x.status])).toEqual([["query", "rpc", "ok"], ["query", "rpc", "error"]]);
    const send = r.find((x) => x.fn === "messages:send")!;
    expect(send.rowsWritten).toBeGreaterThan(0);
    expect(send.ms).toBeGreaterThanOrEqual(0);
    expect(r.find((x) => x.fn === "messages:list")!.rowsRead).toBeGreaterThan(0);
  });

  it("one-shot socket queries record cache hits, misses and errors as query/none", async () => {
    const { points, ds } = sink();
    setMetricsSink(ds);
    const c = await connect("timing:socket-query");
    await hello(c, "c", undefined, ["query", "ident"]);
    c.send({ t: "mut", mid: "seed", fn: "messages:send", args: { channel: "x", body: "row" } });
    await c.waitFor(is("mres"));
    c.send({ t: "q", qid: "miss", fn: "messages:list", args: { channel: "x" } });
    await c.waitFor(is("qres"));
    c.send({ t: "sub", qid: "live", fn: "messages:list", args: { channel: "x" } });
    await c.waitFor(is("snap"));
    c.send({ t: "q", qid: "hit", fn: "messages:list", args: { channel: "x" } });
    await c.waitFor(is("qres"));
    c.send({ t: "q", qid: "error", fn: "messages:latest", args: { channel: "empty" } });
    await c.waitFor(is("qres"));
    c.send({ t: "q", qid: "denied", fn: "missing:query", args: {} });
    await c.waitFor(is("qres"));
    const queries = rows(points).filter((r) => r.kind === "query");
    expect(queries).toHaveLength(3);
    expect(queries[0]).toMatchObject({ fn: "messages:list", timing: "none", status: "ok", rowsWritten: 0 });
    expect(queries[0]!.rowsRead).toBeGreaterThan(0);
    expect(queries[0]!.bytes).toBeGreaterThan(0);
    expect(queries[1]).toMatchObject({ fn: "messages:list", timing: "none", status: "ok", rowsRead: 0, rowsWritten: 0, bytes: queries[0]!.bytes });
    expect(queries[2]).toMatchObject({ fn: "messages:latest", timing: "none", status: "error", rowsWritten: 0 });
    c.close();
  });

  it("WebSocket mutations: timing commit (receipt → durable), subscriptions: timing none", async () => {
    const { points, ds } = sink();
    setMetricsSink(ds);
    const c = await connect("timing:ws");
    c.send({ t: "hello", clientId: "c1", protocol: 1 });
    await c.waitFor((m) => m.t === "ready");
    c.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "w" } });
    await c.waitFor((m) => m.t === "snap");
    c.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "w", body: "hi" } });
    await c.waitFor((m) => m.t === "mres");
    let r = rows(points);
    for (let i = 0; i < 50 && !r.some((x) => x.kind === "mutation"); i++) {
      await sleep(10);
      r = rows(points);
    }
    expect(r.find((x) => x.kind === "mutation")).toMatchObject({ fn: "messages:send", timing: "commit", status: "ok" });
    expect(r.find((x) => x.kind === "mutation")!.rowsWritten).toBeGreaterThan(0);
    expect(r.filter((x) => x.kind === "subscription").every((x) => x.timing === "none")).toBe(true);
    expect(r.some((x) => x.kind === "subscription")).toBe(true);
    c.close();
  });

  it("an action's runQuery / runMutation are recorded by the action (timing rpc), the action itself as wall", async () => {
    const { points, ds } = sink();
    setMetricsSink(ds);
    const res = await SELF.fetch("http://ember/api/action", { method: "POST", headers: { authorization: "Bearer good:ana" }, body: JSON.stringify({ fn: "actions:combo", args: { channel: "a" }, shard: "timing:act" }) });
    expect(res.status).toBe(200);
    const r = rows(points);
    expect(r.filter((x) => x.kind === "action").every((x) => x.timing === "wall")).toBe(true);
    expect(r.find((x) => x.fn === "actions:combo")).toMatchObject({ kind: "action", timing: "wall" });
    const calls = r.filter((x) => x.kind === "query" || x.kind === "mutation");
    expect(calls.slice(0, 3).map((x) => `${x.kind}:${x.fn}:${x.timing}`)).toEqual(["mutation:messages:send:rpc", "query:messages:list:rpc", "query:messages:secret:rpc"]);
    expect(calls.every((x) => x.timing === "rpc")).toBe(true);
    expect(calls[0]!.rowsWritten).toBeGreaterThan(0);
  });
});

describe("shard catalog (registry D1)", () => {
  it("due logic: forced, never reported, or older than the interval", () => {
    expect(catalogDue(null, 1000)).toBe(true);
    expect(catalogDue(1000, 1000 + CATALOG_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(catalogDue(1000, 1000 + CATALOG_MIN_INTERVAL_MS)).toBe(true);
    expect(catalogDue(1000, 1001, true)).toBe(true);
  });

  it("a shard reports kind/key/schemaVersion/dbSize/lastWrite after its migration", async () => {
    const shard = "catalog:acme";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "x" }, shard }, "good:ana");
    // The first boot migrated before the shard knew its name; the report happens once it does (waitUntil).
    let row: Record<string, unknown> | null = null;
    for (let i = 0; i < 50 && !row; i++) {
      await sleep(20);
      row = await env.EMBER_REGISTRY.prepare("SELECT * FROM shards WHERE shard = ?").bind(shard).first();
    }
    expect(row).toMatchObject({ project: "test", env: "test", kind: "catalog", key: "acme" });
    const status = await shardStub(shard).status(shard);
    expect(row!.schema_version).toBe(status.schemaVersion);
    expect(row!.db_size).toBeGreaterThan(0);
  });
});

describe("GET /api/_ember/data (admin data browser)", () => {
  const get = async (qs: string, token: string | null = "admin-secret") => {
    const res = await SELF.fetch(`http://ember/api/_ember/data?${qs}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    return { status: res.status, body: (await res.json()) as any };
  };

  it("needs the admin token", async () => {
    expect((await get("shard=data:a", null)).status).toBe(401);
    expect((await get("shard=data:a", "wrong")).status).toBe(401);
  });

  it("lists tables and pages through rows read-only", async () => {
    const shard = "data:a";
    for (let i = 0; i < 5; i++) await api("mutation", { fn: "messages:send", args: { channel: "d", body: `m${i}` }, shard }, "good:ana");
    const list = await get(`shard=${shard}`);
    expect(list.status).toBe(200);
    expect(list.body.tables).toEqual(expect.arrayContaining([{ name: "messages", kind: "schema", rows: 5 }, expect.objectContaining({ name: "_jobs", kind: "internal" })]));
    const p1 = await get(`shard=${shard}&table=messages&limit=2`);
    expect(p1.body).toMatchObject({ ok: true, table: "messages", done: false });
    expect(p1.body.rows.map((r: any) => r.body)).toEqual(["m0", "m1"]);
    expect(Object.keys(p1.body.rows[0]).some((k) => k.startsWith("_k_"))).toBe(false);
    const p2 = await get(`shard=${shard}&table=messages&limit=2&cursor=${p1.body.cursor}`);
    expect(p2.body.rows.map((r: any) => r.body)).toEqual(["m2", "m3"]);
    const p3 = await get(`shard=${shard}&table=messages&limit=2&cursor=${p2.body.cursor}`);
    expect(p3.body).toMatchObject({ done: true, cursor: null });
    expect(p3.body.rows.map((r: any) => r.body)).toEqual(["m4"]);
    expect((await get(`shard=${shard}&table=sqlite_master`)).status).toBe(404);
    expect((await get(`shard=${shard}&table=messages&cursor=-1`)).status).toBe(400);
    expect((await get(`shard=bad`)).status).toBe(400);
  });

  it("GET /api/_ember/crons lists crons with their System state", async () => {
    const r = await SELF.fetch("http://ember/api/_ember/crons", { headers: { authorization: "Bearer admin-secret" } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.crons)).toBe(true);
  });
});
