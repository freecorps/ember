// SQL Explorer: one read-only query on the shard picked in the top bar (`POST /api/sql` → the project's
// `/api/_ember/sql`). The project refuses anything but SELECT / WITH ... SELECT / EXPLAIN QUERY PLAN and runs it in a
// transaction it always aborts; the dashboard audits each run (`sql.run`, with the text). Admin role only. The editor
// is a textarea with a small completer (tables, their columns, keywords) fed by `/api/schema`: no editor library.
// Results are rendered as text and exported client-side (CSV, JSON).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, path } from "../api.ts";
import { download, toCsv, toJson } from "../export.ts";
import { fmtNum, text } from "../format.ts";
import { useApi, useSession } from "../hooks.ts";
import { Badge, Empty, Mono, Problem, Table } from "../ui.tsx";
import type { SchemaBody } from "./types.ts";

interface PlanNode {
  id: number;
  detail: string;
  children: PlanNode[];
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  rowsRead: number;
  rowsWritten: number;
  truncated: boolean;
  ms: number;
  explain: boolean;
  plan?: PlanNode[];
}

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN", "LIKE", "GLOB", "BETWEEN", "ORDER BY", "GROUP BY", "HAVING", "LIMIT", "OFFSET",
  "JOIN", "LEFT JOIN", "INNER JOIN", "CROSS JOIN", "ON", "AS", "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "WITH", "UNION", "UNION ALL",
  "EXCEPT", "INTERSECT", "EXISTS", "ASC", "DESC", "VALUES", "EXPLAIN QUERY PLAN", "count(", "sum(", "avg(", "min(", "max(", "json_extract(",
  "json_each(", "length(", "lower(", "upper(", "substr(", "coalesce(", "ifnull(", "typeof(", "datetime(", "sqlite_master", "pragma_table_info(",
];

export interface Completion {
  label: string;
  /** What replaces the word being typed. */
  insert: string;
  kind: "table" | "column" | "keyword";
  detail?: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (name: string) => (IDENT.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/**
 * What to offer at `caret`: after `<table>.`, that table's columns; else the tables, columns and keywords starting
 * with the word being typed (case-insensitive). `from` is where that word starts.
 */
export function completionsAt(textValue: string, caret: number, tables: ReadonlyArray<{ name: string; columns: string[] }>, extra: readonly string[] = []): { from: number; items: Completion[] } {
  let from = caret;
  while (from > 0 && /[A-Za-z0-9_$]/.test(textValue[from - 1]!)) from--;
  const word = textValue.slice(from, caret).toLowerCase();
  if (textValue[from - 1] === ".") {
    let q = from - 1;
    while (q > 0 && /[A-Za-z0-9_$"]/.test(textValue[q - 1]!)) q--;
    const owner = textValue.slice(q, from - 1).replace(/"/g, "");
    const t = tables.find((x) => x.name === owner);
    if (!t) return { from, items: [] };
    return { from, items: t.columns.filter((c) => c.toLowerCase().startsWith(word)).map((c) => ({ label: c, insert: quote(c), kind: "column" as const, detail: t.name })) };
  }
  if (!word) return { from, items: [] };
  const items: Completion[] = [];
  const seen = new Set<string>();
  const add = (c: Completion) => {
    if (seen.has(c.label) || c.label.toLowerCase() === word || !c.label.toLowerCase().startsWith(word)) return;
    seen.add(c.label);
    items.push(c);
  };
  for (const t of tables) add({ label: t.name, insert: quote(t.name), kind: "table" });
  for (const n of extra) add({ label: n, insert: quote(n), kind: "table" });
  for (const t of tables) for (const c of t.columns) add({ label: c, insert: quote(c), kind: "column", detail: t.name });
  for (const k of KEYWORDS) add({ label: k, insert: k, kind: "keyword" });
  return { from, items: items.slice(0, 12) };
}

const LIMITS = [100, 500, 1000, 5000];

export function SqlExplorer({ project, env, shard }: { project: string; env: string; shard: string }) {
  const s = useSession();
  const schema = useApi<SchemaBody>(path("/api/schema", { project, env }));
  const tables = useMemo(() => (schema.data?.tables ?? []).map((t) => ({ name: t.sql?.table ?? t.name, columns: t.sql?.columns ?? ["_id", "_creationTime", ...Object.keys(t.document.fields), "_json"] })), [schema.data]);
  const extra = useMemo(() => [...(schema.data?.componentTables ?? []), ...(schema.data?.internalTables ?? [])], [schema.data]);
  const first = schema.data?.tables[0]?.name;
  const [sql, setSql] = useState<string | null>(null);
  const value = sql ?? (first ? `SELECT * FROM ${quote(first)} ORDER BY _rowid DESC LIMIT 50` : "SELECT name, type FROM sqlite_master ORDER BY name");
  const [explain, setExplain] = useState(false);
  const [limit, setLimit] = useState(500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<{ value: SqlResult; at: number; roundTrip: number } | null>(null);
  const [menu, setMenu] = useState<{ from: number; items: Completion[]; active: number } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  /** The blur's delayed close (a click on a completion lands first): cleared when the editor is back or a menu opens. */
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelBlur = () => {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    blurTimer.current = null;
  };
  useEffect(() => cancelBlur, []);

  const run = async () => {
    if (busy || !s.isAdmin || !value.trim()) return;
    setBusy(true);
    setError(null);
    setMenu(null);
    const t0 = performance.now();
    try {
      const r = await api.post<{ value: SqlResult }>("/api/sql", { project, env, shard, sql: value, explain, limit });
      setResult({ value: r.value, at: Date.now(), roundTrip: performance.now() - t0 });
    } catch (e) {
      // The previous answer would read as this query's.
      setResult(null);
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const suggest = (textValue: string, caret: number) => {
    cancelBlur();
    const c = completionsAt(textValue, caret, tables, extra);
    setMenu(c.items.length ? { ...c, active: 0 } : null);
  };
  const accept = (c: Completion) => {
    const el = editor.current;
    const caret = el?.selectionStart ?? value.length;
    // The word being completed is the one at the caret now (it may have moved since the menu opened).
    const from = completionsAt(value, caret, tables, extra).from;
    const next = value.slice(0, from) + c.insert + value.slice(caret);
    setSql(next);
    setMenu(null);
    const at = from + c.insert.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run();
      return;
    }
    if (!menu) {
      if (e.key === " " && e.ctrlKey) {
        e.preventDefault();
        suggest(value, e.currentTarget.selectionStart);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setMenu({ ...menu, active: (menu.active + d + menu.items.length) % menu.items.length });
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(menu.items[menu.active]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
    }
  };

  const r = result?.value;
  const fileBase = `${project}-${env}-${shard}`.replace(/[^\w.-]+/g, "_");
  return (
    <div className="sql">
      <div className="toolbar">
        <span className="muted small">
          Read-only SQL on <Mono>{shard}</Mono> (pick another shard in the top bar). SELECT, WITH … SELECT and EXPLAIN QUERY PLAN only; every run is audited with its text.
        </span>
      </div>
      {!s.isAdmin && (
        <div className="notice info" role="status">
          <strong>Admins only</strong>
          <p>Raw SQL reads every table of a shard (internal ones too), so it needs the admin role. Your role is read-only.</p>
        </div>
      )}
      {schema.error && <Problem error={schema.error} />}
      <div className="sql-editor">
        <textarea
          ref={editor}
          className="editor sql-input"
          value={value}
          rows={8}
          spellCheck={false}
          aria-label="SQL"
          aria-autocomplete="list"
          aria-controls="sql-completions"
          aria-expanded={!!menu}
          {...(menu ? { "aria-activedescendant": `sql-c-${menu.active}` } : {})}
          onChange={(e) => {
            setSql(e.target.value);
            suggest(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKey}
          onFocus={cancelBlur}
          onBlur={() => {
            cancelBlur();
            blurTimer.current = setTimeout(() => setMenu(null), 150);
          }}
        />
        {menu && (
          <ul className="options sql-completions" id="sql-completions" role="listbox" aria-label="Completions">
            {menu.items.map((c, i) => (
              <li key={`${c.kind}:${c.label}:${c.detail ?? ""}`} id={`sql-c-${i}`} role="option" aria-selected={i === menu.active} className={i === menu.active ? "active" : undefined} onMouseDown={(e) => (e.preventDefault(), accept(c))}>
                <Mono>{c.label}</Mono> <span className="muted small">{c.kind === "column" ? `column of ${c.detail}` : c.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="toolbar">
        <button type="button" className="primary" disabled={!s.isAdmin || busy || !value.trim()} onClick={() => void run()} title="Run (⌘↵ / Ctrl+↵)">
          {busy ? "Running…" : "Run"} <kbd>⌘↵</kbd>
        </button>
        <label className="inline">
          <input type="checkbox" checked={explain} onChange={(e) => setExplain(e.target.checked)} /> EXPLAIN QUERY PLAN
        </label>
        <label className="inline">
          Row cap
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Row cap">
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {fmtNum(n)}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">Ctrl+Space completes tables, columns and keywords.</span>
        <span className="spacer" />
        {r && !r.explain && (
          <>
            <button type="button" onClick={() => download(`${fileBase}.csv`, "text/csv", toCsv(r.columns, r.rows))}>
              Export CSV
            </button>
            <button type="button" onClick={() => download(`${fileBase}.json`, "application/json", toJson(r.columns, r.rows))}>
              Export JSON
            </button>
          </>
        )}
      </div>
      {error && <Problem error={error} />}
      {r && (
        <section aria-label="Result">
          <div className="toolbar sql-stats" role="status">
            <span>
              <strong>{fmtNum(r.rows.length)}</strong> row{r.rows.length === 1 ? "" : "s"}
            </span>
            {r.truncated && <Badge tone="warn" title="The query had more rows than the cap (or the answer budget): raise the cap or add a LIMIT">truncated</Badge>}
            <span className="muted">
              rows read <strong className="mono">{fmtNum(r.rowsRead)}</strong>
            </span>
            <span className="muted">
              rows written <strong className="mono">{fmtNum(r.rowsWritten)}</strong>
            </span>
            <span className="muted">
              <strong className="mono">{fmtNum(Math.max(r.ms, 0), 1)}</strong> ms on the shard · {fmtNum(result.roundTrip, 0)} ms round trip
            </span>
          </div>
          {r.explain && r.plan ? (
            r.plan.length ? (
              <PlanTree nodes={r.plan} />
            ) : (
              <Empty>No plan.</Empty>
            )
          ) : !r.columns.length ? (
            <Empty>The statement returned no columns.</Empty>
          ) : (
            <Table
              label="SQL result"
              empty="No rows."
              cols={r.columns.map((h) => ({ h }))}
              rows={r.rows.map((row) => row.map((v) => (v === null || v === undefined ? <span className="muted">NULL</span> : <span className={typeof v === "object" ? "mono" : undefined}>{text(v, 200)}</span>)))}
            />
          )}
        </section>
      )}
    </div>
  );
}

function PlanTree({ nodes }: { nodes: PlanNode[] }) {
  return (
    <ul className="plan" aria-label="Query plan">
      {nodes.map((n) => (
        <li key={n.id}>
          <span className={/^SCAN /.test(n.detail) ? "mono warn" : "mono"}>{n.detail}</span>
          {n.children.length > 0 && <PlanTree nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}
