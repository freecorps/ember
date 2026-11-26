// `@freecorps/ember-analytics/client`: a tiny batching tracker for browsers and apps (no dependency, no Ember client
// needed). Events wait in memory and go to `POST <url><path>` every `flushIntervalMs`, when a batch is full, on
// `pagehide` (`navigator.sendBeacon`) and on `close()`. Bodies are `text/plain` JSON, a "simple" request with no CORS
// preflight (like the RUM client). A batch that fails (network, 429, 5xx) goes back to the queue; one the server
// refuses (other 4xx) is dropped. The anonymous id lives in localStorage when there is one.
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
  private inFlight = 0;
  /** Requests sent (tests). */
  sent = 0;

  constructor(private readonly o: AnalyticsClientOptions) {
    this.endpoint = `${o.url.replace(/\/+$/, "")}${o.path ?? "/analytics/track"}`;
    this.batchSize = Math.max(1, Math.min(50, Math.floor(o.batchSize ?? 20)));
    this.maxQueue = Math.max(this.batchSize, Math.floor(o.maxQueue ?? 500));
    this.storage = o.storage === undefined ? defaultStorage() : o.storage;
    this.aid = this.loadId();
    const t = setInterval(() => void this.flush(), o.flushIntervalMs ?? 10_000);
    (t as { unref?: () => void }).unref?.();
    this.timer = t;
    const g = globalThis as { addEventListener?: (t: string, f: () => void) => void; document?: unknown };
    if (g.document !== undefined && typeof g.addEventListener === "function") {
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
      for (const [k, v] of Object.entries(props).slice(0, 20)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k)) continue;
        if (typeof v === "string") p[k] = v.slice(0, 256);
        else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") p[k] = v;
      }
    }
    this.queue.push({ name, ...(p && Object.keys(p).length ? { props: p } : {}), ts: Date.now(), anonymousId: this.aid });
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
    if (this.queue.length >= this.batchSize && !this.inFlight) void this.flush();
  }

  /** Events waiting to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  /** Posts what is queued, a batch at a time. Never throws. */
  async flush(): Promise<void> {
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
    this.inFlight++;
    this.sent++;
    try {
      const headers: Record<string, string> = { "content-type": "text/plain" };
      const token = this.o.getToken ? await this.o.getToken() : null;
      if (token) headers.authorization = `Bearer ${token}`;
      const r = await f(this.endpoint, { method: "POST", headers, body: JSON.stringify({ events: batch }), keepalive: true });
      return !(r.status === 429 || r.status >= 500);
    } catch {
      return false;
    } finally {
      this.inFlight--;
    }
  }

  /** The page is going away: everything queued, as beacons (fetch with keepalive when there is no sendBeacon). */
  flushBeacon(): void {
    const nav = (globalThis as { navigator?: { sendBeacon?: (url: string, data: Blob | string) => boolean } }).navigator;
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.batchSize);
      const body = JSON.stringify({ events: batch });
      this.sent++;
      try {
        if (typeof nav?.sendBeacon === "function" && typeof Blob !== "undefined" && nav.sendBeacon(this.endpoint, new Blob([body], { type: "text/plain" }))) continue;
        const f = this.o.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
        void f?.(this.endpoint, { method: "POST", headers: { "content-type": "text/plain" }, body, keepalive: true }).catch(() => undefined);
      } catch {
        // tracking must never break the app
      }
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
