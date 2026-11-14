// Functions, deployments and crons of an environment; the account's projects.

import { useState } from "react";
import { path } from "../api.ts";
import { ago, fmtBytes, fmtNum, fmtPct, fmtTime, short, windowLabel, windows } from "../format.ts";
import { href, useApi } from "../hooks.ts";
import { Badge, Empty, Loading, Mono, Problem, Section, Table } from "../ui.tsx";
import type { FunctionRow, Project } from "./types.ts";

/** What p50/p95 measure per timing label (@freecorps/ember-runtime metrics.ts). */
const TIMING_HELP: Record<string, string> = {
  rpc: "Wall time in the Worker around the RPC to the shard (hop + queue + execution + durable commit)",
  commit: "Wall time in the Durable Object from receipt to durable commit (group commit + execution + durability)",
  wall: "Action wall time in the Worker (I/O included)",
  none: "Not measurable in production (synchronous inside the Durable Object): 0",
  "": "Recorded before timing labels: 0 ms for queries/mutations in production",
};

export function Functions({ project, env }: { project: string; env: string }) {
  const [hours, setHours] = useState(24);
  const [q, setQ] = useState("");
  const { data, error, reload } = useApi<{ functions: FunctionRow[] }>(path("/api/functions", { project, env, hours }));
  const rows = (data?.functions ?? []).filter((f) => !q || f.fn.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder="Filter functions…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter functions" />
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
        <button type="button" onClick={reload}>
          Refresh
        </button>
      </div>
      {error ? (
        <Problem error={error} onRetry={reload} />
      ) : !data ? (
        <Loading lines={6} />
      ) : (
        <Table
          label="Functions"
          empty={q ? "No function matches." : "No executions recorded in this window (Analytics Engine can take a minute to show new points)."}
          cols={[{ h: "Function" }, { h: "Kind" }, { h: "Timing" }, { h: "Calls", num: true }, { h: "Errors", num: true }, { h: "p50 ms", num: true }, { h: "p95 ms", num: true }, { h: "Rows read/call", num: true }, { h: "Rows written", num: true }, { h: "Bytes out", num: true }]}
          rows={rows.map((f) => [
            <Mono>{f.fn}</Mono>,
            f.kind,
            <span title={TIMING_HELP[f.timing] ?? TIMING_HELP[""]}>{f.timing || "—"}</span>,
            fmtNum(f.calls),
            <span className={f.errorRate > 0.01 ? "bad" : ""}>
              {fmtNum(f.errors)} <span className="muted">({fmtPct(f.errorRate)})</span>
            </span>,
            fmtNum(f.p50, 2),
            fmtNum(f.p95, 2),
            <span className={f.avgRowsRead > 1000 ? "warn" : ""}>{fmtNum(f.avgRowsRead, 1)}</span>,
            fmtNum(f.rowsWritten),
            fmtBytes(f.bytesOut),
          ])}
        />
      )}
    </>
  );
}

export function Deployments({ project, env }: { project: string; env: string }) {
  const { data, error, reload } = useApi<{ deployments: Array<Record<string, unknown>> }>(path("/api/deployments", { project, env }));
  if (error) return <Problem error={error} onRetry={reload} />;
  if (!data) return <Loading lines={5} />;
  return (
    <Table
      label="Deployments"
      empty="No deployments recorded."
      cols={[{ h: "When" }, { h: "Version" }, { h: "Strategy" }, { h: "Schema" }, { h: "Message" }]}
      rows={data.deployments.map((d) => [
        <span title={fmtTime(d.at)}>{ago(d.at)}</span>,
        <Mono>{short(d.version_id, 8)}</Mono>,
        String(d.strategy ?? "—"),
        <Mono>{short(d.schema_version)}</Mono>,
        String(d.message ?? ""),
      ])}
    />
  );
}

interface Cron {
  name: string;
  schedule: string;
  tz?: string;
  fn: string;
  shard: string;
  state: { last_dispatch?: number; last_error?: string | null } | null;
}

export function Crons({ project, env, shard }: { project: string; env: string; shard?: string }) {
  const crons = useApi<{ crons: Cron[] }>(path("/api/crons", { project, env }));
  const target = shard ?? "global:main";
  const jobs = useApi<{ rows: Array<Record<string, unknown>> }>(path("/api/data", { project, env, shard: target, table: "_jobs", limit: 100 }));
  return (
    <>
      <Section title="Crons" id="crons">
        {crons.error ? (
          <Problem error={crons.error} onRetry={crons.reload} />
        ) : !crons.data ? (
          <Loading />
        ) : (
          <Table
            label="Crons"
            empty={
              <>
                No crons. Declare them in <code>ember/crons.ts</code>.
              </>
            }
            cols={[{ h: "Name" }, { h: "Schedule" }, { h: "Function" }, { h: "Shard" }, { h: "Last dispatch" }, { h: "Last error" }]}
            rows={crons.data.crons.map((c) => [
              c.name,
              <Mono>
                {c.schedule}
                {c.tz ? ` (${c.tz})` : ""}
              </Mono>,
              <Mono>{c.fn}</Mono>,
              <Mono>{c.shard}</Mono>,
              c.state?.last_dispatch ? fmtTime(c.state.last_dispatch * 60_000) : "—",
              c.state?.last_error ? <span className="bad">{c.state.last_error}</span> : "",
            ])}
          />
        )}
      </Section>
      <Section
        title={
          <>
            Jobs on <Mono>{target}</Mono>
          </>
        }
        id="jobs"
        actions={<span className="muted small">Pick another shard in the top bar.</span>}
      >
        {jobs.error ? (
          <Problem error={jobs.error} onRetry={jobs.reload} />
        ) : !jobs.data ? (
          <Loading />
        ) : (
          <Table
            label="Jobs"
            empty="No pending or failed jobs on this shard."
            cols={[{ h: "Job" }, { h: "Function" }, { h: "Kind" }, { h: "State" }, { h: "Run at" }, { h: "Attempts", num: true }, { h: "Last error" }]}
            rows={jobs.data.rows.map((j) => [
              <Mono>{short(String(j.job_id ?? j.id), 16)}</Mono>,
              <Mono>{String(j.fn)}</Mono>,
              String(j.kind),
              <Badge {...(j.state === "failed" ? { tone: "bad" as const } : {})}>{String(j.state)}</Badge>,
              fmtTime(j.run_at),
              `${String(j.attempts)}/${String(j.max_attempts)}`,
              String(j.last_error ?? ""),
            ])}
          />
        )}
      </Section>
    </>
  );
}

export function Projects() {
  const { data, error, reload } = useApi<{ projects: Project[] }>("/api/projects");
  if (error) return <Problem error={error} onRetry={reload} />;
  if (!data) return <Loading lines={4} />;
  if (!data.projects.length)
    return (
      <Empty>
        No projects yet. Run <code>ember deploy</code> in a project: it registers itself here.
      </Empty>
    );
  return (
    <>
      <h1 className="page-title">Projects</h1>
      {data.projects.map((p) => (
        <Section key={p.name} title={p.name} id={`p-${p.name}`} actions={p.repo ? <span className="muted small">{p.repo}</span> : undefined}>
          <Table
            label={`${p.name} environments`}
            onRow={(i) => (location.hash = href({ project: p.name, env: p.envs[i]!.env }))}
            cols={[{ h: "Environment" }, { h: "Worker" }, { h: "URL" }, { h: "Schema" }, { h: "Shards", num: true }, { h: "Last deploy" }]}
            rows={p.envs.map((e) => [
              <a href={href({ project: p.name, env: e.env })}>{e.env}</a>,
              <Mono>{e.worker}</Mono>,
              e.url && /^https:\/\//.test(e.url) ? (
                <a href={e.url} target="_blank" rel="noreferrer noopener" onClick={(ev) => ev.stopPropagation()}>
                  {e.url.replace(/^https:\/\//, "")}
                </a>
              ) : (
                "—"
              ),
              <Mono>{short(e.schema_version)}</Mono>,
              fmtNum(e.shards),
              ago(e.last_deploy),
            ])}
          />
          {p.domains.length > 0 && <p className="muted small">Domains: {p.domains.map((d) => `${d.host} (${d.env})`).join(", ")}</p>}
        </Section>
      ))}
    </>
  );
}
