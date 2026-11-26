// Functions: the list with their numbers (Analytics Engine), and one function's page — charts over time, recent
// errors and the runner. The runner calls the project's admin endpoint, which runs the function in the project's
// Worker; "run as" hands it an identity built there (no token is ever minted or returned). Admin only, audited.
// The runner keeps the last runs in this browser (localStorage, runner.ts) to run one again, and copies the call as
// cURL (the admin token as the `$EMBER_ADMIN_TOKEN` placeholder, never a real one) or as TypeScript.

import { useEffect, useMemo, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { TimeChart } from "../chart.tsx";
import { ago, fmtBytes, fmtNum, fmtPct, fmtTime, windowLabel, windows } from "../format.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Dialog, Empty, JsonView, Loading, Mono, Problem, Section, Table } from "../ui.tsx";
import { limitWarnings, seriesPeaks } from "../../metrics-sql.ts";
import type { FunctionRow, Project } from "./types.ts";
import { clearHistory, curlFor, HISTORY_KEY, historyEpoch, loadHistory, saveRun, tsFor, type RunEntry } from "../runner.ts";
import { argsFromForm, fieldKind, type Shape } from "../forms.ts";

/** What p50/p95 measure per timing label (@freecorps/ember-runtime metrics.ts). */
const TIMING_HELP: Record<string, string> = {
  rpc: "Wall time in the Worker around the RPC to the shard (hop + queue + execution + durable commit)",
  commit: "Wall time in the Durable Object from receipt to durable commit (group commit + execution + durability)",
  wall: "Action wall time in the Worker (I/O included)",
  none: "Not measurable in production (synchronous inside the Durable Object): 0",
  "": "Recorded before timing labels: 0 ms for queries/mutations in production",
};

export interface FunctionInfo {
  name: string;
  type: "query" | "mutation" | "action";
  visibility: "public" | "internal";
  args: Extract<Shape, { kind: "object" }>;
  shard: { kind: string; fromArg?: string; fromClaim?: string } | null;
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
  // The environment's URL, for "Copy as cURL" (the registry's; null → the command says $EMBER_URL).
  const projects = useApi<{ projects: Project[] }>(s.isAdmin ? "/api/projects" : null);
  const url = projects.data?.projects.find((x) => x.name === project)?.envs.find((e) => e.env === env)?.url ?? null;
  const series = useApi<{ points: Array<{ t: number; calls: number; errors: number; p50: number; p95: number; rowsRead: number; rowsWritten: number; limitPeaks?: { rowsRead: number; documentsRead: number; rowsWritten: number } }>; bucketMinutes: number }>(
    s.me.metrics ? path("/api/fn/series", { project, env, fn, hours }) : null,
  );
  const errors = useApi<{ errors: Array<{ t: number; code: string; shard: string; kind: string; ms: number }> }>(s.me.metrics ? path("/api/fn/errors", { project, env, fn, hours }) : null);
  // Peaks of this function's per-transaction limits in the window (from its own series, no query over every
  // function): the same warning `ember dev` prints at 70%.
  const warnings = useMemo(() => limitWarnings(seriesPeaks(series.data?.points ?? [])), [series.data]);
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
                {info.shard.fromArg ? ` (from ${info.shard.fromArg})` : info.shard.fromClaim ? ` (from the ${info.shard.fromClaim} claim)` : ""}
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
      {warnings.map((w) => (
        <div key={w.counter} className="notice warn">
          <strong>Near a limit</strong>
          <p>
            <Mono>{fn}</Mono> {w.message}
          </p>
        </div>
      ))}
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
          {!s.isAdmin ? <Empty>Running functions needs the admin role.</Empty> : info ? <Runner project={project} env={env} info={info} url={url} /> : list.loading ? <Loading /> : null}
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

/** What one run sends (the form's values, or a history entry's). */
interface RunInput {
  args: Record<string, unknown>;
  shard: string;
  as: { subject: string; claims?: Record<string, unknown> } | null;
}

function Runner({ project, env, info, url }: { project: string; env: string; info: FunctionInfo; url: string | null }) {
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
  const [history, setHistory] = useState<RunEntry[]>(loadHistory);
  // Another tab ran or cleared something: show the stored history.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === HISTORY_KEY || e.key === null) setHistory(loadHistory());
    };
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  }, []);
  const mine = history.filter((e) => e.project === project && e.env === env && e.fn === info.name);
  /** The run waiting for the protected environment's confirmation (the form's, or a history entry's). */
  const [pending, setPending] = useState<RunInput | null>(null);
  const [snippet, setSnippet] = useState<{ title: string; text: string } | null>(null);

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
  // A shard routed by an argument follows it; one routed by a claim (`fromAuth`) follows the act-as claims.
  const claimed = info.shard?.fromClaim ? claimsObj?.[info.shard.fromClaim] : undefined;
  const routed =
    info.shard?.fromArg && args && args[info.shard.fromArg] !== undefined
      ? `${info.shard.kind}:${String(args[info.shard.fromArg])}`
      : info.shard?.fromClaim && asUser.trim() && (typeof claimed === "string" || typeof claimed === "number")
        ? `${info.shard.kind}:${String(claimed)}`
        : null;
  const target = routed ?? shard;
  const writes = info.type !== "query";
  const refusedAs = !!asUser.trim() && info.sensitive;

  const current = (): RunInput | null => (args ? { args, shard: target, as: asUser.trim() ? { subject: asUser.trim(), ...(claimsObj ? { claims: claimsObj } : {}) } : null } : null);
  const record = (input: RunInput, ok: boolean, value: unknown, ms: number | null, since: number) =>
    // Not after a sign-out that came while the run was out (its args and result must not be kept for the next user).
    since === historyEpoch() &&
    // Written here, not in a state updater (React may call one twice): saveRun reads and writes the stored history.
    setHistory(saveRun(history, { at: Date.now(), project, env, fn: info.name, type: info.type, shard: input.shard, args: input.args, ...(input.as ? { as: input.as.subject, ...(input.as.claims ? { claims: input.as.claims } : {}) } : {}), ok, result: value, ms }));

  const run = async (input: RunInput) => {
    const since = historyEpoch();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.post<{ ok: boolean; value?: unknown; ms: number; as: string | null }>("/api/fn/run", {
        project,
        env,
        shard: input.shard,
        fn: info.name,
        args: input.args,
        ...(input.as ? { as: input.as } : {}),
      });
      setResult(r);
      record(input, true, r.value, r.ms, since);
    } catch (e) {
      const x = e as ApiError;
      // A function error is a result, not a failure of the dashboard.
      if (x.status === 400 && x.code !== "bad_request" && x.code !== "bad_shard") {
        const fnError = { code: x.code, message: x.message, ...(x.data ? { data: x.data } : {}) };
        setResult({ ok: false, error: fnError });
        record(input, false, fnError, null, since);
      } else setError(x);
    } finally {
      setBusy(false);
      setConfirming(false);
      setPending(null);
    }
  };
  /** Runs now, or after the confirmation on a protected environment (writes). */
  const start = (input: RunInput) => {
    if (writes && s.isProtected(env)) {
      setPending(input);
      setConfirming(true);
    } else void run(input);
  };
  /** A history entry back in the form (JSON editor, its shard and identity), and run again when asked. */
  const load = (e: RunEntry, again: boolean) => {
    setMode("json");
    setJson(JSON.stringify(e.args, null, 2));
    if (!info.shard?.fromArg) setShard(e.shard);
    setAsUser(e.as ?? "");
    setClaims(e.claims ? JSON.stringify(e.claims) : "");
    if (again) start({ args: e.args, shard: e.shard, as: e.as ? { subject: e.as, ...(e.claims ? { claims: e.claims } : {}) } : null });
  };
  const copy = async (title: string, text: string) => {
    setSnippet({ title, text });
    try {
      await navigator.clipboard.writeText(text);
      s.toast({ text: `Copied ${title}` });
    } catch {
      // No clipboard access (permissions, an insecure origin): the dialog shows the text to copy by hand.
    }
  };

  return (
    <>
    <form
      className="runner"
      onSubmit={(e) => {
        e.preventDefault();
        const input = current();
        if (!input || claimsError || refusedAs) return;
        start(input);
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
        <span>Shard {routed && <span className="muted">(routed by {info.shard!.fromArg ?? `the ${info.shard!.fromClaim} claim`})</span>}</span>
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
        <span className="spacer" />
        <button type="button" disabled={!args || !!claimsError} onClick={() => args && void copy("cURL", curlFor({ url, shard: target, fn: info.name, args, as: current()?.as ?? null }))}>
          Copy as cURL
        </button>
        <button type="button" disabled={!args} onClick={() => args && void copy("TypeScript", tsFor({ fn: info.name, type: info.type, visibility: info.visibility, args }))}>
          Copy as TypeScript
        </button>
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
      <RunHistory entries={mine} busy={busy} onLoad={(e) => load(e, false)} onRerun={(e) => load(e, true)} onClear={() => setHistory(clearHistory(history, { project, env, fn: info.name }))} />
      {/* Outside the form: the dialog has its own form, and forms do not nest. */}
      <ConfirmDialog open={confirming} title={`Run ${info.name} on ${env}?`} confirmLabel={`Run ${info.type}`} busy={busy} onCancel={() => (setConfirming(false), setPending(null))} onConfirm={() => pending && void run(pending)}>
        <p>
          This {info.type} runs on <Mono>{pending?.shard ?? target}</Mono> in a protected environment{pending?.as ? <> as <Mono>{pending.as.subject}</Mono></> : null}. It is recorded in the audit log.
        </p>
      </ConfirmDialog>
      <Dialog open={!!snippet} onClose={() => setSnippet(null)} title={`${info.name} as ${snippet?.title ?? ""}`} wide>
        <div className="dialog-body">
          {snippet?.title === "cURL" && (
            <p className="muted small">
              Set <code>EMBER_ADMIN_TOKEN</code> to the project's admin token first (the dashboard never shows it). This calls the admin endpoint directly: it is not in the dashboard's audit log.
            </p>
          )}
          <pre className="json" aria-label={`${snippet?.title ?? ""} snippet`}>
            {snippet?.text}
          </pre>
        </div>
        <footer className="dialog-foot">
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => snippet && void copy(snippet.title, snippet.text)}>
            Copy
          </button>
        </footer>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------------------------------- history

/** The last runs of this function from this browser (localStorage): load one into the form, or run it again. */
function RunHistory({ entries, busy, onLoad, onRerun, onClear }: { entries: RunEntry[]; busy: boolean; onLoad: (e: RunEntry) => void; onRerun: (e: RunEntry) => void; onClear: () => void }) {
  return (
    <div className="run-history">
      <div className="toolbar">
        <strong className="small">History</strong>
        <span className="muted small">last runs from this browser (kept in its storage, not shared)</span>
        <span className="spacer" />
        <button type="button" className="link" disabled={!entries.length} onClick={onClear}>
          Clear
        </button>
      </div>
      <Table
        label="Run history"
        empty="No runs of this function from this browser yet."
        rowKeys={entries.map((e) => e.id)}
        cols={[{ h: "When" }, { h: "Args" }, { h: "Shard" }, { h: "Result" }, { h: "ms", num: true }, { h: "" }]}
        rows={entries.map((e) => [
          <span title={fmtTime(e.at)}>{ago(e.at)}</span>,
          <code className="mono small clip" title={JSON.stringify(e.args)}>
            {JSON.stringify(e.args)}
          </code>,
          <span>
            <Mono>{e.shard}</Mono>
            {e.as ? <span className="muted small"> as {e.as}</span> : null}
          </span>,
          <span>
            <Badge tone={e.ok ? "ok" : "bad"}>{e.ok ? "ok" : "error"}</Badge>{" "}
            <code className="mono small clip" title={e.result}>
              {e.result}
            </code>
          </span>,
          e.ms === null ? "—" : fmtNum(e.ms, 1),
          <span className="row-actions">
            <button type="button" className="link" onClick={() => onLoad(e)}>
              Load
            </button>
            <button type="button" disabled={busy} onClick={() => onRerun(e)} aria-label={`Re-run with ${JSON.stringify(e.args)}`}>
              Re-run
            </button>
          </span>,
        ])}
      />
    </div>
  );
}
