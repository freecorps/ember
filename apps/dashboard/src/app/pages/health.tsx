// Health of one environment, from data that already exists: Analytics Engine (errors, latency, rows read per call,
// busiest shards) and the shard catalog (D1). Loading it wakes no shard: the catalog says which shards reported an
// older schema, and their live migration status is asked for only on demand ("Check live status").

import { useState, type ReactNode } from "react";
import { path } from "../api.ts";
import { fmtNum, fmtPct, short, windowLabel, windows } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, Empty, Loading, Meter, Mono, Problem, Section, Stat, Table } from "../ui.tsx";
import { limitWarnings } from "../../metrics-sql.ts";
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

/** `/api/status` for several shards (one request; the project wakes each one it names). */
export function statusPath(project: string, env: string, shards: string[]): string {
  const q = new URLSearchParams({ project, env });
  for (const s of shards) q.append("shard", s);
  return `/api/status?${q}`;
}

/** Catalog rows whose last reported schema is not the deployed one (a migration not reported yet, or pending). */
export function behindCatalog(rows: ShardRow[], expected: string | null | undefined): ShardRow[] {
  return expected ? rows.filter((r) => r.schema_version !== expected) : [];
}

/** What the catalog alone says about a shard's schema (no live status asked). */
export function catalogState(row: ShardRow, expected: string | null | undefined): { tone: "ok" | "warn" | undefined; text: string } {
  if (!expected || !row.schema_version) return { tone: undefined, text: "—" };
  return row.schema_version === expected ? { tone: "ok", text: "current" } : { tone: "warn", text: "behind (catalog)" };
}

export function Health({ project, env }: { project: string; env: string }) {
  const [hours, setHours] = useState(24);
  const { me } = useSession();
  const scope = { project, env };
  // Without Analytics Engine there is nothing to ask: one notice instead of an error per panel.
  const fns = useApi<{ functions: FunctionRow[] }>(me.metrics ? path("/api/functions", { ...scope, hours }) : null);
  const hot = useApi<{ shards: Array<{ shard: string; calls: number; errors: number; rowsRead: number; rowsWritten: number }> }>(me.metrics ? path("/api/hot-shards", { ...scope, hours }) : null);
  // The catalog only: no shard is woken up by opening this screen.
  const shards = useApi<{ shards: ShardRow[]; expected?: string | null }>(path("/api/shards", scope));
  const behind = behindCatalog(shards.data?.shards ?? [], shards.data?.expected);
  // Live status on demand: the shards the catalog says are behind (else the 50 largest), up to 50.
  const [check, setCheck] = useState<string[] | null>(null);
  const live = useApi<StatusBody>(check?.length ? statusPath(project, env, check) : null);
  const caps = useApi<{ level: number; features: string[] }>(path("/api/capabilities", scope));

  const f = fns.data?.functions ?? [];
  const calls = f.reduce((a, x) => a + x.calls, 0);
  const errors = f.reduce((a, x) => a + x.errors, 0);
  const rate = calls ? errors / calls : 0;
  const p95 = f.filter((x) => x.timing === "rpc" || x.timing === "commit" || x.timing === "wall").reduce((a, x) => Math.max(a, x.p95), 0);
  const expensive = f.filter((x) => (x.kind === "query" || x.kind === "subscription") && x.avgRowsRead >= EXPENSIVE_ROWS).sort((a, b) => b.avgRowsRead - a.avgRowsRead).slice(0, 8);
  const failing = f.filter((x) => x.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 8);
  const status = live.data;
  const pending = (status?.shards ?? []).filter((s) => !s.ready);
  const checkLive = () => setCheck((behind.length ? behind : (shards.data?.shards ?? [])).slice(0, 50).map((r) => r.shard));

  const attention: Array<{ tone: "bad" | "warn"; text: ReactNode }> = [];
  if (caps.data && caps.data.level < 2) attention.push({ tone: "warn", text: <>This project runs an older runtime (admin API level {caps.data.level}). Update <code>@freecorps/ember-runtime</code> and redeploy for every screen.</> });
  if (status) for (const s of pending) attention.push({ tone: s.migrationError ? "bad" : "warn", text: <><Mono>{s.shard}</Mono> migration {migrationState(s).text}</> });
  else for (const r of behind.slice(0, 5)) attention.push({ tone: "warn", text: <><Mono>{r.shard}</Mono> reported an older schema ({short(r.schema_version)}): check its live status</> });
  for (const x of failing.filter((x) => x.errorRate >= BAD_ERROR_RATE).slice(0, 3)) attention.push({ tone: "bad", text: <><Mono>{x.fn}</Mono> fails {fmtPct(x.errorRate)} of {fmtNum(x.calls)} calls</> });
  // Functions that came within 70% of a per-transaction limit (the `ember dev` warning, from the metrics' peaks).
  for (const x of f) for (const w of limitWarnings(x.limitPeaks ?? {})) attention.push({ tone: (x.limitPeaks?.[w.counter] ?? 0) >= 1 ? "bad" : "warn", text: <><Mono>{x.fn}</Mono> {w.message}</> });
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
            if (check) live.reload();
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
      {caps.error && <Problem error={caps.error} onRetry={caps.reload} />}
      <div className="stats">
        <Stat label={`Calls · ${windowLabel(hours)}`} value={fns.data ? fmtNum(calls) : "—"} />
        <Stat label="Error rate" value={fns.data ? fmtPct(rate) : "—"} tone={fns.data ? (rate >= BAD_ERROR_RATE ? "bad" : "ok") : undefined} hint={fns.data ? `${fmtNum(errors)} errors` : undefined} />
        <Stat label="Worst p95" value={fns.data ? `${fmtNum(p95, 1)} ms` : "—"} hint="rpc / commit / action wall time" />
        <Stat label="Shards" value={shards.data ? fmtNum(shards.data.shards.length) : "—"} hint="in the catalog" />
        <Stat
          label="Migrations"
          value={status ? (pending.length ? `${pending.length} pending` : "all ready") : shards.data ? (behind.length ? `${behind.length} behind` : "all current") : "—"}
          tone={status ? (pending.some((s) => s.migrationError) ? "bad" : pending.length ? "warn" : "ok") : shards.data ? (behind.length ? "warn" : "ok") : undefined}
          hint={status ? "live status" : "from the catalog"}
        />
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
        <Section
          title="Pending migrations"
          id="migrations"
          actions={
            shards.data?.shards.length ? (
              <button type="button" onClick={() => (check ? live.reload() : checkLive())} disabled={live.loading}>
                {check ? "Check again" : "Check live status"}
              </button>
            ) : null
          }
        >
          {shards.error ? (
            <Problem error={shards.error} />
          ) : !shards.data ? (
            <Loading />
          ) : !shards.data.shards.length ? (
            <Empty>No shard has reported yet.</Empty>
          ) : live.error ? (
            <Problem error={live.error} onRetry={live.reload} />
          ) : live.loading ? (
            <Loading />
          ) : status ? (
            <Table
              label="Pending migrations"
              empty={`All ${fmtNum(status.shards.length)} checked shards are on the deployed schema.`}
              cols={[{ h: "Shard" }, { h: "State" }]}
              rows={pending.map((s) => {
                const m = migrationState(s);
                return [<Mono>{s.shard}</Mono>, <Badge {...(m.tone ? { tone: m.tone } : {})}>{m.text}</Badge>];
              })}
            />
          ) : (
            <>
              <p className="muted small">From the catalog (each shard reports after a migration and hourly while active). The live status wakes each shard it asks: up to 50, on demand.</p>
              <Table
                label="Pending migrations"
                empty={`All ${fmtNum(shards.data.shards.length)} shards of the catalog reported the deployed schema.`}
                cols={[{ h: "Shard" }, { h: "Reported schema" }, { h: "State" }]}
                rows={behind.slice(0, 50).map((r) => {
                  const m = catalogState(r, shards.data?.expected);
                  return [<Mono>{r.shard}</Mono>, <Mono>{short(r.schema_version)}</Mono>, <Badge {...(m.tone ? { tone: m.tone } : {})}>{m.text}</Badge>];
                })}
              />
            </>
          )}
        </Section>
      </div>
    </>
  );
}
