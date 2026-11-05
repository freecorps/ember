// Pure rate-limit math (no I/O, no clock): the component's mutation feeds it the stored state and `ctx.now`.
//
// - Token bucket: `capacity` tokens (default `rate`), refilled continuously at `rate` per `period` ms. Bursts up
//   to `capacity`, then a steady `rate / period`.
// - Fixed window: `rate` tokens are added at the start of every window of `period` ms (windows aligned to
//   `start`, default 0 = the epoch), up to `capacity` (default `rate`: unused tokens do not carry over).
//
// `reserve: true` takes the tokens even when there are not enough (the value goes negative) and reports when the
// reservation becomes valid (`retryAfter`): the caller schedules its work at that time. `maxReserved` caps how
// far below zero reservations may go.

export type TokenBucket = { kind: "token bucket"; rate: number; period: number; capacity?: number; maxReserved?: number };
export type FixedWindow = { kind: "fixed window"; rate: number; period: number; capacity?: number; start?: number; maxReserved?: number };
export type RateLimitConfig = TokenBucket | FixedWindow;

/** Stored per (name, key): tokens left and the time they were computed for (window start for fixed windows). */
export type RateLimitState = { value: number; ts: number };

export type RateLimitResult =
  | { ok: true; retryAfter?: undefined }
  /** `retryAfter`: ms until `count` tokens are available (or, with `reserve`, until the reservation is valid). */
  | { ok: false; retryAfter: number };

export type ReserveResult = { ok: true; retryAfter?: number } | { ok: false; retryAfter: number };

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function checkConfig(c: RateLimitConfig): void {
  if (!c || (c.kind !== "token bucket" && c.kind !== "fixed window")) throw new Error(`rate limit: kind must be "token bucket" or "fixed window"`);
  if (!(c.rate > 0) || !Number.isFinite(c.rate)) throw new Error("rate limit: rate must be a positive number");
  if (!(c.period > 0) || !Number.isFinite(c.period)) throw new Error("rate limit: period must be a positive number of ms");
  if (c.capacity !== undefined && !(c.capacity > 0)) throw new Error("rate limit: capacity must be positive");
  if (c.maxReserved !== undefined && !(c.maxReserved >= 0)) throw new Error("rate limit: maxReserved must be >= 0");
}

const capacityOf = (c: RateLimitConfig) => c.capacity ?? c.rate;

/** The state as of `now` (refilled), without consuming anything. `prev` null = never used: a full bucket. */
export function refill(c: RateLimitConfig, prev: RateLimitState | null, now: number): RateLimitState {
  const cap = capacityOf(c);
  if (c.kind === "token bucket") {
    if (!prev) return { value: cap, ts: now };
    const elapsed = Math.max(0, now - prev.ts);
    return { value: Math.min(cap, prev.value + (elapsed * c.rate) / c.period), ts: Math.max(now, prev.ts) };
  }
  const start = c.start ?? 0;
  const windowStart = now - (((now - start) % c.period) + c.period) % c.period;
  if (!prev) return { value: cap, ts: windowStart };
  const windows = Math.max(0, Math.floor((windowStart - prev.ts) / c.period));
  return { value: Math.min(cap, prev.value + windows * c.rate), ts: Math.max(prev.ts, windowStart) };
}

/** Time until `value` reaches `target` (ms; 0 if already there). */
function timeUntil(c: RateLimitConfig, s: RateLimitState, target: number, now: number): number {
  if (s.value >= target) return 0;
  const missing = target - s.value;
  if (c.kind === "token bucket") return Math.ceil((missing * c.period) / c.rate);
  // Fixed window: tokens arrive `rate` at a time, at window boundaries.
  const windows = Math.ceil(missing / c.rate);
  return Math.max(0, s.ts + windows * c.period - now);
}

/**
 * Consumes `count` tokens if available. Returns the decision and the state to store (unchanged on refusal:
 * a refused call costs nothing).
 */
export function consume(
  c: RateLimitConfig,
  prev: RateLimitState | null,
  now: number,
  count = 1,
  reserve = false,
): { result: ReserveResult; state: RateLimitState | null } {
  checkConfig(c);
  if (!(count >= 0) || !Number.isFinite(count)) throw new Error("rate limit: count must be a non-negative number");
  if (count > capacityOf(c)) throw new Error(`rate limit: count ${count} exceeds capacity ${capacityOf(c)}`);
  const s = refill(c, prev, now);
  if (s.value >= count) return { result: { ok: true }, state: { value: s.value - count, ts: s.ts } };
  if (reserve) {
    const next = s.value - count;
    if (c.maxReserved === undefined || -next <= c.maxReserved) {
      return { result: { ok: true, retryAfter: timeUntil(c, s, count, now) }, state: { value: next, ts: s.ts } };
    }
  }
  return { result: { ok: false, retryAfter: timeUntil(c, s, count, now) }, state: null };
}

/** Whether `count` tokens are available now, without consuming them. */
export function check(c: RateLimitConfig, prev: RateLimitState | null, now: number, count = 1): RateLimitResult {
  checkConfig(c);
  const s = refill(c, prev, now);
  return s.value >= count ? { ok: true } : { ok: false, retryAfter: timeUntil(c, s, count, now) };
}
