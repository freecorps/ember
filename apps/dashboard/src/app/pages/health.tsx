// Health of one environment, from data that already exists: Analytics Engine (errors, latency, rows read per call,
// busiest shards), the shard catalog and the live migration status of each shard.

import { useState, type ReactNode } from "react";
import { path } from "../api.ts";
import { fmtNum, fmtPct, windowLabel, windows } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, Empty, Loading, Meter, Mono, Problem, Section, Stat, Table } from "../ui.tsx";
import type { FunctionRow, ShardRow, StatusBody } from "./types.ts";

/** Mean rows read per call from which a query is listed as expensive (a sign of a missing index). */
const EXPENSIVE_ROWS = 100;
const BAD_ROWS = 1000;
const BAD_ERROR_RATE = 0.01;

export function migrationState(st: StatusBody["shards"][number] | undefined): { tone: "ok" | "bad" | "warn" | undefined; text: string } {
  if (!st) return { tone: undefined, text: "—" };
  if (st.migrationError) return { tone: "bad", text: `refused: ${st.migrationError.code}` };
  if (st.staged?.length) return { tone: "warn", text: `backfilling ${st.staged.length}` };
  if (st.ready) return { tone: "ok", text: "ready" };
  return { tone: "warn", text: "pending" };
}

export function Health({ project, env }: { project: string; env: string }) {
  const [hours, setHours] = useState(24);
  const { me } = useSession();
  const scope = { project, env };
  // Without Analytics Engine there is nothing to ask: one notice instead of an error per panel.
  const fns = useApi<{ functions: FunctionRow[] }>(me.metrics ? path("/api/functions", { ...scope, hours }) : null);
  const hot = useApi<{ shards: Array<{ shard: string; calls: number; errors: number; rowsRead: number; rowsWritten: number }> }>(me.metrics ? path("/api/hot-shards", { ...scope, hours }) : null);
  const shards = useApi<{ shards: ShardRow[]; status: StatusBody | { ok: false; status: number; error: string } | null }>(path("/api/shards", { ...scope, status: 1 }));
  const caps = useApi<{ level: number; features: string[] }>(path("/api/capabilities", scope));

  const f = fns.data?.functions ?? [];
  const calls = f.reduce((a, x) => a + x.calls, 0);
  const errors = f.reduce((a, x) => a + x.errors, 0);
  const rate = calls ? errors / calls : 0;
  const p95 = f.filter((x) => x.timing === "rpc" || x.timing === "commit" || x.timing === "wall").reduce((a, x) => Math.max(a, x.p95), 0);
  const expensive = f.filter((x) => (x.kind === "query" || x.kind === "subscription") && x.avgRowsRead >= EXPENSIVE_ROWS).sort((a, b) => b.avgRowsRead - a.avgRowsRead).slice(0, 8);
  const failing = f.filter((x) => x.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 8);
  const status = shards.data?.status && "shards" in shards.data.status ? shards.data.status : null;
  const statusError = shards.data?.status && !("shards" in shards.data.status) ? shards.data.status : null;
  const pending = (status?.shards ?? []).filter((s) => !s.ready);

  const attention: Array<{ tone: "bad" | "warn"; text: ReactNode }> = [];
  if (caps.data && caps.data.level < 2) attention.push({ tone: "warn", text: <>This project runs an older runtime (admin API level {caps.data.level}). Update <code>@freecorps/ember-runtime</code> and redeploy for every screen.</> });
  for (const s of pending) attention.push({ tone: s.migrationError ? "bad" : "warn", text: <><Mono>{s.shard}</Mono> migration {migrationState(s).text}</> });
  for (const x of failing.filter((x) => x.errorRate >= BAD_ERROR_RATE).slice(0, 3)) attention.push({ tone: "bad", text: <><Mono>{x.fn}</Mono> fails {fmtPct(x.errorRate)} of {fmtNum(x.calls)} calls</> });
  for (const x of expensive.filter((x) => x.avgRowsRead >= BAD_ROWS).slice(0, 3)) attention.push({ tone: "warn", text: <><Mono>{x.fn}</Mono> reads {fmtNum(x.avgRowsRead)} rows per call: an index is probably missing</> });

  const hotMax = Math.max(0, ...(hot.data?.shards ?? []).map((s) => s.calls));
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
        <button
          type="button"
          onClick={() => {
            fns.reload();
            hot.reload();
            shards.reload();
          }}
        >
          Refresh
        </button>
      </div>

      {!me.metrics && (
        <div className="notice info">
          <strong>Connect Analytics Engine for calls, errors, latency and hot shards</strong>
          <p className="muted">
            Create an API token with <b>Account Analytics: Read</b> and run <code>EMBER_ANALYTICS_TOKEN=… ember dashboard deploy</code>. Projects record metrics when <code>metrics</code> is enabled in <code>ember.json</code>.
          </p>
        </div>
      )}
      <div className="stats">
        <Stat label={`Calls · ${windowLabel(hours)}`} value={fns.data ? fmtNum(calls) : "—"} />
        <Stat label="Error rate" value={fns.data ? fmtPct(rate) : "—"} tone={fns.data ? (rate >= BAD_ERROR_RATE ? "bad" : "ok") : undefined} hint={fns.data ? `${fmtNum(errors)} errors` : undefined} />
        <Stat label="Worst p95" value={fns.data ? `${fmtNum(p95, 1)} ms` : "—"} hint="rpc / commit / action wall time" />
        <Stat label="Shards" value={shards.data ? fmtNum(shards.data.shards.length) : "—"} hint="in the catalog" />
        <Stat label="Migrations" value={status ? (pending.length ? `${pending.length} pending` : "all ready") : "—"} tone={status ? (pending.some((s) => s.migrationError) ? "bad" : pending.length ? "warn" : "ok") : undefined} />
      </div>

      <Section title="Needs attention" id="attention">
        {(me.metrics && fns.loading) || shards.loading ? (
          <Loading lines={2} />
        ) : attention.length ? (
          <ul className="attention">
            {attention.map((a, i) => (
              <li key={i} className={a.tone}>
                {a.text}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing needs attention{!me.metrics || fns.error ? " in the data available" : ""}.</Empty>
        )}
      </Section>

      <div className="grid2">
        <Section title="Errors by function" id="errors">
          {!me.metrics ? (
            <Empty>Needs Analytics Engine.</Empty>
          ) : fns.error ? (
            <Problem error={fns.error} />
          ) : !fns.data ? (
            <Loading />
          ) : (
            <Table
              label="Errors by function"
              empty="No errors in this window."
              cols={[{ h: "Function" }, { h: "Kind" }, { h: "Errors", num: true }, { h: "Rate", num: true }]}
              rows={failing.map((x) => [<Mono>{x.fn}</Mono>, x.kind, fmtNum(x.errors), <span className={x.errorRate >= BAD_ERROR_RATE ? "bad" : ""}>{fmtPct(x.errorRate)}</span>])}
            />
          )}
        </Section>
        <Section title="Expensive queries" id="expensive">
          {!me.metrics ? (
            <Empty>Needs Analytics Engine.</Empty>
          ) : fns.error ? (
            <Problem error={fns.error} />
          ) : !fns.data ? (
            <Loading />
          ) : (
            <Table
              label="Expensive queries"
              empty={`No query reads ${EXPENSIVE_ROWS}+ rows per call.`}
              cols={[{ h: "Query" }, { h: "Rows read / call", num: true }, { h: "Calls", num: true }]}
              rows={expensive.map((x) => [<Mono>{x.fn}</Mono>, <span className={x.avgRowsRead >= BAD_ROWS ? "warn" : ""}>{fmtNum(x.avgRowsRead, 1)}</span>, fmtNum(x.calls)])}
            />
          )}
        </Section>
        <Section title="Hot shards" id="hot">
          {!me.metrics ? (
            <Empty>Needs Analytics Engine.</Empty>
          ) : hot.error ? (
            <Problem error={hot.error} />
          ) : !hot.data ? (
            <Loading />
          ) : (
            <Table
              label="Hot shards"
              empty="No calls recorded in this window."
              cols={[{ h: "Shard" }, { h: "Calls", num: true }, { h: "", cls: "meter-col" }, { h: "Rows written", num: true }]}
              rows={hot.data.shards.map((s) => [
                <a href={href({ project, env, section: "shards", shard: s.shard })}>
                  <Mono>{s.shard}</Mono>
                </a>,
                fmtNum(s.calls),
                <Meter value={s.calls} max={hotMax} {...(s.errors ? { tone: "bad" as const } : {})} />,
                fmtNum(s.rowsWritten),
              ])}
            />
          )}
        </Section>
        <Section title="Pending migrations" id="migrations">
          {shards.error ? (
            <Problem error={shards.error} />
          ) : !shards.data ? (
            <Loading />
          ) : statusError ? (
            <div className="notice bad">Live status unavailable ({String(statusError.status)}).</div>
          ) : !shards.data.shards.length ? (
            <Empty>No shard has reported yet.</Empty>
          ) : (
            <Table
              label="Pending migrations"
              empty={`All ${fmtNum(status?.shards.length ?? 0)} checked shards are on the deployed schema.`}
              cols={[{ h: "Shard" }, { h: "State" }]}
              rows={pending.map((s) => {
                const m = migrationState(s);
                return [<Mono>{s.shard}</Mono>, <Badge {...(m.tone ? { tone: m.tone } : {})}>{m.text}</Badge>];
              })}
            />
          )}
        </Section>
      </div>
    </>
  );
}
