// Real-user latency in the dashboard: the Analytics Engine SQL (RUM points apart from execution metrics), percentiles
// from summed log histograms, and the bucket formula shared with the runtime.
import { describe, expect, it } from "vitest";
import { functionStatsSql, rumAggregate, rumBucketMs, rumSql, shardStatsSql } from "../src/metrics-sql.ts";

describe("RUM in the dashboard", () => {
  it("RUM points are read apart: never counted as function or shard executions", () => {
    expect(functionStatsSql({ dataset: "ember_metrics", project: "chat", env: "prod" })).toContain("blob5 != 'rum'");
    expect(shardStatsSql({ dataset: "ember_metrics", project: "chat", env: "prod" })).toContain("blob5 != 'rum'");
    const sql = rumSql({ dataset: "ember_metrics", project: "chat", env: "prod", sinceHours: 24 });
    expect(sql).toContain("blob5 = 'rum'");
    expect(sql).toContain("SUM(_sample_interval * double11 * double12) AS n");
    expect(sql).toContain("index1 = 'chat/prod'");
    expect(() => rumSql({ dataset: "x; DROP", project: "chat", env: "prod", sinceHours: 1 })).toThrow();
  });

  it("same buckets as the runtime's rumBucketMs (packages/runtime/src/rum.ts)", () => {
    // floor(2·log2(ms + 1)) buckets, represented by their geometric middle.
    expect([0, 9, 11, 13, 15, 40].map(rumBucketMs)).toEqual([0.19, 25.91, 52.82, 106.63, 214.27, 1246973.04]);
  });

  it("p50/p95 from the summed histograms, per metric and per country × colo", () => {
    const r = rumAggregate({
      data: [
        { metric: "rtt", country: "BR", colo: "GRU", bucket: 11, n: 80 },
        { metric: "rtt", country: "BR", colo: "GRU", bucket: 13, n: 20 },
        { metric: "rtt", country: "US", colo: "MIA", bucket: 9, n: 40 },
        { metric: "rtt", country: "", colo: "", bucket: 20, n: 0 },
        { metric: "ack", country: "BR", colo: "", bucket: 14, n: 5 },
      ],
    });
    expect(r.metrics.find((m) => m.metric === "rtt")).toEqual({ metric: "rtt", country: "", colo: "", n: 140, p50: rumBucketMs(11), p95: rumBucketMs(13) });
    expect(r.cells[0]).toEqual({ metric: "rtt", country: "BR", colo: "GRU", n: 100, p50: rumBucketMs(11), p95: rumBucketMs(13) });
    expect(r.cells.find((c) => c.metric === "ack")).toMatchObject({ country: "BR", colo: "", n: 5 });
    expect(rumAggregate({})).toEqual({ metrics: [], cells: [] });
  });
});
