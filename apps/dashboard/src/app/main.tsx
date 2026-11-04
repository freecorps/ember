// Ember Dashboard SPA (React, no router/UI deps). Hash routes:
//   #/                                   projects + environments (registry)
//   #/p/<project>/<env>/<tab>            deployments | functions | shards | crons | data

import { StrictMode, useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const TOKEN_KEY = "ember-dashboard-token";
const store = {
  get: () => {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) sessionStorage.setItem(TOKEN_KEY, v);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // storage unavailable: the token lives only in memory
    }
  },
};
let memToken = store.get();

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api<T = any>(path: string): Promise<T> {
  const res = await fetch(path, { headers: memToken ? { authorization: `Bearer ${memToken}` } : {} });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || body.ok === false) throw new ApiError(res.status, body?.error?.code ?? "error", body?.error?.message ?? res.statusText);
  return body as T;
}

function useApi<T = any>(path: string | null): { data: T | null; error: ApiError | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path).then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error: ApiError) => live && setState({ data: null, error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [path, n]);
  return { ...state, reload: useCallback(() => setN((x) => x + 1), []) };
}

function useHash(): string[] {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const f = () => setH(location.hash);
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return h.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

// ------------------------------------------------------------------------------------------- formatting

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`);
const fmtTime = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toLocaleString() : "—");
const ago = (ms: unknown) => {
  if (typeof ms !== "number" || !ms) return "—";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const fmtNum = (n: number, d = 0) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : "—");
const short = (s: unknown, n = 12) => (typeof s === "string" ? s.slice(0, n) : "—");

// ------------------------------------------------------------------------------------------- UI bits

function Table({ cols, rows, empty = "Nothing yet." }: { cols: Array<{ h: string; num?: boolean }>; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c.h} className={c.num ? "num" : ""}>{c.h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={cols[j]?.num ? "num" : ""}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Problem({ error }: { error: ApiError }) {
  return (
    <p className="problem">
      <strong>{error.code}</strong> {error.message}
    </p>
  );
}

function Loading() {
  return <p className="muted">Loading…</p>;
}

// ------------------------------------------------------------------------------------------- pages

function Projects() {
  const { data, error } = useApi<{ projects: any[] }>("/api/projects");
  if (error) return <Problem error={error} />;
  if (!data) return <Loading />;
  if (!data.projects.length) return <p className="muted">No projects yet. Run <code>ember deploy</code> in a project.</p>;
  return (
    <>
      {data.projects.map((p) => (
        <section key={p.name} className="card">
          <h2>{p.name}</h2>
          {p.repo && <p className="muted small">{p.repo}</p>}
          <Table
            cols={[{ h: "Environment" }, { h: "Worker" }, { h: "URL" }, { h: "Schema" }, { h: "Shards", num: true }, { h: "Last deploy" }]}
            rows={p.envs.map((e: any) => [
              <a href={`#/p/${p.name}/${e.env}/functions`}>{e.env}</a>,
              <code>{e.worker}</code>,
              e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.url.replace(/^https:\/\//, "")}</a> : "—",
              <code>{short(e.schema_version)}</code>,
              fmtNum(e.shards),
              ago(e.last_deploy),
            ])}
          />
          {p.domains.length > 0 && <p className="small">Domains: {p.domains.map((d: any) => `${d.host} (${d.env})`).join(", ")}</p>}
        </section>
      ))}
    </>
  );
}

function Deployments({ project, env }: { project: string; env: string }) {
  const { data, error } = useApi<{ deployments: any[] }>(`/api/deployments?project=${project}&env=${env}`);
  if (error) return <Problem error={error} />;
  if (!data) return <Loading />;
  return (
    <Table
      cols={[{ h: "When" }, { h: "Version" }, { h: "Strategy" }, { h: "Schema" }, { h: "Message" }]}
      rows={data.deployments.map((d) => [fmtTime(d.at), <code>{short(d.version_id, 8)}</code>, d.strategy ?? "—", <code>{short(d.schema_version)}</code>, d.message ?? ""])}
    />
  );
}

function Functions({ project, env }: { project: string; env: string }) {
  const [hours, setHours] = useState(24);
  const { data, error, reload } = useApi<{ functions: any[] }>(`/api/functions?project=${project}&env=${env}&hours=${hours}`);
  return (
    <>
      <div className="bar">
        <label>
          Window{" "}
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[1, 6, 24, 72, 168].map((h) => <option key={h} value={h}>{h < 24 ? `${h}h` : `${h / 24}d`}</option>)}
          </select>
        </label>
        <button onClick={reload}>Refresh</button>
      </div>
      {error ? (
        <Problem error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <Table
          empty="No executions recorded in this window (Analytics Engine can take a minute to show new points)."
          cols={[{ h: "Function" }, { h: "Kind" }, { h: "Calls", num: true }, { h: "Errors", num: true }, { h: "p50 ms", num: true }, { h: "p95 ms", num: true }, { h: "Rows read/call", num: true }, { h: "Rows written", num: true }, { h: "Bytes out", num: true }]}
          rows={data.functions.map((f) => [
            <code>{f.fn}</code>,
            f.kind,
            fmtNum(f.calls),
            <span className={f.errorRate > 0.01 ? "bad" : ""}>{fmtNum(f.errors)} ({(f.errorRate * 100).toFixed(1)}%)</span>,
            fmtNum(f.p50, 2),
            fmtNum(f.p95, 2),
            <span className={f.avgRowsRead > 1000 ? "warn" : ""}>{fmtNum(f.avgRowsRead, 1)}</span>,
            fmtNum(f.rowsWritten),
            fmtBytes(f.bytesOut),
          ])}
        />
      )}
    </>
  );
}

function Shards({ project, env }: { project: string; env: string }) {
  const { data, error, reload } = useApi<{ shards: any[]; status: any }>(`/api/shards?project=${project}&env=${env}&status=1`);
  if (error) return <Problem error={error} />;
  if (!data) return <Loading />;
  const live = new Map<string, any>((data.status?.shards ?? []).map((s: any) => [s.shard, s]));
  return (
    <>
      <div className="bar">
        <span className="muted small">Catalog: reported by each shard after a migration and hourly while active. Status: live from the project.</span>
        <button onClick={reload}>Refresh</button>
      </div>
      {data.status && data.status.ok === false && <p className="problem">status: {String(data.status.error ?? data.status.status)}</p>}
      <Table
        empty="No shard has reported yet."
        cols={[{ h: "Shard" }, { h: "Size", num: true }, { h: "Schema" }, { h: "Migration" }, { h: "Last write" }, { h: "Reported" }, { h: "" }]}
        rows={data.shards.map((s) => {
          const st = live.get(s.shard);
          const mig = !st ? "—" : st.migrationError ? <span className="bad">refused: {st.migrationError.code}</span> : st.staged?.length ? <span className="warn">backfilling {st.staged.length}</span> : st.ready ? <span className="ok">ready</span> : "pending";
          return [
            <code>{s.shard}</code>,
            fmtBytes(st?.databaseSize ?? s.db_size),
            <code>{short(st?.schemaVersion ?? s.schema_version)}</code>,
            mig,
            ago(s.last_write),
            ago(s.reported_at),
            <a href={`#/p/${project}/${env}/data/${encodeURIComponent(s.shard)}`}>data</a>,
          ];
        })}
      />
    </>
  );
}

function Crons({ project, env }: { project: string; env: string }) {
  const crons = useApi<{ crons: any[] }>(`/api/crons?project=${project}&env=${env}`);
  const [shard, setShard] = useState("global:main");
  const jobs = useApi<{ rows: any[] }>(`/api/data?project=${project}&env=${env}&shard=${encodeURIComponent(shard)}&table=_jobs&limit=100`);
  return (
    <>
      <h3>Crons</h3>
      {crons.error ? (
        <Problem error={crons.error} />
      ) : !crons.data ? (
        <Loading />
      ) : (
        <Table
          empty="No crons (ember/crons.ts)."
          cols={[{ h: "Name" }, { h: "Schedule" }, { h: "Function" }, { h: "Shard" }, { h: "Last dispatch" }, { h: "Last error" }]}
          rows={crons.data.crons.map((c) => [c.name, <code>{c.schedule}{c.tz ? ` (${c.tz})` : ""}</code>, <code>{c.fn}</code>, <code>{c.shard}</code>, c.state?.last_dispatch ? fmtTime(c.state.last_dispatch * 60_000) : "—", c.state?.last_error ? <span className="bad">{c.state.last_error}</span> : ""])}
        />
      )}
      <h3>Jobs</h3>
      <div className="bar">
        <label>
          Shard <input value={shard} onChange={(e) => setShard(e.target.value)} />
        </label>
      </div>
      {jobs.error ? (
        <Problem error={jobs.error} />
      ) : !jobs.data ? (
        <Loading />
      ) : (
        <Table
          empty="No pending or failed jobs on this shard."
          cols={[{ h: "Job" }, { h: "Function" }, { h: "Kind" }, { h: "State" }, { h: "Run at" }, { h: "Attempts", num: true }, { h: "Last error" }]}
          rows={jobs.data.rows.map((j) => [<code>{short(j.job_id ?? String(j.id), 16)}</code>, <code>{j.fn}</code>, j.kind, j.state, fmtTime(j.run_at), `${j.attempts}/${j.max_attempts}`, j.last_error ?? ""])}
        />
      )}
    </>
  );
}

function DataBrowser({ project, env, initialShard }: { project: string; env: string; initialShard?: string }) {
  const [shard, setShard] = useState(initialShard ?? "global:main");
  const [draft, setDraft] = useState(shard);
  const [table, setTable] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const base = `/api/data?project=${project}&env=${env}&shard=${encodeURIComponent(shard)}`;
  const tables = useApi<{ tables: any[] }>(base);
  const cursor = cursors[cursors.length - 1] ?? null;
  const page = useApi<{ rows: any[]; cursor: string | null; done: boolean }>(table ? `${base}&table=${encodeURIComponent(table)}&limit=50${cursor ? `&cursor=${cursor}` : ""}` : null);
  const cols = page.data ? [...new Set(page.data.rows.flatMap((r) => Object.keys(r)))].slice(0, 12) : [];
  const cell = (v: unknown) => (v === null || v === undefined ? <span className="muted">null</span> : typeof v === "object" ? <code>{JSON.stringify(v).slice(0, 120)}</code> : String(v).slice(0, 120));
  return (
    <>
      <form
        className="bar"
        onSubmit={(e) => {
          e.preventDefault();
          setShard(draft);
          setTable(null);
          setCursors([null]);
        }}
      >
        <label>
          Shard <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="kind:key" />
        </label>
        <button type="submit">Open</button>
        <span className="muted small">read-only</span>
      </form>
      {tables.error ? (
        <Problem error={tables.error} />
      ) : !tables.data ? (
        <Loading />
      ) : (
        <div className="tabs">
          {tables.data.tables.map((t) => (
            <button
              key={t.name}
              className={t.name === table ? "active" : ""}
              onClick={() => {
                setTable(t.name);
                setCursors([null]);
              }}
            >
              {t.name} <span className="muted">{fmtNum(t.rows)}</span>
            </button>
          ))}
        </div>
      )}
      {table && (page.error ? <Problem error={page.error} /> : !page.data ? <Loading /> : (
        <>
          <Table cols={cols.map((h) => ({ h }))} rows={page.data.rows.map((r) => cols.map((c) => cell(r[c])))} empty="Empty table." />
          <div className="bar">
            <button disabled={cursors.length < 2} onClick={() => setCursors((c) => c.slice(0, -1))}>← Previous</button>
            <span className="muted small">page {cursors.length}</span>
            <button disabled={page.data.done} onClick={() => setCursors((c) => [...c, page.data!.cursor])}>Next →</button>
          </div>
        </>
      ))}
    </>
  );
}

const TABS = ["functions", "shards", "deployments", "crons", "data"] as const;

function EnvPage({ project, env, tab, arg }: { project: string; env: string; tab: string; arg?: string }) {
  return (
    <>
      <p className="crumbs">
        <a href="#/">Projects</a> / <strong>{project}</strong> / {env}
      </p>
      <nav className="tabs">
        {TABS.map((t) => (
          <a key={t} href={`#/p/${project}/${env}/${t}`} className={t === tab ? "active" : ""}>
            {t}
          </a>
        ))}
      </nav>
      {tab === "deployments" ? (
        <Deployments project={project} env={env} />
      ) : tab === "shards" ? (
        <Shards project={project} env={env} />
      ) : tab === "crons" ? (
        <Crons project={project} env={env} />
      ) : tab === "data" ? (
        <DataBrowser key={arg ?? ""} project={project} env={env} {...(arg ? { initialShard: arg } : {})} />
      ) : (
        <Functions project={project} env={env} />
      )}
    </>
  );
}

function Login({ onDone, error }: { onDone: () => void; error: ApiError }) {
  const [v, setV] = useState("");
  return (
    <section className="card login">
      <h2>Sign in</h2>
      {error.status === 403 ? (
        <p>{error.message}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            memToken = v.trim();
            store.set(memToken);
            onDone();
          }}
        >
          <p className="muted small">Use Cloudflare Access, or paste the dashboard token printed by <code>ember dashboard deploy</code>.</p>
          <input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="dashboard token" autoFocus />
          <button type="submit">Continue</button>
          {memToken && <p className="bad small">That token was rejected.</p>}
        </form>
      )}
    </section>
  );
}

function App() {
  const me = useApi<{ via: string; who: string | null; metrics: boolean }>("/api/me");
  const route = useHash();
  let body: ReactNode;
  if (me.error && (me.error.status === 401 || me.error.status === 403)) body = <Login error={me.error} onDone={me.reload} />;
  else if (me.error) body = <Problem error={me.error} />;
  else if (!me.data) body = <Loading />;
  else if (route[0] === "p" && route[1] && route[2]) body = <EnvPage project={route[1]} env={route[2]} tab={route[3] ?? "functions"} {...(route[4] ? { arg: route[4] } : {})} />;
  else body = <Projects />;
  return (
    <>
      <header>
        <a href="#/" className="logo">ember</a>
        <span className="muted small">{me.data ? (me.data.who ?? (me.data.via === "access" ? "Cloudflare Access" : "admin token")) : ""}</span>
        {me.data?.via === "token" && (
          <button
            className="link"
            onClick={() => {
              memToken = null;
              store.set(null);
              me.reload();
            }}
          >
            Sign out
          </button>
        )}
      </header>
      <main>{body}</main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
