import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { catalogDue, CATALOG_MIN_INTERVAL_MS, recordExecution, sampleRate, setMetricsSink, type AnalyticsEngineDatasetLike } from "../src/metrics.ts";
import { api, shardStub, sleep } from "./helpers.ts";

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
      blobs: ["chat", "prod", "org", "m:send", "mutation", "ok", "", "org:acme"],
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
