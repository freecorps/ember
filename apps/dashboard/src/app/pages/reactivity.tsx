// Reactivity of one shard, live from its Durable Object (runtime reactivity.ts): every cached query with its
// subscribers, whether its result is shared by everyone or computed per user, how often commits re-ran it and how
// often that changed it, and on demand one profiled run (rows read against rows returned, and the same advice
// `ember dev` prints). Nothing here runs unless asked: the report is a few counters the shard already keeps.

import { useEffect, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { ago, fmtBytes, fmtNum, fmtTime } from "../format.ts";
import { useApi } from "../hooks.ts";
import { Badge, Dialog, Empty, Loading, Mono, Problem, Section, Stat, Table } from "../ui.tsx";

interface Entry {
  key: string;
  fn: string;
  args: string;
  shared: boolean;
  subscribers: number;
  returned: number;
  bytes: number;
  error: string | null;
  reads: string[];
  ranges: number;
  runs: number;
  changed: number;
  lastRunAt: number | null;
}

interface Report {
  shard: string | null;
  version: number;
  subscriptions: number;
  sockets: number;
  entries: Entry[];
  gates: number;
  stats: { reruns: number; debouncedReruns: number; identityRuns: number; splits: number; gateRuns: number; batches: number };
  commits: Array<{ version: number; at: number; reran: number; changed: number; ms: number }>;
}

interface Profile {
  fn: string;
  read: number;
  returned: number;
  profile: { scanned: number; filteredOut: number; collectRows: number; sql: number };
  identityRead: boolean;
  advice: Array<{ kind: string; message: string }>;
  error: string | null;
}

export function Reactivity({ project, env, shard }: { project: string; env: string; shard: string }) {
  const [auto, setAuto] = useState(false);
  const r = useApi<{ report: Report }>(path("/api/reactivity", { project, env, shard }));
  const [profiling, setProfiling] = useState<Entry | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<ApiError | null>(null);
  const { reload } = r;
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [auto, reload]);
  const report = r.data?.report;
  const perUser = report?.entries.filter((e) => !e.shared).length ?? 0;
  const avg = report?.commits.length ? report.commits.reduce((a, c) => a + c.reran, 0) / report.commits.length : 0;

  const runProfile = async (e: Entry) => {
    setProfiling(e);
    setProfile(null);
    setProfileError(null);
    try {
      setProfile((await api.get<{ profile: Profile }>(path("/api/reactivity/profile", { project, env, shard, key: e.key }))).profile);
    } catch (x) {
      setProfileError(x as ApiError);
    }
  };

  return (
    <>
      <div className="toolbar">
        <span className="muted small">
          Live from <Mono>{shard}</Mono> (this Durable Object instance, since it last started). Pick another shard in the top bar.
        </span>
        <span className="spacer" />
        <label className="inline">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> every 5 s
        </label>
        <button type="button" onClick={r.reload}>
          Refresh
        </button>
      </div>
      {r.error ? (
        <Problem error={r.error} onRetry={r.reload} />
      ) : !report ? (
        <Loading lines={6} />
      ) : (
        <>
          <div className="stats">
            <Stat label="Subscriptions" value={fmtNum(report.subscriptions)} hint={`${fmtNum(report.sockets)} sockets`} />
            <Stat label="Cached queries" value={fmtNum(report.entries.length)} hint={`${fmtNum(report.entries.length - perUser)} shared · ${fmtNum(perUser)} per user`} tone={perUser > report.entries.length / 2 && perUser > 5 ? "warn" : undefined} />
            <Stat label="Re-runs per commit" value={fmtNum(avg, 1)} hint={`last ${report.commits.length} commits`} />
            <Stat label="Re-runs since start" value={fmtNum(report.stats.reruns)} hint={`${fmtNum(report.stats.identityRuns)} read the identity · ${fmtNum(report.stats.splits)} splits`} />
            <Stat label="Access checks" value={fmtNum(report.stats.gateRuns)} hint={`${fmtNum(report.gates)} authorize gates`} />
          </div>
          <Section title="Cached queries" id="entries">
            <Table
              label="Cached queries"
              empty="No live subscription on this shard right now."
              cols={[{ h: "Query" }, { h: "Args" }, { h: "Result" }, { h: "Subs", num: true }, { h: "Re-runs", num: true }, { h: "Changed", num: true }, { h: "Returned", num: true }, { h: "Size", num: true }, { h: "Reads" }, { h: "" }]}
              rows={report.entries.map((e) => [
                <Mono>{e.fn}</Mono>,
                <Mono title={e.args}>{e.args.length > 40 ? `${e.args.slice(0, 40)}…` : e.args}</Mono>,
                e.error ? (
                  <Badge tone="bad" title={e.error}>
                    error
                  </Badge>
                ) : e.shared ? (
                  <Badge tone="ok" title="One result for every subscriber">
                    shared
                  </Badge>
                ) : (
                  <Badge tone="warn" title="Computed per signed-in user: the query reads ctx.auth">
                    per user
                  </Badge>
                ),
                fmtNum(e.subscribers),
                <span title={e.lastRunAt ? `last ${fmtTime(e.lastRunAt)}` : undefined}>{fmtNum(e.runs)}</span>,
                <span className={e.runs >= 10 && e.changed / e.runs < 0.2 ? "warn" : undefined} title="Re-runs whose value changed (sent to subscribers)">
                  {fmtNum(e.changed)}
                </span>,
                fmtNum(e.returned),
                fmtBytes(e.bytes),
                <span className="muted small" title={e.reads.join("\n")}>
                  {e.reads.slice(0, 2).join(", ")}
                  {e.reads.length > 2 ? ` +${e.reads.length - 2}` : ""}
                </span>,
                <button type="button" className="small" onClick={() => void runProfile(e)}>
                  Profile
                </button>,
              ])}
            />
          </Section>
          <Section title="Recent commits that re-ran queries" id="commits">
            {report.commits.length ? (
              <Table
                label="Recent commits"
                cols={[{ h: "Version", num: true }, { h: "When" }, { h: "Re-ran", num: true }, { h: "Changed", num: true }, { h: "ms", num: true }]}
                rows={report.commits.map((c) => [fmtNum(c.version), <span title={fmtTime(c.at)}>{ago(c.at)}</span>, fmtNum(c.reran), fmtNum(c.changed), fmtNum(c.ms, 2)])}
              />
            ) : (
              <Empty>No commit has re-run a query since this shard started.</Empty>
            )}
          </Section>
        </>
      )}
      <Dialog open={!!profiling} onClose={() => setProfiling(null)} title={profiling ? <Mono>{profiling.fn}</Mono> : ""}>
        <div className="dialog-body">
          {profileError ? (
            <Problem error={profileError} />
          ) : !profile ? (
            <Loading />
          ) : (
            <>
              <div className="stats compact">
                <Stat label="Rows read" value={fmtNum(profile.read)} tone={profile.read >= 1000 && profile.read > 20 * Math.max(1, profile.returned) ? "warn" : undefined} />
                <Stat label="Returned" value={fmtNum(profile.returned)} />
                <Stat label="Scanned" value={fmtNum(profile.profile.scanned)} hint={`${fmtNum(profile.profile.filteredOut)} dropped by .filter()`} />
                <Stat label="Result" value={profile.identityRead ? "per user" : "shared"} tone={profile.identityRead ? "warn" : "ok"} />
              </div>
              {profile.error && <p className="bad">{profile.error}</p>}
              <h3>Advice (same as ember dev)</h3>
              {profile.advice.length ? (
                <ul className="attention">
                  {profile.advice.map((a) => (
                    <li key={a.kind} className="warn">
                      {a.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Nothing to change in this run.</Empty>
              )}
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
