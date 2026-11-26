// Replication & Outbox: each replication source of the project (the Auth DO for org tables, `global:main` for
// `.replicated()` tables) with its outbox and its targets — how far each target acknowledged (its seq against the
// source's), what still waits and since when, retries against `maxAttempts`, parked targets and the last error — and a
// resync of one target (admin, confirmed, audited as replica.resync). Runtime admin `GET /api/_ember/replicas`;
// the outbox depth, the oldest waiting row and maxAttempts need admin API level 18 (`replicas/lag`).

import { useMemo, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { ago, fmtNum, fmtTime } from "../format.ts";
import { useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Empty, Loading, Mono, Problem, Section, Stat, Table } from "../ui.tsx";

interface TargetRow {
  target: string;
  last_seq: number;
  /** `global:main` only: how far the drain read the log for this target. */
  scan_seq?: number;
  snapshot: number;
  attempts: number;
  next_at: number;
  dead: number;
  last_error: string | null;
  delivered_at: number | null;
  pending: number;
  /** Level 18. */
  oldest_at?: number | null;
}

interface SourceStatus {
  enabled: boolean;
  journal: number;
  convert?: { failures: number; retryAt: number; error: string } | null;
  seq?: number;
  targets: TargetRow[];
  next: number | null;
  /** Level 18. */
  outbox?: { seq: number; depth: number; parked: number; oldestAt: number | null };
  maxAttempts?: number;
}

interface ReplicasBody {
  tables: Array<{ name: string; source: string }>;
  sources: Record<string, SourceStatus>;
}

/** Targets the runtime lists per source (parked and retrying first). */
const TARGETS_LISTED = 100;

const SOURCE_LABEL: Record<string, string> = { auth: "Auth DO (organizations)", "global:main": "global:main (.replicated() tables)" };

const age = (at: number | null | undefined) => (typeof at === "number" && at > 0 ? ago(at).replace(/ ago$/, "") : "—");

function state(t: TargetRow, max: number | undefined): { label: string; tone: "ok" | "bad" | "warn" | "info" | undefined; title?: string } {
  if (t.dead) return { label: "parked", tone: "bad", title: `Failed ${t.attempts}${max ? ` of ${max}` : ""} attempts; waits for a resync` };
  if (t.snapshot) return { label: "resync queued", tone: "info" };
  if (t.attempts > 0) return { label: `retrying ${t.attempts}${max ? `/${max}` : ""}`, tone: "warn", title: `Next attempt ${fmtTime(t.next_at)}` };
  if (t.pending > 0) return { label: "delivering", tone: "info" };
  return { label: "in sync", tone: "ok" };
}

export function Replication({ project, env }: { project: string; env: string }) {
  const s = useSession();
  const data = useApi<ReplicasBody>(path("/api/replicas", { project, env }));
  const [q, setQ] = useState("");
  const [resync, setResync] = useState<{ source: string; target: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const sources = useMemo(() => Object.entries(data.data?.sources ?? {}), [data.data]);
  const tablesOf = (source: string) => (data.data?.tables ?? []).filter((t) => t.source === source).map((t) => t.name);
  const lagFields = sources.some(([, v]) => v.outbox !== undefined);

  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder="Filter targets…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter targets" />
        <span className="spacer" />
        <button type="button" onClick={data.reload} disabled={data.loading}>
          Refresh
        </button>
      </div>
      {data.error ? (
        <Problem error={data.error} onRetry={data.reload} />
      ) : !data.data ? (
        <Loading lines={5} />
      ) : !sources.length ? (
        <Empty>No replication in this deployment: no .replicated() tables and no organization replication from auth (ember.replicate in auth.config.ts).</Empty>
      ) : (
        <>
          {!lagFields && (
            <div className="notice info">
              <strong>Outbox depth, oldest pending age and maxAttempts need a newer runtime</strong>
              <p className="muted">
                This runtime predates admin API level 18. Run <code>npm i @freecorps/ember-runtime@latest</code> and <code>ember deploy</code>; targets and resync work meanwhile.
              </p>
            </div>
          )}
          {sources.map(([name, src]) => (
            <SourcePanel
              key={name}
              name={name}
              src={src}
              tables={tablesOf(name)}
              filter={q.trim()}
              canResync={s.isAdmin}
              onResync={(target) => (setError(null), setResync({ source: name, target }))}
            />
          ))}
        </>
      )}
      <ConfirmDialog
        open={!!resync}
        title={`Resync ${resync?.target ?? ""}?`}
        confirmLabel="Resync"
        busy={busy}
        error={error}
        onCancel={() => setResync(null)}
        onConfirm={async () => {
          if (!resync) return;
          setBusy(true);
          try {
            const r = await api.post<{ value: Record<string, { ok: boolean; targets?: number; error?: string }> }>("/api/replicas/resync", { project, env, shard: resync.target, source: resync.source });
            const out = r.value?.[resync.source];
            if (out && out.ok === false) throw new ApiError(409, "resync_refused", out.error ?? "the source refused the resync");
            s.toast({ text: `Resync of ${resync.target} queued`, detail: `from ${resync.source}` });
            setResync(null);
            data.reload();
          } catch (e) {
            setError(e as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          <Mono>{resync?.source}</Mono> re-reads every row <Mono>{resync?.target}</Mono> should hold and replaces its replica rows with them; the deltas queued meanwhile apply on top. It clears a parked target. Recorded in the audit log.
        </p>
      </ConfirmDialog>
    </>
  );
}

function SourcePanel({ name, src, tables, filter, canResync, onResync }: { name: string; src: SourceStatus; tables: string[]; filter: string; canResync: boolean; onResync: (target: string) => void }) {
  const seq = src.outbox?.seq ?? src.seq;
  const targets = src.targets.filter((t) => !filter || t.target.includes(filter));
  const parked = src.targets.filter((t) => t.dead).length;
  const max = src.maxAttempts;
  return (
    <Section
      id={`source-${name}`}
      title={
        <>
          Source <Mono>{name}</Mono> <span className="muted small">{SOURCE_LABEL[name] ?? ""}</span>
        </>
      }
      actions={tables.length ? <span className="muted small">tables: {tables.join(", ")}</span> : undefined}
    >
      {!src.enabled ? (
        <Empty>Replication is not enabled for this source.</Empty>
      ) : (
        <>
          <div className="stats" aria-label={`Outbox of ${name}`}>
            <Stat label="Outbox depth" value={src.outbox ? fmtNum(src.outbox.depth) : "—"} tone={src.outbox && src.outbox.depth > 1000 ? "warn" : undefined} hint={name === "global:main" ? "log rows kept" : "rows waiting"} />
            <Stat label="Oldest pending" value={src.outbox ? age(src.outbox.oldestAt) : "—"} tone={src.outbox?.oldestAt && Date.now() - src.outbox.oldestAt > 5 * 60_000 ? "warn" : undefined} hint={src.outbox?.oldestAt ? fmtTime(src.outbox.oldestAt) : undefined} />
            <Stat label="Source seq" value={seq === undefined ? "—" : fmtNum(seq)} />
            <Stat label="Parked" value={fmtNum(parked)} tone={parked ? "bad" : undefined} hint={name !== "global:main" && src.outbox?.parked ? `targets; ${fmtNum(src.outbox.parked)} rows kept for inspection` : "targets"} />
            <Stat label="maxAttempts" value={max === undefined ? "—" : fmtNum(max)} hint="before a batch is parked" />
            {src.journal > 0 && <Stat label="Journal" value={fmtNum(src.journal)} hint="changes not converted yet" />}
          </div>
          {src.convert && (
            <div className="notice bad" role="alert">
              <strong>Journal conversion failing</strong>
              <p>
                {fmtNum(src.convert.failures)} failures in a row, next try {fmtTime(src.convert.retryAt)}: <span className="err-text">{src.convert.error}</span>
              </p>
            </div>
          )}
          <Table
            label={`Targets of ${name}`}
            empty={filter ? "No target matches." : "No targets yet."}
            rowKeys={targets.map((t) => t.target)}
            cols={[{ h: "Target" }, { h: "Acked seq", num: true }, { h: "Lag" }, { h: "State" }, { h: "Last error" }, { h: "Delivered" }, { h: "" }]}
            rows={targets.map((t) => {
              const st = state(t, max);
              return [
                <Mono>{t.target}</Mono>,
                <span title={seq !== undefined ? `source seq ${seq}` : undefined}>
                  {fmtNum(t.last_seq)}
                  {seq !== undefined && <span className="muted"> / {fmtNum(seq)}</span>}
                </span>,
                <span className={`lag${t.pending ? " warn" : ""}`}>
                  {t.pending ? `${fmtNum(t.pending)} pending` : "0 pending"}
                  {t.oldest_at ? <span className="muted"> · oldest {age(t.oldest_at)}</span> : null}
                </span>,
                <Badge tone={st.tone} title={st.title}>
                  {st.label}
                </Badge>,
                t.last_error ? <span className="err-text">{t.last_error}</span> : <span className="muted">—</span>,
                <span title={fmtTime(t.delivered_at)}>{ago(t.delivered_at)}</span>,
                canResync ? (
                  <button type="button" onClick={() => onResync(t.target)} aria-label={`Resync ${t.target}`}>
                    Resync
                  </button>
                ) : (
                  ""
                ),
              ];
            })}
          />
          {src.targets.length >= TARGETS_LISTED && <p className="muted small">The first {TARGETS_LISTED} targets (parked and retrying first).</p>}
        </>
      )}
    </Section>
  );
}
