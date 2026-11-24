/**
 * `createSessionCheck` (remote-session.ts): one deadline per lookup for the request and its answer together, and a
 * bounded answer cache that evicts in O(1).
 */
import { describe, expect, it, vi } from "vitest";
import { createSessionCheck, MAX_CACHED_SESSIONS } from "../../src/remote-session.ts";

const claims = (sid: string, exp = Math.floor(Date.now() / 1000) + 300) => ({ sub: "u1", sid, exp });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("session lookup: deadline and cache", () => {
  it("one deadline covers the request and the answer's body (a slow body after a slow response fails closed)", async () => {
    const lines: string[] = [];
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      await sleep(60);
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          await sleep(60);
          c.enqueue(new TextEncoder().encode(JSON.stringify({ active: true })));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const s = createSessionCheck({ url: "https://origin.test/s", secret: "k", timeoutMs: 100 }, { fetch, env: () => ({}), log: (l) => void lines.push(l) });
    const t0 = Date.now();
    expect(await s.check(claims("s1"))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(115 + 50);
    expect(signal?.aborted).toBe(true);
    expect(lines.at(-1)).toMatch(/session lookup \(https:\/\/origin\.test\/s\) failed: .*; sensitive call denied/);
    // Within the deadline: answered.
    const quick = vi.fn(async () => Response.json({ active: true })) as unknown as typeof globalThis.fetch;
    expect(await createSessionCheck({ url: "https://origin.test/s", secret: "k", timeoutMs: 100 }, { fetch: quick, env: () => ({}) }).check(claims("s1"))).toBe(true);
    // A fractional timeout works (`AbortSignal.timeout` refuses one in Node).
    expect(await createSessionCheck({ url: "https://origin.test/s", secret: "k", timeoutMs: 100.5 }, { fetch: quick, env: () => ({}) }).check(claims("s1"))).toBe(true);
  });

  it("a quick answer leaves no deadline timer pending (a cleared timer, not an uncancellable AbortSignal.timeout)", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const quick = vi.fn(async () => Response.json({ active: true })) as unknown as typeof globalThis.fetch;
      const s = createSessionCheck({ url: "https://origin.test/s", secret: "k", timeoutMs: 2000 }, { fetch: quick, env: () => ({}) });
      expect(await s.check(claims("s1"))).toBe(true);
      expect(await createSessionCheck({ check: () => ({ active: true }), timeoutMs: 2000 }, { fetch: quick, env: () => ({}) }).check(claims("s2"))).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a fetch that ignores the signal still fails at the deadline; a custom check too", async () => {
    const hang = (() => new Promise<Response>(() => undefined)) as unknown as typeof globalThis.fetch;
    const t0 = Date.now();
    expect(await createSessionCheck({ url: "https://origin.test/s", secret: "k", timeoutMs: 40 }, { fetch: hang, env: () => ({}), log: () => {} }).check(claims("s1"))).toBe(false);
    expect(await createSessionCheck({ check: () => new Promise<never>(() => undefined), timeoutMs: 40 }, { fetch: hang, env: () => ({}), log: () => {} }).check(claims("s2"))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("the cache stays bounded, evicting the oldest entry per insert; expired entries go when read", async () => {
    let t = 1_000_000;
    const answers = new Map<string, boolean>();
    const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const { sid } = JSON.parse(String(init?.body)) as { sid: string };
      return Response.json({ active: answers.get(sid) ?? false });
    }) as unknown as typeof globalThis.fetch;
    const s = createSessionCheck({ url: "https://origin.test/s", secret: "k", cacheMs: 60_000 }, { fetch, env: () => ({}), now: () => t });
    const exp = Math.floor(t / 1000) + 3600;
    const n = MAX_CACHED_SESSIONS + 50;
    const started = performance.now();
    for (let i = 0; i < n; i++) await s.check({ sub: "u1", sid: `s${i}`, exp });
    // O(1) per insert: no scan of the full cache on each one past the bound.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(fetch).toHaveBeenCalledTimes(n);
    // The newest are cached (no new lookup), the 50 oldest were evicted (looked up again).
    await s.check({ sub: "u1", sid: `s${n - 1}`, exp });
    expect(fetch).toHaveBeenCalledTimes(n);
    await s.check({ sub: "u1", sid: "s0", exp });
    expect(fetch).toHaveBeenCalledTimes(n + 1);
    expect(s.stats().cacheHits).toBe(1);
    // Past its expiry an entry is asked again.
    answers.set("live", true);
    expect(await s.check({ sub: "u1", sid: "live", exp })).toBe(true);
    t += 61_000;
    expect(await s.check({ sub: "u1", sid: "live", exp })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(n + 3);
  });
});
