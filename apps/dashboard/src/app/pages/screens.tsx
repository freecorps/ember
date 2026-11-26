// Declarative screens (contracts.md "Telas declarativas"): the specs of `defineComponent({ dashboard })` and
// `defineApp({ dashboard })`, rendered generically. Every block runs only the functions its spec names: queries through
// `/api/dash/query` (any role), mutations and actions through `/api/dash/run` (admin, CSRF, audited, typed confirmation
// for destructive ones on protected environments). Filters and forms come from the functions' `v.*` args. Everything
// from the project is rendered as text.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, path } from "../api.ts";
import { TimeChart } from "../chart.tsx";
import { argsFromForm, fieldKind, type ObjectShape, type Shape } from "../forms.ts";
import { ago, fmtBytes, fmtNum, fmtPct, fmtTime, text } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Dialog, Empty, JsonView, Loading, Mono, Problem, Section, Stat, Table } from "../ui.tsx";

// ------------------------------------------------------------------------------------------- spec (as the runtime lists it)

type Format = "text" | "number" | "bytes" | "ms" | "date" | "ago" | "percent" | "boolean" | "badge" | "code" | "json";
interface Field {
  label: string;
  path: string;
  format?: Format;
}
interface Action {
  id: string;
  label: string;
  fn: string;
  args?: Record<string, unknown>;
  fromRow?: Record<string, string>;
  description?: string;
  destructive?: true;
}
type SectionSpec =
  | { kind: "kv"; label?: string; path?: string; items: Field[] }
  | { kind: "timeline"; label?: string; path: string; time: string; title: string; detail?: string; status?: string }
  | { kind: "code"; label?: string; path: string; language?: string }
  | { kind: "stacktrace"; label?: string; path: string }
  | { kind: "json"; label?: string; path?: string }
  | { kind: "chart"; label?: string; path: string; x: string; y: string[]; type?: "line" | "bar" };
interface Detail {
  query: string;
  args?: Record<string, unknown>;
  fromRow?: Record<string, string>;
  sections: SectionSpec[];
}
interface Column extends Field {
  toggle?: { mutation: string; arg: string; args?: Record<string, unknown>; fromRow?: Record<string, string> };
}
type Block = { id: string; label?: string; description?: string } & (
  | { kind: "stats"; query: string; args?: Record<string, unknown>; items: Field[] }
  | { kind: "table"; query: string; args?: Record<string, unknown>; rows?: string; columns: Column[]; filters: string[]; pageSize?: number; rowKey: string; detail?: Detail; rowActions?: Action[] }
  | ({ kind: "detail" } & Detail)
  | { kind: "toggle"; label: string; query: string; args?: Record<string, unknown>; path: string; mutation: string; arg: string; mutationArgs?: Record<string, unknown> }
  | { kind: "actions"; actions: Action[] }
);
export interface Spec {
  key: string;
  component: string | null;
  label: string;
  icon: string;
  description?: string;
  scope: "shard" | "global";
  tabs: Array<{ id: string; label: string; blocks: Block[] }>;
  functions: Record<string, { type: "query" | "mutation" | "action"; args: ObjectShape; destructive?: true }>;
}

const ICONS: Record<string, string> = { box: "▢", queue: "☰", database: "◫", workflow: "⇄", gauge: "◔", bell: "◉", mail: "✉", bot: "◎", list: "≣", clock: "◷", shield: "⛨", chart: "▤", key: "⚿", flag: "⚑" };

/** A dot path into a value (`""`: the value itself). */
export function at(value: unknown, p: string | undefined): unknown {
  if (!p) return value;
  let v: unknown = value;
  for (const k of p.split(".")) {
    if (v === null || v === undefined || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

const TONES: Record<string, "ok" | "bad" | "warn" | "info"> = {
  ok: "ok", success: "ok", done: "ok", completed: "ok", sent: "ok", delivered: "ok", active: "ok", ready: "ok", true: "ok",
  failed: "bad", error: "bad", canceled: "bad", cancelled: "bad", bounced: "bad", dead: "bad", false: "bad",
  pending: "info", running: "info", queued: "info", scheduled: "info", inProgress: "info", streaming: "info",
  warn: "warn", retrying: "warn", deferred: "warn", paused: "warn",
};

/** A value as the spec's format says; always text (never markup from the project). */
export function show(v: unknown, f: Format | undefined): ReactNode {
  if (v === undefined || v === null || v === "") return <span className="muted">—</span>;
  switch (f) {
    case "number":
      return typeof v === "number" ? fmtNum(v, Number.isInteger(v) ? 0 : 2) : text(v);
    case "bytes":
      return fmtBytes(v);
    case "ms":
      return typeof v === "number" ? `${fmtNum(v, v < 10 ? 2 : 0)} ms` : text(v);
    case "date":
      return fmtTime(v);
    case "ago":
      return typeof v === "number" ? <span title={fmtTime(v)}>{ago(v)}</span> : text(v);
    case "percent":
      return fmtPct(v);
    case "boolean":
      return v ? <Badge tone="ok">yes</Badge> : <Badge>no</Badge>;
    case "badge":
      return <Badge tone={TONES[String(v)]}>{text(v, 40)}</Badge>;
    case "code":
      return <Mono>{text(v, 200)}</Mono>;
    case "json":
      return <Mono title={JSON.stringify(v)}>{text(v, 80)}</Mono>;
    default:
      return text(v);
  }
}

const fromRow = (row: unknown, map: Record<string, string> | undefined): Record<string, unknown> => Object.fromEntries(Object.entries(map ?? {}).map(([k, p]) => [k, at(row, p)]));
const localName = (fn: string) => fn.slice(fn.lastIndexOf(":") + 1);

// ------------------------------------------------------------------------------------------- page

interface ScreenCtx {
  project: string;
  env: string;
  shard: string;
  spec: Spec;
  /** Bumped after every successful write: the blocks load again. */
  version: number;
  changed: () => void;
}

function useDashQuery<T>(c: ScreenCtx, fn: string, args: Record<string, unknown> | null) {
  const q = useApi<{ value: T; ms: number }>(args ? path("/api/dash/query", { project: c.project, env: c.env, shard: c.shard, dashboard: c.spec.key, fn, args: JSON.stringify(args) }) : null);
  const { reload } = q;
  useEffect(() => {
    if (c.version) reload();
  }, [c.version, reload]);
  return q;
}

/** `#/p/<p>/<e>/components[/<shard>/<key>[/<tab>]]` and `#/p/<p>/<e>/app[/<shard>/<tab>]`. */
export function Screens({ project, env, shard, kind, rest }: { project: string; env: string; shard: string; kind: "components" | "app"; rest: string[] }) {
  const specs = useApi<{ dashboards: Spec[] }>(path("/api/dash/specs", { project, env }));
  if (specs.error) return <Problem error={specs.error} onRetry={specs.reload} />;
  if (!specs.data) return <Loading lines={5} />;
  const all = specs.data.dashboards ?? [];
  if (kind === "app") {
    const spec = all.find((d) => d.key === "");
    if (!spec)
      return (
        <Empty>
          This app has no screens yet. Add <code>dashboard</code> to <code>defineApp()</code> in <code>ember/ember.config.ts</code> (contracts.md, "Telas declarativas").
        </Empty>
      );
    return <Screen key={`${project}/${env}`} project={project} env={env} shard={shard} spec={spec} tab={rest[0]} link={(tab) => href({ project, env, section: "app", shard, rest: tab ? [tab] : [] })} />;
  }
  const key = rest[0];
  const components = all.filter((d) => d.key !== "");
  const spec = key === undefined ? undefined : components.find((d) => d.key === key);
  if (key !== undefined && !spec) return <Problem error={new ApiError(404, "unknown_dashboard", `No component installed as ${key} has screens in this deployment`)} />;
  if (spec)
    return (
      <>
        <div className="toolbar">
          <a href={href({ project, env, section: "components", shard })}>← Components</a>
        </div>
        <Screen key={`${project}/${env}/${spec.key}`} project={project} env={env} shard={shard} spec={spec} tab={rest[1]} link={(tab) => href({ project, env, section: "components", shard, rest: [spec.key, ...(tab ? [tab] : [])] })} />
      </>
    );
  return (
    <Table
      label="Components with screens"
      empty={
        <>
          No installed component has screens. Components declare them with <code>defineComponent({"{ dashboard }"})</code>.
        </>
      }
      onRow={(i) => (location.hash = href({ project, env, section: "components", shard, rest: [components[i]!.key] }))}
      cols={[{ h: "" }, { h: "Screen" }, { h: "Installed as" }, { h: "Component" }, { h: "Runs on" }, { h: "Tabs" }]}
      rows={components.map((d) => [
        <span aria-hidden="true" className="screen-icon">
          {ICONS[d.icon] ?? ICONS.box}
        </span>,
        <span>
          <strong>{d.label}</strong>
          {d.description && <div className="muted small">{d.description}</div>}
        </span>,
        <Mono>{d.key}</Mono>,
        <Mono>{d.component ?? "—"}</Mono>,
        d.scope === "global" ? <Mono>global:main</Mono> : "the picked shard",
        d.tabs.map((t) => t.label).join(", "),
      ])}
    />
  );
}

function Screen({ project, env, shard: picked, spec, tab, link }: { project: string; env: string; shard: string; spec: Spec; tab: string | undefined; link: (tab: string | null) => string }) {
  const [version, setVersion] = useState(0);
  const shard = spec.scope === "global" ? "global:main" : picked;
  const current = spec.tabs.find((t) => t.id === tab) ?? spec.tabs[0];
  const c: ScreenCtx = useMemo(() => ({ project, env, shard, spec, version, changed: () => setVersion((n) => n + 1) }), [project, env, shard, spec, version]);
  return (
    <>
      <header className="screen-head">
        <span aria-hidden="true" className="screen-icon">
          {ICONS[spec.icon] ?? ICONS.box}
        </span>
        <h1 className="page-title">{spec.label}</h1>
        {spec.component && <Badge>{spec.component === spec.key ? spec.component : `${spec.component} as ${spec.key}`}</Badge>}
        <Badge tone="info" title={spec.scope === "global" ? "This screen always runs on global:main" : "Pick the shard in the top bar"}>
          {shard}
        </Badge>
        <span className="spacer" />
        <button type="button" onClick={c.changed}>
          Refresh
        </button>
      </header>
      {spec.description && <p className="muted">{spec.description}</p>}
      {spec.tabs.length > 1 && (
        <nav className="tabs-inline" aria-label={`${spec.label} tabs`}>
          {spec.tabs.map((t) => (
            <a key={t.id} href={link(t.id)} role="tab" aria-selected={t.id === current?.id} className={t.id === current?.id ? "active" : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
      )}
      {current?.blocks.map((b) => (
        <BlockView key={`${current.id}/${b.id}`} c={c} b={b} />
      ))}
    </>
  );
}

function BlockView({ c, b }: { c: ScreenCtx; b: Block }) {
  const id = `blk-${b.id}`;
  const body =
    b.kind === "stats" ? <StatsBlock c={c} b={b} /> : b.kind === "table" ? <TableBlock c={c} b={b} /> : b.kind === "detail" ? <DetailBlock c={c} b={b} /> : b.kind === "toggle" ? <ToggleBlock c={c} b={b} /> : <ActionsBlock c={c} actions={b.actions} />;
  if (!b.label && !b.description) return <div className="section">{body}</div>;
  return (
    <Section title={b.label ?? ""} id={id}>
      {b.description && <p className="muted small">{b.description}</p>}
      {body}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------- blocks

function StatsBlock({ c, b }: { c: ScreenCtx; b: Extract<Block, { kind: "stats" }> }) {
  const q = useDashQuery<unknown>(c, b.query, b.args ?? {});
  if (q.error) return <Problem error={q.error} onRetry={q.reload} />;
  return (
    <div className="stats compact" aria-busy={q.loading}>
      {b.items.map((it) => (
        <Stat key={it.path + it.label} label={it.label} value={q.data ? show(at(q.data.value, it.path), it.format ?? "number") : "…"} />
      ))}
    </div>
  );
}

function TableBlock({ c, b }: { c: ScreenCtx; b: Extract<Block, { kind: "table" }> }) {
  const s = useSession();
  const info = c.spec.functions[b.query];
  const filterFields = b.filters.flatMap((k) => (info?.args.fields[k] ? [[k, info.args.fields[k]!] as const] : []));
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<Record<string, unknown>>({});
  const [filterError, setFilterError] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [open, setOpen] = useState<unknown>(null);
  const cursor = cursors[cursors.length - 1] ?? null;
  const args = { ...(b.args ?? {}), ...applied, ...(b.pageSize ? { paginationOpts: { numItems: b.pageSize, cursor } } : {}) };
  const q = useDashQuery<unknown>(c, b.query, args);
  const value = q.data?.value;
  const page = b.pageSize && value && typeof value === "object" ? (value as { page?: unknown; isDone?: boolean; continueCursor?: string }) : null;
  const rows = at(b.rows ? value : page ? page.page : value, b.rows);
  const list = Array.isArray(rows) ? rows : null;
  const hasActions = !!b.rowActions?.length;
  return (
    <>
      {filterFields.length > 0 && (
        <form
          className="toolbar filters"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setApplied(argsFromForm({ kind: "object", fields: Object.fromEntries(filterFields) }, raw));
              setFilterError(null);
              setCursors([null]);
            } catch (x) {
              setFilterError((x as Error).message);
            }
          }}
        >
          <ArgInputs fields={filterFields} raw={raw} setRaw={setRaw} inline />
          <button type="submit">Filter</button>
          {Object.keys(applied).length > 0 && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setRaw({});
                setApplied({});
                setCursors([null]);
              }}
            >
              Clear
            </button>
          )}
          {filterError && <span className="bad small">{filterError}</span>}
        </form>
      )}
      {q.error ? (
        <Problem error={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <Loading lines={4} />
      ) : !list ? (
        <JsonView value={value} />
      ) : (
        <Table
          label={b.label ?? b.id}
          empty={Object.keys(applied).length ? "Nothing matches these filters." : "Nothing here yet."}
          {...(b.detail ? { onRow: (i: number) => setOpen(list[i]) } : {})}
          cols={[...b.columns.map((col) => ({ h: col.label, ...(col.format === "number" || col.format === "bytes" || col.format === "ms" ? { num: true } : {}) })), ...(hasActions ? [{ h: "" }] : [])]}
          rows={list.map((row) => [
            ...b.columns.map((col) => (col.toggle ? <Toggle c={c} value={!!at(row, col.path)} label={col.label} mutation={col.toggle.mutation} args={{ ...(col.toggle.args ?? {}), ...fromRow(row, col.toggle.fromRow) }} arg={col.toggle.arg} disabled={!s.isAdmin} /> : show(at(row, col.path), col.format))),
            ...(hasActions
              ? [
                  <span className="row-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    {b.rowActions!.map((a) => (
                      <ActionButton key={a.id} c={c} action={a} preset={{ ...(a.args ?? {}), ...fromRow(row, a.fromRow) }} small />
                    ))}
                  </span>,
                ]
              : []),
          ])}
        />
      )}
      {page && (
        <div className="toolbar">
          <button type="button" disabled={cursors.length < 2} onClick={() => setCursors((x) => x.slice(0, -1))}>
            ← Previous
          </button>
          <button type="button" disabled={page.isDone !== false || !page.continueCursor} onClick={() => setCursors((x) => [...x, page.continueCursor!])}>
            Next →
          </button>
          <span className="muted small">page {cursors.length}</span>
        </div>
      )}
      {b.detail && (
        <Dialog open={open !== null} onClose={() => setOpen(null)} title={b.label ?? "Detail"} wide>
          <div className="dialog-body">{open !== null && <DetailView c={c} d={b.detail} args={{ ...(b.detail.args ?? {}), ...fromRow(open, b.detail.fromRow) }} />}</div>
        </Dialog>
      )}
    </>
  );
}

function DetailBlock({ c, b }: { c: ScreenCtx; b: Extract<Block, { kind: "detail" }> }) {
  const info = c.spec.functions[b.query];
  const free = Object.entries(info?.args.fields ?? {}).filter(([k]) => !(b.args && k in b.args));
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [args, setArgs] = useState<Record<string, unknown> | null>(free.some(([, f]) => !f.optional && f.default === undefined) ? null : { ...(b.args ?? {}) });
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {free.length > 0 && (
        <form
          className="toolbar filters"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setArgs({ ...(b.args ?? {}), ...argsFromForm({ kind: "object", fields: Object.fromEntries(free) }, raw) });
              setError(null);
            } catch (x) {
              setError((x as Error).message);
            }
          }}
        >
          <ArgInputs fields={free} raw={raw} setRaw={setRaw} inline />
          <button type="submit">Show</button>
          {error && <span className="bad small">{error}</span>}
        </form>
      )}
      {args ? <DetailView c={c} d={b} args={args} /> : <Empty>Fill in the fields to load it.</Empty>}
    </>
  );
}

function DetailView({ c, d, args }: { c: ScreenCtx; d: Detail; args: Record<string, unknown> }) {
  const q = useDashQuery<unknown>(c, d.query, args);
  if (q.error) return <Problem error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading lines={4} />;
  const value = q.data.value;
  if (value === null || value === undefined) return <Empty>Not found (it may have been removed).</Empty>;
  return (
    <div className="screen-detail">
      {d.sections.map((s, i) => (
        <SectionView key={i} s={s} value={value} />
      ))}
    </div>
  );
}

function SectionView({ s, value }: { s: SectionSpec; value: unknown }) {
  const title = s.label ? <h3>{s.label}</h3> : null;
  switch (s.kind) {
    case "kv": {
      const base = at(value, s.path);
      return (
        <div>
          {title}
          <dl className="kv">
            {s.items.map((it) => (
              <div key={it.label}>
                <dt>{it.label}</dt>
                <dd>{show(at(base, it.path), it.format)}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    }
    case "timeline": {
      const items = at(value, s.path);
      return (
        <div>
          {title}
          {!Array.isArray(items) || !items.length ? (
            <Empty>No entries.</Empty>
          ) : (
            <ol className="timeline">
              {items.map((it, i) => {
                const t = at(it, s.time);
                const status = s.status ? at(it, s.status) : undefined;
                const detail = s.detail ? at(it, s.detail) : undefined;
                return (
                  <li key={i}>
                    <span className="timeline-time muted small">{typeof t === "number" ? <span title={fmtTime(t)}>{ago(t)}</span> : text(t)}</span>
                    <span className="timeline-title">{text(at(it, s.title))}</span>
                    {status !== undefined && status !== null && <Badge tone={TONES[String(status)]}>{text(status, 40)}</Badge>}
                    {detail !== undefined && detail !== null && <div className="muted small timeline-detail">{typeof detail === "object" ? text(detail, 300) : text(detail, 300)}</div>}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      );
    }
    case "code":
    case "stacktrace": {
      const v = at(value, s.path);
      return (
        <div>
          {title}
          {v === undefined || v === null || v === "" ? <Empty>Nothing.</Empty> : <pre className={s.kind === "stacktrace" ? "json stacktrace" : "json"}>{typeof v === "string" ? v : JSON.stringify(v, null, 2)}</pre>}
        </div>
      );
    }
    case "json":
      return (
        <div>
          {title}
          <JsonView value={at(value, s.path)} />
        </div>
      );
    case "chart": {
      const points = at(value, s.path);
      const list = Array.isArray(points) ? points : [];
      const times = list.map((p) => Number(at(p, s.x)) || 0);
      return (
        <TimeChart
          title={s.label ?? ""}
          times={times}
          series={s.y.map((y, i) => ({ label: y, cls: i === 0 ? "s1" : i === 1 ? "s2" : "muted", values: list.map((p) => Number(at(p, y)) || 0), ...(s.type === "bar" ? { bars: true } : {}) }))}
          empty="No points."
        />
      );
    }
  }
}

function ToggleBlock({ c, b }: { c: ScreenCtx; b: Extract<Block, { kind: "toggle" }> }) {
  const s = useSession();
  const q = useDashQuery<unknown>(c, b.query, b.args ?? {});
  if (q.error) return <Problem error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading lines={1} />;
  return (
    <div className="toolbar">
      <Toggle c={c} value={!!at(q.data.value, b.path)} label={b.label} mutation={b.mutation} args={b.mutationArgs ?? {}} arg={b.arg} disabled={!s.isAdmin} />
      <span>{b.label}</span>
    </div>
  );
}

function ActionsBlock({ c, actions }: { c: ScreenCtx; actions: Action[] }) {
  return (
    <div className="toolbar">
      {actions.map((a) => (
        <ActionButton key={a.id} c={c} action={a} preset={a.args ?? {}} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- writes

async function runWrite(c: ScreenCtx, fn: string, args: Record<string, unknown>, confirm: string | null): Promise<unknown> {
  return api.post("/api/dash/run", { project: c.project, env: c.env, shard: c.shard, dashboard: c.spec.key, fn, args, ...(confirm ? { confirm } : {}) });
}

/** A switch for a boolean (inline in a table, or a toggle block): flipping it runs the mutation with the new value. */
function Toggle({ c, value, label, mutation, args, arg, disabled }: { c: ScreenCtx; value: boolean; label: string; mutation: string; args: Record<string, unknown>; arg: string; disabled: boolean }) {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value]);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      aria-label={label}
      className={`switch${shown ? " on" : ""}`}
      disabled={disabled || busy}
      title={disabled ? "Needs the admin role" : undefined}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await runWrite(c, mutation, { ...args, [arg]: !shown }, null);
          setShown(!shown);
          c.changed();
        } catch (x) {
          s.toast({ kind: "bad", text: `${label}: ${(x as Error).message}`, detail: x instanceof ApiError ? x.code : "" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}

/**
 * An action of the spec: a form for the args it does not fix (from the function's `v.*`), a confirmation on protected
 * environments, and the typed one (the function's name) for destructive actions there.
 */
function ActionButton({ c, action, preset, small }: { c: ScreenCtx; action: Action; preset: Record<string, unknown>; small?: boolean }) {
  const s = useSession();
  const info = c.spec.functions[action.fn];
  const free = Object.entries(info?.args.fields ?? {}).filter(([k]) => !(k in preset));
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [expected, setExpected] = useState<string | null>(null);
  const prot = s.isProtected(c.env);
  const destructive = action.destructive === true || info?.destructive === true;
  const run = async (typed: string | null) => {
    let args: Record<string, unknown>;
    try {
      args = { ...preset, ...argsFromForm({ kind: "object", fields: Object.fromEntries(free) }, raw) };
    } catch (x) {
      setError(new ApiError(400, "bad_request", (x as Error).message));
      setOpen(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = (await runWrite(c, action.fn, args, typed)) as { value?: unknown };
      setOpen(false);
      s.toast({ text: `${action.label}: done`, ...(r.value !== undefined && r.value !== null ? { detail: text(r.value, 120) } : {}) });
      c.changed();
    } catch (x) {
      const e = x instanceof ApiError ? x : new ApiError(0, "error", String(x));
      // The Worker decides what is destructive: when it asks, ask for the text it names.
      if (e.code === "confirmation_required" && typeof e.data?.expected === "string") {
        setExpected(e.data.expected);
        setOpen(true);
      } else {
        setError(e);
        setOpen(true);
      }
    } finally {
      setBusy(false);
    }
  };
  const needsDialog = free.length > 0 || destructive || prot;
  return (
    <>
      <button
        type="button"
        className={`${destructive ? "danger" : ""}${small ? " small" : ""}`.trim() || undefined}
        disabled={!s.isAdmin || busy}
        title={!s.isAdmin ? "Needs the admin role" : action.description}
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          setExpected(destructive && prot ? localName(action.fn) : null);
          if (needsDialog) setOpen(true);
          else void run(null);
        }}
      >
        {action.label}
      </button>
      <ConfirmDialog
        open={open}
        title={`${action.label}${prot ? ` on ${c.env}` : ""}?`}
        confirmLabel={action.label}
        danger={destructive}
        expected={expected}
        busy={busy}
        error={error}
        onCancel={() => setOpen(false)}
        onConfirm={(typed) => void run(typed)}
      >
        {action.description && <p>{action.description}</p>}
        <p className="muted small">
          Runs <Mono>{action.fn}</Mono> on <Mono>{c.shard}</Mono>. Recorded in the audit log.
        </p>
        {free.length > 0 && <ArgInputs fields={free} raw={raw} setRaw={setRaw} />}
      </ConfirmDialog>
    </>
  );
}

// ------------------------------------------------------------------------------------------- inputs from v.*

function ArgInputs({ fields, raw, setRaw, inline }: { fields: ReadonlyArray<readonly [string, { shape: Shape; optional: boolean; default?: unknown; description?: string }]>; raw: Record<string, string>; setRaw: (r: Record<string, string>) => void; inline?: boolean }) {
  return (
    <>
      {fields.map(([k, f]) => {
        const kind = fieldKind(f.shape);
        const id = `dash-arg-${k}`;
        const label = `${k}${f.optional || f.default !== undefined ? "" : " *"}`;
        const set = (v: string) => setRaw({ ...raw, [k]: v });
        const input = kind.options ? (
          <select id={id} value={raw[k] ?? ""} onChange={(e) => set(e.target.value)} aria-label={k}>
            <option value="">{inline ? `${k}: any` : "—"}</option>
            {kind.options.map((o) => (
              <option key={String(o)} value={String(o)}>
                {String(o)}
              </option>
            ))}
          </select>
        ) : kind.kind === "boolean" ? (
          <select id={id} value={raw[k] ?? ""} onChange={(e) => set(e.target.value)} aria-label={k}>
            <option value="">{inline ? `${k}: any` : "—"}</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input id={id} type={kind.kind === "number" ? "number" : "text"} step="any" value={raw[k] ?? ""} onChange={(e) => set(e.target.value)} placeholder={inline ? k : kind.kind === "json" ? "JSON" : ""} className={kind.kind === "json" ? "mono" : undefined} spellCheck={false} aria-label={k} />
        );
        if (inline) return <span key={k}>{input}</span>;
        return (
          <label key={k} className="field" htmlFor={id}>
            <span>
              <Mono>{label}</Mono> <span className="muted">{f.description ?? ""}</span>
            </span>
            {input}
          </label>
        );
      })}
    </>
  );
}
