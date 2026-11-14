// Data of one shard. App tables: filter by an index (equality on a prefix of its fields), order, schema, and — for
// admins — create, edit and delete documents; every write runs through the engine on the project (validated,
// indexed, in the change log, seen by subscribers) and is audited. Internal tables (`_jobs`, `_files`, ...) are
// read-only pages by row id. A runtime without the data endpoints keeps the read-only browser.

import { useEffect, useMemo, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { fmtNum, text } from "../format.ts";
import { useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Dialog, Empty, JsonView, Loading, Mono, Problem, Table } from "../ui.tsx";

interface TableInfo {
  name: string;
  rows: number;
  kind: "schema" | "internal";
}

type Shape =
  | { kind: "string" | "number" | "int64" | "boolean" | "null" | "bytes" | "file" | "any" }
  | { kind: "id"; table: string }
  | { kind: "literal"; value: unknown }
  | { kind: "array"; item: Shape }
  | { kind: "record"; value: Shape }
  | { kind: "object"; fields: Record<string, { shape: Shape; optional: boolean }> }
  | { kind: "union"; members: Shape[] };

interface SchemaTable {
  name: string;
  document: Extract<Shape, { kind: "object" }>;
  indexes: Array<{ name: string; kind: string; fields: string[] }>;
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

export function DataBrowser({ project, env, shard }: { project: string; env: string; shard: string }) {
  const [table, setTable] = useState<string | null>(null);
  // main.tsx keys this component by project/env/shard; the reset also holds for any other mount.
  useEffect(() => setTable(null), [project, env, shard]);
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
          <QueryView key={table} {...scope} table={spec} onChanged={tables.reload} />
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

function Rows({ table, rows, cols, onOpen }: { table: string; rows: Doc[]; cols: string[]; onOpen: (d: Doc) => void }) {
  return (
    <Table
      label={`${table} rows`}
      empty="No documents match."
      onRow={(i) => onOpen(rows[i]!)}
      cols={cols.map((h) => ({ h }))}
      rows={rows.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? <span className="muted">—</span> : <span className={typeof r[c] === "object" ? "mono" : undefined}>{text(r[c], 80)}</span>)))}
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

interface Filter {
  index: string;
  eq: string[];
  order: "asc" | "desc";
}

function QueryView({ project, env, shard, table, onChanged }: { project: string; env: string; shard: string; table: SchemaTable; onChanged: () => void }) {
  const s = useSession();
  const indexes = useMemo(() => [{ name: "by_creation_time", kind: "db", fields: [] as string[] }, ...table.indexes.filter((i) => i.kind === "db")], [table]);
  const [draft, setDraft] = useState<Filter>({ index: "by_creation_time", eq: [], order: "desc" });
  const [filter, setFilter] = useState<Filter>(draft);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [showSchema, setShowSchema] = useState(false);
  const [open, setOpen] = useState<Doc | null>(null);
  const [creating, setCreating] = useState(false);
  const [n, setN] = useState(0);
  const idx = indexes.find((i) => i.name === draft.index) ?? indexes[0]!;
  // Only a prefix of the index's fields can be fixed: stop at the first empty one.
  const fields = indexes.find((i) => i.name === filter.index)?.fields ?? [];
  const prefix: unknown[] = [];
  for (let i = 0; i < fields.length && filter.eq[i]; i++) prefix.push(parseValue(filter.eq[i]!));
  const cursor = cursors[cursors.length - 1] ?? null;
  const rows = useApi<{ value: { page: Doc[]; isDone: boolean; continueCursor: string } }>(
    path("/api/rows", {
      project,
      env,
      shard,
      table: table.name,
      ...(filter.index !== "by_creation_time" ? { index: filter.index } : {}),
      ...(prefix.length ? { eq: JSON.stringify(prefix) } : {}),
      order: filter.order,
      limit: 50,
      cursor,
      n,
    }),
  );
  const page = rows.data?.value;
  const cols = useMemo(() => {
    const declared = Object.keys(table.document.fields);
    const seen = page ? columnsOf(page.page) : [];
    return [...new Set(["_id", ...declared, ...seen.filter((c) => c !== "_creationTime"), "_creationTime"])].slice(0, 14);
  }, [page, table]);
  const apply = (f: Filter) => {
    setFilter(f);
    setCursors([null]);
  };
  const changed = () => {
    setN((x) => x + 1);
    onChanged();
  };
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
            <select value={draft.index} onChange={(e) => setDraft({ ...draft, index: e.target.value, eq: [] })} aria-label="Index">
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
          <label className="inline">
            Order
            <select value={draft.order} onChange={(e) => setDraft({ ...draft, order: e.target.value as "asc" | "desc" })} aria-label="Order">
              <option value="desc">newest first</option>
              <option value="asc">oldest first</option>
            </select>
          </label>
          <button type="submit">Apply</button>
          <span className="spacer" />
          <button type="button" onClick={() => setShowSchema((x) => !x)} aria-pressed={showSchema}>
            Schema
          </button>
          {s.isAdmin && (
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              New document
            </button>
          )}
        </form>
        {idx.fields.length > 0 && <p className="muted small hint">Values are JSON when they parse (5, true, "5"), text otherwise.</p>}
        {rows.error ? (
          <Problem error={rows.error} onRetry={rows.reload} />
        ) : !page ? (
          <Loading lines={8} />
        ) : (
          <>
            <Rows table={table.name} rows={page.page} cols={cols} onOpen={setOpen} />
            <div className="toolbar">
              <span className="spacer" />
              <Pager page={cursors.length} prev={cursors.length > 1 ? () => setCursors((c) => c.slice(0, -1)) : null} next={page.isDone ? null : () => setCursors((c) => [...c, page.continueCursor])} />
            </div>
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
                {i.kind === "db" ? "" : <Badge>{i.kind}</Badge>} <span className="mono">{i.fields.join(", ")}</span>
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
