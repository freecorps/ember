/** `fetch-timeout.ts`: the bound on outbound `fetch` inside `withFetchTimeout`, its error, and a single install per isolate. */
import { getEventListeners } from "node:events";
import { afterAll, describe, expect, it, vi } from "vitest";

type Impl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const real = globalThis.fetch;
/** The "network" under the wrapper: each test sets `impl`. */
let impl: Impl = () => Promise.reject(new Error("no impl"));
const network = ((input: RequestInfo | URL, init?: RequestInit) => impl(input, init)) as typeof fetch;
globalThis.fetch = network;
afterAll(() => {
  globalThis.fetch = real;
});

/** A server that answers after `ms` (never when null) and, like a real fetch, rejects once its signal aborts. */
const answering =
  (ms: number | null): Impl =>
  (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      const t = ms === null ? undefined : setTimeout(() => resolve(new Response("ok")), ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
    });
/** A server that ignores the signal and never answers. */
const deaf: Impl = () => new Promise<Response>(() => {});

const load = async () => {
  vi.resetModules();
  return (await import("../../src/fetch-timeout.ts")) as typeof import("../../src/fetch-timeout.ts");
};

describe("withFetchTimeout", () => {
  it("past the bound the fetch fails with a TimeoutError naming the URL without its query, even if fetch ignores the signal", async () => {
    const { withFetchTimeout } = await load();
    impl = deaf;
    const err = await withFetchTimeout(50, () => fetch("https://idp.example/token?code=secret-code")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("TimeoutError");
    expect((err as DOMException).message).toBe("auth: https://idp.example/token did not answer within 50 ms (ember.fetchTimeoutMs)");
    expect((err as DOMException).message).not.toContain("secret-code");
  });

  it("outside the scope, and with 0, fetch is the original one, untouched", async () => {
    const { withFetchTimeout } = await load();
    await withFetchTimeout(1_000, async () => {});
    let seen: RequestInit | undefined;
    impl = async (_i, init) => ((seen = init), new Response("ok"));
    const init = { headers: { a: "b" } };
    expect((await fetch("https://x.example/", init)).status).toBe(200);
    expect(seen).toBe(init);
    await withFetchTimeout(0, () => fetch("https://x.example/", init));
    expect(seen).toBe(init);
  });

  it("a caller's own signal: its abort is the caller's AbortError, not a timeout, and no listener is left on it after settle", async () => {
    const { withFetchTimeout } = await load();
    const caller = new AbortController();
    const before = getEventListeners(caller.signal, "abort").length;
    impl = answering(1);
    for (let i = 0; i < 20; i++) {
      const r = await withFetchTimeout(1_000, () => fetch("https://idp.example/jwks", { signal: caller.signal }));
      expect(r.status).toBe(200);
    }
    // Nothing of the 20 settled fetches stays on the caller's long-lived signal.
    expect(getEventListeners(caller.signal, "abort").length).toBe(before);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Aborting it now (after every fetch settled) surfaces nothing, as a timeout or otherwise.
      caller.abort();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // Aborted while in flight: the caller's own reason.
    impl = answering(null);
    const inFlight = new AbortController();
    const p = withFetchTimeout(1_000, () => fetch("https://idp.example/jwks", { signal: inFlight.signal })).catch((e: unknown) => e);
    inFlight.abort();
    const err = (await p) as DOMException;
    expect(err.name).toBe("AbortError");
  });

  it("a caller's abort wins even over a fetch that ignores its signal, at once, with the caller's reason", async () => {
    const { withFetchTimeout } = await load();
    impl = deaf;
    const caller = new AbortController();
    const t0 = Date.now();
    const p = withFetchTimeout(2_000, () => fetch("https://idp.example/token", { signal: caller.signal })).catch((e: unknown) => e);
    setTimeout(() => caller.abort(new Error("caller gave up")), 10);
    const err = (await p) as Error;
    expect(err.message).toBe("caller gave up");
    expect(Date.now() - t0).toBeLessThan(1_000);
    // Already aborted: rejected before anything is sent.
    let sent = 0;
    impl = (...a) => (sent++, deaf(...a));
    const gone = AbortSignal.abort(new Error("already gone"));
    expect(((await withFetchTimeout(2_000, () => fetch("https://idp.example/token", { signal: gone })).catch((e: unknown) => e)) as Error).message).toBe("already gone");
    expect(sent).toBe(0);
  });

  it("a caller's shorter timeout comes first; ours caps a longer one", async () => {
    const { withFetchTimeout } = await load();
    impl = answering(null);
    const own = (await withFetchTimeout(1_000, () => fetch("https://x.example/a", { signal: AbortSignal.timeout(20) })).catch((e: unknown) => e)) as DOMException;
    expect(own.name).toBe("TimeoutError");
    expect(own.message).not.toContain("ember.fetchTimeoutMs");
    const ours = (await withFetchTimeout(20, () => fetch("https://x.example/b", { signal: AbortSignal.timeout(5_000) })).catch((e: unknown) => e)) as DOMException;
    expect(ours.message).toContain("https://x.example/b did not answer within 20 ms");
  });

  it("a fetch replaced after the install (instrumentation, a test fake) is wrapped again by the next scope, bounded once", async () => {
    const { withFetchTimeout } = await load();
    await withFetchTimeout(1_000, async () => {});
    const first = globalThis.fetch;
    let timers = 0;
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => (timers++, timeout(ms)));
    // Something replaces fetch, delegating hosts it does not fake to the one it found (the wrapper).
    const replaced = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://faked.example") ? deaf(input, init) : first(input, init)) as typeof fetch;
    globalThis.fetch = replaced;
    try {
      impl = deaf;
      const faked = (await withFetchTimeout(30, () => fetch("https://faked.example/x")).catch((e: unknown) => e)) as DOMException;
      expect(faked.message).toContain("https://faked.example/x did not answer within 30 ms");
      expect(globalThis.fetch).not.toBe(replaced);
      timers = 0;
      const through = (await withFetchTimeout(30, () => fetch("https://real.example/y")).catch((e: unknown) => e)) as DOMException;
      expect(through.message).toContain("https://real.example/y did not answer within 30 ms");
      // The wrapper under the replacement passed through: one timer per fetch, not one per wrapper.
      expect(timers).toBe(1);
    } finally {
      spy.mockRestore();
      globalThis.fetch = first;
    }
  });

  it("two copies of the module in one isolate wrap fetch once, and both bound their scope", async () => {
    const a = await load();
    await a.withFetchTimeout(1_000, async () => {});
    const wrapped = globalThis.fetch;
    expect(wrapped).not.toBe(network);
    const b = await load();
    expect(b).not.toBe(a);
    await b.withFetchTimeout(1_000, async () => {});
    expect(globalThis.fetch).toBe(wrapped);
    impl = deaf;
    const err = (await b.withFetchTimeout(30, () => fetch("https://idp.example/b")).catch((e: unknown) => e)) as DOMException;
    expect(err.message).toContain("https://idp.example/b did not answer within 30 ms");
    const errA = (await a.withFetchTimeout(30, () => fetch("https://idp.example/a")).catch((e: unknown) => e)) as DOMException;
    expect(errA.message).toContain("https://idp.example/a did not answer within 30 ms");
  });
});
