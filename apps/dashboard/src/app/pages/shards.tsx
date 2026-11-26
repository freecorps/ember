// Shards of an environment (the catalog; live status on demand) and one shard's detail: status, live counters, bookmarks with
// "record now" and "restore to this" (admin; typed confirmation on protected environments).

import { useEffect, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { ago, fmtBytes, fmtNum, fmtTime, short } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Empty, Loading, Mono, Problem, Section, Stat, Table } from "../ui.tsx";
import { catalogState, migrationState, statusPath } from "./health.tsx";
import type { Bookmark, ShardRow, StatusBody } from "./types.ts";

/** How long the filter waits after the last keystroke (each search is one D1 query; no shard is woken). */
export const SHARD_SEARCH_DEBOUNCE_MS = 250;

export function Shards({ project, env, shard }: { project: string; env: string; shard?: string }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), SHARD_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);
  // The catalog (D1) only: typing, paging and opening the screen never wake a shard. The live status of the listed
  // shards (up to 50 Durable Objects) is asked for by the button; the detail of a selected shard asks for its own.
  const list = useApi<{ shards: ShardRow[]; expected?: string | null }>(path("/api/shards", { project, env, q: term }));
  const rows = list.data?.shards ?? [];
  const [check, setCheck] = useState<string[] | null>(null);
  const status = useApi<StatusBody>(check?.length ? statusPath(project, env, check) : null);
  const live = new Map((status.data?.shards ?? []).map((s) => [s.shard, s]));
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
          <button
            type="button"
            disabled={!rows.length || status.loading}
            title="Asks the project for the live status of the listed shards (wakes up to 50 Durable Objects)"
            onClick={() => {
              const names = rows.slice(0, 50).map((r) => r.shard);
              if (check && check.join("\n") === names.join("\n")) status.reload();
              else setCheck(names);
            }}
          >
            {status.loading ? "Checking…" : "Check live status"}
          </button>
        </div>
        {status.error && <Problem error={status.error} onRetry={status.reload} />}
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
              // A live answer from before a deploy (another expected schema) no longer says anything: the catalog does.
              const fresh = live.get(s.shard);
              const st = fresh && (!list.data?.expected || fresh.expectedVersion === list.data.expected) ? fresh : undefined;
              const m = st ? migrationState(st) : catalogState(s, list.data?.expected);
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
