// Real-user latency (RUM, contracts.md "RUM"; the runtime's rum.ts is the other end). Opt-in:
// `new EmberClient({ url, rum: { sampleRate: 0.05 } })` draws once per client (page load) whether this session
// measures; a session that is not drawn costs nothing. A drawn one keeps log-scale histograms of:
//   connect      `new WebSocket` → `ready`
//   rtt          heartbeat `ping` → `pong` (answered at the edge of the Durable Object, which it does not wake)
//   ack          `mut` sent → its `mres`
//   first_value  a new subscription → its first value from the server
// per shard **kind** (never the key) and the colo of the Durable Object (`ready.colo` / `{t:"colo"}`), and posts them
// to `POST /api/_ember/rum` every `flushIntervalMs` (default 60 s), on `pagehide` (`sendBeacon`) and on `close()`.
// Nothing personal goes: no user, client id, args, shard key or URL; the server adds the country and its colo.

export interface RumOptions {
  /** Fraction of sessions that measure, in (0, 1]. Drawn once per client. */
  sampleRate: number;
  /** How often a drawn session posts its histograms. Default 60 s. */
  flushIntervalMs?: number;
}

export type RumMetric = "connect" | "rtt" | "ack" | "first_value";

/** Same formula as the runtime's `rumBucket`: `floor(2·log2(ms + 1))`, 0..40. */
export function rumBucket(ms: number): number {
  if (!(ms > 0)) return 0;
  return Math.min(40, Math.floor(2 * Math.log2(ms + 1)));
}

/** What one batch may hold (the server refuses more). */
const MAX_HISTOGRAMS = 32;
const MAX_BUCKETS = 200;
/** Batches stay small (a beacon is limited, and the server takes 4 KiB). */
const MAX_BYTES = 2048;
/** What the server takes in one body (a single histogram may go over MAX_BYTES, never over this). */
const MAX_BATCH_BYTES = 4096;

const SDK = "0.10.0";

function platform(): "web" | "react-native" | "node" | "other" {
  const g = globalThis as { navigator?: { product?: string }; document?: unknown; process?: { versions?: { node?: string } } };
  if (g.navigator?.product === "ReactNative") return "react-native";
  if (g.document !== undefined) return "web";
  if (g.process?.versions?.node) return "node";
  return "other";
}

type Hist = { m: RumMetric; k: string; c: string; b: Array<[number, number]> };

export class RumCollector {
  private readonly hist = new Map<string, { m: RumMetric; k: string; c: string; b: Map<number, number> }>();
  private readonly timer: ReturnType<typeof setInterval> | null;
  private readonly onHide: (() => void) | null = null;
  private readonly rate: number;
  /** Batches posted (tests). */
  sent = 0;

  constructor(
    private readonly endpoint: string,
    o: RumOptions,
    private readonly fetchImpl: typeof fetch | undefined,
  ) {
    this.rate = Math.min(1, o.sampleRate);
    const t = setInterval(() => this.flush(false), o.flushIntervalMs ?? 60_000);
    (t as { unref?: () => void }).unref?.();
    this.timer = t;
    const g = globalThis as { addEventListener?: (t: string, f: () => void) => void; document?: unknown };
    if (g.document !== undefined && typeof g.addEventListener === "function") {
      this.onHide = () => this.flush(true);
      g.addEventListener("pagehide", this.onHide);
    }
  }

  /** One sample of `ms`. `shard` is `kind:key`: only the kind is kept. */
  record(metric: RumMetric, shard: string, colo: string | undefined, ms: number): void {
    if (!(ms >= 0) || ms > 600_000) return;
    const i = shard.indexOf(":");
    const k = i > 0 ? shard.slice(0, i) : shard;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) return;
    const c = colo && /^[A-Z]{3}$/.test(colo) ? colo : "";
    const key = `${metric}\n${k}\n${c}`;
    let h = this.hist.get(key);
    if (!h) {
      if (this.hist.size >= MAX_HISTOGRAMS) return;
      this.hist.set(key, (h = { m: metric, k, c, b: new Map() }));
    }
    const b = rumBucket(ms);
    h.b.set(b, Math.min(100_000, (h.b.get(b) ?? 0) + 1));
  }

  /** The next batch to post (taken out of the collector), or null when there is nothing. What does not fit 2 KB
   *  waits for the next one; a histogram that could never fit a batch on its own is dropped. */
  take(): string | null {
    return this.takeBatch()?.body ?? null;
  }

  private takeBatch(): { body: string; taken: Hist[] } | null {
    if (!this.hist.size) return null;
    const h: Hist[] = [];
    let buckets = 0;
    const base = { v: 1, r: this.rate, p: platform(), s: SDK };
    for (const [key, x] of this.hist) {
      const b = [...x.b.entries()].sort((a, z) => a[0] - z[0]);
      const item = { m: x.m, k: x.k, c: x.c, b };
      const tooBig = b.length > MAX_BUCKETS || JSON.stringify({ ...base, h: [item] }).length > MAX_BATCH_BYTES;
      if (tooBig) {
        // The server would refuse any batch with it: it goes, so that it does not block the rest forever.
        this.hist.delete(key);
        continue;
      }
      if (buckets + b.length > MAX_BUCKETS) break;
      if (h.length && JSON.stringify({ ...base, h: [...h, item] }).length > MAX_BYTES) break;
      h.push(item);
      buckets += b.length;
      this.hist.delete(key);
    }
    return h.length ? { body: JSON.stringify({ ...base, h }), taken: h } : null;
  }

  /** A batch that did not go out comes back (added to what was measured since, never counted twice). */
  private restore(taken: Hist[]): void {
    for (const x of taken) {
      const key = `${x.m}\n${x.k}\n${x.c}`;
      let h = this.hist.get(key);
      if (!h) {
        if (this.hist.size >= MAX_HISTOGRAMS) continue;
        this.hist.set(key, (h = { m: x.m, k: x.k, c: x.c, b: new Map() }));
      }
      for (const [b, n] of x.b) h.b.set(b, Math.min(100_000, (h.b.get(b) ?? 0) + n));
    }
  }

  /** Posts what was measured (a beacon when the page is going away). Never throws. A batch that fails (network
   *  error, 429 or 5xx) goes back for the next flush; one the server refuses (4xx) is dropped. */
  flush(leaving: boolean): void {
    const batch = this.takeBatch();
    if (!batch) return;
    const { body, taken } = batch;
    this.sent++;
    try {
      const nav = (globalThis as { navigator?: { sendBeacon?: (url: string, data: Blob | string) => boolean } }).navigator;
      // text/plain: a "simple" request (no CORS preflight); the server reads it as JSON.
      if (leaving && typeof nav?.sendBeacon === "function" && typeof Blob !== "undefined" && nav.sendBeacon(this.endpoint, new Blob([body], { type: "text/plain" }))) return;
      if (!this.fetchImpl) return;
      void this.fetchImpl(this.endpoint, { method: "POST", headers: { "content-type": "text/plain" }, body, keepalive: true }).then(
        (r) => {
          if (r.status === 429 || r.status >= 500) this.restore(taken);
        },
        () => this.restore(taken),
      );
    } catch {
      // measuring must never break the app
      this.restore(taken);
    }
  }

  stop(): void {
    this.flush(true);
    if (this.timer) clearInterval(this.timer);
    if (this.onHide) (globalThis as { removeEventListener?: (t: string, f: () => void) => void }).removeEventListener?.("pagehide", this.onHide);
  }
}
