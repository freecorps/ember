/**
 * Delivery options shared by the direct transports: urgency → priority, TTL defaults, interruption level. The values
 * follow Freecorps Brigade's relay as its README documents them (the relay is AGPL; nothing is copied from its code):
 * TTL 15 min for its `page`, 1 h for `high`, 4 h for `low`, at most 30 days, 0 = try once; priority 5 only for `low`;
 * `time-sensitive` only for `page`. Ember names them `high`, `normal`, `low`.
 */
import type { PushFallback, PushInterruptionLevel, PushMessage, PushUrgency } from "./types.ts";

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

export function resolveInterruptionLevel(m: Pick<PushMessage, "urgency" | "priority" | "interruptionLevel">): PushInterruptionLevel | undefined {
  if (m.interruptionLevel) return m.interruptionLevel;
  return resolveUrgency(m) === "high" ? "time-sensitive" : undefined;
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

export interface RetryOptions {
  /** Retries on 429 / 5xx / network errors (default 2), exponential backoff from `retryDelayMs` (default 1000). */
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `fetch` with retries for transient answers. A `Retry-After` header (seconds) wins over the backoff. The last
 * response is returned whatever its status; a network error on the last try throws.
 */
export async function fetchWithRetry(fetchFn: typeof fetch, url: string, init: () => RequestInit, o: RetryOptions = {}): Promise<Response> {
  const retries = o.retries ?? 2;
  const sleep = o.sleep ?? defaultSleep;
  let delay = o.retryDelayMs ?? 1000;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, init());
    } catch (e) {
      if (attempt >= retries) throw e;
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
