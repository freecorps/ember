// Deployments and crons of an environment; the account's projects.

import { useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { ago, fmtNum, fmtTime, short } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Empty, Loading, Mono, Problem, Section, Table } from "../ui.tsx";
import type { Project } from "./types.ts";

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

interface JobRow {
  id: number;
  job_id: string | null;
  fn: string;
  args: string;
  kind: string;
  state: string;
  run_at: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

/** A schedule action waiting for its confirmation. */
type Pending = { title: string; label: string; body: string; run: () => Promise<unknown>; done: string };

export function Crons({ project, env, shard }: { project: string; env: string; shard?: string }) {
  const s = useSession();
  const crons = useApi<{ crons: Cron[] }>(path("/api/crons", { project, env }));
  const target = shard ?? "global:main";
  const jobs = useApi<{ rows: JobRow[] }>(path("/api/data", { project, env, shard: target, table: "_jobs", limit: 100 }));
  const history = useApi<{ runs: Array<{ t: number; fn: string; shard: string; status: string; code: string; ms: number }> }>(s.me.metrics ? path("/api/jobs/history", { project, env, hours: 24 }) : null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ask = (p: Pending) => {
    setError(null);
    setPending(p);
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await pending.run();
      s.toast({ text: pending.done });
      setPending(null);
      jobs.reload();
      crons.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const argsOf = (j: JobRow): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(j.args);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
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
            cols={[{ h: "Name" }, { h: "Schedule" }, { h: "Function" }, { h: "Shard" }, { h: "Last dispatch" }, { h: "Last error" }, { h: "" }]}
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
              s.isAdmin ? (
                <button
                  type="button"
                  className="small"
                  onClick={() =>
                    ask({
                      title: `Run ${c.name} now?`,
                      label: "Run now",
                      body: `${c.fn} is scheduled now on ${c.shard}, with the cron's arguments. The regular schedule is unchanged.`,
                      run: () => api.post("/api/crons/run", { project, env, name: c.name }),
                      done: `${c.name} scheduled now`,
                    })
                  }
                >
                  Run now
                </button>
              ) : null,
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
            cols={[{ h: "Job" }, { h: "Function" }, { h: "Kind" }, { h: "State" }, { h: "Run at" }, { h: "Attempts", num: true }, { h: "Last error" }, { h: "" }]}
            rows={jobs.data.rows.map((j) => [
              <Mono>{short(String(j.job_id ?? j.id), 16)}</Mono>,
              <Mono>{String(j.fn)}</Mono>,
              String(j.kind),
              <Badge {...(j.state === "failed" ? { tone: "bad" as const } : {})}>{String(j.state)}</Badge>,
              fmtTime(j.run_at),
              `${String(j.attempts)}/${String(j.max_attempts)}`,
              String(j.last_error ?? ""),
              s.isAdmin ? (
                <span className="row-actions">
                  {j.state !== "failed" && j.job_id && (
                    <button
                      type="button"
                      className="small"
                      onClick={() =>
                        ask({
                          title: "Cancel this job?",
                          label: "Cancel job",
                          body: `${j.fn} will not run. A run already in progress is not interrupted.`,
                          run: () => api.post("/api/jobs/cancel", { project, env, shard: target, id: j.job_id }),
                          done: `Cancelled ${j.job_id}`,
                        })
                      }
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    className="small"
                    onClick={() =>
                      ask({
                        title: `Run ${j.fn} again?`,
                        label: "Run again",
                        body: `A new job runs ${j.fn} now on ${target} with the same arguments.`,
                        run: () => api.post("/api/jobs/run", { project, env, shard: target, fn: j.fn, args: argsOf(j) }),
                        done: `${j.fn} scheduled again`,
                      })
                    }
                  >
                    Run again
                  </button>
                </span>
              ) : null,
            ])}
          />
        )}
      </Section>
      <Section title="History (24 h)" id="history" actions={<span className="muted small">job runs recorded in Analytics Engine, all shards</span>}>
        {!s.me.metrics ? (
          <Empty>Needs Analytics Engine.</Empty>
        ) : history.error ? (
          <Problem error={history.error} />
        ) : !history.data ? (
          <Loading />
        ) : (
          <Table
            label="Job history"
            empty="No job ran in the last 24 hours."
            cols={[{ h: "When" }, { h: "Function" }, { h: "Shard" }, { h: "Result" }, { h: "ms", num: true }]}
            rows={history.data.runs.map((r) => [
              <span title={fmtTime(r.t)}>{ago(r.t)}</span>,
              <Mono>{r.fn}</Mono>,
              <Mono>{r.shard}</Mono>,
              r.status === "error" ? <Badge tone="bad">{r.code || "error"}</Badge> : <Badge tone="ok">ok</Badge>,
              fmtNum(r.ms, 1),
            ])}
          />
        )}
      </Section>
      <ConfirmDialog open={!!pending} title={pending?.title ?? ""} confirmLabel={pending?.label ?? ""} busy={busy} error={error} onCancel={() => setPending(null)} onConfirm={() => void confirm()}>
        <p>{pending?.body}</p>
        <p className="muted">Recorded in the audit log.</p>
      </ConfirmDialog>
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
