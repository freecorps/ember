// Delivery policy, pure: classification, the retry schedule with jitter and Retry-After, the breaker's transitions,
// event patterns.
import { describe, expect, test } from "vitest";
import {
  breakerHalfOpen,
  breakerOnFailure,
  breakerOnSuccess,
  classify,
  closedBreaker,
  DEFAULT_RETRY_SCHEDULE_MS,
  HOUR,
  matchesEvent,
  MINUTE,
  parseRetryAfter,
  retryDelay,
  SECOND,
} from "../src/policy.ts";

describe("classify", () => {
  test("2xx delivered; network, 408, 429, 5xx retried; other statuses terminal", () => {
    expect(classify(200)).toEqual({ kind: "delivered" });
    expect(classify(204)).toEqual({ kind: "delivered" });
    expect(classify(undefined)).toEqual({ kind: "retry" });
    for (const s of [408, 429, 500, 502, 503, 504]) expect(classify(s).kind).toBe("retry");
    expect(classify(429, 7000)).toEqual({ kind: "retry", retryAfterMs: 7000 });
    for (const s of [301, 302, 400, 401, 403, 404, 410, 422]) expect(classify(s)).toEqual({ kind: "terminal" });
  });

  test("Retry-After: seconds or an HTTP date", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Thu, 26 Nov 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Thu, 26 Nov 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe("retry schedule", () => {
  test("the default: 5 s, 30 s, 2 min, 10 min, 1 h, 6 h, 24 h, then dead", () => {
    const noJitter = DEFAULT_RETRY_SCHEDULE_MS.map((_, i) => retryDelay(i, DEFAULT_RETRY_SCHEDULE_MS, 0.5, 0));
    expect(noJitter).toEqual([5 * SECOND, 30 * SECOND, 2 * MINUTE, 10 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR]);
    expect(retryDelay(7, DEFAULT_RETRY_SCHEDULE_MS, 0.5)).toBeNull();
  });

  test("jitter spreads each delay by ±20% (random 0 → -20%, 0.5 → the delay, ~1 → +20%)", () => {
    expect(retryDelay(1, DEFAULT_RETRY_SCHEDULE_MS, 0)).toBe(24_000);
    expect(retryDelay(1, DEFAULT_RETRY_SCHEDULE_MS, 0.5)).toBe(30_000);
    expect(retryDelay(1, DEFAULT_RETRY_SCHEDULE_MS, 0.999_999)).toBe(36_000);
    const many = Array.from({ length: 1000 }, (_, i) => retryDelay(0, DEFAULT_RETRY_SCHEDULE_MS, i / 1000)!);
    expect(Math.min(...many)).toBeGreaterThanOrEqual(4000);
    expect(Math.max(...many)).toBeLessThanOrEqual(6000);
  });

  test("Retry-After replaces the delay (at least 1 s, at most 24 h); a custom schedule ends when it ends", () => {
    expect(retryDelay(0, DEFAULT_RETRY_SCHEDULE_MS, 0.5, 0.2, 90_000)).toBe(90_000);
    expect(retryDelay(0, DEFAULT_RETRY_SCHEDULE_MS, 0.5, 0.2, 0)).toBe(1000);
    expect(retryDelay(0, DEFAULT_RETRY_SCHEDULE_MS, 0.5, 0.2, 10 * 24 * HOUR)).toBe(24 * HOUR);
    expect(retryDelay(6, DEFAULT_RETRY_SCHEDULE_MS, 0.5, 0.2, 1000)).toBe(1000);
    expect(retryDelay(7, DEFAULT_RETRY_SCHEDULE_MS, 0.5, 0.2, 1000)).toBeNull();
    expect([0, 1, 2].map((i) => retryDelay(i, [100, 200], 0.5, 0))).toEqual([100, 200, null]);
  });
});

describe("circuit breaker", () => {
  test("closed → open after `threshold` consecutive failures; a success resets the count", () => {
    let b = closedBreaker();
    for (let i = 1; i < 3; i++) {
      b = breakerOnFailure(b, 1000 * i, 3, 60_000);
      expect(b).toEqual({ state: "closed", failures: i });
    }
    expect(breakerOnSuccess(b)).toEqual({ state: "closed", failures: 0 });
    b = breakerOnFailure(b, 3000, 3, 60_000);
    expect(b).toEqual({ state: "open", failures: 3, openedAt: 3000, probeAt: 63_000 });
    // An attempt in flight when it opened fails too: counted, the probe stays when it was due.
    expect(breakerOnFailure(b, 5000, 3, 60_000)).toEqual({ state: "open", failures: 4, openedAt: 3000, probeAt: 63_000 });
  });

  test("open → half-open after the cooldown; the probe's failure reopens, its success closes", () => {
    const open = breakerOnFailure({ state: "closed", failures: 9 }, 0, 10, 1000);
    const half = breakerHalfOpen(open);
    expect(half).toMatchObject({ state: "halfOpen", failures: 10 });
    expect(breakerOnFailure(half, 5000, 10, 1000)).toEqual({ state: "open", failures: 11, openedAt: 0, probeAt: 6000 });
    expect(breakerOnSuccess(half)).toEqual({ state: "closed", failures: 0 });
    expect(breakerHalfOpen(closedBreaker())).toEqual(closedBreaker());
  });
});

test("event patterns", () => {
  expect(matchesEvent(["*"], "anything")).toBe(true);
  expect(matchesEvent(["invoice.*"], "invoice.paid")).toBe(true);
  expect(matchesEvent(["invoice.*"], "invoices.paid")).toBe(false);
  expect(matchesEvent(["invoice.*"], "invoice")).toBe(false);
  expect(matchesEvent(["invoice.paid", "user.created"], "user.created")).toBe(true);
  expect(matchesEvent([], "x")).toBe(false);
});
