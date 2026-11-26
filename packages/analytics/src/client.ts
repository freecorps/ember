// `@freecorps/ember-analytics/client`: a tiny batching tracker for browsers and apps (no dependency, no Ember client
// needed). Events wait in memory and go to `POST <url><path>` every `flushIntervalMs`, when a batch is full, on
// `pagehide` (`navigator.sendBeacon`) and on `close()`. Bodies are `text/plain` JSON, a "simple" request with no CORS
// preflight (like the RUM client). One request at a time; a batch that is not delivered (network, 3xx, 429, 5xx) goes
// back to the queue; one the server refuses (other 4xx) is dropped. On `pagehide` the beacons stay within the
// browser's keepalive budget (64 KiB in flight per page, shared with the pending fetch): what does not fit stays
// queued (a page restored from the back/forward cache sends it). The anonymous id lives in localStorage when there is
// one.
//
//   const analytics = createAnalytics({ url: "https://my-app.example.com" });
//   analytics.track("viewed_pricing", { plan: "pro" });

export type PropValue = string | number | boolean;

export interface AnalyticsClientOptions {
  /** The deployment's URL (`https://my-app.example.com`, or the Worker's). */
  url: string;
  /** The component's track route (default `/analytics/track`: the install's mount + `/track`). */
  path?: string;
  /** How often queued events are posted (default 10 s). */
  flushIntervalMs?: number;
  /** Events per request (default 20, at most 50: what the server takes). */
  batchSize?: number;
  /** Most events kept while the network is down (default 500; the oldest go first). */
  maxQueue?: number;
  /**
   * A bearer token: the server takes the user from it (`userId` is never sent). Sends an `Authorization` header, so
   * the request has a CORS preflight (the route answers it); beacons on `pagehide` go without it (anonymous).
   */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Where the anonymous id is kept (default `localStorage`, when available; otherwise memory). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

interface QueuedEvent {
  name: string;
  props?: Record<string, PropValue>;
  ts: number;
  anonymousId: string;
}

export const ANONYMOUS_ID_KEY = "ember.analytics.anonymousId";
const NAME = /^[A-Za-z](?:[A-Za-z0-9 _.:/-]{0,62}[A-Za-z0-9_.:/-])?$/;
/** Props per event (what the server takes). */
const MAX_PROPS = 20;
/**
 * Bytes of keepalive bodies in flight on `pagehide`. Browsers refuse a beacon (or keepalive fetch) once the page's
 * pending keepalive bodies pass 64 KiB (Fetch "keepalive" quota); a little under it, for the headers.
 */
export const BEACON_BUDGET_BYTES = 60 * 1024;

const byteLength = (s: string) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : s.length * 3);

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === "function" ? s : null;
  } catch {
    return null; // blocked storage (privacy settings, sandboxed frames)
  }
}

export class AnalyticsClient {
  private queue: QueuedEvent[] = [];
  private readonly endpoint: string;
  private readonly batchSize: number;
  private readonly maxQueue: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onHide: (() => void) | null = null;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private aid: string;
  /** The flush running now: one request at a time (the timer, a full batch and `flush()` share it). */
  private flushing: Promise<void> | null = null;
  /** Bytes of the keepalive fetch in flight (they count against the beacon budget). */
  private inFlightBytes = 0;
  /** Requests sent (tests). */
  sent = 0;

  constructor(private readonly o: AnalyticsClientOptions) {
    this.endpoint = `${o.url.replace(/\/+$/, "")}${o.path ?? "/analytics/track"}`;
    this.batchSize = Math.max(1, Math.min(50, Math.floor(o.batchSize ?? 20)));
    this.maxQueue = Math.max(this.batchSize, Math.floor(o.maxQueue ?? 500));
    this.storage = o.storage === undefined ? defaultStorage() : o.storage;
    this.aid = this.loadId();
    this.timer = setInterval(() => void this.flush(), o.flushIntervalMs ?? 10_000);
    (this.timer as { unref?: () => void }).unref?.();
    // A page (a document to hide and a navigator to beacon with): not a worker, not Node/SSR with a stubbed document.
    const g = globalThis as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: unknown; document?: unknown; navigator?: unknown };
    if (g.document !== undefined && g.navigator !== undefined && typeof g.addEventListener === "function" && typeof g.removeEventListener === "function") {
      this.onHide = () => this.flushBeacon();
      g.addEventListener("pagehide", this.onHide);
    }
  }

  private loadId(): string {
    try {
      const got = this.storage?.getItem(ANONYMOUS_ID_KEY);
      if (got && /^[A-Za-z0-9_-]{1,64}$/.test(got)) return got;
    } catch {
      // ignore
    }
    const id = newId();
    try {
      this.storage?.setItem(ANONYMOUS_ID_KEY, id);
    } catch {
      // memory only
    }
    return id;
  }

  /** This device's anonymous id (sent with every event). */
  get anonymousId(): string {
    return this.aid;
  }

  /** A new anonymous id (after sign-out, so the next visitor is not linked to the last). */
  reset(): void {
    this.aid = newId();
    try {
      this.storage?.setItem(ANONYMOUS_ID_KEY, this.aid);
    } catch {
      // ignore
    }
  }

  /** Queues one event. Invalid names and non-flat props are dropped here (the server would refuse the whole batch). */
  track(name: string, props?: Record<string, PropValue>): void {
    if (!NAME.test(name)) return;
    let p: Record<string, PropValue> | undefined;
    if (props) {
      p = {};
      let kept = 0;
      // The cap counts the props kept, not the keys looked at (an invalid one does not use a slot).
      for (const [k, v] of Object.entries(props)) {
        if (kept >= MAX_PROPS) break;
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k)) continue;
        if (typeof v === "string") p[k] = v.slice(0, 256);
        else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") p[k] = v;
        else continue;
        kept++;
      }
    }
    this.queue.push({ name, ...(p && Object.keys(p).length ? { props: p } : {}), ts: Date.now(), anonymousId: this.aid });
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
    if (this.queue.length >= this.batchSize && !this.flushing) void this.flush();
  }

  /** Events waiting to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  /** Posts what is queued, a batch at a time. Never throws. While one runs, a call waits for it (no second request). */
  flush(): Promise<void> {
    if (!this.flushing) this.flushing = this.drain().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.batchSize);
      const ok = await this.post(batch);
      if (!ok) {
        // Back to the front, for the next flush (keeping the cap).
        this.queue.unshift(...batch);
        if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
        return;
      }
    }
  }

  /** false: retry later. */
  private async post(batch: QueuedEvent[]): Promise<boolean> {
    const f = this.o.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) return true;
    this.sent++;
    const body = JSON.stringify({ events: batch });
    const bytes = byteLength(body);
    try {
      const headers: Record<string, string> = { "content-type": "text/plain" };
      const token = this.o.getToken ? await this.o.getToken() : null;
      if (token) headers.authorization = `Bearer ${token}`;
      this.inFlightBytes += bytes;
      try {
        const r = await f(this.endpoint, { method: "POST", headers, body, keepalive: true });
        // Delivered: 2xx. Refused (a 4xx other than 429): dropped, sending it again would not change the answer.
        // Anything else (a redirect not followed, 429, 5xx) was not taken: retried.
        if (r.status >= 200 && r.status < 300) return true;
        return r.status >= 400 && r.status < 500 && r.status !== 429;
      } finally {
        this.inFlightBytes -= bytes;
      }
    } catch {
      return false;
    }
  }

  /**
   * The page is going away: what is queued, as beacons (fetch with keepalive when there is no sendBeacon), while they
   * fit in the keepalive budget (`BEACON_BUDGET_BYTES`, less the fetch in flight). A batch that does not fit, or that
   * the browser refuses, stays queued with the rest. A fetch already in flight is not waited for: its events are not
   * in the queue, and each event carries its own `ts`, so the order the server gets them in does not matter.
   */
  flushBeacon(): void {
    const nav = (globalThis as { navigator?: { sendBeacon?: (url: string, data: Blob | string) => boolean } }).navigator;
    let budget = BEACON_BUDGET_BYTES - this.inFlightBytes;
    while (this.queue.length) {
      const batch = this.queue.slice(0, this.batchSize);
      const body = JSON.stringify({ events: batch });
      const bytes = byteLength(body);
      if (bytes > budget) return;
      try {
        if (typeof nav?.sendBeacon === "function" && typeof Blob !== "undefined") {
          if (!nav.sendBeacon(this.endpoint, new Blob([body], { type: "text/plain" }))) return; // over the browser's quota
        } else {
          const f = this.o.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
          if (!f) return;
          void f(this.endpoint, { method: "POST", headers: { "content-type": "text/plain" }, body, keepalive: true }).catch(() => undefined);
        }
      } catch {
        return; // tracking must never break the app
      }
      this.queue.splice(0, batch.length);
      this.sent++;
      budget -= bytes;
    }
  }

  /** Sends what is left (as beacons) and stops the timer. */
  close(): void {
    this.flushBeacon();
    clearInterval(this.timer);
    if (this.onHide) (globalThis as { removeEventListener?: (t: string, f: () => void) => void }).removeEventListener?.("pagehide", this.onHide);
  }
}

export function createAnalytics(o: AnalyticsClientOptions): AnalyticsClient {
  return new AnalyticsClient(o);
}
