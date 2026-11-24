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

  it("a caller's shorter timeout comes first; ours caps a longer one", async () => {
    const { withFetchTimeout } = await load();
    impl = answering(null);
    const own = (await withFetchTimeout(1_000, () => fetch("https://x.example/a", { signal: AbortSignal.timeout(20) })).catch((e: unknown) => e)) as DOMException;
    expect(own.name).toBe("TimeoutError");
    expect(own.message).not.toContain("ember.fetchTimeoutMs");
    const ours = (await withFetchTimeout(20, () => fetch("https://x.example/b", { signal: AbortSignal.timeout(5_000) })).catch((e: unknown) => e)) as DOMException;
    expect(ours.message).toContain("https://x.example/b did not answer within 20 ms");
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
