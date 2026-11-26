// Estimated cost of one environment: a month projected from the window's metrics (Analytics Engine) and the shard
// catalog, at Cloudflare's published prices (../../pricing.ts, with the sources and the date they were read). An
// estimate only: the real bill is Cloudflare's, and some of it is not measured here (the notice says what).

import { useMemo, useState } from "react";
import { path } from "../api.ts";
import { fmtBytes, fmtNum, windowLabel, windows } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Empty, Loading, Meter, Mono, Problem, Section, Stat, Table } from "../ui.tsx";
import { estimate, fmtUsd, PRICING } from "../../pricing.ts";
import type { FunctionRow, ShardRow } from "./types.ts";

export function Cost({ project, env }: { project: string; env: string }) {
  const { me } = useSession();
  const [hours, setHours] = useState(168);
  const scope = { project, env };
  const fns = useApi<{ functions: FunctionRow[] }>(me.metrics ? path("/api/functions", { ...scope, hours }) : null);
  const hot = useApi<{ shards: Array<{ shard: string; calls: number; errors: number; rowsRead: number; rowsWritten: number }> }>(me.metrics ? path("/api/hot-shards", { ...scope, hours }) : null);
  // Storage per shard: the catalog (D1), no shard woken.
  const catalog = useApi<{ shards: ShardRow[] }>(path("/api/shards", scope));
  // The totals from the whole environment (not the ranked lists the tables show).
  const totals = useApi<{ usage: Array<{ kind: string; timing: string; calls: number; rowsRead: number; rowsWritten: number; bytesOut: number }>; storage: { shards: number; bytes: number } }>(me.metrics ? path("/api/cost", { ...scope, hours }) : null);
  const est = useMemo(
    () =>
      fns.data && hot.data && catalog.data && totals.data
        ? estimate({ hours, functions: fns.data.functions, shards: hot.data.shards, catalog: catalog.data.shards, totals: { usage: totals.data.usage, storageBytes: totals.data.storage.bytes } })
        : null,
    [fns.data, hot.data, catalog.data, totals.data, hours],
  );
  const fnMax = Math.max(0, ...(est?.byFunction ?? []).map((x) => x.usd));
  const shardMax = Math.max(0, ...(est?.byShard ?? []).map((x) => x.usd));
  return (
    <>
      <div className="toolbar">
        <label className="inline">
          Based on the last
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {windows.map((h) => (
              <option key={h} value={h}>
                {windowLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            fns.reload();
            hot.reload();
            catalog.reload();
            totals.reload();
          }}
        >
          Refresh
        </button>
      </div>
      <div className="notice info" role="note">
        <strong>Estimate, not a bill</strong>
        <p className="muted">
          A month (730 h) projected from the last {windowLabel(hours)} of sampled metrics, at {PRICING.plan} prices read on {PRICING.checked} ({sourceLinks()}). Counted: Workers requests, Durable Object requests, SQLite rows read and written, SQLite storage.
          Not measured, so not counted: CPU time, Durable Object duration, WebSocket connections, what the app stores in D1, R2 or KV, logs. Included usage is per account and shared by every project. Egress is free on Workers.
        </p>
      </div>
      {!me.metrics ? (
        <div className="notice info">
          <strong>The estimate needs Analytics Engine</strong>
          <p className="muted">
            Create an API token with <b>Account Analytics: Read</b> and run <code>EMBER_ANALYTICS_TOKEN=… ember dashboard deploy</code>.
          </p>
        </div>
      ) : fns.error || hot.error || catalog.error || totals.error ? (
        <Problem error={(fns.error ?? hot.error ?? catalog.error ?? totals.error)!} onRetry={() => (fns.reload(), hot.reload(), catalog.reload(), totals.reload())} />
      ) : !est ? (
        <Loading lines={6} />
      ) : (
        <>
          <div className="stats">
            <Stat label="Estimated / month" value={fmtUsd(est.totals.gross)} hint="every unit at its price" />
            <Stat label="With included usage" value={fmtUsd(est.totals.net)} hint={`if this were the account's only project, with the $${PRICING.baseMonthlyUsd} base fee`} />
            <Stat label="Rows read / month" value={fmtNum(est.totals.usage.rowsRead)} />
            <Stat label="Rows written / month" value={fmtNum(est.totals.usage.rowsWritten)} />
            <Stat label="Storage" value={fmtBytes(est.totals.usage.storageBytes)} hint="SQLite, from the catalog" />
          </div>
          <Section title="Breakdown" id="breakdown">
            <Table
              label="Cost breakdown"
              cols={[{ h: "Item" }, { h: "Units / month", num: true }, { h: "Unit" }, { h: "Estimated", num: true }, { h: "After included", num: true }]}
              rows={est.totals.lines.map((l) => [l.what, fmtNum(l.units, l.units < 10 ? 3 : 0), l.unit, fmtUsd(l.gross), fmtUsd(l.net)])}
            />
          </Section>
          <div className="grid2">
            <Section title="By function" id="by-function">
              <Table
                label="Estimated cost by function"
                empty="No calls recorded in this window."
                onRow={(i) => (location.hash = href({ project, env, section: "functions", shard: est.byFunction[i]!.fn }))}
                cols={[{ h: "Function" }, { h: "/ month", num: true }, { h: "", cls: "meter-col" }, { h: "Rows read", num: true }, { h: "Rows written", num: true }, { h: "Requests", num: true }]}
                rows={est.byFunction.slice(0, 50).map((x) => [
                  <Mono>{x.fn}</Mono>,
                  fmtUsd(x.usd),
                  <Meter value={x.usd} max={fnMax} />,
                  fmtNum(x.rowsRead),
                  fmtNum(x.rowsWritten),
                  fmtNum(x.workerRequests + x.doRequests),
                ])}
              />
            </Section>
            <Section title="By shard" id="by-shard">
              <Table
                label="Estimated cost by shard"
                empty="No shard activity or storage."
                onRow={(i) => (location.hash = href({ project, env, section: "shards", shard: est.byShard[i]!.shard }))}
                cols={[{ h: "Shard" }, { h: "/ month", num: true }, { h: "", cls: "meter-col" }, { h: "Rows written", num: true }, { h: "Storage", num: true }]}
                rows={est.byShard.slice(0, 50).map((x) => [<Mono>{x.shard}</Mono>, fmtUsd(x.usd), <Meter value={x.usd} max={shardMax} />, fmtNum(x.rowsWritten), fmtBytes(x.storageBytes)])}
              />
              {!est.byShard.length && <Empty>Shards appear once they report to the catalog or record calls.</Empty>}
              <p className="muted small">Per shard the call type is not known: each call counts as one Durable Object request (an upper bound).</p>
            </Section>
          </div>
        </>
      )}
    </>
  );
}

function sourceLinks() {
  const s = PRICING.sources;
  const items: Array<[string, string]> = [
    ["Workers", s.workers],
    ["Durable Objects", s.durableObjects],
    ["D1", s.d1],
    ["R2", s.r2],
  ];
  return items.map(([label, url], i) => (
    <span key={label}>
      {i ? ", " : ""}
      <a href={url} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    </span>
  ));
}
