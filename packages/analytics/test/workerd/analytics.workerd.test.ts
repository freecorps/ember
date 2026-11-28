/**
 * The analytics component in workerd: the real Worker routes `POST /analytics/track` to the component, each event is
 * one Analytics Engine data point, the raw batch lands in R2 (miniflare), and the Durable Object is never written: its
 * SQLite row count is the same before and after 100 tracked events (an app mutation, the baseline, does change it), and
 * every execution the runtime measured while tracking wrote 0 rows.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { setMetricsSink } from "@freecorps/ember-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { gunzipNdjson } from "../../src/index.ts";
import { probes } from "./worker.ts";

type Point = { blobs?: (string | null)[]; doubles?: number[] };
const executions: Point[] = [];
setMetricsSink({ writeDataPoint: (p) => void executions.push(p as Point) });
afterEach(() => {
  executions.length = 0;
  probes.points.length = 0;
});

const call = async (kind: "query" | "mutation", fn: string, args: unknown, shard = "global:main") => {
  const res = await SELF.fetch(`http://ember/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
  const body = (await res.json()) as { ok: boolean; value?: unknown };
  if (!body.ok) throw new Error(`${kind} ${fn}: ${JSON.stringify(body)}`);
  return body.value;
};
const track = (events: unknown[], headers: Record<string, string> = {}) =>
  SELF.fetch("http://ember/analytics/track", { method: "POST", headers: { "content-type": "text/plain", ...headers }, body: JSON.stringify({ events }) });

/** Every row of every table of the shard's SQLite (Ember's own tables included; workerd's `_cf_*` are not readable). */
const totalRows = () =>
  runInDurableObject(env.SHARD.get(env.SHARD.idFromName("global:main")), (_i, state) => {
    const sql = state.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray() as Array<{ name: string }>;
    let n = 0;
    for (const t of tables) n += Number((sql.exec(`SELECT count(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).one() as { n: number }).n);
    return n;
  });
/** Rows written by the measured executions (double3 of the runtime's metric points). */
const rowsWritten = (ps: Point[]) => ps.reduce((s, p) => s + (p.doubles?.[2] ?? 0), 0);

describe("analytics in workerd", () => {
  it("100 events over HTTP: 100 data points, 0 rows written in the Durable Object", async () => {
    // Wake the shard and write the baseline row: a mutation does change the count, and is measured with its rows.
    await call("mutation", "api:add", { text: "baseline" });
    expect(rowsWritten(executions)).toBeGreaterThan(0);
    executions.length = 0;
    const before = await totalRows();

    for (let b = 0; b < 2; b++) {
      const events = Array.from({ length: 50 }, (_, i) => ({ name: i % 2 ? "viewed" : "clicked", props: { plan: "pro", i }, anonymousId: `dev-${b}` }));
      const res = await track(events, { "cf-connecting-ip": "203.0.113.7" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    expect(probes.points).toHaveLength(100);
    expect(probes.points[0]).toEqual({ indexes: ["clicked"], blobs: ["clicked", "", "dev-0", "client", "", "analytics", '{"i":0}', "pro"], doubles: [expect.any(Number)] });

    // The DO: not one row more (and no query or mutation ran: only the two HTTP executions were measured).
    expect(await totalRows()).toBe(before);
    expect(executions.map((p) => p.blobs?.[3])).toEqual(["http:POST /analytics/track", "http:POST /analytics/track"]);
    expect(rowsWritten(executions)).toBe(0);
    expect(await call("query", "api:count", {})).toBe(1);
  });

  it("each batch is archived to R2 as gzip NDJSON (real R2 in miniflare)", async () => {
    const res = await track([{ name: "signed_up", props: { plan: "team" }, anonymousId: "a-1" }, { name: "paid", anonymousId: "a-1" }]);
    expect(res.status).toBe(204);
    const listed = await env.EMBER_FILES.list({ prefix: "analytics/", include: ["customMetadata"] });
    const obj = listed.objects.find((o) => o.customMetadata?.count === "2");
    expect(obj?.key).toMatch(/^analytics\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.ndjson\.gz$/);
    const body = await env.EMBER_FILES.get(obj!.key);
    expect(body?.httpMetadata?.contentEncoding).toBe("gzip");
    const lines = (await gunzipNdjson(await body!.arrayBuffer())) as Array<{ name: string; props: unknown; anonymousId: string; install: string }>;
    expect(lines.map((l) => [l.name, l.props, l.anonymousId, l.install])).toEqual([["signed_up", { plan: "team" }, "a-1", "analytics"], ["paid", {}, "a-1", "analytics"]]);
  });

  it("refusals: a bad batch is 400, too big 413, nothing written; the preflight answers", async () => {
    expect((await track([{ name: "x'; DROP" }])).status).toBe(400);
    expect((await track(Array.from({ length: 51 }, () => ({ name: "a" })))).status).toBe(400);
    const big = await SELF.fetch("http://ember/analytics/track", { method: "POST", body: "x".repeat(40_000) });
    expect(big.status).toBe(413);
    expect(probes.points).toHaveLength(0);
    const pre = await SELF.fetch("http://ember/analytics/track", { method: "OPTIONS", headers: { origin: "https://app.test", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
