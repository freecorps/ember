// Functions: the list with their numbers (Analytics Engine), and one function's page — charts over time, recent
// errors and the runner. The runner calls the project's admin endpoint, which runs the function in the project's
// Worker; "run as" hands it an identity built there (no token is ever minted or returned). Admin only, audited.

import { useMemo, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { TimeChart } from "../chart.tsx";
import { ago, fmtBytes, fmtNum, fmtPct, fmtTime, windowLabel, windows } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Empty, JsonView, Loading, Mono, Problem, Section, Table } from "../ui.tsx";
import type { FunctionRow } from "./types.ts";

/** What p50/p95 measure per timing label (@freecorps/ember-runtime metrics.ts). */
const TIMING_HELP: Record<string, string> = {
  rpc: "Wall time in the Worker around the RPC to the shard (hop + queue + execution + durable commit)",
  commit: "Wall time in the Durable Object from receipt to durable commit (group commit + execution + durability)",
  wall: "Action wall time in the Worker (I/O included)",
  none: "Not measurable in production (synchronous inside the Durable Object): 0",
  "": "Recorded before timing labels: 0 ms for queries/mutations in production",
};

type Shape =
  | { kind: "string" | "number" | "int64" | "boolean" | "null" | "bytes" | "file" | "any" }
  | { kind: "id"; table: string }
  | { kind: "literal"; value: unknown }
  | { kind: "array"; item: Shape }
  | { kind: "record"; value: Shape }
  | { kind: "object"; fields: Record<string, { shape: Shape; optional: boolean; default?: unknown; description?: string }> }
  | { kind: "union"; members: Shape[] };

export interface FunctionInfo {
  name: string;
  type: "query" | "mutation" | "action";
  visibility: "public" | "internal";
  args: Extract<Shape, { kind: "object" }>;
  shard: { kind: string; fromArg?: string } | null;
  sensitive: boolean;
  authorize: boolean;
  errors: string[];
}

export function Functions({ project, env, fn }: { project: string; env: string; fn?: string | undefined }) {
  // Keyed: another function (or environment) starts with a fresh runner, never the previous one's arguments.
  if (fn) return <FunctionPage key={`${project}/${env}/${fn}`} project={project} env={env} fn={fn} />;
  return <FunctionList project={project} env={env} />;
}

function FunctionList({ project, env }: { project: string; env: string }) {
  const s = useSession();
  const [hours, setHours] = useState(24);
  const [q, setQ] = useState("");
  const stats = useApi<{ functions: FunctionRow[] }>(s.me.metrics ? path("/api/functions", { project, env, hours }) : null);
  const list = useApi<{ functions: FunctionInfo[] }>(path("/api/fn/list", { project, env }));
  // Every function of the app (from the runtime), with its numbers when Analytics Engine has some.
  const names = useMemo(() => {
    const all = new Map<string, { info?: FunctionInfo; stats: FunctionRow[] }>();
    for (const f of list.data?.functions ?? []) all.set(f.name, { info: f, stats: [] });
    for (const r of stats.data?.functions ?? []) {
      const e = all.get(r.fn) ?? { stats: [] };
      e.stats.push(r);
      all.set(r.fn, e);
    }
    return [...all.entries()].filter(([n]) => !q || n.toLowerCase().includes(q.toLowerCase())).sort(([a], [b]) => a.localeCompare(b));
  }, [list.data, stats.data, q]);
  const sum = (rows: FunctionRow[], k: "calls" | "errors" | "rowsWritten" | "bytesOut") => rows.reduce((a, r) => a + r[k], 0);
  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder="Filter functions…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter functions" />
        <label className="inline">
          Window
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {windows.map((h) => (
              <option key={h} value={h}>
                {windowLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            stats.reload();
            list.reload();
          }}
        >
          Refresh
        </button>
      </div>
      {stats.error && <Problem error={stats.error} />}
      {list.error && list.error.code !== "runtime_outdated" && <Problem error={list.error} onRetry={list.reload} />}
      {list.error?.code === "runtime_outdated" && <Problem error={list.error} />}
      {!list.data && !list.error && (stats.loading || list.loading) ? (
        <Loading lines={6} />
      ) : (
        <Table
          label="Functions"
          empty={q ? "No function matches." : "No functions."}
          onRow={(i) => (location.hash = href({ project, env, section: "functions", shard: names[i]![0] }))}
          cols={[{ h: "Function" }, { h: "Type" }, { h: "Timing" }, { h: "Calls", num: true }, { h: "Errors", num: true }, { h: "p50 ms", num: true }, { h: "p95 ms", num: true }, { h: "Rows read/call", num: true }, { h: "Rows written", num: true }, { h: "Bytes out", num: true }]}
          rows={names.map(([name, e]) => {
            const r = e.stats;
            const calls = sum(r, "calls");
            const errors = sum(r, "errors");
            const main = r[0];
            return [
              <span>
                <Mono>{name}</Mono> {e.info?.visibility === "internal" && <Badge>internal</Badge>}
              </span>,
              e.info?.type ?? main?.kind ?? "—",
              main ? <span title={TIMING_HELP[main.timing] ?? TIMING_HELP[""]}>{r.map((x) => x.timing || "—").join(", ")}</span> : "—",
              r.length ? fmtNum(calls) : "—",
              r.length ? (
                <span className={calls && errors / calls > 0.01 ? "bad" : ""}>
                  {fmtNum(errors)} <span className="muted">({fmtPct(calls ? errors / calls : 0)})</span>
                </span>
              ) : (
                "—"
              ),
              main ? fmtNum(main.p50, 2) : "—",
              main ? fmtNum(main.p95, 2) : "—",
              main ? <span className={main.avgRowsRead > 1000 ? "warn" : ""}>{fmtNum(main.avgRowsRead, 1)}</span> : "—",
              r.length ? fmtNum(sum(r, "rowsWritten")) : "—",
              r.length ? fmtBytes(sum(r, "bytesOut")) : "—",
            ];
          })}
        />
      )}
    </>
  );
}

function FunctionPage({ project, env, fn }: { project: string; env: string; fn: string }) {
  const s = useSession();
  const [hours, setHours] = useState(24);
  const list = useApi<{ functions: FunctionInfo[] }>(path("/api/fn/list", { project, env }));
  const info = list.data?.functions.find((f) => f.name === fn);
  const series = useApi<{ points: Array<{ t: number; calls: number; errors: number; p50: number; p95: number; rowsRead: number; rowsWritten: number }>; bucketMinutes: number }>(
    s.me.metrics ? path("/api/fn/series", { project, env, fn, hours }) : null,
  );
  const errors = useApi<{ errors: Array<{ t: number; code: string; shard: string; kind: string; ms: number }> }>(s.me.metrics ? path("/api/fn/errors", { project, env, fn, hours }) : null);
  const p = series.data?.points ?? [];
  const times = p.map((x) => x.t);
  return (
    <>
      <div className="toolbar">
        <a href={href({ project, env, section: "functions" })}>← Functions</a>
        <h1 className="fn-title">
          <Mono>{fn}</Mono>
        </h1>
        {info && (
          <>
            <Badge tone="info">{info.type}</Badge>
            {info.visibility === "internal" && <Badge>internal</Badge>}
            {info.sensitive && <Badge tone="warn" title="Checks the caller's live session on every call">sensitive</Badge>}
            {info.authorize && <Badge title="Per-user access check; the result is shared">authorize</Badge>}
            {info.shard && (
              <Badge title="Shard it runs in">
                shard {info.shard.kind}
                {info.shard.fromArg ? ` (from ${info.shard.fromArg})` : ""}
              </Badge>
            )}
          </>
        )}
        <span className="spacer" />
        <label className="inline">
          Window
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {windows.map((h) => (
              <option key={h} value={h}>
                {windowLabel(h)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.error && <Problem error={list.error} />}
      {list.data && !info && <Problem error={new ApiError(404, "not_found", `${fn} is not a function of this deployment`)} />}
      {!s.me.metrics ? (
        <div className="notice info">
          <strong>Charts need Analytics Engine</strong>
          <p className="muted">
            Run <code>EMBER_ANALYTICS_TOKEN=… ember dashboard deploy</code> with a token that has Account Analytics: Read.
          </p>
        </div>
      ) : series.error ? (
        <Problem error={series.error} onRetry={series.reload} />
      ) : !series.data ? (
        <Loading lines={4} />
      ) : (
        <div className="charts">
          <TimeChart title={`Calls per ${series.data.bucketMinutes} min`} times={times} series={[{ label: "calls", cls: "s1", values: p.map((x) => x.calls), bars: true }, { label: "errors", cls: "bad", values: p.map((x) => x.errors), bars: true }]} />
          <TimeChart title="Latency" unit=" ms" times={times} series={[{ label: "p50", cls: "muted", values: p.map((x) => x.p50) }, { label: "p95", cls: "s2", values: p.map((x) => x.p95) }]} />
          <TimeChart title="Rows" times={times} series={[{ label: "read", cls: "s1", values: p.map((x) => x.rowsRead) }, { label: "written", cls: "s2", values: p.map((x) => x.rowsWritten) }]} />
        </div>
      )}
      <div className="grid2">
        <Section title="Run" id="runner">
          {!s.isAdmin ? <Empty>Running functions needs the admin role.</Empty> : info ? <Runner project={project} env={env} info={info} /> : list.loading ? <Loading /> : null}
        </Section>
        <Section title="Recent errors" id="errors" actions={<span className="muted small">codes from Analytics Engine; messages are in the logs</span>}>
          {!s.me.metrics ? (
            <Empty>Needs Analytics Engine.</Empty>
          ) : errors.error ? (
            <Problem error={errors.error} />
          ) : !errors.data ? (
            <Loading />
          ) : (
            <Table
              label="Recent errors"
              empty="No errors in this window."
              cols={[{ h: "When" }, { h: "Code" }, { h: "Shard" }, { h: "ms", num: true }]}
              rows={errors.data.errors.map((e) => [<span title={fmtTime(e.t)}>{ago(e.t)}</span>, <Mono>{e.code || "—"}</Mono>, <Mono>{e.shard}</Mono>, fmtNum(e.ms, 1)])}
            />
          )}
        </Section>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------- runner

type FieldKind = { kind: "text" | "number" | "boolean" | "json"; options?: unknown[] };

/** How the form edits a field: simple shapes get an input; anything else is a JSON input. */
function fieldKind(shape: Shape): FieldKind {
  if (shape.kind === "string" || shape.kind === "id") return { kind: "text" };
  if (shape.kind === "number") return { kind: "number" };
  if (shape.kind === "boolean") return { kind: "boolean" };
  if (shape.kind === "literal") return { kind: "text", options: [shape.value] };
  if (shape.kind === "union" && shape.members.every((m) => m.kind === "literal")) return { kind: "text", options: shape.members.map((m) => (m as { value: unknown }).value) };
  return { kind: "json" };
}

/** The args object from the form's raw inputs: blanks omitted; JSON fields parsed. Throws on a bad JSON field. */
function argsFromForm(shape: FunctionInfo["args"], raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(shape.fields)) {
    const v = raw[k];
    if (v === undefined || v === "") continue;
    const kind = fieldKind(f.shape);
    if (kind.kind === "number") out[k] = Number(v);
    else if (kind.kind === "boolean") out[k] = v === "true";
    else if (kind.options) out[k] = kind.options.find((o) => String(o) === v) ?? v;
    else if (kind.kind === "json") {
      try {
        out[k] = JSON.parse(v);
      } catch {
        throw new Error(`${k}: not valid JSON`);
      }
    } else out[k] = v;
  }
  return out;
}

function Runner({ project, env, info }: { project: string; env: string; info: FunctionInfo }) {
  const s = useSession();
  const fields = Object.entries(info.args.fields ?? {});
  const simple = fields.every(([, f]) => fieldKind(f.shape).kind !== "json") && fields.length <= 12;
  const [mode, setMode] = useState<"form" | "json">(simple && fields.length ? "form" : "json");
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [jsonText, setJson] = useState("{}");
  const [shard, setShard] = useState(info.shard && !info.shard.fromArg ? `${info.shard.kind}:` : "global:main");
  const [asUser, setAsUser] = useState("");
  const [claims, setClaims] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; value?: unknown; error?: unknown; ms?: number; as?: string | null } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  let args: Record<string, unknown> | null = null;
  let argsError: string | null = null;
  try {
    if (mode === "form") args = argsFromForm(info.args, raw);
    else {
      const v: unknown = JSON.parse(jsonText || "{}");
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("args must be a JSON object");
      args = v as Record<string, unknown>;
    }
  } catch (e) {
    argsError = (e as Error).message;
  }
  let claimsObj: Record<string, unknown> | undefined;
  let claimsError: string | null = null;
  if (claims.trim()) {
    try {
      const v: unknown = JSON.parse(claims);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      claimsObj = v as Record<string, unknown>;
    } catch {
      claimsError = "claims must be a JSON object";
    }
  }
  // A shard routed by an argument follows it.
  const routed = info.shard?.fromArg && args && args[info.shard.fromArg] !== undefined ? `${info.shard.kind}:${String(args[info.shard.fromArg])}` : null;
  const target = routed ?? shard;
  const writes = info.type !== "query";
  const refusedAs = !!asUser.trim() && info.sensitive;

  const run = async () => {
    if (!args) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.post<{ ok: boolean; value?: unknown; ms: number; as: string | null }>("/api/fn/run", {
        project,
        env,
        shard: target,
        fn: info.name,
        args,
        ...(asUser.trim() ? { as: { subject: asUser.trim(), ...(claimsObj ? { claims: claimsObj } : {}) } } : {}),
      });
      setResult(r);
    } catch (e) {
      const x = e as ApiError;
      // A function error is a result, not a failure of the dashboard.
      if (x.status === 400 && x.code !== "bad_request" && x.code !== "bad_shard") setResult({ ok: false, error: { code: x.code, message: x.message, ...(x.data ? { data: x.data } : {}) } });
      else setError(x);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
    <form
      className="runner"
      onSubmit={(e) => {
        e.preventDefault();
        if (!args || claimsError || refusedAs) return;
        if (writes && s.isProtected(env)) setConfirming(true);
        else void run();
      }}
    >
      <div className="tabs-inline" role="tablist" aria-label="Arguments editor">
        <button type="button" role="tab" aria-selected={mode === "form"} disabled={!fields.length} onClick={() => setMode("form")}>
          Form
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "json"}
          onClick={() => {
            if (mode === "form" && args) setJson(JSON.stringify(args, null, 2));
            setMode("json");
          }}
        >
          JSON
        </button>
      </div>
      {mode === "form" ? (
        fields.length ? (
          fields.map(([k, f]) => {
            const kind = fieldKind(f.shape);
            const id = `arg-${k}`;
            return (
              <label key={k} className="field" htmlFor={id}>
                <span>
                  <Mono>
                    {k}
                    {f.optional || f.default !== undefined ? "?" : ""}
                  </Mono>{" "}
                  <span className="muted">{f.description ?? ""}</span>
                </span>
                {kind.options ? (
                  <select id={id} value={raw[k] ?? ""} onChange={(e) => setRaw({ ...raw, [k]: e.target.value })}>
                    <option value="">—</option>
                    {kind.options.map((o) => (
                      <option key={String(o)} value={String(o)}>
                        {String(o)}
                      </option>
                    ))}
                  </select>
                ) : kind.kind === "boolean" ? (
                  <select id={id} value={raw[k] ?? ""} onChange={(e) => setRaw({ ...raw, [k]: e.target.value })}>
                    <option value="">—</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input id={id} type={kind.kind === "number" ? "number" : "text"} step="any" value={raw[k] ?? ""} onChange={(e) => setRaw({ ...raw, [k]: e.target.value })} className={kind.kind === "json" ? "mono" : undefined} spellCheck={false} />
                )}
              </label>
            );
          })
        ) : (
          <p className="muted">No arguments.</p>
        )
      ) : (
        <textarea className="editor small-editor" value={jsonText} onChange={(e) => setJson(e.target.value)} spellCheck={false} aria-label="Arguments JSON" rows={6} />
      )}
      {argsError && <p className="bad small">{argsError}</p>}
      <label className="field">
        <span>Shard {routed && <span className="muted">(routed by {info.shard!.fromArg})</span>}</span>
        <input value={target} onChange={(e) => setShard(e.target.value)} disabled={!!routed} className="mono" spellCheck={false} aria-label="Shard" />
      </label>
      <details className="act-as">
        <summary>Run as a user</summary>
        <label className="field">
          <span>User id (the identity's subject)</span>
          <input value={asUser} onChange={(e) => setAsUser(e.target.value)} placeholder="anonymous" className="mono" spellCheck={false} aria-label="Run as user id" />
        </label>
        <label className="field">
          <span>Extra claims (JSON, optional)</span>
          <input value={claims} onChange={(e) => setClaims(e.target.value)} placeholder='{"role": "member"}' className="mono" spellCheck={false} aria-label="Claims" />
        </label>
        {claimsError && <p className="bad small">{claimsError}</p>}
        <p className="muted small">The project builds this identity (issuer ember-dashboard) and runs the function with it. No token is created. Recorded as function.run_as.</p>
        {refusedAs && <p className="warn small">{info.name} is sensitive: it checks the user's live session, so it cannot run as someone else.</p>}
      </details>
      <div className="toolbar">
        <button type="submit" className="primary" disabled={!args || busy || !!claimsError || refusedAs}>
          {busy ? "Running…" : `Run ${info.type}`}
        </button>
        {writes && <span className="muted small">{info.type === "action" ? "Actions can call external services and write." : "Writes to the shard."}</span>}
      </div>
      {error && <Problem error={error} />}
      {result && (
        <div className={`result ${result.ok ? "ok" : "bad"}`} aria-live="polite">
          <div className="result-head">
            <Badge tone={result.ok ? "ok" : "bad"}>{result.ok ? "ok" : "error"}</Badge>
            {result.ms !== undefined && <span className="muted small">{fmtNum(result.ms, 1)} ms</span>}
            {result.as && <span className="muted small">as {result.as}</span>}
          </div>
          <JsonView value={result.ok ? result.value : result.error} />
        </div>
      )}
    </form>
      {/* Outside the form: the dialog has its own form, and forms do not nest. */}
      <ConfirmDialog open={confirming} title={`Run ${info.name} on ${env}?`} confirmLabel={`Run ${info.type}`} busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => void run()}>
        <p>
          This {info.type} runs on <Mono>{target}</Mono> in a protected environment{asUser.trim() ? <> as <Mono>{asUser.trim()}</Mono></> : null}. It is recorded in the audit log.
        </p>
      </ConfirmDialog>
    </>
  );
}
