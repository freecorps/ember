// Estimated cost (informative only: nothing here bills anyone). Cloudflare's published prices for what an Ember
// project uses, and a projection of a month from the execution metrics the runtime already writes (Analytics Engine,
// metrics.ts) and the shard catalog. Pure module: the SPA and the tests use it.
//
// What is estimated and how (also shown on the screen):
//   - Workers requests: calls measured in the Worker (`timing` "rpc": HTTP queries/mutations and an action's calls;
//     "wall": actions). Socket frames routed through the Worker are not Worker requests.
//   - Durable Object requests: one per RPC (`rpc`, jobs), one per 20 incoming WebSocket messages (a socket mutation,
//     `commit`); subscription re-runs happen inside the object (none).
//   - SQLite rows read / written in the shards (the engine's counters: what Cloudflare bills as rows).
//   - SQLite storage of each shard (catalog `db_size`).
// Not measured, so not included: CPU time, Durable Object duration (GB-s: a hibernated socket costs none), WebSocket
// connections, D1/R2/KV used by the app itself, Workers Logs. Egress is free on Workers (bytes out shown, $0).

export interface Price {
  /** US$ per `per` units. */
  usd: number;
  per: number;
  /** Included every month on Workers Paid (per account, shared by every project). */
  included: number;
  unit: string;
}

export const PRICING = {
  /** When these were read from the pages below. */
  checked: "2026-11-26",
  currency: "USD",
  plan: "Workers Paid",
  baseMonthlyUsd: 5,
  sources: {
    workers: "https://developers.cloudflare.com/workers/platform/pricing/",
    durableObjects: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
    d1: "https://developers.cloudflare.com/d1/platform/pricing/",
    r2: "https://developers.cloudflare.com/r2/pricing/",
    analyticsEngine: "https://developers.cloudflare.com/analytics/analytics-engine/pricing/",
  },
  workers: {
    requests: { usd: 0.3, per: 1e6, included: 10e6, unit: "requests" },
    cpuMs: { usd: 0.02, per: 1e6, included: 30e6, unit: "CPU ms" },
  },
  durableObjects: {
    requests: { usd: 0.15, per: 1e6, included: 1e6, unit: "requests" },
    /** Incoming WebSocket messages per billed request. */
    wsMessagesPerRequest: 20,
    durationGbS: { usd: 12.5, per: 1e6, included: 400_000, unit: "GB-s" },
    rowsRead: { usd: 0.001, per: 1e6, included: 25e9, unit: "rows read" },
    rowsWritten: { usd: 1, per: 1e6, included: 50e6, unit: "rows written" },
    storageGbMonth: { usd: 0.2, per: 1, included: 5, unit: "GB-month" },
  },
  d1: {
    rowsRead: { usd: 0.001, per: 1e6, included: 25e9, unit: "rows read" },
    rowsWritten: { usd: 1, per: 1e6, included: 50e6, unit: "rows written" },
    storageGbMonth: { usd: 0.75, per: 1, included: 5, unit: "GB-month" },
  },
  r2: {
    storageGbMonth: { usd: 0.015, per: 1, included: 10, unit: "GB-month" },
    classA: { usd: 4.5, per: 1e6, included: 1e6, unit: "Class A operations" },
    classB: { usd: 0.36, per: 1e6, included: 10e6, unit: "Class B operations" },
  },
  analyticsEngine: {
    /** Published but not billed yet (the page says so): shown, not added to the total. */
    billed: false,
    dataPoints: { usd: 0.25, per: 1e6, included: 10e6, unit: "data points" },
  },
} as const;

const HOURS_PER_MONTH = 730;

/** Cost of `units` at a unit price, before (gross) and after (net) the month's included usage. */
export function priced(units: number, p: Price): { gross: number; net: number } {
  const u = Math.max(0, units);
  return { gross: (u / p.per) * p.usd, net: (Math.max(0, u - p.included) / p.per) * p.usd };
}

/** What a window of metrics becomes in a 730-hour month. */
export const monthFactor = (hours: number) => HOURS_PER_MONTH / Math.max(1, hours);

export interface UsageLine {
  workerRequests: number;
  doRequests: number;
  rowsRead: number;
  rowsWritten: number;
  bytesOut: number;
}

export interface CostLine extends UsageLine {
  /** US$ per month at the unit prices (no included usage: each line's share of the bill). */
  usd: number;
  parts: { workers: number; doRequests: number; rowsRead: number; rowsWritten: number; storage: number };
}

/** The billable units of one function's metrics (one row per kind and timing), per month. */
export function functionUsage(rows: Array<{ kind: string; timing: string; calls: number; rowsRead: number; rowsWritten: number; bytesOut: number }>, hours: number): UsageLine {
  const f = monthFactor(hours);
  const u: UsageLine = { workerRequests: 0, doRequests: 0, rowsRead: 0, rowsWritten: 0, bytesOut: 0 };
  for (const r of rows) {
    const calls = r.calls * f;
    if (r.timing === "rpc") {
      u.workerRequests += calls;
      u.doRequests += calls;
    } else if (r.timing === "wall" || r.kind === "action") u.workerRequests += calls;
    else if (r.kind === "job") u.doRequests += calls;
    else if (r.timing === "commit" || r.kind === "mutation") u.doRequests += calls / PRICING.durableObjects.wsMessagesPerRequest;
    // Subscription re-runs ("none") and socket queries run inside the object: no request of their own.
    u.rowsRead += r.rowsRead * f;
    u.rowsWritten += r.rowsWritten * f;
    u.bytesOut += r.bytesOut * f;
  }
  return u;
}

/** Gross US$ per month of a usage line (plus a storage size, for a shard). */
export function costOf(u: UsageLine, storageBytes = 0): CostLine {
  const P = PRICING;
  const parts = {
    workers: priced(u.workerRequests, P.workers.requests).gross,
    doRequests: priced(u.doRequests, P.durableObjects.requests).gross,
    rowsRead: priced(u.rowsRead, P.durableObjects.rowsRead).gross,
    rowsWritten: priced(u.rowsWritten, P.durableObjects.rowsWritten).gross,
    storage: priced(storageBytes / 1e9, P.durableObjects.storageGbMonth).gross,
  };
  return { ...u, parts, usd: parts.workers + parts.doRequests + parts.rowsRead + parts.rowsWritten + parts.storage };
}

export interface EstimateInput {
  hours: number;
  functions: Array<{ fn: string; kind: string; timing: string; calls: number; rowsRead: number; rowsWritten: number; bytesOut: number }>;
  /** Busiest shards in the window (Analytics Engine, by `blob8`). */
  shards: Array<{ shard: string; calls: number; rowsRead: number; rowsWritten: number }>;
  /** Shard catalog: storage per shard. */
  catalog: Array<{ shard: string; db_size: number }>;
}

export interface Estimate {
  hours: number;
  byFunction: Array<CostLine & { fn: string; kinds: string[] }>;
  byShard: Array<CostLine & { shard: string; storageBytes: number }>;
  totals: {
    usage: UsageLine & { storageBytes: number };
    /** Every unit at its price (this project's share of a bill whose included usage is spent elsewhere). */
    gross: number;
    /** With the plan's included usage, as if this were the account's only project, plus the base fee. */
    net: number;
    lines: Array<{ what: string; units: number; unit: string; gross: number; net: number }>;
  };
}

/** The month projected from a window of metrics. Informative: see the header for what is and is not counted. */
export function estimate(i: EstimateInput): Estimate {
  const groups = new Map<string, EstimateInput["functions"]>();
  for (const r of i.functions) groups.set(r.fn, [...(groups.get(r.fn) ?? []), r]);
  const byFunction = [...groups.entries()]
    .map(([fn, rows]) => ({ fn, kinds: [...new Set(rows.map((r) => r.kind))], ...costOf(functionUsage(rows, i.hours)) }))
    .sort((a, b) => b.usd - a.usd);
  const f = monthFactor(i.hours);
  const size = new Map(i.catalog.map((c) => [c.shard, Number(c.db_size) || 0]));
  const seen = new Set<string>();
  const byShard = i.shards.map((s) => {
    seen.add(s.shard);
    const storageBytes = size.get(s.shard) ?? 0;
    // Per shard the timing is unknown: each call counted as one Durable Object request (an upper bound).
    return { shard: s.shard, storageBytes, ...costOf({ workerRequests: 0, doRequests: s.calls * f, rowsRead: s.rowsRead * f, rowsWritten: s.rowsWritten * f, bytesOut: 0 }, storageBytes) };
  });
  // Idle shards still store data.
  for (const c of i.catalog) if (!seen.has(c.shard) && c.db_size > 0) byShard.push({ shard: c.shard, storageBytes: c.db_size, ...costOf({ workerRequests: 0, doRequests: 0, rowsRead: 0, rowsWritten: 0, bytesOut: 0 }, c.db_size) });
  byShard.sort((a, b) => b.usd - a.usd);

  const usage = byFunction.reduce(
    (a, x) => ({ workerRequests: a.workerRequests + x.workerRequests, doRequests: a.doRequests + x.doRequests, rowsRead: a.rowsRead + x.rowsRead, rowsWritten: a.rowsWritten + x.rowsWritten, bytesOut: a.bytesOut + x.bytesOut, storageBytes: a.storageBytes }),
    { workerRequests: 0, doRequests: 0, rowsRead: 0, rowsWritten: 0, bytesOut: 0, storageBytes: i.catalog.reduce((a, c) => a + (Number(c.db_size) || 0), 0) },
  );
  const P = PRICING;
  const line = (what: string, units: number, p: Price) => ({ what, units, unit: p.unit, ...priced(units, p) });
  const lines = [
    line("Workers requests", usage.workerRequests, P.workers.requests),
    line("Durable Object requests", usage.doRequests, P.durableObjects.requests),
    line("SQLite rows read", usage.rowsRead, P.durableObjects.rowsRead),
    line("SQLite rows written", usage.rowsWritten, P.durableObjects.rowsWritten),
    line("SQLite storage", usage.storageBytes / 1e9, P.durableObjects.storageGbMonth),
  ];
  const gross = lines.reduce((a, l) => a + l.gross, 0);
  const net = P.baseMonthlyUsd + lines.reduce((a, l) => a + l.net, 0);
  return { hours: i.hours, byFunction, byShard, totals: { usage, gross, net, lines } };
}

/** US$ with cents, or sub-cent precision for tiny amounts. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `<$0.01`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
