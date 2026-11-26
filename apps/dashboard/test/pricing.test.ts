// The estimated cost (informative): unit prices with their sources, the month projection, the breakdown by function
// and by shard, included usage.
import { describe, expect, it } from "vitest";
import { costOf, estimate, fmtUsd, functionUsage, monthFactor, priced, PRICING } from "../src/pricing.ts";

describe("estimated cost", () => {
  it("prices carry their sources and the date they were read", () => {
    expect(PRICING.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const url of Object.values(PRICING.sources)) expect(url).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
    expect(PRICING.durableObjects.rowsWritten).toEqual({ usd: 1, per: 1e6, included: 50e6, unit: "rows written" });
    expect(PRICING.analyticsEngine.billed).toBe(false);
  });

  it("gross is every unit at its price; net subtracts the month's included usage", () => {
    expect(priced(2e6, PRICING.durableObjects.requests)).toEqual({ gross: 0.3, net: 0.15 });
    expect(priced(5e6, PRICING.workers.requests).net).toBe(0);
    expect(priced(-1, PRICING.workers.requests)).toEqual({ gross: 0, net: 0 });
  });

  it("requests by how the call reached the shard: HTTP/RPC, socket mutation (20:1), subscription re-runs (none), action", () => {
    expect(monthFactor(730)).toBe(1);
    const u = functionUsage(
      [
        { kind: "mutation", timing: "rpc", calls: 100, rowsRead: 10, rowsWritten: 5, bytesOut: 1 },
        { kind: "mutation", timing: "commit", calls: 200, rowsRead: 20, rowsWritten: 10, bytesOut: 2 },
        { kind: "subscription", timing: "none", calls: 1000, rowsRead: 1000, rowsWritten: 0, bytesOut: 3 },
        { kind: "action", timing: "wall", calls: 7, rowsRead: 0, rowsWritten: 0, bytesOut: 0 },
        { kind: "job", timing: "commit", calls: 3, rowsRead: 0, rowsWritten: 3, bytesOut: 0 },
      ],
      730,
    );
    expect(u).toEqual({ workerRequests: 107, doRequests: 100 + 10 + 3, rowsRead: 1030, rowsWritten: 18, bytesOut: 6 });
    const c = costOf(u, 2e9);
    expect(c.parts.storage).toBeCloseTo(0.4);
    expect(c.parts.rowsWritten).toBeCloseTo(18e-6);
    expect(c.usd).toBeCloseTo(c.parts.workers + c.parts.doRequests + c.parts.rowsRead + c.parts.rowsWritten + c.parts.storage);
  });

  it("a month from a window, by function and by shard (idle shards still store data)", () => {
    const e = estimate({
      hours: 73, // a tenth of a month
      functions: [
        { fn: "messages:send", kind: "mutation", timing: "rpc", calls: 1e6, rowsRead: 2e6, rowsWritten: 3e6, bytesOut: 9e6 },
        { fn: "messages:list", kind: "subscription", timing: "none", calls: 5e6, rowsRead: 5e8, rowsWritten: 0, bytesOut: 1e9 },
      ],
      shards: [{ shard: "org:acme", calls: 6e6, rowsRead: 5.02e8, rowsWritten: 3e6 }],
      catalog: [
        { shard: "org:acme", db_size: 1e9 },
        { shard: "org:idle", db_size: 4e9 },
      ],
    });
    expect(e.byFunction.map((x) => x.fn)).toEqual(["messages:send", "messages:list"]);
    // 30M rows written a month: $30; 10M Worker + 10M DO requests: $3 + $1.5; 20M rows read: $0.02.
    expect(e.byFunction[0]!.usd).toBeCloseTo(30 + 3 + 1.5 + 0.02, 5);
    expect(e.byShard.map((x) => x.shard)).toEqual(["org:acme", "org:idle"]);
    expect(e.byShard[1]!.usd).toBeCloseTo(0.8);
    const lines = Object.fromEntries(e.totals.lines.map((l) => [l.what, l]));
    expect(lines["SQLite storage"]!.units).toBe(5);
    expect(lines["SQLite storage"]!.net).toBe(0);
    expect(lines["SQLite rows written"]!.net).toBe(0); // 30M < 50M included
    expect(e.totals.net).toBeCloseTo(PRICING.baseMonthlyUsd + 0 + (10e6 - 1e6) * 0.15e-6, 5);
    expect(e.totals.gross).toBeGreaterThan(e.totals.net - PRICING.baseMonthlyUsd);
  });

  it("formats dollars", () => {
    expect([fmtUsd(0), fmtUsd(0.001), fmtUsd(1234.5), fmtUsd(Number.NaN)]).toEqual(["$0", "<$0.01", "$1,234.50", "—"]);
  });
});
