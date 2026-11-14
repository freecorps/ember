// Live logs for the dashboard: the same Workers tail API `ember logs` uses (POST /workers/scripts/<w>/tails →
// WebSocket `trace-v1` → DELETE), opened by the dashboard Worker and relayed to the browser as NDJSON over a normal
// authenticated fetch. The tail session's URL (a bearer capability) and the Cloudflare token never leave the Worker.
//
// Events become structured records filtered like `ember logs`: by function and shard (needs EMBER_TRACE=1 on the
// project: one `ember:exec {json}` line per execution), and errors only.

export interface TailEvent {
  outcome?: string;
  eventTimestamp?: number;
  entrypoint?: string;
  event?: { request?: { url?: string; method?: string }; cron?: string; queue?: string; batchSize?: number } | null;
  logs?: Array<{ message: unknown[]; level: string; timestamp: number }>;
  exceptions?: Array<{ name: string; message: string; timestamp: number }>;
}

export interface LogFilters {
  fn?: string;
  shard?: string;
  errors?: boolean;
}

export type LogLine =
  | { t: number; kind: "exec"; fn: string; shard: string; type: string; status: string; errorCode: string; ms: number; rowsRead: number; rowsWritten: number }
  | { t: number; kind: "log"; level: string; message: string }
  | { t: number; kind: "exception"; message: string };

export interface LogRecord {
  t: number;
  outcome: string;
  /** What ran: `GET /path`, `cron ...`, `queue ...`. */
  head: string;
  lines: LogLine[];
}

const EXEC_PREFIX = "ember:exec ";
const MAX_MESSAGE = 2000;

export function parseExec(message: unknown[]): Record<string, unknown> | null {
  const first = message[0];
  if (typeof first !== "string" || !first.startsWith(EXEC_PREFIX)) return null;
  try {
    const v: unknown = JSON.parse(first.slice(EXEC_PREFIX.length));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `org` matches every `org:*` shard; `org:acme` that one. */
export function matchesShard(filter: string, shard: string): boolean {
  return filter.endsWith(":") || !filter.includes(":") ? shard.startsWith(filter.includes(":") ? filter : `${filter}:`) : shard === filter;
}

const text = (m: unknown[]) => {
  const s = m.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s;
};

function headOf(ev: TailEvent): string {
  const req = ev.event?.request;
  if (req?.url) {
    try {
      const u = new URL(req.url);
      return `${req.method ?? "GET"} ${u.pathname}`;
    } catch {
      return `${req.method ?? "GET"} ${req.url.slice(0, 200)}`;
    }
  }
  if (ev.event?.cron) return `cron ${ev.event.cron}`;
  if (ev.event?.queue) return `queue ${ev.event.queue} (${ev.event.batchSize ?? "?"} messages)`;
  return ev.entrypoint ?? "event";
}

/** One tail event as a record (null when the filters drop it). Request query strings are left out: they may hold tokens. */
export function tailRecord(ev: TailEvent, f: LogFilters = {}): LogRecord | null {
  const lines: LogLine[] = [];
  let anyExec = false;
  for (const l of ev.logs ?? []) {
    const e = parseExec(l.message);
    if (e) {
      anyExec = true;
      const fn = String(e.fn ?? "");
      const shard = String(e.shard ?? "");
      const status = String(e.status ?? "");
      if (f.fn && fn !== f.fn) continue;
      if (f.shard && !matchesShard(f.shard, shard)) continue;
      if (f.errors && status !== "error") continue;
      lines.push({
        t: l.timestamp,
        kind: "exec",
        fn,
        shard,
        type: String(e.kind ?? ""),
        status,
        errorCode: String(e.errorCode ?? ""),
        ms: Number(e.durationMs) || 0,
        rowsRead: Number(e.rowsRead) || 0,
        rowsWritten: Number(e.rowsWritten) || 0,
      });
      continue;
    }
    const msg = text(l.message);
    if ((f.fn || f.shard) && !(f.fn && msg.includes(f.fn)) && !(f.shard && msg.includes(f.shard))) continue;
    if (f.errors && l.level !== "error") continue;
    lines.push({ t: l.timestamp, kind: "log", level: l.level, message: msg });
  }
  for (const e of ev.exceptions ?? []) {
    const msg = `${e.name}: ${e.message}`.slice(0, MAX_MESSAGE);
    if ((f.fn || f.shard) && !(f.fn && msg.includes(f.fn)) && !(f.shard && msg.includes(f.shard))) continue;
    lines.push({ t: e.timestamp, kind: "exception", message: msg });
  }
  const outcome = ev.outcome ?? "ok";
  const filtering = !!(f.fn || f.shard || f.errors);
  if (filtering && !lines.length) {
    const url = ev.event?.request?.url ?? "";
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      // keep it encoded
    }
    const urlHit = (f.shard && decoded.includes(f.shard)) || (f.fn && url.includes(f.fn));
    if (!(urlHit && !anyExec) && !(f.errors && outcome !== "ok" && !f.fn && !f.shard)) return null;
  }
  return { t: ev.eventTimestamp ?? Date.now(), outcome, head: headOf(ev), lines };
}

// ------------------------------------------------------------------------------------------- relay

/** A connected tail WebSocket (Workers `fetch` upgrade in production; a fake in tests). */
export interface TailSocket {
  addEventListener(type: "message" | "close" | "error", fn: (e: { data?: unknown }) => void): void;
  send(data: string): void;
  close(code?: number): void;
}

export type TailConnector = (url: string) => Promise<TailSocket>;

/** Workers: an outbound WebSocket is a fetch with `Upgrade: websocket` (to the https form of the URL). */
export const workersTailConnector: TailConnector = async (url) => {
  const res = await fetch(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "trace-v1" } });
  const ws = (res as Response & { webSocket?: (TailSocket & { accept(): void }) | null }).webSocket;
  if (!ws) throw new Error(`tail WebSocket refused (${res.status})`);
  ws.accept();
  return ws;
};

export interface RelayOptions {
  accountId: string;
  token: string;
  worker: string;
  filters: LogFilters;
  fetch: typeof fetch;
  connect: TailConnector;
  /** Stop after this long (the browser reconnects on demand). Default 15 min. */
  maxMs?: number;
  /** Keep-alive line every this many ms. Default 20 s. */
  pingMs?: number;
}

const API = "https://api.cloudflare.com/client/v4";

/**
 * The relay as a stream of NDJSON lines: `{type:"open"}`, then `{type:"event", record}` per kept event, `{type:"ping"}`
 * now and then, and `{type:"end", reason}`. The tail session is deleted when the stream ends for any reason
 * (time limit, the tail closing, the browser going away).
 */
export async function relayTail(o: RelayOptions): Promise<ReadableStream<Uint8Array>> {
  const base = `${API}/accounts/${o.accountId}/workers/scripts/${o.worker}/tails`;
  const headers = { authorization: `Bearer ${o.token}`, "content-type": "application/json" };
  const created = await o.fetch(base, { method: "POST", headers, body: "{}" });
  const body = (await created.json().catch(() => null)) as { success?: boolean; result?: { id?: string; url?: string }; errors?: Array<{ message?: string }> } | null;
  if (!created.ok || !body?.success || !body.result?.id || !body.result.url) {
    throw Object.assign(new Error(`could not start a tail on ${o.worker}: ${body?.errors?.map((e) => e.message).join("; ") || created.status}`), { status: created.status });
  }
  const { id, url } = body.result as { id: string; url: string };
  const remove = () => o.fetch(`${base}/${id}`, { method: "DELETE", headers }).then(
    (r) => r.body?.cancel(),
    () => undefined,
  );
  let ws: TailSocket;
  try {
    ws = await o.connect(url);
  } catch (e) {
    await remove();
    throw e;
  }
  const enc = new TextEncoder();
  let done = false;
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const finish = (reason: string, notify: boolean) => {
    if (done) return;
    done = true;
    for (const t of timers) clearTimeout(t);
    timers = [];
    try {
      ws.close(1000);
    } catch {
      // already closed
    }
    void remove();
    if (notify) {
      try {
        ctrl.enqueue(enc.encode(`${JSON.stringify({ type: "end", reason })}\n`));
        ctrl.close();
      } catch {
        // the reader went away
      }
    }
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      c.enqueue(enc.encode(`${JSON.stringify({ type: "open", worker: o.worker, filters: o.filters })}\n`));
      ws.send(JSON.stringify({ debug: false }));
      ws.addEventListener("message", (e) => {
        if (done) return;
        const raw = typeof e.data === "string" ? e.data : e.data instanceof ArrayBuffer ? new TextDecoder().decode(e.data) : "";
        let ev: TailEvent;
        try {
          ev = JSON.parse(raw) as TailEvent;
        } catch {
          return;
        }
        const record = tailRecord(ev, o.filters);
        if (!record) return;
        try {
          c.enqueue(enc.encode(`${JSON.stringify({ type: "event", record })}\n`));
        } catch {
          finish("gone", false);
        }
      });
      ws.addEventListener("close", () => finish("tail closed", true));
      ws.addEventListener("error", () => finish("tail error", true));
      timers.push(setTimeout(() => finish("time limit (reconnect to keep going)", true), o.maxMs ?? 15 * 60_000));
      const ping = () => {
        if (done) return;
        try {
          c.enqueue(enc.encode(`${JSON.stringify({ type: "ping", t: Date.now() })}\n`));
        } catch {
          finish("gone", false);
          return;
        }
        timers.push(setTimeout(ping, o.pingMs ?? 20_000));
      };
      timers.push(setTimeout(ping, o.pingMs ?? 20_000));
    },
    cancel() {
      finish("cancelled", false);
    },
  });
}
