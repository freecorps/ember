// The audit log: every write made through the dashboard (and every refused attempt), newest first.

import { useEffect, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { ago, fmtTime } from "../format.ts";
import { Badge, Dialog, JsonView, Loading, Mono, Problem, Table } from "../ui.tsx";
import type { AuditEntry } from "./types.ts";

const TONE = { ok: "ok", error: "bad", denied: "warn", started: "info" } as const;

export function Audit({ project, env }: { project?: string; env?: string }) {
  const [pages, setPages] = useState<AuditEntry[][]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const [n, setN] = useState(0);

  const load = async (before: number | null, reset: boolean) => {
    setLoading(true);
    try {
      const r = await api.get<{ entries: AuditEntry[]; next: number | null }>(path("/api/audit", { project, env, before, limit: 100 }));
      setPages((p) => (reset ? [r.entries] : [...p, r.entries]));
      setNext(r.entries.length === 100 ? r.next : null);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(null, true);
  }, [project, env, n]);

  const rows = pages.flat();
  let args: unknown = null;
  try {
    args = open?.args ? JSON.parse(open.args) : null;
  } catch {
    args = open?.args;
  }
  return (
    <>
      <div className="toolbar">
        <span className="muted small">{project ? `Writes to ${project}/${env} through the dashboard, and refused attempts.` : "Every write through the dashboard, all projects."}</span>
        <span className="spacer" />
        <button type="button" onClick={() => setN((x) => x + 1)}>
          Refresh
        </button>
      </div>
      {error ? (
        <Problem error={error} onRetry={() => setN((x) => x + 1)} />
      ) : loading && !rows.length ? (
        <Loading lines={6} />
      ) : (
        <>
          <Table
            label="Audit log"
            empty="No writes yet."
            onRow={(i) => setOpen(rows[i]!)}
            cols={[{ h: "When" }, { h: "Who" }, { h: "Action" }, ...(project ? [] : [{ h: "Project" }]), { h: "Target" }, { h: "Outcome" }, { h: "Error" }]}
            rows={rows.map((r) => [
              <span title={fmtTime(r.at)}>{ago(r.at)}</span>,
              <span>
                {r.actor} {r.role === "read" && <span className="muted">(read)</span>}
              </span>,
              <Mono>{r.action}</Mono>,
              ...(project ? [] : [r.project ? `${r.project}/${r.env}` : "—"]),
              r.target ? <Mono>{r.target}</Mono> : "—",
              <Badge tone={TONE[r.outcome] ?? "info"}>{r.outcome}</Badge>,
              <span className="muted">{r.error ?? ""}</span>,
            ])}
          />
          {next && (
            <div className="toolbar">
              <button type="button" disabled={loading} onClick={() => void load(next, false)}>
                Older entries
              </button>
            </div>
          )}
        </>
      )}
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? `Audit #${open.id}` : ""}>
        {open && (
          <div className="dialog-body">
            <dl className="kv">
              <dt>When</dt>
              <dd>{fmtTime(open.at)}</dd>
              <dt>Who</dt>
              <dd>
                {open.actor} · {open.via} · {open.role}
              </dd>
              <dt>Where</dt>
              <dd>{[open.project, open.env, open.shard].filter(Boolean).join(" / ") || "—"}</dd>
              <dt>Action</dt>
              <dd>
                <Mono>{open.action}</Mono> {open.target && <Mono>{open.target}</Mono>}
              </dd>
              <dt>Outcome</dt>
              <dd>
                <Badge tone={TONE[open.outcome] ?? "info"}>{open.outcome}</Badge> {open.status ?? ""} {open.error ?? ""}
              </dd>
            </dl>
            <h3>Arguments (secrets removed)</h3>
            <JsonView value={args} />
          </div>
        )}
      </Dialog>
    </>
  );
}
