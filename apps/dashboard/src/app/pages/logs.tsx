// Live logs of an environment: the dashboard Worker tails the project's Worker (like `ember logs`) and streams the
// events here as NDJSON over an authenticated fetch. Everything shown is text from the project: never markup.

import { useEffect, useRef, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { Badge, Empty, Mono, Problem } from "../ui.tsx";

type LogLine =
  | { t: number; kind: "exec"; fn: string; shard: string; type: string; status: string; errorCode: string; ms: number; rowsRead: number; rowsWritten: number }
  | { t: number; kind: "log"; level: string; message: string }
  | { t: number; kind: "exception"; message: string };

interface LogRecord {
  t: number;
  outcome: string;
  head: string;
  lines: LogLine[];
}

const MAX_RECORDS = 500;
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
        if (got.length) setRecords((r) => [...r, ...got].slice(-MAX_RECORDS));
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
      {error && <Problem error={error} onRetry={() => void start()} />}
      {ended && <div className="notice info">Stream ended: {ended}.</div>}
      <div className="log-list" ref={list} role="log" aria-live="off" aria-label="Log events">
        {!records.length ? (
          <Empty>{live ? "Waiting for events…" : "Start to stream this environment's logs."}</Empty>
        ) : (
          records.map((r) => (
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
