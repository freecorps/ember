// `@freecorps/ember-analytics/client`: a tiny batching tracker for browsers and apps (no dependency, no Ember client
// needed). Events wait in memory and go to `POST <url><path>` every `flushIntervalMs`, when a batch is full, on
// `pagehide` (`navigator.sendBeacon`) and on `close()`. Bodies are `text/plain` JSON, a "simple" request with no CORS
// preflight (like the RUM client). One request at a time; a batch that is not delivered (network, 3xx, 429, 5xx) goes
// back to the queue; one the server refuses whole (400, 413) is sent again in halves, and only an event refused on
// its own (or a batch refused with another 4xx) is dropped. On `pagehide` the beacons stay within the
// browser's keepalive budget (64 KiB in flight per page, shared with the pending fetch): what does not fit stays
// queued (a page restored from the back/forward cache sends it). The anonymous id lives in localStorage when there is
// one; `reset()` (sign-out) is an identity boundary: what was queued before it never goes with the next user's token.
// A send that hangs (token or fetch) gives up after `timeoutMs` and is retried; redirects are never followed.
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
  /** How long one send (token + request) may take before it is given up and retried (default 15 s). */
  timeoutMs?: number;
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
/**
 * Bytes of one request body: what the track route takes (events.ts `MAX_BODY_BYTES`; over it, 413). A beacon cannot
 * be split after the fact (`sendBeacon` only says the browser queued it), so each one is cut to fit before it goes.
 */
export const MAX_BODY_BYTES = 32 * 1024;

const finite = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
const LOOPBACK = (host: string) => host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
type Outcome = "ok" | "retry" | "split";
/** Delivered: 2xx. Refused whole (400 bad_batch, 413 too_large): "split". Another 4xx but 429: dropped for good. */
const outcomeOf = (status: number): Outcome =>
  status >= 200 && status < 300 ? "ok" : status === 400 || status === 413 ? "split" : status >= 400 && status < 500 && status !== 429 ? "ok" : "retry";

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
  private readonly timeoutMs: number;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onHide: (() => void) | null = null;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private aid: string;
  /** The flush running now: one request at a time (the timer, a full batch and `flush()` share it). */
  private flushing: Promise<void> | null = null;
  /**
   * Bytes of the keepalive fetches in flight (they count against the beacon budget): the regular send's from the
   * moment it chooses keepalive (before its token), and the `pagehide` fallback fetches' until they settle.
   */
  private inFlightBytes = 0;
  /** Enqueue order of each event (not sent): a batch put back goes where it was, whatever order the answers come in. */
  private readonly seq = new WeakMap<QueuedEvent, number>();
  private nextSeq = 0;
  /** Requests sent (tests). */
  sent = 0;

  constructor(private readonly o: AnalyticsClientOptions) {
    this.endpoint = `${o.url.replace(/\/+$/, "")}${o.path ?? "/analytics/track"}`;
    if (o.getToken) {
      // A bearer token never crosses the network in the clear: https, or plain http to the loopback (local dev).
      let u: URL | null = null;
      try {
        u = new URL(this.endpoint);
      } catch {
        // a relative URL: the page's own origin, which the browser already chose
      }
      if (u && u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK(u.hostname))) {
        throw new Error(`ember-analytics: getToken needs an https url (got ${u.protocol}//${u.host}): the token would go in the clear`);
      }
    }
    // Non-finite options (NaN, Infinity) fall back to the defaults before clamping.
    this.batchSize = Math.max(1, Math.min(50, Math.floor(finite(o.batchSize, 20))));
    this.maxQueue = Math.max(this.batchSize, Math.floor(finite(o.maxQueue, 500)));
    this.timeoutMs = Math.max(1000, finite(o.timeoutMs, 15_000));
    this.storage = o.storage === undefined ? defaultStorage() : o.storage;
    this.aid = this.loadId();
    this.timer = setInterval(() => void this.flush(), Math.max(100, finite(o.flushIntervalMs, 10_000)));
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

  /**
   * A new anonymous id (after sign-out, so the next visitor is not linked to the last). Events already queued keep the
   * old id and are sent without a token (anonymous): never as the user who signs in next.
   */
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
        if (!/^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k)) continue;
        if (typeof v === "string") p[k] = v.slice(0, 256);
        else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") p[k] = v;
        else continue;
        kept++;
      }
    }
    const e: QueuedEvent = { name, ...(p && Object.keys(p).length ? { props: p } : {}), ts: Date.now(), anonymousId: this.aid };
    this.seq.set(e, this.nextSeq++);
    this.queue.push(e);
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
    if (this.queue.length >= this.batchSize && !this.flushing) void this.flush();
  }

  /** Events waiting to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  /** Posts what is queued, a batch at a time. Never throws. While one runs, a call waits for it (no second request). */
  flush(): Promise<void> {
    if (!this.flushing) {
      // The promise is in place before any user code runs (a `getToken` that tracks, say): the drain starts a tick later.
      this.flushing = Promise.resolve()
        .then(() => this.drain())
        .finally(() => (this.flushing = null));
    }
    return this.flushing;
  }

  /** How many of the first `n` queued events go together: one anonymous id per batch (an identity boundary). */
  private run(n: number): number {
    const aid = this.queue[0]?.anonymousId;
    let k = 0;
    while (k < n && k < this.queue.length && this.queue[k]!.anonymousId === aid) k++;
    return k;
  }

  /**
   * Puts a batch back in enqueue order: its events are merged into the queue by sequence, one by one (a batch can mix
   * events older and newer than ones already queued again, e.g. a retried A + C after B came back).
   */
  private requeue(batch: QueuedEvent[]): void {
    if (!batch.length) return;
    const at = (e: QueuedEvent) => this.seq.get(e) ?? Number.MAX_SAFE_INTEGER;
    this.queue.push(...batch);
    this.queue.sort((x, y) => at(x) - at(y));
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
  }

  private async drain(): Promise<void> {
    // A batch the server refuses whole (400: more events than the install's `maxEvents`, or one bad event; 413: over
    // 32 KiB) goes back in halves, for the rest of this flush: only an event refused on its own is dropped.
    let size = this.batchSize;
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.run(size));
      const r = await this.post(batch);
      if (r === "split" && batch.length > 1) {
        this.requeue(batch);
        size = Math.ceil(batch.length / 2);
        continue;
      }
      if (r === "retry") {
        // Back to the front, for the next flush (keeping the cap). Closed: no timer will come, so beacon it now.
        this.requeue(batch);
        if (this.closed) this.flushBeacon();
        return;
      }
    }
  }

  /** "ok": delivered or dropped for good; "retry": later, as is; "split": refused whole, smaller batches may pass. */
  private async post(batch: QueuedEvent[]): Promise<Outcome> {
    const f = this.o.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) return "ok";
    const body = JSON.stringify({ events: batch });
    const bytes = byteLength(body);
    // Over what the route takes: it would answer 413, so it is split before it goes (and never offered to keepalive,
    // whose quota a big body would pass: the browser would refuse it before the server could answer).
    if (bytes > MAX_BODY_BYTES && batch.length > 1) return "split";
    // keepalive (the send survives the page) only while it fits in the page's keepalive quota with what is in flight.
    // The bytes are counted from this choice, not from the dispatch: a `pagehide` while the token is pending must
    // already see them as spent (its beacons would otherwise take the room this send counts on).
    const keepalive = bytes + this.inFlightBytes <= BEACON_BUDGET_BYTES;
    if (keepalive) this.inFlightBytes += bytes;
    this.sent++;
    // One deadline for the token and the request: a send that hangs is given up (aborted) and retried, so the flush
    // never stays held. A late answer of a given-up send changes nothing (the batch is already back in the queue).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    try {
      const headers: Record<string, string> = { "content-type": "text/plain" };
      // The token only for events queued under the current anonymous id: after `reset()` (sign-out), older events go
      // anonymous, never as the next user.
      if (this.o.getToken && batch[0]?.anonymousId === this.aid) {
        const token = await Promise.race([Promise.resolve().then(() => this.o.getToken!()), timeout]);
        if (token === "timeout") return "retry";
        // Again after the await: a `reset()` while the token was pending makes this batch the previous visitor's.
        if (token && batch[0]?.anonymousId === this.aid) headers.authorization = `Bearer ${token}`;
      }
      // `redirect: "manual"`: a redirect is never followed (a 301 to a landing page would turn the POST into a GET
      // and answer 200): it comes back as a 3xx or an opaque redirect (status 0), retried.
      const sending = f(this.endpoint, { method: "POST", headers, body, keepalive, redirect: "manual", ...(ctrl ? { signal: ctrl.signal } : {}) });
      sending.catch(() => undefined);
      const r = await Promise.race([sending, timeout]);
      if (r === "timeout") {
        ctrl?.abort();
        return "retry";
      }
      return outcomeOf(r.status);
    } catch {
      return "retry";
    } finally {
      if (keepalive) this.inFlightBytes -= bytes;
      clearTimeout(timer);
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
      // Fewer events while the body is over what the server takes; one event that alone is over it stays queued
      // (the regular send drops it when the server answers 413).
      let batch = this.queue.slice(0, this.run(this.batchSize));
      let body = JSON.stringify({ events: batch });
      let bytes = byteLength(body);
      while (bytes > MAX_BODY_BYTES && batch.length > 1) {
        batch = batch.slice(0, Math.ceil(batch.length / 2));
        body = JSON.stringify({ events: batch });
        bytes = byteLength(body);
      }
      if (bytes > MAX_BODY_BYTES || bytes > budget) return;
      try {
        if (typeof nav?.sendBeacon === "function" && typeof Blob !== "undefined") {
          if (!nav.sendBeacon(this.endpoint, new Blob([body], { type: "text/plain" }))) return; // over the browser's quota
          this.queue.splice(0, batch.length);
        } else {
          const f = this.o.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
          if (!f) return;
          // Out of the queue while the keepalive fetch is pending (never sent twice); back in front if it is not
          // delivered (network, 3xx, 429, 5xx), for a page restored from the back/forward cache.
          this.queue.splice(0, batch.length);
          let sending: Promise<Response>;
          try {
            sending = f(this.endpoint, { method: "POST", headers: { "content-type": "text/plain" }, body, keepalive: true, redirect: "manual" });
          } catch (e) {
            this.requeue(batch);
            throw e;
          }
          // Its body is in the page's keepalive quota until it settles: a regular send meanwhile counts it.
          this.inFlightBytes += bytes;
          const settled = () => (this.inFlightBytes -= bytes);
          // Back for the regular drain when not delivered, or refused whole with more than one event (the drain splits
          // it); a refused singleton is dropped, as the drain does.
          sending.then(
            (r) => {
              settled();
              const o = outcomeOf(r.status);
              if (o === "retry" || (o === "split" && batch.length > 1)) this.requeue(batch);
            },
            () => {
              settled();
              this.requeue(batch);
            },
          );
        }
      } catch {
        return; // tracking must never break the app
      }
      this.sent++;
      budget -= bytes;
    }
  }

  /**
   * Sends what is left (as beacons) and stops the timer. A fetch still in flight is not waited for; if it then fails,
   * its batch is beaconed as soon as it is back in the queue (no timer is left to send it).
   */
  close(): void {
    this.closed = true;
    this.flushBeacon();
    clearInterval(this.timer);
    if (this.onHide) (globalThis as { removeEventListener?: (t: string, f: () => void) => void }).removeEventListener?.("pagehide", this.onHide);
  }
}

export function createAnalytics(o: AnalyticsClientOptions): AnalyticsClient {
  return new AnalyticsClient(o);
}
