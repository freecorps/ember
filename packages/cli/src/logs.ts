// `ember logs [--env] [--fn name] [--shard kind:key] [--errors] [--json]`: Workers tail through the API (no
// wrangler): create a tail session, read its WebSocket (`trace-v1`), pretty-print, delete the session on exit.
//
// Filtering by function/shard needs per-execution lines: with the Worker var EMBER_TRACE=1 the runtime logs one
// `ember:exec {json}` line per execution (metrics.ts). Without it, filters match the event's URL, logs and
// exceptions as text.

import type { CfClient } from "./deploy/cf.ts";

export interface TailEvent {
  outcome?: string;
  scriptName?: string;
  entrypoint?: string;
  eventTimestamp?: number;
  event?: {
    request?: { url?: string; method?: string };
    cron?: string;
    scheduledTime?: number;
    queue?: string;
    batchSize?: number;
    getWebSocketEvent?: unknown;
  } | null;
  logs?: Array<{ message: unknown[]; level: string; timestamp: number }>;
  exceptions?: Array<{ name: string; message: string; timestamp: number }>;
}

export interface ExecLine {
  project: string;
  env: string;
  shard: string;
  fn: string;
  kind: string;
  status: string;
  errorCode: string;
  durationMs: number;
  rowsRead: number;
  rowsWritten: number;
  bytesOut: number;
}

export interface LogFilters {
  fn?: string;
  shard?: string;
  /** Only failed executions, exceptions and error-level logs. */
  errors?: boolean;
}

const EXEC_PREFIX = "ember:exec ";

function parseExec(message: unknown[]): ExecLine | null {
  const first = message[0];
  if (typeof first !== "string" || !first.startsWith(EXEC_PREFIX)) return null;
  try {
    return JSON.parse(first.slice(EXEC_PREFIX.length)) as ExecLine;
  } catch {
    return null;
  }
}

const time = (ms: number | undefined) => new Date(ms ?? Date.now()).toISOString().slice(11, 23);
const text = (m: unknown[]) => m.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");

function matchesShard(filter: string, shard: string) {
  return filter.endsWith(":") || !filter.includes(":") ? shard.startsWith(filter.includes(":") ? filter : `${filter}:`) : shard === filter;
}

/** Formats one tail event as lines (empty when filtered out). */
export function formatTailEvent(ev: TailEvent, f: LogFilters = {}, color = false): string[] {
  const c = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const req = ev.event?.request;
  const head = req?.url
    ? `${req.method ?? "GET"} ${(() => {
        try {
          const u = new URL(req.url);
          return u.pathname + u.search;
        } catch {
          return req.url;
        }
      })()}`
    : ev.event?.cron
      ? `cron ${ev.event.cron}`
      : ev.event?.queue
        ? `queue ${ev.event.queue} (${ev.event.batchSize ?? "?"} messages)`
        : (ev.entrypoint ?? "event");
  const outcome = ev.outcome ?? "ok";
  const bad = outcome !== "ok";
  const lines: string[] = [];
  let anyExec = false;
  for (const l of ev.logs ?? []) {
    const exec = parseExec(l.message);
    if (exec) {
      anyExec = true;
      if (f.fn && exec.fn !== f.fn) continue;
      if (f.shard && !matchesShard(f.shard, exec.shard)) continue;
      if (f.errors && exec.status !== "error") continue;
      const st = exec.status === "ok" ? c(32, "ok") : c(31, `error ${exec.errorCode}`);
      lines.push(
        `${time(l.timestamp)} ${c(36, exec.kind.padEnd(12))} ${exec.fn} ${c(90, exec.shard)} ${st} ${exec.durationMs}ms r${exec.rowsRead}/w${exec.rowsWritten} ${exec.bytesOut}B`,
      );
      continue;
    }
    const msg = text(l.message);
    if ((f.fn || f.shard) && !(f.fn && msg.includes(f.fn)) && !(f.shard && msg.includes(f.shard))) continue;
    if (f.errors && l.level !== "error") continue;
    const lvl = l.level === "error" ? c(31, "error") : l.level === "warn" ? c(33, "warn ") : c(90, l.level.padEnd(5));
    lines.push(`${time(l.timestamp)} ${lvl} ${msg}`);
  }
  for (const e of ev.exceptions ?? []) {
    const msg = `${e.name}: ${e.message}`;
    if ((f.fn || f.shard) && !(f.fn && msg.includes(f.fn)) && !(f.shard && msg.includes(f.shard))) continue;
    lines.push(`${time(e.timestamp)} ${c(31, "exception")} ${msg}`);
  }
  const filtering = !!(f.fn || f.shard || f.errors);
  if (filtering && !lines.length) {
    // A request line alone matches when its URL names the shard/fn (e.g. /ws?shard=...).
    const url = req?.url ?? "";
    const urlHit = (f.shard && decodeURIComponent(url).includes(f.shard)) || (f.fn && url.includes(f.fn));
    if (!(urlHit && !anyExec) && !(f.errors && bad && !f.fn && !f.shard)) return [];
  }
  return [`${time(ev.eventTimestamp)} ${bad ? c(31, outcome) : c(32, outcome)} ${c(1, head)}`, ...lines.map((l) => `  ${l}`)];
}

export interface TailSession {
  id: string;
  url: string;
  expiresAt?: string;
}

export async function createTail(client: CfClient, worker: string): Promise<TailSession> {
  const r = await client.call<{ id: string; url: string; expires_at?: string }>("POST", `/workers/scripts/${worker}/tails`, {});
  return { id: r.id, url: r.url, ...(r.expires_at ? { expiresAt: r.expires_at } : {}) };
}

export async function deleteTail(client: CfClient, worker: string, id: string): Promise<void> {
  await client.request("DELETE", `/workers/scripts/${worker}/tails/${id}`);
}

type WsLike = {
  addEventListener(type: "open" | "message" | "close" | "error", fn: (e: any) => void): void;
  send(data: string): void;
  close(code?: number): void;
};

export interface StreamLogsOptions {
  filters?: LogFilters;
  json?: boolean;
  color?: boolean;
  print?: (line: string) => void;
  /** Injected for tests. */
  WebSocket?: new (url: string, protocols?: string | string[]) => WsLike;
  /** Resolves to stop streaming (default: SIGINT/SIGTERM). */
  until?: Promise<void>;
  onEvent?: (ev: TailEvent) => void;
}

/** Streams the Worker's tail until `until` resolves (or the socket closes). Always deletes the tail session. */
export async function streamLogs(client: CfClient, worker: string, o: StreamLogsOptions = {}): Promise<{ events: number }> {
  const print = o.print ?? ((l: string) => console.log(l));
  const Ws = o.WebSocket ?? (globalThis.WebSocket as unknown as NonNullable<StreamLogsOptions["WebSocket"]>);
  if (!Ws) throw new Error("ember logs needs a global WebSocket (Node 22+)");
  const tail = await createTail(client, worker);
  let events = 0;
  let stopSignal: (() => void) | null = null;
  const until =
    o.until ??
    new Promise<void>((resolve) => {
      stopSignal = resolve;
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  try {
    const ws = new Ws(tail.url, "trace-v1");
    await new Promise<void>((resolve, reject) => {
      let open = false;
      ws.addEventListener("open", () => {
        open = true;
        ws.send(JSON.stringify({ debug: false }));
        print(`tailing ${worker} (session ${tail.id.slice(0, 8)}) — Ctrl-C to stop`);
      });
      ws.addEventListener("message", async (e) => {
        const data = typeof e.data === "string" ? e.data : e.data instanceof Blob ? await e.data.text() : new TextDecoder().decode(e.data as ArrayBuffer);
        let ev: TailEvent;
        try {
          ev = JSON.parse(data) as TailEvent;
        } catch {
          return;
        }
        events++;
        o.onEvent?.(ev);
        if (o.json) print(JSON.stringify(ev));
        else for (const l of formatTailEvent(ev, o.filters, o.color ?? !!process.stdout.isTTY)) print(l);
      });
      ws.addEventListener("error", (e) => {
        if (!open) reject(new Error(`tail WebSocket failed: ${(e as { message?: string }).message ?? "error"}`));
      });
      ws.addEventListener("close", () => resolve());
      void until.then(() => {
        try {
          ws.close(1000);
        } catch {
          // already closed
        }
        resolve();
      });
    });
  } finally {
    if (stopSignal) {
      process.removeListener("SIGINT", stopSignal);
      process.removeListener("SIGTERM", stopSignal);
    }
    await deleteTail(client, worker, tail.id).catch(() => {});
  }
  return { events };
}
