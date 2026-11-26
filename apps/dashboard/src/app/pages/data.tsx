// Data of one shard. App tables: filter by an index (equality on a prefix of its fields, then a range on the next
// one), open a document by `_id`, full-text search through a searchIndex, order, schema, auto-refresh, and — for
// admins — create, edit, delete and bulk-delete documents; every write runs through the engine on the project
// (validated, indexed, in the change log, seen by subscribers) and is audited. `v.id()` fields link to their document,
// `v.file()` fields to the Files screen. Internal tables (`_jobs`, `_files`, ...) are read-only pages by row id. A
// runtime without the data endpoints keeps the read-only browser; one before level 16 says so for range, `_id` and
// search (runtime_outdated) and keeps the rest.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, path } from "../api.ts";
import { fmtNum, text } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Dialog, Empty, JsonView, Loading, Mono, Problem, Table } from "../ui.tsx";
import type { SchemaTable, Shape } from "./types.ts";

interface TableInfo {
  name: string;
  rows: number;
  kind: "schema" | "internal";
}

type Doc = Record<string, unknown>;

/** A compact type of a field, for the schema panel. */
export function shapeText(s: Shape): string {
  switch (s.kind) {
    case "id":
      return `id<${s.table}>`;
    case "literal":
      return JSON.stringify(s.value);
    case "array":
      return `${s.item.kind === "union" ? `(${shapeText(s.item)})` : shapeText(s.item)}[]`;
    case "record":
      return `record<${shapeText(s.value)}>`;
    case "object":
      return `{ ${Object.entries(s.fields)
        .map(([k, f]) => `${k}${f.optional ? "?" : ""}: ${shapeText(f.shape)}`)
        .join(", ")} }`;
    case "union":
      return s.members.map(shapeText).join(" | ");
    default:
      return s.kind;
  }
}

/** A starting document for "New document": every required field with a placeholder of its type. */
export function template(s: Shape): unknown {
  switch (s.kind) {
    case "string":
      return "";
    case "number":
      return 0;
    case "int64":
      return { $int64: "0" };
    case "boolean":
      return false;
    case "null":
      return null;
    case "literal":
      return s.value;
    case "array":
      return [];
    case "record":
      return {};
    case "union":
      return s.members[0] ? template(s.members[0]) : null;
    case "object":
      return Object.fromEntries(Object.entries(s.fields).filter(([, f]) => !f.optional).map(([k, f]) => [k, template(f.shape)]));
    case "id":
      return `<${s.table} id>`;
    default:
      return null;
  }
}

/** An index value typed in the filter: JSON when it parses ("5", "true", "\"5\""), else the text itself. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const SYSTEM = new Set(["_id", "_creationTime"]);
const withoutSystem = (d: Doc) => Object.fromEntries(Object.entries(d).filter(([k]) => !SYSTEM.has(k)));

export function DataBrowser({ project, env, shard, initialTable, initialId }: { project: string; env: string; shard: string; initialTable?: string; initialId?: string }) {
  // `initialTable`: the route's table (`data/<shard>/<table>`, the command palette's link); `initialId` the document a
  // `v.id()` link opens (`data/<shard>/<table>/<id>`).
  const [table, setTable] = useState<string | null>(initialTable ?? null);
  // main.tsx keys this component by project/env/shard/table; the reset also holds for any other mount.
  useEffect(() => setTable(initialTable ?? null), [project, env, shard, initialTable]);
  const scope = { project, env, shard };
  const tables = useApi<{ tables: TableInfo[] }>(path("/api/data", scope));
  const schema = useApi<{ tables: SchemaTable[] }>(path("/api/schema", { project, env }));
  const info = tables.data?.tables.find((t) => t.name === table);
  const spec = schema.data?.tables.find((t) => t.name === table) ?? null;
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
            <button key={t.name} type="button" className={t.name === table ? "active" : undefined} aria-current={t.name === table ? "true" : undefined} onClick={() => setTable(t.name)}>
              <span className={t.kind === "internal" ? "muted" : undefined}>{t.name}</span>
              <span className="count">{fmtNum(t.rows)}</span>
            </button>
          ))
        )}
      </nav>
      <div className="table-view">
        {!table ? (
          <Empty>Pick a table. Documents open with Enter or a click.</Empty>
        ) : info?.kind === "schema" && spec ? (
          <QueryView key={table} {...scope} table={spec} onChanged={tables.reload} {...(table === initialTable && initialId ? { initialId } : {})} />
        ) : (
          <>
            {info?.kind === "schema" && schema.error && <Problem error={schema.error} />}
            <BrowseView key={table} {...scope} table={table} />
          </>
        )}
      </div>
    </div>
  );
}

/** Read-only pages by row id (internal tables, and app tables on an older runtime). */
function BrowseView({ project, env, shard, table }: { project: string; env: string; shard: string; table: string }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [open, setOpen] = useState<Doc | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;
  const page = useApi<{ rows: Doc[]; cursor: string | null; done: boolean; kind: string }>(path("/api/data", { project, env, shard, table, limit: 50, cursor }));
  if (page.error) return <Problem error={page.error} onRetry={page.reload} />;
  if (!page.data) return <Loading lines={8} />;
  const cols = columnsOf(page.data.rows);
  return (
    <>
      <div className="toolbar">
        <strong>
          <Mono>{table}</Mono>
        </strong>
        <Badge>read-only</Badge>
        <span className="spacer" />
        <Pager page={cursors.length} prev={cursors.length > 1 ? () => setCursors((c) => c.slice(0, -1)) : null} next={page.data.done ? null : () => setCursors((c) => [...c, page.data!.cursor])} />
      </div>
      <Rows table={table} rows={page.data.rows} cols={cols} onOpen={setOpen} />
      <Dialog open={!!open} onClose={() => setOpen(null)} title={<Mono>{String(open?._id ?? open?.id ?? "row")}</Mono>} wide>
        <div className="dialog-body">
          <JsonView value={open} />
        </div>
      </Dialog>
    </>
  );
}

function columnsOf(rows: Doc[]): string[] {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  // System fields first, then the rest in first-seen order.
  return [...keys.filter((k) => SYSTEM.has(k)), ...keys.filter((k) => !SYSTEM.has(k))].slice(0, 14);
}

/** A reference a field's shape makes (`v.id("t")`, `v.file()`), looking through optional / nullable unions. */
function refOf(shape: Shape | undefined): { kind: "id"; table: string } | { kind: "file" } | null {
  if (!shape) return null;
  if (shape.kind === "id") return { kind: "id", table: shape.table };
  if (shape.kind === "file") return { kind: "file" };
  if (shape.kind === "union") {
    const refs = shape.members.filter((m) => m.kind !== "null").map(refOf);
    const r = refs[0];
    if (r && refs.every((x) => x && x.kind === r.kind && (x.kind === "file" || (r.kind === "id" && x.kind === "id" && x.table === r.table)))) return r;
  }
  return null;
}

interface RowLinks {
  project: string;
  env: string;
  shard: string;
  /** Top-level field shapes of the table (links for `v.id()` / `v.file()` values). */
  fields: Record<string, { shape: Shape; optional: boolean }>;
}

function Cell({ value, field, links }: { value: unknown; field: string; links?: RowLinks | undefined }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const ref = links ? refOf(links.fields[field]?.shape) : null;
  if (ref && typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    const to =
      ref.kind === "id"
        ? href({ project: links!.project, env: links!.env, section: "data", shard: links!.shard, rest: [ref.table, value] })
        : href({ project: links!.project, env: links!.env, section: "files", shard: links!.shard, rest: [value] });
    return (
      <a href={to} className="mono" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} title={ref.kind === "id" ? `Open ${value} in ${ref.table}` : `Open file ${value}`}>
        {text(value, 80)}
      </a>
    );
  }
  return <span className={typeof value === "object" ? "mono" : undefined}>{text(value, 80)}</span>;
}

function Rows({
  table,
  rows,
  cols,
  onOpen,
  links,
  selection,
}: {
  table: string;
  rows: Doc[];
  cols: string[];
  onOpen: (d: Doc) => void;
  links?: RowLinks;
  /** Checkboxes for bulk actions (admins): the selected `_id`s. */
  selection?: { ids: ReadonlySet<string>; toggle: (id: string) => void; all: (on: boolean) => void };
}) {
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const ids = rows.map((r) => String(r._id ?? r.id ?? ""));
  const allOn = !!selection && rows.length > 0 && ids.every((id) => selection.ids.has(id));
  const cells = (r: Doc, i: number): ReactNode[] => {
    const out: ReactNode[] = cols.map((c) => <Cell value={r[c]} field={c} links={links} />);
    if (selection)
      out.unshift(
        <input type="checkbox" checked={selection.ids.has(ids[i]!)} onChange={() => selection.toggle(ids[i]!)} onClick={stop} onKeyDown={stop} aria-label={`Select ${ids[i]}`} />,
      );
    return out;
  };
  return (
    <Table
      label={`${table} rows`}
      empty="No documents match."
      onRow={(i) => onOpen(rows[i]!)}
      rowKeys={ids.map((id, i) => id || String(i))}
      cols={[
        ...(selection ? [{ h: <input type="checkbox" checked={allOn} onChange={(e) => selection.all(e.target.checked)} aria-label="Select all rows on this page" />, cls: "check" }] : []),
        ...cols.map((h) => ({ h })),
      ]}
      rows={rows.map(cells)}
    />
  );
}

function Pager({ page, prev, next }: { page: number; prev: (() => void) | null; next: (() => void) | null }) {
  return (
    <>
      <button type="button" disabled={!prev} onClick={() => prev?.()}>
        ← Prev
      </button>
      <span className="muted small">page {page}</span>
      <button type="button" disabled={!next} onClick={() => next?.()}>
        Next →
      </button>
    </>
  );
}

type LowerOp = "gt" | "gte";
type UpperOp = "lt" | "lte";

interface Filter {
  index: string;
  eq: string[];
  order: "asc" | "desc";
  /** A range on the index field after the `eq` prefix (level 16). */
  lower: { op: LowerOp; value: string };
  upper: { op: UpperOp; value: string };
}

/** What the page shows instead of an index range: one document by `_id`, or a full-text search. */
type Lookup = { kind: "id"; id: string } | { kind: "search"; index: string; text: string } | null;

const EMPTY_RANGE = { lower: { op: "gte" as LowerOp, value: "" }, upper: { op: "lt" as UpperOp, value: "" } };

function QueryView({ project, env, shard, table, onChanged, initialId }: { project: string; env: string; shard: string; table: SchemaTable; onChanged: () => void; initialId?: string }) {
  const s = useSession();
  const indexes = useMemo(() => [{ name: "by_creation_time", kind: "db", fields: [] as string[] }, ...table.indexes.filter((i) => i.kind === "db")], [table]);
  const searches = useMemo(() => table.indexes.filter((i) => i.kind === "search"), [table]);
  const [draft, setDraft] = useState<Filter>({ index: "by_creation_time", eq: [], order: "desc", ...EMPTY_RANGE });
  const [filter, setFilter] = useState<Filter>(draft);
  const [lookup, setLookup] = useState<Lookup>(initialId ? { kind: "id", id: initialId } : null);
  const [idDraft, setIdDraft] = useState(initialId ?? "");
  const [searchDraft, setSearchDraft] = useState({ index: searches[0]?.name ?? "", text: "" });
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [showSchema, setShowSchema] = useState(false);
  const [open, setOpen] = useState<Doc | null>(null);
  /** The `_id` lookup whose document was opened already (a reload does not open it again). */
  const [opened, setOpened] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** The bulk delete dialog: the ids are the ones counted when it opened (an auto-refresh does not change them). */
  const [bulk, setBulk] = useState<{ ids: string[]; busy: boolean; error: ApiError | null } | null>(null);
  /** Which bulk delete is current: an answer for another (cancelled, then a new dialog) changes nothing. */
  const bulkOp = useRef(0);
  const [auto, setAuto] = useState(false);
  const [n, setN] = useState(0);
  const idx = indexes.find((i) => i.name === draft.index) ?? indexes[0]!;
  // Only a prefix of the index's fields can be fixed: stop at the first empty one. The range is on the next field.
  const fields = indexes.find((i) => i.name === filter.index)?.fields ?? [];
  const prefix: unknown[] = [];
  for (let i = 0; i < fields.length && filter.eq[i]; i++) prefix.push(parseValue(filter.eq[i]!));
  const draftPrefix = (() => {
    let k = 0;
    while (k < idx.fields.length && draft.eq[k]) k++;
    return k;
  })();
  const rangeField = [...idx.fields, "_creationTime"][draftPrefix]!;
  const cursor = cursors[cursors.length - 1] ?? null;
  const bound = (b: { op: string; value: string }) => (b.value.trim() ? { [b.op]: JSON.stringify(parseValue(b.value.trim())) } : {});
  const rows = useApi<{ value: { page: Doc[]; isDone: boolean; continueCursor: string } }>(
    path("/api/rows", {
      project,
      env,
      shard,
      table: table.name,
      ...(lookup?.kind === "id"
        ? { id: lookup.id }
        : lookup?.kind === "search"
          ? { index: lookup.index, search: lookup.text, limit: 50 }
          : {
              ...(filter.index !== "by_creation_time" ? { index: filter.index } : {}),
              ...(prefix.length ? { eq: JSON.stringify(prefix) } : {}),
              ...bound(filter.lower),
              ...bound(filter.upper),
              order: filter.order,
              limit: 50,
              cursor,
            }),
      n,
    }),
  );
  const page = rows.data?.value;
  const cols = useMemo(() => {
    const declared = Object.keys(table.document.fields);
    const seen = page ? columnsOf(page.page) : [];
    return [...new Set(["_id", ...declared, ...seen.filter((c) => c !== "_creationTime"), "_creationTime"])].slice(0, 14);
  }, [page, table]);
  // An `_id` lookup opens its document once its answer arrives (once per lookup, found or not).
  useEffect(() => {
    if (lookup?.kind === "id" && opened !== lookup.id && page) {
      setOpened(lookup.id);
      if (page.page[0]) setOpen(page.page[0]);
    }
  }, [lookup, page, opened]);
  // Auto-refresh: every 5 s while on, paused while the tab is hidden or the bulk delete dialog is open (the same page,
  // data kept while it reloads).
  const reload = rows.reload;
  const confirming = !!bulk;
  // A tick while the previous rows request is still out is skipped (a new one would drop its answer: a request slower
  // than 5 s would never land). Read through a ref, since the interval is created once per `auto`/`confirming`.
  const rowsLoading = useRef(rows.loading);
  rowsLoading.current = rows.loading;
  useEffect(() => {
    if (!auto || confirming) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && !rowsLoading.current) reload();
    }, 5000);
    return () => clearInterval(t);
  }, [auto, reload, confirming]);
  const reset = () => {
    setCursors([null]);
    setSelected(new Set());
  };
  const apply = (f: Filter) => {
    setFilter(f);
    setLookup(null);
    reset();
  };
  const changed = () => {
    setN((x) => x + 1);
    setSelected(new Set());
    onChanged();
  };
  const ids = (page?.page ?? []).map((d) => String(d._id));
  const selection = s.isAdmin
    ? {
        ids: selected,
        toggle: (id: string) =>
          setSelected((cur) => {
            const next = new Set(cur);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }),
        all: (on: boolean) => setSelected(on ? new Set(ids) : new Set()),
      }
    : undefined;
  const chosen = ids.filter((id) => selected.has(id));
  const bulkIds = bulk?.ids ?? [];
  return (
    <div className={showSchema ? "split" : undefined}>
      <div>
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft);
          }}
        >
          <strong>
            <Mono>{table.name}</Mono>
          </strong>
          <label className="inline">
            Index
            <select value={draft.index} onChange={(e) => setDraft({ ...draft, index: e.target.value, eq: [], ...EMPTY_RANGE })} aria-label="Index">
              {indexes.map((i) => (
                <option key={i.name} value={i.name}>
                  {i.name}
                  {i.fields.length ? ` (${i.fields.join(", ")})` : ""}
                </option>
              ))}
            </select>
          </label>
          {idx.fields.map((f, i) => (
            <label key={f} className="inline">
              <Mono>{f}</Mono> =
              <input
                value={draft.eq[i] ?? ""}
                onChange={(e) => {
                  const eq2 = [...draft.eq];
                  eq2[i] = e.target.value;
                  setDraft({ ...draft, eq: eq2 });
                }}
                placeholder={i === 0 ? "any" : "any (needs the field before)"}
                aria-label={`${f} equals`}
                disabled={i > 0 && !draft.eq[i - 1]}
                className="eq"
              />
            </label>
          ))}
          <span className="inline range" role="group" aria-label={`Range on ${rangeField}`}>
            <Mono>{rangeField}</Mono>
            <select value={draft.lower.op} onChange={(e) => setDraft({ ...draft, lower: { ...draft.lower, op: e.target.value as LowerOp } })} aria-label={`${rangeField} lower bound`}>
              <option value="gte">≥</option>
              <option value="gt">&gt;</option>
            </select>
            <input className="eq" value={draft.lower.value} onChange={(e) => setDraft({ ...draft, lower: { ...draft.lower, value: e.target.value } })} placeholder="from" aria-label={`${rangeField} from`} />
            <select value={draft.upper.op} onChange={(e) => setDraft({ ...draft, upper: { ...draft.upper, op: e.target.value as UpperOp } })} aria-label={`${rangeField} upper bound`}>
              <option value="lt">&lt;</option>
              <option value="lte">≤</option>
            </select>
            <input className="eq" value={draft.upper.value} onChange={(e) => setDraft({ ...draft, upper: { ...draft.upper, value: e.target.value } })} placeholder="to" aria-label={`${rangeField} to`} />
          </span>
          <label className="inline">
            Order
            <select value={draft.order} onChange={(e) => setDraft({ ...draft, order: e.target.value as "asc" | "desc" })} aria-label="Order">
              <option value="desc">newest first</option>
              <option value="asc">oldest first</option>
            </select>
          </label>
          <button type="submit">Apply</button>
          <span className="spacer" />
          <label className="inline" title="Reload this page every 5 s (paused while the tab is hidden)">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} aria-label="Auto-refresh every 5 seconds" /> Auto-refresh
          </label>
          <button type="button" onClick={() => setShowSchema((x) => !x)} aria-pressed={showSchema}>
            Schema
          </button>
          {s.isAdmin && (
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              New document
            </button>
          )}
        </form>
        <div className="toolbar">
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              const id = idDraft.trim();
              if (!id) return;
              setOpened(null);
              setLookup({ kind: "id", id });
              reset();
            }}
          >
            <input type="search" value={idDraft} onChange={(e) => setIdDraft(e.target.value)} placeholder="Go to _id" aria-label="Document _id" className="mono" spellCheck={false} />
            <button type="submit">Open</button>
          </form>
          {searches.length > 0 && (
            <form
              className="inline"
              onSubmit={(e) => {
                e.preventDefault();
                if (!searchDraft.text.trim() || !searchDraft.index) return;
                setLookup({ kind: "search", index: searchDraft.index, text: searchDraft.text.trim() });
                reset();
              }}
            >
              {searches.length > 1 && (
                <select value={searchDraft.index} onChange={(e) => setSearchDraft({ ...searchDraft, index: e.target.value })} aria-label="Search index">
                  {searches.map((i) => (
                    <option key={i.name} value={i.name}>
                      {i.name}
                    </option>
                  ))}
                </select>
              )}
              <input
                type="search"
                value={searchDraft.text}
                onChange={(e) => setSearchDraft({ ...searchDraft, text: e.target.value })}
                placeholder={`Search ${searches.find((i) => i.name === searchDraft.index)?.searchField ?? searches.find((i) => i.name === searchDraft.index)?.fields[0] ?? "text"}`}
                aria-label="Full-text search"
              />
              <button type="submit">Search</button>
            </form>
          )}
          {lookup && (
            <span className="inline">
              <Badge tone="info">{lookup.kind === "id" ? `_id = ${lookup.id}` : `search “${lookup.text}” in ${lookup.index}`}</Badge>
              <button type="button" className="link" onClick={() => (setLookup(null), reset())}>
                Clear
              </button>
            </span>
          )}
          <span className="spacer" />
          {s.isAdmin && chosen.length > 0 && (
            <button type="button" className="danger-text" onClick={() => setBulk({ ids: chosen, busy: false, error: null })}>
              Delete {chosen.length} selected…
            </button>
          )}
        </div>
        {(idx.fields.length > 0 || draft.lower.value || draft.upper.value) && <p className="muted small hint">Values are JSON when they parse (5, true, "5"), text otherwise. The range is on the field after the fixed ones.</p>}
        {rows.error ? (
          <Problem error={rows.error} onRetry={rows.reload} />
        ) : !page ? (
          <Loading lines={8} />
        ) : (
          <>
            <Rows table={table.name} rows={page.page} cols={cols} onOpen={setOpen} links={{ project, env, shard, fields: table.document.fields }} {...(selection ? { selection } : {})} />
            {!lookup && (
              <div className="toolbar">
                <span className="spacer" />
                <Pager page={cursors.length} prev={cursors.length > 1 ? () => (setCursors((c) => c.slice(0, -1)), setSelected(new Set())) : null} next={page.isDone ? null : () => (setCursors((c) => [...c, page.continueCursor]), setSelected(new Set()))} />
              </div>
            )}
          </>
        )}
      </div>
      {showSchema && <SchemaPanel table={table} onClose={() => setShowSchema(false)} />}
      {open && <DocDialog key={String(open._id)} project={project} env={env} shard={shard} table={table} doc={open} onClose={() => setOpen(null)} onChanged={(d) => (setOpen(d), changed())} />}
      {creating && (
        <EditorDialog
          title={`New document in ${table.name}`}
          initial={template(table.document) as Doc}
          save={(doc) => api.post<{ value: string }>("/api/doc/insert", { project, env, shard, table: table.name, doc }).then((r) => r.value)}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            s.toast({ text: `Inserted into ${table.name}`, detail: String(id) });
            setCreating(false);
            changed();
          }}
        />
      )}
      <ConfirmDialog
        open={!!bulk}
        title={`Delete ${bulkIds.length} document${bulkIds.length === 1 ? "" : "s"} of ${table.name}?`}
        confirmLabel={`Delete ${bulkIds.length} document${bulkIds.length === 1 ? "" : "s"}`}
        danger
        expected={s.isProtected(env) ? table.name : null}
        busy={bulk?.busy ?? false}
        error={bulk?.error ?? null}
        onCancel={() => {
          // While the delete is out the dialog stays: its answer belongs to it.
          if (bulk?.busy) return;
          bulkOp.current++;
          setBulk(null);
        }}
        onConfirm={async (typed) => {
          const op = ++bulkOp.current;
          setBulk({ ids: bulkIds, busy: true, error: null });
          try {
            const r = await api.post<{ value: { deleted: number } }>("/api/doc/delete", { project, env, shard, table: table.name, ids: bulkIds, ...(typed ? { confirm: typed } : {}) });
            s.toast({ text: `Deleted ${r.value.deleted} document${r.value.deleted === 1 ? "" : "s"} from ${table.name}` });
            changed();
            if (bulkOp.current === op) setBulk(null);
          } catch (e) {
            if (bulkOp.current === op) setBulk({ ids: bulkIds, busy: false, error: e as ApiError });
          }
        }}
      >
        <p>
          {bulkIds.length} document{bulkIds.length === 1 ? "" : "s"} leave <Mono>{table.name}</Mono> on <Mono>{shard}</Mono> in one mutation (all or nothing): indexes are updated and subscribed clients see them go. Recorded in the audit log.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function SchemaPanel({ table, onClose }: { table: SchemaTable; onClose: () => void }) {
  return (
    <aside className="detail" aria-label={`Schema of ${table.name}`}>
      <header className="detail-head">
        <h2>
          <Mono>{table.name}</Mono> schema
        </h2>
        <button type="button" className="icon" onClick={onClose} aria-label="Close schema">
          ×
        </button>
      </header>
      <h3>Fields</h3>
      <dl className="kv">
        <dt>
          <Mono>_id</Mono>
        </dt>
        <dd className="mono">id&lt;{table.name}&gt;</dd>
        <dt>
          <Mono>_creationTime</Mono>
        </dt>
        <dd className="mono">number</dd>
        {Object.entries(table.document.fields).map(([k, f]) => (
          <div key={k} className="kv-row">
            <dt>
              <Mono>
                {k}
                {f.optional ? "?" : ""}
              </Mono>
            </dt>
            <dd className="mono">{shapeText(f.shape)}</dd>
          </div>
        ))}
      </dl>
      <h3>Indexes</h3>
      {table.indexes.length ? (
        <dl className="kv">
          {table.indexes.map((i) => (
            <div key={i.name} className="kv-row">
              <dt>
                <Mono>{i.name}</Mono>
              </dt>
              <dd>
                {i.kind === "db" ? "" : <Badge>{i.kind}</Badge>} {i.sparse ? <Badge>sparse</Badge> : null} <span className="mono">{i.fields.join(", ")}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">Only the default by_creation_time.</p>
      )}
    </aside>
  );
}

function DocDialog({
  project,
  env,
  shard,
  table,
  doc,
  onClose,
  onChanged,
}: {
  project: string;
  env: string;
  shard: string;
  table: SchemaTable;
  doc: Doc;
  onClose: () => void;
  onChanged: (d: Doc | null) => void;
}) {
  const s = useSession();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const id = String(doc._id);
  if (editing)
    return (
      <EditorDialog
        title={`Edit ${id}`}
        initial={withoutSystem(doc)}
        save={(d) => api.post<{ value: Doc }>("/api/doc/replace", { project, env, shard, table: table.name, id, doc: d }).then((r) => r.value)}
        onClose={() => setEditing(false)}
        onSaved={(d) => {
          s.toast({ text: `Saved ${id}` });
          setEditing(false);
          onChanged(d as Doc);
        }}
      />
    );
  return (
    <>
      <Dialog open={!deleting} onClose={onClose} title={<Mono>{id}</Mono>} wide>
        <div className="dialog-body">
          <JsonView value={doc} />
        </div>
        {s.isAdmin && (
          <footer className="dialog-foot">
            <button type="button" className="danger-text" onClick={() => (setError(null), setDeleting(true))}>
              Delete…
            </button>
            <span className="spacer" />
            <button type="button" className="primary" onClick={() => setEditing(true)}>
              Edit
            </button>
          </footer>
        )}
      </Dialog>
      <ConfirmDialog
        open={deleting}
        title={`Delete ${id}?`}
        confirmLabel="Delete document"
        danger
        expected={s.isProtected(env) ? table.name : null}
        busy={busy}
        error={error}
        onCancel={() => setDeleting(false)}
        onConfirm={async (typed) => {
          setBusy(true);
          setError(null);
          try {
            await api.post("/api/doc/delete", { project, env, shard, table: table.name, ids: [id], ...(typed ? { confirm: typed } : {}) });
            s.toast({ text: `Deleted ${id} from ${table.name}` });
            onChanged(null);
            onClose();
          } catch (e) {
            setError(e as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          The document leaves <Mono>{table.name}</Mono> on <Mono>{shard}</Mono> through a mutation: indexes are updated and subscribed clients see it go. Recorded in the audit log.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** JSON editor for a document (tagged JSON: {"$int64": "1"}, {"$bytes": "<base64>"}). The engine validates on save. */
function EditorDialog({ title, initial, save, onClose, onSaved }: { title: string; initial: Doc; save: (doc: Doc) => Promise<unknown>; onClose: () => void; onSaved: (result: unknown) => void }) {
  const [textValue, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  let parsed: Doc | null = null;
  let parseError: string | null = null;
  try {
    const v: unknown = JSON.parse(textValue);
    if (!v || typeof v !== "object" || Array.isArray(v)) parseError = "a document is a JSON object";
    else parsed = v as Doc;
  } catch (e) {
    parseError = (e as Error).message;
  }
  return (
    <Dialog open onClose={onClose} title={title} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!parsed) return;
          setBusy(true);
          setError(null);
          try {
            onSaved(await save(parsed));
          } catch (x) {
            setError(x as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <textarea className="editor" value={textValue} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Document JSON" rows={16} autoFocus />
          <p className={parseError ? "bad small" : "muted small"}>{parseError ?? "System fields (_id, _creationTime) are set by the engine. The schema is checked when you save."}</p>
          {error && <Problem error={error} />}
        </div>
        <footer className="dialog-foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!parsed || busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
