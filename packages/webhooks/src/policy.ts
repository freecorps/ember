// Delivery policy, pure (no clock, no randomness of its own): what an attempt's outcome means, when the next one is
// due, and how an endpoint's circuit breaker moves. The component calls these with `ctx.now` and `ctx.random()`.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Delays before each retry (attempt 2 is due 5 s after attempt 1 failed, ...); after the last one: dead. */
export const DEFAULT_RETRY_SCHEDULE_MS: readonly number[] = [5 * SECOND, 30 * SECOND, 2 * MINUTE, 10 * MINUTE, HOUR, 6 * HOUR, DAY];
/** ±20% around each delay. */
export const DEFAULT_JITTER = 0.2;
/** A `Retry-After` is honoured up to this long; a longer one waits this long. */
export const MAX_RETRY_AFTER_MS = DAY;

export type AttemptOutcome =
  /** The endpoint answered 2xx. */
  | { kind: "delivered" }
  /** A network error, a timeout, 408, 429 or 5xx: retried on the schedule (a `Retry-After` replaces the delay). */
  | { kind: "retry"; retryAfterMs?: number }
  /** Any other status (3xx are not followed; 4xx other than 408/429): the receiver refused it, no retry. */
  | { kind: "terminal" };

/** What an HTTP status (or a network error: `status` undefined) means for the delivery. */
export function classify(status: number | undefined, retryAfterMs?: number): AttemptOutcome {
  if (status === undefined) return { kind: "retry" };
  if (status >= 200 && status < 300) return { kind: "delivered" };
  if (status === 408 || status === 429 || status >= 500) return retryAfterMs !== undefined ? { kind: "retry", retryAfterMs } : { kind: "retry" };
  return { kind: "terminal" };
}

/**
 * `Retry-After` (delta seconds or an HTTP date) in ms from `now`, at most `MAX_RETRY_AFTER_MS`; undefined when absent
 * or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(MAX_RETRY_AFTER_MS, Number(v) * SECOND);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
}

/**
 * The delay before retry number `retry` (0 = the first retry, after attempt 1), or null when the schedule is
 * exhausted (the delivery is dead). `random` in [0, 1) spreads it by ±`jitter`. A `retryAfterMs` the endpoint asked for
 * replaces the scheduled delay (capped at `MAX_RETRY_AFTER_MS`, never shorter than 1 s).
 */
export function retryDelay(retry: number, schedule: readonly number[], random: number, jitter = DEFAULT_JITTER, retryAfterMs?: number): number | null {
  if (retry < 0 || retry >= schedule.length) return null;
  if (retryAfterMs !== undefined) return Math.min(MAX_RETRY_AFTER_MS, Math.max(SECOND, retryAfterMs));
  const base = schedule[retry]!;
  const j = Math.min(1, Math.max(0, jitter));
  return Math.max(0, Math.round(base * (1 - j + 2 * j * random)));
}

// ------------------------------------------------------------------------------------------------ circuit breaker

export type BreakerState = "closed" | "open" | "halfOpen";

export interface Breaker {
  state: BreakerState;
  /** Consecutive failed attempts. */
  failures: number;
  /** When it opened (state open/halfOpen). */
  openedAt?: number;
  /** When the next probe may go (state open). */
  probeAt?: number;
}

export const DEFAULT_BREAKER_THRESHOLD = 10;
export const DEFAULT_BREAKER_COOLDOWN_MS = MINUTE;

export const closedBreaker = (): Breaker => ({ state: "closed", failures: 0 });

/** After a delivered attempt: closed, no failures. */
export function breakerOnSuccess(_b: Breaker): Breaker {
  return closedBreaker();
}

/**
 * After a failed attempt: one more consecutive failure; `threshold` of them open a closed breaker, and a failed probe
 * (half-open) opens it again, with the next probe due after `cooldownMs`. An open breaker only counts the failure
 * (an attempt that was in flight when it opened).
 */
export function breakerOnFailure(b: Breaker, now: number, threshold = DEFAULT_BREAKER_THRESHOLD, cooldownMs = DEFAULT_BREAKER_COOLDOWN_MS): Breaker {
  const failures = b.failures + 1;
  // Already open (an attempt that was in flight when it opened): the probe stays when it was due.
  if (b.state === "open") return { ...b, failures };
  if (b.state === "halfOpen" || failures >= threshold) return { state: "open", failures, openedAt: b.state === "closed" ? now : (b.openedAt ?? now), probeAt: now + cooldownMs };
  return { state: "closed", failures };
}

/** The cooldown is over: one probe may go. */
export function breakerHalfOpen(b: Breaker): Breaker {
  return b.state === "open" ? { ...b, state: "halfOpen" } : b;
}

// ------------------------------------------------------------------------------------------------ events

/**
 * Whether an endpoint subscribed to `patterns` receives `event`: `"*"` is every event, `"invoice.*"` every event
 * starting with `invoice.`, anything else must be equal.
 */
export function matchesEvent(patterns: readonly string[], event: string): boolean {
  for (const p of patterns) {
    if (p === "*" || p === event) return true;
    if (p.endsWith(".*") && event.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}
