// Search and export of the live logs (pages/logs.tsx), over the events this tab received: Workers Tail has no history
// and no server-side search. Pure functions, tested without a browser.

export type LogLine =
  | { t: number; kind: "exec"; fn: string; shard: string; type: string; status: string; errorCode: string; ms: number; rowsRead: number; rowsWritten: number }
  | { t: number; kind: "log"; level: string; message: string }
  | { t: number; kind: "exception"; message: string };

export interface LogRecord {
  t: number;
  outcome: string;
  head: string;
  lines: LogLine[];
}

/** Events kept in this tab (the window search and export work on). */
export const WINDOW = 5000;
/** Events drawn (the newest matches): the rest stay searchable and exportable. */
export const SHOWN = 500;
/** Lines one export writes at most. */
export const EXPORT_MAX = 50_000;

export type Level = "any" | "warn" | "error";
export const RANGES = [
  { id: "all", label: "whole window", ms: 0 },
  { id: "1m", label: "last minute", ms: 60_000 },
  { id: "5m", label: "last 5 minutes", ms: 5 * 60_000 },
  { id: "15m", label: "last 15 minutes", ms: 15 * 60_000 },
  { id: "1h", label: "last hour", ms: 3_600_000 },
] as const;

/** The record's worst level: an exception, an error line, a failed execution or outcome → error; a warning → warn. */
function levelOf(r: LogRecord): "log" | "warn" | "error" {
  if (r.outcome !== "ok") return "error";
  let worst: "log" | "warn" | "error" = "log";
  for (const l of r.lines) {
    if (l.kind === "exception" || (l.kind === "exec" && l.status === "error") || (l.kind === "log" && l.level === "error")) return "error";
    if (l.kind === "log" && l.level === "warn") worst = "warn";
  }
  return worst;
}

/** All the record's text, lower-cased (what the search matches). */
const haystack = (r: LogRecord) =>
  [r.head, r.outcome, ...r.lines.map((l) => (l.kind === "exec" ? `${l.fn} ${l.shard} ${l.type} ${l.status} ${l.errorCode}` : l.message))].join("\n").toLowerCase();

export interface LogSearch {
  text: string;
  level: Level;
  fn: string;
  /** Only events newer than this (ms; 0: the whole window). */
  since: number;
}

/** The records that match a search (pure: what is shown and exported). */
export function searchLogs<T extends LogRecord>(records: readonly T[], q: LogSearch): T[] {
  const text = q.text.trim().toLowerCase();
  const fn = q.fn.trim().toLowerCase();
  return records.filter((r) => {
    if (q.since && r.t < q.since) return false;
    if (q.level !== "any") {
      const l = levelOf(r);
      if (q.level === "error" ? l !== "error" : l === "log") return false;
    }
    // Only the executions' functions (the request line is text-search matter: `mutation` must not match `POST
    // /api/mutation`), case-insensitive like the text search.
    if (fn && !r.lines.some((l) => l.kind === "exec" && l.fn.toLowerCase().includes(fn))) return false;
    return !text || haystack(r).includes(text);
  });
}

/** One JSON object per line (the record as the dashboard received it), at most EXPORT_MAX lines. */
export function toNdjson(records: readonly LogRecord[]): string {
  const kept = records.slice(-EXPORT_MAX);
  return kept.map((r) => JSON.stringify({ t: r.t, time: new Date(r.t).toISOString(), outcome: r.outcome, head: r.head, lines: r.lines })).join("\n") + (kept.length ? "\n" : "");
}
