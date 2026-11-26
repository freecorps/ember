// Storage cleanup: objects of the files bucket that no `_files` row references (R2 orphans, the whole bucket, a
// bounded page of the bucket per scan), and the shard's `_files` rows stuck short of `ready` (failed uploads,
// abandoned pending ones). Listing is read-only for every role; deleting is admin, confirmed (typed on protected
// environments), audited, and checked again by the project at delete time: an object a `_files` row has, or a file a
// document references, is never deleted whatever this page listed.

import { useEffect, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { ago, fmtBytes, fmtNum, fmtTime } from "../format.ts";
import { useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Loading, Mono, Problem, Section, Stat, Table } from "../ui.tsx";

interface OrphanPage {
  scanned: number;
  foreign: number;
  young: number;
  orphans: Array<{ key: string; shard: string; size: number; uploaded: number }>;
  deleted: number;
  skipped: Array<{ shard: string; keys: number; code: string; message: string }>;
  graceMs: number;
  cursor: string | null;
  done: boolean;
}

interface OrphanDelete {
  deleted: Array<{ key: string; shard: string; size: number }>;
  refused: Array<{ key: string; reason: string }>;
  skipped: Array<{ shard: string; keys: number; code: string; message: string }>;
}

interface StuckRow {
  id: string;
  state: string;
  key: string;
  size: number | null;
  contentType: string | null;
  refcount: number;
  createdAt: number;
}

interface StuckPage {
  rows: StuckRow[];
  cursor: string | null;
  done: boolean;
  totals?: { count: number; bytes: number; referenced: number };
  graceMs: number;
}

const HOUR = 3_600_000;
const GRACES = [
  { ms: HOUR, label: "1 hour" },
  { ms: 24 * HOUR, label: "24 hours" },
  { ms: 7 * 24 * HOUR, label: "7 days" },
];
/** Objects listed per scan (one bounded `list` call of the bucket). */
const SCAN_PAGE = 500;
/** Keys or ids per delete (the runtime's limit). */
const DELETE_MAX = 100;

const REASONS: Record<string, string> = { referenced: "a file row has it", young: "newer than the grace period", gone: "already gone", foreign: "not an Ember key", not_found: "no such row", not_stuck: "not stuck any more" };

export function Storage({ project, env, shard }: { project: string; env: string; shard: string }) {
  const [graceMs, setGrace] = useState(24 * HOUR);
  return (
    <>
      <div className="toolbar">
        <label className="inline">
          Grace period
          <select value={graceMs} onChange={(e) => setGrace(Number(e.target.value))} aria-label="Grace period">
            {GRACES.map((g) => (
              <option key={g.ms} value={g.ms}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">Nothing newer than this is listed or deleted (uploads in flight, imports between the object and its row).</span>
      </div>
      <Orphans key={`o${graceMs}`} project={project} env={env} graceMs={graceMs} />
      <Stuck key={`s${shard}/${graceMs}`} project={project} env={env} shard={shard} graceMs={graceMs} />
    </>
  );
}

function Orphans({ project, env, graceMs }: { project: string; env: string; graceMs: number }) {
  const s = useSession();
  const [found, setFound] = useState<OrphanPage["orphans"]>([]);
  const [scan, setScan] = useState<{ pages: number; scanned: number; foreign: number; young: number; cursor: string | null; done: boolean; skipped: OrphanPage["skipped"] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);
  const [outcome, setOutcome] = useState<OrphanDelete | null>(null);

  const next = async (restart: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const cursor = restart ? null : (scan?.cursor ?? null);
      const r = await api.get<{ value: OrphanPage }>(path("/api/files/orphans", { project, env, graceMs, limit: SCAN_PAGE, cursor }));
      const p = r.value;
      const base = restart || !scan ? { pages: 0, scanned: 0, foreign: 0, young: 0, skipped: [] as OrphanPage["skipped"] } : scan;
      setScan({ pages: base.pages + 1, scanned: base.scanned + p.scanned, foreign: base.foreign + p.foreign, young: base.young + p.young, skipped: [...base.skipped, ...p.skipped], cursor: p.cursor, done: p.done });
      setFound((f) => (restart ? p.orphans : [...f, ...p.orphans.filter((o) => !f.some((x) => x.key === o.key))]));
      if (restart) setPicked(new Set());
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const bytes = found.reduce((n, o) => n + o.size, 0);
  const pickedList = found.filter((o) => picked.has(o.key));
  const pickedBytes = pickedList.reduce((n, o) => n + o.size, 0);
  const all = found.length > 0 && found.slice(0, DELETE_MAX).every((o) => picked.has(o.key));
  const toggle = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else if (n.size < DELETE_MAX) n.add(key);
      return n;
    });

  return (
    <Section
      id="orphans"
      title="R2 orphans"
      actions={
        <>
          <button type="button" className="primary" disabled={busy} onClick={() => void next(true)}>
            {busy && !scan ? "Scanning…" : scan ? "Scan again" : "Scan bucket"}
          </button>
          {scan && !scan.done && (
            <button type="button" disabled={busy} onClick={() => void next(false)}>
              {busy ? "Scanning…" : "Scan next page"}
            </button>
          )}
        </>
      }
    >
      <p className="muted small hint">
        Objects of the whole files bucket that no <code>_files</code> row of their shard references. Each scan lists {fmtNum(SCAN_PAGE)} objects (one bounded R2 list call) and asks their shards; the project's own sweep is <code>ember files orphans</code>.
      </p>
      {error && <Problem error={error} />}
      {scan && (
        <div className="stats" aria-label="Orphan totals">
          <Stat label="Orphans found" value={fmtNum(found.length)} tone={found.length ? "warn" : "ok"} />
          <Stat label="Orphan size" value={fmtBytes(bytes)} />
          <Stat label="Objects scanned" value={fmtNum(scan.scanned)} hint={`${fmtNum(scan.pages)} page${scan.pages === 1 ? "" : "s"}${scan.done ? ", whole bucket" : ", more to scan"}`} />
          <Stat label="Left alone" value={fmtNum(scan.young + scan.foreign)} hint={`${fmtNum(scan.young)} too young, ${fmtNum(scan.foreign)} not Ember's`} />
        </div>
      )}
      {scan?.skipped.map((k) => (
        <div key={k.shard} className="notice warn">
          <strong>
            {k.shard} could not answer ({k.code})
          </strong>
          <p>
            {fmtNum(k.keys)} of its objects were left alone: {k.message}
          </p>
        </div>
      ))}
      {outcome && (
        <div className={`notice ${outcome.refused.length || outcome.skipped.length ? "warn" : "info"}`} role="status">
          <strong>
            Deleted {fmtNum(outcome.deleted.length)} object{outcome.deleted.length === 1 ? "" : "s"} ({fmtBytes(outcome.deleted.reduce((n, d) => n + d.size, 0))})
          </strong>
          {outcome.refused.map((r) => (
            <p key={r.key} className="small">
              <Mono>{r.key}</Mono> kept: {REASONS[r.reason] ?? r.reason}
            </p>
          ))}
          {outcome.skipped.map((k) => (
            <p key={k.shard} className="small">
              {k.shard}: {k.message}
            </p>
          ))}
        </div>
      )}
      {!scan ? null : (
        <>
          <Table
            label="Orphans"
            empty={scan.done ? "No orphans in the bucket." : "No orphans in what was scanned so far."}
            rowKeys={found.map((o) => o.key)}
            cols={[
              {
                h: s.isAdmin ? <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(found.slice(0, DELETE_MAX).map((o) => o.key)))} aria-label="Select all orphans" /> : "",
              },
              { h: "Object key" },
              { h: "Shard" },
              { h: "Size", num: true },
              { h: "Uploaded" },
            ]}
            rows={found.map((o) => [
              s.isAdmin ? <input type="checkbox" checked={picked.has(o.key)} onChange={() => toggle(o.key)} aria-label={`Select ${o.key}`} /> : "",
              <Mono>{o.key}</Mono>,
              <Mono>{o.shard}</Mono>,
              fmtBytes(o.size),
              <span title={fmtTime(o.uploaded)}>{ago(o.uploaded)}</span>,
            ])}
          />
          {s.isAdmin && found.length > 0 && (
            <div className="toolbar">
              <span className="muted small">
                {fmtNum(pickedList.length)} selected ({fmtBytes(pickedBytes)}){found.length > DELETE_MAX ? `, up to ${DELETE_MAX} per delete` : ""}
              </span>
              <span className="spacer" />
              <button type="button" className="danger" disabled={!pickedList.length} onClick={() => (setDeleteError(null), setConfirming(true))}>
                Delete selected…
              </button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Delete ${pickedList.length} orphan${pickedList.length === 1 ? "" : "s"}?`}
        confirmLabel="Delete objects"
        danger
        expected={s.isProtected(env) ? "orphans" : null}
        busy={deleting}
        error={deleteError}
        onCancel={() => setConfirming(false)}
        onConfirm={async (typed) => {
          setDeleting(true);
          try {
            const r = await api.post<{ value: OrphanDelete }>("/api/files/orphans/delete", { project, env, keys: pickedList.map((o) => o.key), graceMs, ...(typed ? { confirm: typed } : {}) });
            const gone = new Set(r.value.deleted.map((d) => d.key));
            setOutcome(r.value);
            setFound((f) => f.filter((o) => !gone.has(o.key)));
            setPicked(new Set());
            setConfirming(false);
            s.toast({ text: `Deleted ${r.value.deleted.length} orphan${r.value.deleted.length === 1 ? "" : "s"}`, ...(r.value.refused.length ? { detail: `${r.value.refused.length} kept` } : {}) });
          } catch (e) {
            setDeleteError(e as ApiError);
          } finally {
            setDeleting(false);
          }
        }}
      >
        <p>
          {fmtNum(pickedList.length)} object{pickedList.length === 1 ? "" : "s"} ({fmtBytes(pickedBytes)}) are deleted from R2 for good. The project checks each one again first: an object that a <code>_files</code> row has, or that is newer than the grace period, is kept. Recorded in the audit log.
        </p>
      </ConfirmDialog>
    </Section>
  );
}

function Stuck({ project, env, shard, graceMs }: { project: string; env: string; shard: string; graceMs: number }) {
  const s = useSession();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const list = useApi<{ value: StuckPage }>(path("/api/files/stuck", { project, env, shard, graceMs, cursor, limit: 50 }));
  const [totals, setTotals] = useState<StuckPage["totals"] | null>(null);
  // Totals come with the first page only: kept while paging.
  useEffect(() => {
    if (list.data?.value.totals) setTotals(list.data.value.totals);
  }, [list.data]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const rows = list.data?.value.rows ?? [];
  const free = rows.filter((r) => r.refcount === 0);
  const all = free.length > 0 && free.every((r) => picked.has(r.id));
  return (
    <Section id="stuck" title={<>Stuck uploads on <Mono>{shard}</Mono></>} actions={<button type="button" onClick={list.reload}>Refresh</button>}>
      <p className="muted small hint">
        <code>_files</code> rows of this shard that never became ready: failed uploads, and pending ones no client finished (older than the grace period and their ticket). Queued rows go at the shard's next GC turn, with their object unless another row shares it. Pick another shard with <kbd>/</kbd>.
      </p>
      {list.error ? (
        <Problem error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading lines={3} />
      ) : (
        <>
          {totals && (
            <div className="stats compact" aria-label="Stuck totals">
              <Stat label="Stuck rows" value={fmtNum(totals.count)} tone={totals.count ? "warn" : "ok"} hint={totals.referenced ? `${fmtNum(totals.referenced)} referenced (kept)` : undefined} />
              <Stat label="Declared size" value={fmtBytes(totals.bytes)} />
            </div>
          )}
          <Table
            label="Stuck files"
            empty="No stuck uploads on this shard."
            rowKeys={rows.map((r) => r.id)}
            cols={[
              { h: s.isAdmin ? <input type="checkbox" checked={all} disabled={!free.length} onChange={() => setPicked(all ? new Set() : new Set(free.map((r) => r.id)))} aria-label="Select all stuck files" /> : "" },
              { h: "File" },
              { h: "State" },
              { h: "Size", num: true },
              { h: "Type" },
              { h: "References", num: true },
              { h: "Created" },
            ]}
            rows={rows.map((r) => [
              s.isAdmin ? (
                <input
                  type="checkbox"
                  checked={picked.has(r.id)}
                  disabled={r.refcount > 0}
                  title={r.refcount > 0 ? "Referenced by documents: never collected" : undefined}
                  onChange={() =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (n.has(r.id)) n.delete(r.id);
                      else n.add(r.id);
                      return n;
                    })
                  }
                  aria-label={`Select ${r.id}`}
                />
              ) : (
                ""
              ),
              <Mono>{r.id}</Mono>,
              <Badge tone={r.state === "failed" ? "bad" : "warn"}>{r.state}</Badge>,
              r.size === null ? "—" : fmtBytes(r.size),
              <span className="mono">{r.contentType ?? "—"}</span>,
              r.refcount > 0 ? <span className="warn">{fmtNum(r.refcount)}</span> : "0",
              <span title={fmtTime(r.createdAt)}>{ago(r.createdAt)}</span>,
            ])}
          />
          <div className="toolbar">
            {s.isAdmin && (
              <button type="button" className="danger" disabled={!picked.size} onClick={() => (setError(null), setConfirming(true))}>
                Queue {picked.size || ""} for GC…
              </button>
            )}
            <span className="spacer" />
            <button type="button" disabled={cursors.length < 2} onClick={() => setCursors((c) => c.slice(0, -1))}>
              ← Prev
            </button>
            <span className="muted small">page {cursors.length}</span>
            <button type="button" disabled={list.data.value.done} onClick={() => setCursors((c) => [...c, list.data!.value.cursor])}>
              Next →
            </button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Queue ${picked.size} stuck file${picked.size === 1 ? "" : "s"} for GC?`}
        confirmLabel="Queue for GC"
        danger
        expected={s.isProtected(env) ? shard : null}
        busy={busy}
        error={error}
        onCancel={() => setConfirming(false)}
        onConfirm={async (typed) => {
          setBusy(true);
          try {
            const r = await api.post<{ value: { queued: string[]; refused: Array<{ id: string; reason: string }> } }>("/api/files/stuck/delete", { project, env, shard, ids: [...picked], graceMs, ...(typed ? { confirm: typed } : {}) });
            s.toast({ text: `Queued ${r.value.queued.length} for GC`, ...(r.value.refused.length ? { detail: r.value.refused.map((x) => `${x.id}: ${REASONS[x.reason] ?? x.reason}`).join("; ") } : {}) });
            setPicked(new Set());
            setConfirming(false);
            list.reload();
          } catch (e) {
            setError(e as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          The shard checks each row again (still stuck, no document references it, older than the grace period) and its GC deletes them with their objects. Recorded in the audit log.
        </p>
      </ConfirmDialog>
    </Section>
  );
}
