// Live logs of an environment: the dashboard Worker tails the project's Worker (like `ember logs`) and streams the
// events here as NDJSON over an authenticated fetch. Everything shown is text from the project: never markup.
//
// Workers Tail is live only (no history, no server-side search): text search, the level and function filters and the
// time range apply here, in the browser, to the last WINDOW events this tab received, and "Export NDJSON" saves what
// they match (at most EXPORT_MAX lines). The page says so.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { download } from "../export.ts";
import { EXPORT_MAX, RANGES, searchLogs, SHOWN, toNdjson, WINDOW, type Level, type LogRecord } from "../logsearch.ts";
import { fmtNum } from "../format.ts";
import { Badge, Empty, Mono, Problem } from "../ui.tsx";

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false }) + `.${String(ms % 1000).padStart(3, "0")}`;

export function Logs({ project, env }: { project: string; env: string }) {
  const [fn, setFn] = useState("");
  const [shard, setShard] = useState("");
  const [errors, setErrors] = useState(false);
  const [records, setRecords] = useState<Array<LogRecord & { n: number }>>([]);
  const [state, setState] = useState<"idle" | "connecting" | "live" | "ended">("idle");
  const [ended, setEnded] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [follow, setFollow] = useState(true);
  const [text, setText] = useState("");
  const [level, setLevel] = useState<Level>("any");
  const [fnSearch, setFnSearch] = useState("");
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("all");
  // Re-evaluated with the records (and each second while a range is on), so "last minute" keeps moving.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (range === "all") return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [range]);
  const searching = !!text.trim() || level !== "any" || !!fnSearch.trim() || range !== "all";
  const matches = useMemo(() => {
    const ms = RANGES.find((r) => r.id === range)?.ms ?? 0;
    // `tick` (a dependency) moves the range's start with the clock.
    return searchLogs(records, { text, level, fn: fnSearch, since: ms ? Date.now() - ms + tick * 0 : 0 });
  }, [records, text, level, fnSearch, range, tick]);
  const shown = matches.slice(-SHOWN);
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const list = useRef<HTMLDivElement>(null);

  const stop = () => {
    abort.current?.abort();
    abort.current = null;
  };
  useEffect(() => stop, []);
  useEffect(() => {
    if (follow && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [records, follow]);

  const start = async () => {
    stop();
    const ctl = new AbortController();
    abort.current = ctl;
    setError(null);
    setEnded(null);
    setState("connecting");
    try {
      const reader = await api.stream(path("/api/logs", { project, env, fn: fn.trim(), shard: shard.trim(), errors: errors ? 1 : null }), ctl.signal);
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        const got: Array<LogRecord & { n: number }> = [];
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m: { type?: string; record?: LogRecord; reason?: string };
          try {
            m = JSON.parse(line) as typeof m;
          } catch {
            continue;
          }
          if (m.type === "open") setState("live");
          else if (m.type === "event" && m.record) got.push({ ...m.record, n: ++seq.current });
          else if (m.type === "end") setEnded(m.reason ?? "ended");
        }
        if (got.length) setRecords((r) => [...r, ...got].slice(-WINDOW));
      }
      setState("ended");
    } catch (e) {
      if (ctl.signal.aborted) setState("idle");
      else {
        setError(e instanceof ApiError ? e : new ApiError(0, "network", String(e)));
        setState("ended");
      }
    }
  };

  const live = state === "live" || state === "connecting";
  return (
    <>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <input placeholder="function (module:fn)" value={fn} onChange={(e) => setFn(e.target.value)} aria-label="Filter by function" className="mono" />
        <input placeholder="shard (kind or kind:key)" value={shard} onChange={(e) => setShard(e.target.value)} aria-label="Filter by shard" className="mono" />
        <label className="inline">
          <input type="checkbox" checked={errors} onChange={(e) => setErrors(e.target.checked)} /> errors only
        </label>
        {live ? (
          <button type="button" onClick={() => (stop(), setState("idle"))}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary">
            {state === "ended" ? "Reconnect" : "Start"}
          </button>
        )}
        <span className="spacer" />
        <Badge tone={state === "live" ? "ok" : state === "connecting" ? "info" : undefined}>{state === "live" ? "live" : state}</Badge>
        <label className="inline">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
        <button type="button" onClick={() => setRecords([])} disabled={!records.length}>
          Clear
        </button>
      </form>
      <p className="muted small hint">
        Filters by function and shard need <code>EMBER_TRACE=1</code> on the project (one line per execution); without it they match the log text. Changing a filter takes effect on the next Start.
      </p>
      <div className="toolbar log-search" role="search" aria-label="Search the received logs">
        <input type="search" placeholder="Search text…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search logs" />
        <select value={level} onChange={(e) => setLevel(e.target.value as Level)} aria-label="Level">
          <option value="any">any level</option>
          <option value="warn">warnings and errors</option>
          <option value="error">errors only</option>
        </select>
        <input placeholder="function" value={fnSearch} onChange={(e) => setFnSearch(e.target.value)} aria-label="Search by function" className="mono" />
        <select value={range} onChange={(e) => setRange(e.target.value as typeof range)} aria-label="Time range">
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <span className="muted small" aria-live="polite">
          {searching ? `${fmtNum(matches.length)} of ${fmtNum(records.length)} events` : `${fmtNum(records.length)} events`}
        </span>
        <span className="spacer" />
        <button type="button" disabled={!matches.length} onClick={() => download(`logs-${project}-${env}-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`, "application/x-ndjson", toNdjson(matches))}>
          Export NDJSON
        </button>
      </div>
      <p className="muted small hint">
        Workers Tail is live only and cannot be searched server-side: search, filters and export apply in this browser to the last {fmtNum(WINDOW)} events this tab received since Start (export: up to {fmtNum(EXPORT_MAX)} lines), not to stored history.
      </p>
      {error && <Problem error={error} onRetry={() => void start()} />}
      {ended && <div className="notice info">Stream ended: {ended}.</div>}
      {matches.length > SHOWN && <p className="muted small">Showing the newest {fmtNum(SHOWN)} of {fmtNum(matches.length)} matching events; the export has all of them.</p>}
      <div className="log-list" ref={list} role="log" aria-live="off" aria-label="Log events">
        {!records.length ? (
          <Empty>{live ? "Waiting for events…" : "Start to stream this environment's logs."}</Empty>
        ) : !shown.length ? (
          <Empty>No received event matches the search.</Empty>
        ) : (
          shown.map((r) => (
            <div key={r.n} className={`log-rec${r.outcome !== "ok" ? " bad" : ""}`}>
              <div className="log-head">
                <span className="log-time">{time(r.t)}</span>
                <Badge tone={r.outcome === "ok" ? "ok" : "bad"}>{r.outcome}</Badge>
                <Mono>{r.head}</Mono>
              </div>
              {r.lines.map((l, i) =>
                l.kind === "exec" ? (
                  <div key={i} className={`log-line${l.status === "error" ? " bad" : ""}`}>
                    <span className="log-time">{time(l.t)}</span>
                    <span className="log-kind">{l.type}</span>
                    <Mono>{l.fn}</Mono> <span className="muted mono">{l.shard}</span> {l.status === "error" ? <Badge tone="bad">{l.errorCode || "error"}</Badge> : <span className="ok">ok</span>}{" "}
                    <span className="muted">
                      {l.ms} ms · r{l.rowsRead}/w{l.rowsWritten}
                    </span>
                  </div>
                ) : (
                  <div key={i} className={`log-line${l.kind === "exception" || (l.kind === "log" && l.level === "error") ? " bad" : l.kind === "log" && l.level === "warn" ? " warn" : ""}`}>
                    <span className="log-time">{time(l.t)}</span>
                    <span className="log-kind">{l.kind === "log" ? l.level : "exception"}</span>
                    <span className="log-msg">{l.message}</span>
                  </div>
                ),
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
