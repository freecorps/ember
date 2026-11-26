// Real latency (RUM, contracts.md "RUM"): what sampled clients measured — socket connect, heartbeat RTT, mutation ack,
// first value — per country (the client's, from the Worker's `request.cf`) and the colo the shard runs in. From
// Analytics Engine (`GET /api/rum`); the clients opt in with `new EmberClient({ rum: { sampleRate } })`.

import { useMemo, useState } from "react";
import { path } from "../api.ts";
import { fmtNum, windowLabel, windows } from "../format.ts";
import { useApi, useSession } from "../hooks.ts";
import { Empty, Loading, Problem, Section, Stat } from "../ui.tsx";

interface Cell {
  metric: string;
  country: string;
  colo: string;
  n: number;
  p50: number;
  p95: number;
}

const METRICS: Array<{ id: string; label: string; help: string }> = [
  { id: "rtt", label: "RTT", help: "heartbeat ping → pong: the network to the shard, nothing else" },
  { id: "ack", label: "Mutation ack", help: "mut sent → its result: RTT + queue + group commit + durable write" },
  { id: "first_value", label: "First value", help: "a new subscription → its first value from the server" },
  { id: "connect", label: "Connect", help: "new WebSocket → ready (TLS, upgrade, the shard's wake)" },
];

/** p95 from which a cell reads as slow (ms), per metric. */
const SLOW: Record<string, number> = { rtt: 150, ack: 250, first_value: 400, connect: 800 };

const ms = (v: number) => `${fmtNum(v, v < 10 ? 1 : 0)} ms`;

export function Latency({ project, env }: { project: string; env: string }) {
  const { me } = useSession();
  const [hours, setHours] = useState(24);
  const [metric, setMetric] = useState("rtt");
  const rum = useApi<{ metrics: Cell[]; cells: Cell[] }>(me.metrics ? path("/api/rum", { project, env, hours }) : null);
  const grid = useMemo(() => {
    const cells = (rum.data?.cells ?? []).filter((c) => c.metric === metric);
    const sum = (key: "country" | "colo") => {
      const m = new Map<string, number>();
      for (const c of cells) m.set(c[key], (m.get(c[key]) ?? 0) + c.n);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    };
    return { countries: sum("country").slice(0, 15), colos: sum("colo").slice(0, 8), at: new Map(cells.map((c) => [`${c.country}\n${c.colo}`, c])) };
  }, [rum.data, metric]);
  const total = (id: string) => rum.data?.metrics.find((m) => m.metric === id);
  const slow = SLOW[metric] ?? 300;
  return (
    <>
      <div className="toolbar">
        <label className="inline">
          Window
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {windows.map((h) => (
              <option key={h} value={h}>
                {windowLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="Metric">
            {METRICS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={rum.reload}>
          Refresh
        </button>
      </div>
      {!me.metrics ? (
        <div className="notice info">
          <strong>Real latency needs Analytics Engine</strong>
          <p className="muted">
            Create an API token with <b>Account Analytics: Read</b> and run <code>EMBER_ANALYTICS_TOKEN=… ember dashboard deploy</code>.
          </p>
        </div>
      ) : rum.error ? (
        <Problem error={rum.error} onRetry={rum.reload} />
      ) : !rum.data ? (
        <Loading lines={5} />
      ) : !rum.data.metrics.length ? (
        <Empty>
          No samples in this window. Clients opt in with <code>new EmberClient({"{"} url, rum: {"{"} sampleRate: 0.05 {"}"} {"}"})</code>: a share of sessions sends small latency histograms (no user, IP or args) to the
          project's <code>/api/_ember/rum</code>.
        </Empty>
      ) : (
        <>
          <div className="stats">
            {METRICS.map((m) => {
              const t = total(m.id);
              return <Stat key={m.id} label={`${m.label} p50 / p95`} value={t ? `${ms(t.p50)} / ${ms(t.p95)}` : "—"} hint={t ? `${fmtNum(t.n)} samples · ${m.help}` : m.help} {...(t ? { tone: t.p95 >= (SLOW[m.id] ?? 300) ? ("warn" as const) : ("ok" as const) } : {})} />;
            })}
          </div>
          <Section title={`${METRICS.find((m) => m.id === metric)?.label ?? metric}: country × shard colo`} id="heatmap">
            <p className="muted small">p50 / p95 per country of the client and colo where the shard runs ("?" until a shard reports it). Weighted by the sample rate; buckets are ~√2 wide, so values are within about ±20%.</p>
            {!grid.countries.length ? (
              <Empty>No samples for this metric.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="heat" aria-label="Latency by country and shard colo">
                  <thead>
                    <tr>
                      <th scope="col">Country</th>
                      {grid.colos.map((c) => (
                        <th key={c} scope="col" className="num">
                          {c || "?"}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.countries.map((country) => (
                      <tr key={country}>
                        <th scope="row">{country}</th>
                        {grid.colos.map((colo) => {
                          const c = grid.at.get(`${country}\n${colo}`);
                          return (
                            <td key={colo} className={`num${c ? (c.p95 >= slow ? " warn" : " ok") : ""}`} title={c ? `${fmtNum(c.n)} samples` : undefined}>
                              {c ? `${ms(c.p50)} / ${ms(c.p95)}` : "—"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}
