// Shards of an environment (catalog + live status) and one shard's detail: status, live counters, bookmarks with
// "record now" and "restore to this" (admin; typed confirmation on protected environments).

import { useEffect, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { ago, fmtBytes, fmtNum, fmtTime, short } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Empty, Loading, Mono, Problem, Section, Stat, Table } from "../ui.tsx";
import { migrationState } from "./health.tsx";
import type { Bookmark, ShardRow, StatusBody } from "./types.ts";

export function Shards({ project, env, shard }: { project: string; env: string; shard?: string }) {
  const [q, setQ] = useState("");
  // Debounced: every request with status=1 asks the project for the live status of up to 50 shards.
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const list = useApi<{ shards: ShardRow[]; status: StatusBody | { ok: false; status: number; error: string } | null }>(path("/api/shards", { project, env, status: 1, q: term }));
  const live = new Map((list.data?.status && "shards" in list.data.status ? list.data.status.shards : []).map((s) => [s.shard, s]));
  const rows = list.data?.shards ?? [];
  const selected = shard ? rows.findIndex((r) => r.shard === shard) : -1;
  return (
    <div className={shard ? "split" : undefined}>
      <div>
        <div className="toolbar">
          <input type="search" placeholder="Filter shards…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter shards" />
          <span className="muted small">Catalog: reported after each migration and hourly while active.</span>
          <button type="button" onClick={list.reload}>
            Refresh
          </button>
        </div>
        {list.error ? (
          <Problem error={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <Loading lines={6} />
        ) : (
          <Table
            label="Shards"
            empty={q ? "No shard matches." : "No shard has reported yet. Shards report to the catalog after their first migration."}
            selected={selected >= 0 ? selected : null}
            onRow={(i) => (location.hash = href({ project, env, section: "shards", shard: rows[i]!.shard }))}
            cols={[{ h: "Shard" }, { h: "Size", num: true }, { h: "Schema" }, { h: "Migration" }, { h: "Last write" }, { h: "Reported" }]}
            rows={rows.map((s) => {
              const st = live.get(s.shard);
              const m = migrationState(st);
              return [
                <Mono>{s.shard}</Mono>,
                fmtBytes(st?.databaseSize ?? s.db_size),
                <Mono>{short(st?.schemaVersion ?? s.schema_version)}</Mono>,
                <Badge {...(m.tone ? { tone: m.tone } : {})}>{m.text}</Badge>,
                ago(s.last_write),
                ago(s.reported_at),
              ];
            })}
          />
        )}
      </div>
      {shard && <ShardDetail key={shard} project={project} env={env} shard={shard} />}
    </div>
  );
}

interface Inspection {
  version: number;
  subs: number;
  queries: number;
  shared: number;
  stats: { reruns: number; identityRuns: number; batches: number; booted: number };
  rows: { read: number; written: number };
  jobs: unknown[];
  bookmarks: number;
}

function ShardDetail({ project, env, shard }: { project: string; env: string; shard: string }) {
  const s = useSession();
  const scope = { project, env, shard };
  const status = useApi<StatusBody>(path("/api/status", scope));
  const inspect = useApi<{ shard: Inspection }>(path("/api/inspect", scope));
  const marks = useApi<{ bookmarks: Bookmark[]; retentionMs: number; now: number }>(path("/api/bookmarks", scope));
  const [restore, setRestore] = useState<Bookmark | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const st = status.data?.shards[0];
  const m = migrationState(st);
  const i = inspect.data?.shard;

  const record = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ bookmark: Bookmark }>("/api/bookmark", { ...scope, label: "dashboard" });
      s.toast({ text: `Bookmark recorded on ${shard}`, detail: r.bookmark.bookmark });
      marks.reload();
    } catch (e) {
      s.toast({ kind: "bad", text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };
  const doRestore = async (typed: string | null) => {
    if (!restore) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ undo: string }>("/api/restore", { ...scope, bookmark: restore.bookmark, ...(typed ? { confirm: typed } : {}) });
      s.toast({ text: `${shard} restored to bookmark #${restore.id}. Undo bookmark:`, detail: r.undo });
      setRestore(null);
      marks.reload();
      status.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="detail" aria-label={`Shard ${shard}`}>
      <header className="detail-head">
        <h2>
          <Mono>{shard}</Mono>
        </h2>
        <a className="icon" href={href({ project, env, section: "shards" })} aria-label="Close shard detail">
          ×
        </a>
      </header>
      <div className="detail-links">
        <a href={href({ project, env, section: "data", shard })}>Browse data →</a>
      </div>
      {status.error ? (
        <Problem error={status.error} />
      ) : !st ? (
        <Loading lines={2} />
      ) : (
        <div className="stats compact">
          <Stat label="Migration" value={<Badge {...(m.tone ? { tone: m.tone } : {})}>{m.text}</Badge>} />
          <Stat label="Size" value={fmtBytes(st.databaseSize)} />
          <Stat label="Version" value={fmtNum(st.version)} hint="commits" />
          <Stat label="Schema" value={<Mono>{short(st.schemaVersion)}</Mono>} />
        </div>
      )}
      {st?.migrationError && (
        <div className="notice bad">
          <strong>{st.migrationError.code}</strong>
          <p>{st.migrationError.message}</p>
        </div>
      )}
      <Section title="Live" id="live">
        {inspect.error ? (
          <Problem error={inspect.error} />
        ) : !i ? (
          <Loading lines={2} />
        ) : (
          <dl className="kv">
            <dt>Subscriptions</dt>
            <dd>{fmtNum(i.subs)}</dd>
            <dt>Cached queries</dt>
            <dd>
              {fmtNum(i.queries)} <span className="muted">({fmtNum(i.shared)} shared)</span>
            </dd>
            <dt>Re-runs since boot</dt>
            <dd>{fmtNum(i.stats.reruns)}</dd>
            <dt>Rows read / written</dt>
            <dd>
              {fmtNum(i.rows.read)} / {fmtNum(i.rows.written)}
            </dd>
            <dt>Pending jobs</dt>
            <dd>{fmtNum(i.jobs.length)}</dd>
          </dl>
        )}
      </Section>
      <Section
        title="Bookmarks"
        id="bookmarks"
        actions={
          s.isAdmin && (
            <button type="button" onClick={record} disabled={busy}>
              Record bookmark
            </button>
          )
        }
      >
        {marks.error ? (
          <Problem error={marks.error} />
        ) : !marks.data ? (
          <Loading />
        ) : !marks.data.bookmarks.length ? (
          <Empty>No bookmarks yet. The shard records one at each deploy, migration and hour of activity.</Empty>
        ) : (
          <Table
            label="Bookmarks"
            cols={[{ h: "#", num: true }, { h: "When" }, { h: "Reason" }, { h: "" }]}
            rows={[...marks.data.bookmarks].reverse().slice(0, 50).map((b) => [
              fmtNum(b.id),
              <span title={fmtTime(b.at)}>{ago(b.at)}</span>,
              <Mono>{b.reason}</Mono>,
              s.isAdmin && b.bookmark ? (
                <button type="button" className="small" onClick={() => (setError(null), setRestore(b))}>
                  Restore…
                </button>
              ) : null,
            ])}
          />
        )}
      </Section>
      <ConfirmDialog
        open={!!restore}
        title={`Restore ${shard}?`}
        confirmLabel="Restore shard"
        danger
        expected={s.isProtected(env) ? shard : null}
        busy={busy}
        error={error}
        onCancel={() => setRestore(null)}
        onConfirm={doRestore}
      >
        {restore && (
          <>
            <p>
              Every write to <Mono>{shard}</Mono> after bookmark #{restore.id} ({fmtTime(restore.at)}, <Mono>{restore.reason}</Mono>) is undone. Connected clients resubscribe.
            </p>
            <p className="muted">The answer carries an undo bookmark that brings the current state back. This is recorded in the audit log.</p>
          </>
        )}
      </ConfirmDialog>
    </aside>
  );
}
