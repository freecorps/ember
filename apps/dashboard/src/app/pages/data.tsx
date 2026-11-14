// Data browser of one shard (read-only in this version): tables with row counts, pages by row id, a document drawer.

import { useState } from "react";
import { path } from "../api.ts";
import { fmtNum, text } from "../format.ts";
import { useApi } from "../hooks.ts";
import { Badge, Dialog, Empty, JsonView, Loading, Mono, Problem, Table } from "../ui.tsx";

interface TableInfo {
  name: string;
  rows: number;
  kind: "schema" | "internal";
}

export function DataBrowser({ project, env, shard }: { project: string; env: string; shard: string }) {
  const [table, setTable] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [open, setOpen] = useState<Record<string, unknown> | null>(null);
  const scope = { project, env, shard };
  const tables = useApi<{ tables: TableInfo[] }>(path("/api/data", scope));
  const cursor = cursors[cursors.length - 1] ?? null;
  const page = useApi<{ rows: Array<Record<string, unknown>>; cursor: string | null; done: boolean; kind: string }>(table ? path("/api/data", { ...scope, table, limit: 50, cursor }) : null);
  const cols = page.data ? [...new Set(page.data.rows.flatMap((r) => Object.keys(r)))].slice(0, 14) : [];
  const pick = (name: string) => {
    setTable(name);
    setCursors([null]);
  };
  return (
    <div className="data">
      <nav className="table-list" aria-label="Tables">
        {tables.error ? (
          <Problem error={tables.error} onRetry={tables.reload} />
        ) : !tables.data ? (
          <Loading lines={5} />
        ) : !tables.data.tables.length ? (
          <Empty>No tables on this shard yet.</Empty>
        ) : (
          tables.data.tables.map((t) => (
            <button key={t.name} type="button" className={t.name === table ? "active" : undefined} aria-current={t.name === table ? "true" : undefined} onClick={() => pick(t.name)}>
              <span className={t.kind === "internal" ? "muted" : undefined}>{t.name}</span>
              <span className="count">{fmtNum(t.rows)}</span>
            </button>
          ))
        )}
      </nav>
      <div className="table-view">
        {!table ? (
          <Empty>Pick a table. Documents open in full with Enter or a click.</Empty>
        ) : page.error ? (
          <Problem error={page.error} onRetry={page.reload} />
        ) : !page.data ? (
          <Loading lines={8} />
        ) : (
          <>
            <div className="toolbar">
              <strong>
                <Mono>{table}</Mono>
              </strong>
              {page.data.kind === "internal" && <Badge>internal · read-only</Badge>}
              <span className="spacer" />
              <button type="button" disabled={cursors.length < 2} onClick={() => setCursors((c) => c.slice(0, -1))}>
                ← Prev
              </button>
              <span className="muted small">page {cursors.length}</span>
              <button type="button" disabled={page.data.done} onClick={() => setCursors((c) => [...c, page.data!.cursor])}>
                Next →
              </button>
            </div>
            <Table
              label={`${table} rows`}
              empty="Empty table."
              onRow={(i) => setOpen(page.data!.rows[i]!)}
              cols={cols.map((h) => ({ h }))}
              rows={page.data.rows.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? <span className="muted">null</span> : <span className={typeof r[c] === "object" ? "mono" : undefined}>{text(r[c], 80)}</span>)))}
            />
          </>
        )}
      </div>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={<Mono>{String(open?._id ?? open?.id ?? "row")}</Mono>} wide>
        <div className="dialog-body">
          <JsonView value={open} />
        </div>
      </Dialog>
    </div>
  );
}
