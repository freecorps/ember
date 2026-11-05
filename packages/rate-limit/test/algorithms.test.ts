import { describe, expect, test } from "vitest";
import { check, consume, MINUTE, refill, SECOND, type RateLimitConfig, type RateLimitState } from "../src/algorithms.ts";

const T0 = 1_700_000_000_000;

/** Runs a sequence of calls, threading the stored state. */
function run(c: RateLimitConfig, calls: Array<{ at: number; count?: number; reserve?: boolean }>) {
  let s: RateLimitState | null = null;
  return calls.map(({ at, count, reserve }) => {
    const { result, state } = consume(c, s, at, count ?? 1, reserve ?? false);
    if (state) s = state;
    return result;
  });
}

describe("token bucket", () => {
  const c: RateLimitConfig = { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 };

  test("bursts up to capacity, then refuses with the time until the next token", () => {
    const r = run(c, [{ at: T0 }, { at: T0 }, { at: T0 }, { at: T0 }]);
    expect(r.map((x) => x.ok)).toEqual([true, true, true, false]);
    expect(r[3]!.retryAfter).toBe(6 * SECOND); // 10 per minute = one every 6 s
  });

  test("refills continuously at rate/period, never above capacity", () => {
    const r = run(c, [{ at: T0 }, { at: T0 }, { at: T0 }, { at: T0 + 3 * SECOND }, { at: T0 + 6 * SECOND }, { at: T0 + 6 * SECOND }]);
    expect(r.map((x) => x.ok)).toEqual([true, true, true, false, true, false]);
    expect(r[3]!.retryAfter).toBe(3 * SECOND);
    expect(refill(c, { value: 0, ts: T0 }, T0 + 10 * MINUTE).value).toBe(3);
  });

  test("a refused call costs nothing", () => {
    const s: RateLimitState = { value: 0.5, ts: T0 };
    const { result, state } = consume(c, s, T0);
    expect(result.ok).toBe(false);
    expect(state).toBeNull();
  });

  test("count takes several tokens; more than capacity is an error", () => {
    expect(run(c, [{ at: T0, count: 3 }, { at: T0, count: 1 }]).map((x) => x.ok)).toEqual([true, false]);
    expect(() => consume(c, null, T0, 4)).toThrow(/exceeds capacity/);
  });

  test("reserve goes negative and says when the reservation is valid; maxReserved caps it", () => {
    const r = run(c, [{ at: T0, count: 3 }, { at: T0, reserve: true }, { at: T0, reserve: true }]);
    expect(r).toEqual([{ ok: true }, { ok: true, retryAfter: 6 * SECOND }, { ok: true, retryAfter: 12 * SECOND }]);
    const capped: RateLimitConfig = { ...c, maxReserved: 1 };
    expect(run(capped, [{ at: T0, count: 3 }, { at: T0, reserve: true }, { at: T0, reserve: true }]).map((x) => x.ok)).toEqual([true, true, false]);
  });

  test("check does not consume", () => {
    const s: RateLimitState = { value: 1, ts: T0 };
    expect(check(c, s, T0)).toEqual({ ok: true });
    expect(check(c, s, T0, 2)).toEqual({ ok: false, retryAfter: 6 * SECOND });
  });

  test("invariant (fuzz): over any interval, tokens taken <= capacity + rate * elapsed / period", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const cfg: RateLimitConfig = { kind: "token bucket", rate: 5, period: 10 * SECOND, capacity: 4 };
    let s: RateLimitState | null = null;
    let t = T0;
    const taken: Array<{ at: number; n: number }> = [];
    for (let i = 0; i < 2000; i++) {
      t += Math.floor(rnd() * 1500);
      const n = 1 + Math.floor(rnd() * 2);
      const { result, state } = consume(cfg, s, t, n);
      if (state) s = state;
      if (result.ok) taken.push({ at: t, n });
    }
    expect(taken.length).toBeGreaterThan(100);
    for (let i = 0; i < taken.length; i += 7) {
      let sum = 0;
      for (let j = i; j < taken.length; j++) {
        sum += taken[j]!.n;
        const elapsed = taken[j]!.at - taken[i]!.at;
        expect(sum).toBeLessThanOrEqual(cfg.capacity! + (cfg.rate * elapsed) / cfg.period + 1e-9);
      }
    }
  });
});

describe("fixed window", () => {
  const c: RateLimitConfig = { kind: "fixed window", rate: 2, period: MINUTE };
  const start = Math.floor(T0 / MINUTE) * MINUTE;

  test("rate tokens per window aligned to the epoch; refused until the next window starts", () => {
    const r = run(c, [{ at: start + 10 }, { at: start + 20 }, { at: start + 30 * SECOND }, { at: start + MINUTE }, { at: start + MINUTE + 1 }, { at: start + MINUTE + 2 }]);
    expect(r.map((x) => x.ok)).toEqual([true, true, false, true, true, false]);
    expect(r[2]!.retryAfter).toBe(30 * SECOND);
    expect(r[5]!.retryAfter).toBe(MINUTE - 2);
  });

  test("unused tokens carry over only up to capacity", () => {
    const cap: RateLimitConfig = { kind: "fixed window", rate: 2, period: MINUTE, capacity: 5 };
    // First use 3 windows later: starts full (5); after 5, refused.
    const r = run(cap, Array.from({ length: 6 }, (_, i) => ({ at: start + i })));
    expect(r.map((x) => x.ok)).toEqual([true, true, true, true, true, false]);
    // Two empty windows add 4 tokens, capped at 5.
    expect(refill(cap, { value: 0, ts: start }, start + 2 * MINUTE + 5).value).toBe(4);
    expect(refill(cap, { value: 0, ts: start }, start + 9 * MINUTE).value).toBe(5);
  });

  test("custom start shifts the windows", () => {
    const shifted: RateLimitConfig = { kind: "fixed window", rate: 1, period: MINUTE, start: 15 * SECOND };
    const r = run(shifted, [{ at: start + 14 * SECOND }, { at: start + 14 * SECOND + 1 }, { at: start + 15 * SECOND }]);
    expect(r.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r[1]!.retryAfter).toBe(SECOND - 1);
  });

  test("invariant (fuzz): at most capacity tokens per window when capacity = rate", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const cfg: RateLimitConfig = { kind: "fixed window", rate: 3, period: 10 * SECOND };
    let s: RateLimitState | null = null;
    let t = start;
    const perWindow = new Map<number, number>();
    for (let i = 0; i < 3000; i++) {
      t += Math.floor(rnd() * 900);
      const { result, state } = consume(cfg, s, t);
      if (state) s = state;
      if (result.ok) perWindow.set(Math.floor(t / cfg.period), (perWindow.get(Math.floor(t / cfg.period)) ?? 0) + 1);
    }
    expect(Math.max(...perWindow.values())).toBe(3);
  });
});

test("config errors", () => {
  expect(() => consume({ kind: "token bucket", rate: 0, period: 1 }, null, T0)).toThrow(/rate/);
  expect(() => consume({ kind: "nope" } as any, null, T0)).toThrow(/kind/);
  expect(() => consume({ kind: "fixed window", rate: 1, period: -1 }, null, T0)).toThrow(/period/);
});

test("config errors: non-finite capacity / maxReserved / start are rejected", () => {
  expect(() => consume({ kind: "token bucket", rate: 1, period: 1, capacity: Infinity }, null, T0)).toThrow(/capacity/);
  expect(() => check({ kind: "token bucket", rate: 1, period: 1, maxReserved: Infinity }, null, T0)).toThrow(/maxReserved/);
  expect(() => consume({ kind: "token bucket", rate: 1, period: 1, maxReserved: NaN }, null, T0)).toThrow(/maxReserved/);
  expect(() => consume({ kind: "fixed window", rate: 1, period: 1, start: NaN }, null, T0)).toThrow(/start/);
  expect(() => refill({ kind: "fixed window", rate: 1, period: 1, start: Infinity }, null, T0)).not.toThrow(); // refill is the raw math
  expect(() => check({ kind: "fixed window", rate: 1, period: 1, start: Infinity }, null, T0)).toThrow(/start/);
});

test("check validates count like consume", () => {
  const c: RateLimitConfig = { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 };
  for (const count of [-5, NaN, Infinity, 4]) {
    expect(() => consume(c, null, T0, count)).toThrow(/count/);
    expect(() => check(c, null, T0, count)).toThrow(/count/);
  }
  expect(check(c, null, T0, 3)).toEqual({ ok: true });
  expect(check(c, null, T0, 0)).toEqual({ ok: true });
});
