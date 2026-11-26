/**
 * Delivery options shared by the direct transports: urgency → priority, TTL defaults, interruption level. The values
 * follow Freecorps Brigade's relay as its README documents them (the relay is AGPL; nothing is copied from its code):
 * TTL 15 min for its `page`, 1 h for `high`, 4 h for `low`, at most 30 days, 0 = try once; priority 5 only for `low`;
 * `time-sensitive` only for `page`. Ember names them `high`, `normal`, `low`.
 */
import type { PushCriticalSound, PushFallback, PushInterruptionLevel, PushMessage, PushUrgency } from "./types.ts";

/** What a device shows for a sealed push it cannot open (and, with `encryption: "required"`, a device with no key). */
export const DEFAULT_PUSH_FALLBACK: Required<Pick<PushFallback, "title" | "body">> = { title: "New notification", body: "Open the app to see it." };

export const PUSH_TTL_DEFAULTS: Readonly<Record<PushUrgency, number>> = { low: 4 * 3600, normal: 3600, high: 15 * 60 };

/** APNs keeps an undelivered push about 30 days at most (and FCM's limit is 28 days, which `fcm.ts` clamps to). */
export const PUSH_MAX_TTL_SECONDS = 30 * 24 * 3600;

export function resolveUrgency(m: Pick<PushMessage, "urgency" | "priority">): PushUrgency {
  if (m.urgency) return m.urgency;
  return m.priority === "normal" ? "low" : "normal";
}

/** Seconds the push service keeps trying: `ttl` if given (clamped to 0..30 days), else the urgency's default. */
export function resolveTtlSeconds(m: Pick<PushMessage, "urgency" | "priority" | "ttl">): number {
  if (m.ttl === undefined || m.ttl === null || !Number.isFinite(m.ttl)) return PUSH_TTL_DEFAULTS[resolveUrgency(m)];
  return Math.min(PUSH_MAX_TTL_SECONDS, Math.max(0, Math.floor(m.ttl)));
}

export function resolveInterruptionLevel(m: Pick<PushMessage, "urgency" | "priority" | "interruptionLevel" | "sound">): PushInterruptionLevel | undefined {
  if (m.interruptionLevel) return m.interruptionLevel;
  if (isCriticalSound(m.sound)) return "critical";
  return resolveUrgency(m) === "high" ? "time-sensitive" : undefined;
}

/** Whether `sound` asks for a Critical Alert. */
export function isCriticalSound(sound: PushMessage["sound"]): sound is PushCriticalSound {
  return typeof sound === "object" && sound !== null && sound.critical === true;
}

/** APNs' `sound` value: the name, or the critical-sound dictionary. */
export function apnsSound(sound: PushMessage["sound"]): string | Record<string, unknown> | undefined {
  if (!sound) return undefined;
  if (!isCriticalSound(sound)) return sound;
  const volume = sound.volume === undefined ? 1 : Math.min(1, Math.max(0, sound.volume));
  return { critical: 1, name: sound.name ?? "default", volume };
}

/** The sound name for transports with no critical alerts (Android, Expo). */
export function soundName(sound: PushMessage["sound"]): string | undefined {
  if (!sound) return undefined;
  return isCriticalSound(sound) ? (sound.name ?? "default") : sound;
}

const utf8 = new TextEncoder();
export const byteLength = (s: string) => utf8.encode(s).length;

/** Runs `fn` over `items` with at most `limit` in flight, keeping the result order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Most push requests (APNs + FCM + Expo + the OAuth exchange, together) in flight at once in one invocation. A Worker
 * keeps at most 6 connections open per invocation (Cloudflare docs: "simultaneous open connections"; more wait in a
 * queue, and a stalled one can deadlock the rest); push stays one under it, for the action's own calls.
 */
export const MAX_PUSH_CONCURRENCY = 5;

/**
 * How long one request may hold a slot (default 60 s). Past it the slot is taken back: a request whose invocation
 * died (its promise never settles) would otherwise hold it for good, and the default limiter is the isolate's.
 */
export const PUSH_SLOT_HOLD_MS = 60_000;

/** A counting semaphore over outbound requests (`sharedPushLimiter` by default, one per isolate). */
export interface PushLimiter {
  /** Requests allowed in flight at once (1..`MAX_PUSH_CONCURRENCY`). */
  readonly limit: number;
  /** In flight now. */
  readonly active: number;
  /** The most in flight at once so far. */
  readonly peak: number;
  /**
   * Waits for a free slot (FIFO) and answers its release (calling it again does nothing). A `signal` aborted while
   * waiting rejects without taking one.
   */
  acquire(signal?: AbortSignal | null): Promise<() => void>;
  /** Runs `fn` in a slot, released when it settles. */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal | null): Promise<T>;
}

export interface PushLimiterOptions {
  /** See `PUSH_SLOT_HOLD_MS`. */
  holdMs?: number;
  now?: () => number;
}

/** A `PushLimiter` of `limit` slots (clamped to 1..`MAX_PUSH_CONCURRENCY`; default the max). */
export function createPushLimiter(limit: number = MAX_PUSH_CONCURRENCY, o: PushLimiterOptions = {}): PushLimiter {
  const max = Number.isFinite(limit) ? Math.min(MAX_PUSH_CONCURRENCY, Math.max(1, Math.floor(limit))) : MAX_PUSH_CONCURRENCY;
  const holdMs = Math.max(1, o.holdMs ?? PUSH_SLOT_HOLD_MS);
  const now = o.now ?? Date.now;
  /** Slots held now, by when each was taken. */
  const held = new Set<{ at: number }>();
  const waiting: Array<() => void> = [];
  let peak = 0;
  const take = (): (() => void) => {
    const slot = { at: now() };
    held.add(slot);
    peak = Math.max(peak, held.size);
    return () => {
      if (held.delete(slot)) pump();
    };
  };
  const pump = () => {
    const t = now();
    for (const s of held) if (t - s.at >= holdMs) held.delete(s);
    while (held.size < max && waiting.length) waiting.shift()!();
  };
  /** When the oldest slot's hold ends (a waiter checks again then, in case its holder never releases). */
  const nextExpiry = () => {
    let oldest = Infinity;
    for (const s of held) oldest = Math.min(oldest, s.at);
    return oldest === Infinity ? holdMs : Math.max(0, oldest + holdMs - now());
  };
  const acquire = (signal?: AbortSignal | null): Promise<() => void> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    pump();
    if (held.size < max && !waiting.length) return Promise.resolve(take());
    return new Promise<() => void>((resolve, reject) => {
      // The waiter's own timer (its invocation is alive; the holder's may not be).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        timer = setTimeout(() => {
          pump();
          if (waiting.includes(go)) arm();
        }, nextExpiry());
      };
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const go = () => {
        done();
        resolve(take());
      };
      const onAbort = () => {
        const i = waiting.indexOf(go);
        if (i >= 0) waiting.splice(i, 1);
        done();
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.push(go);
      arm();
    });
  };
  return {
    limit: max,
    get active() {
      return held.size;
    },
    get peak() {
      return peak;
    },
    acquire,
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
      const release = await acquire(signal);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/**
 * The limiter every send without its own `limiter` takes: one per isolate, so sends running at once in an invocation
 * (two deliveries of a queue batch, a `sendNow` beside a scheduled send) never pass `MAX_PUSH_CONCURRENCY` together.
 * Concurrent invocations of the isolate share it too (stricter than the platform's per-invocation limit).
 */
export const sharedPushLimiter: PushLimiter = createPushLimiter();

/** Statuses whose `Response` cannot carry a body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * `fetchFn` under `limiter`: a slot is held from the request until its body is read to the end, cancelled or the
 * request's `signal` aborts (an unread body keeps its connection open). The body is not buffered here: a retried
 * answer is cancelled unread, and a body that fails to download fails its reader, not the request.
 */
export function limitedFetch(fetchFn: typeof fetch, limiter: PushLimiter): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    const release = await limiter.acquire(signal);
    let res: Response;
    try {
      res = await fetchFn(input, init);
    } catch (e) {
      release();
      throw e;
    }
    if (signal?.aborted || !res.body || NULL_BODY.has(res.status)) {
      await res.body?.cancel().catch(() => {});
      release();
      signal?.throwIfAborted();
      return res.body ? new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
    }
    const reader = res.body.getReader();
    let open = true;
    const finish = () => {
      if (!open) return;
      open = false;
      signal?.removeEventListener("abort", onAbort);
      release();
    };
    const onAbort = () => {
      finish();
      reader.cancel(signal!.reason).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          try {
            const r = await reader.read();
            if (r.done) {
              finish();
              c.close();
            } else c.enqueue(r.value);
          } catch (e) {
            finish();
            c.error(e);
          }
        },
        cancel(reason) {
          finish();
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 }, // read only when the caller reads
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

export interface RetryOptions {
  /** Retries on 429 / 5xx / network errors (default 2), exponential backoff from `retryDelayMs` (default 1000). */
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Aborts a send: every try and the waits between them. A send that stops this way answers `RequestFailed`. */
  signal?: AbortSignal;
  /**
   * A deadline for each send, retries and the token it needs included (past it, the send stops with `RequestFailed`).
   * A token exchange shared with other sends is not cut short by one caller's deadline: that caller stops waiting.
   */
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The signal a send runs under: `signal` and `timeoutMs` together (undefined when neither is set). */
export function deadlineSignal(o: Pick<RetryOptions, "signal" | "timeoutMs">): AbortSignal | undefined {
  const parts: AbortSignal[] = [];
  if (o.signal) parts.push(o.signal);
  if (o.timeoutMs !== undefined) parts.push(AbortSignal.timeout(Math.max(0, o.timeoutMs)));
  if (parts.length <= 1) return parts[0];
  return AbortSignal.any(parts);
}

/** `p`, or a rejection with `signal`'s reason once it aborts (`p` itself goes on; its outcome is still observed). */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * `fetch` with retries for transient answers. A `Retry-After` header (seconds) wins over the backoff. The last
 * response is returned whatever its status; a network error on the last try throws.
 */
export async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: () => RequestInit,
  o: RetryOptions = {},
  // `null`: no deadline at all (a token exchange other sends share, which has its own); omitted: `o`'s.
  deadline: AbortSignal | null | undefined = deadlineSignal(o),
): Promise<Response> {
  const signal = deadline ?? undefined;
  const retries = o.retries ?? 2;
  const sleep = (ms: number) => untilAborted((o.sleep ?? defaultSleep)(ms), signal);
  let delay = o.retryDelayMs ?? 1000;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let res: Response;
    try {
      res = await fetchFn(url, signal ? { ...init(), signal } : init());
    } catch (e) {
      // Aborted (the caller's signal or deadline): not a network error to retry.
      if (signal?.aborted || attempt >= retries) throw signal?.aborted ? signal.reason : e;
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => {});
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay);
      delay *= 2;
      continue;
    }
    return res;
  }
}
