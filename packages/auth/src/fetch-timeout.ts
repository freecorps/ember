/**
 * A bound on the outbound `fetch` Better Auth and its plugins make inside the `Auth` Durable Object (contracts.md
 * "`fetch` de saída no DO `Auth`"). Better Auth has no fetch option of its own: core, plugins (`betterFetch`) and jose
 * all call the global `fetch` at call time. So the global is wrapped once, and the wrapper only acts inside
 * `withFetchTimeout` (an `AsyncLocalStorage` scope the DO opens around Better Auth's init and every call into it):
 * anything else in the isolate (the Worker, other Durable Objects of the script, an action's own `fetch`) goes to the
 * original untouched. Inside, every request gets `AbortSignal.timeout(ms)`, combined with its own signal (whichever
 * fires first: jose's 5 s JWKS timeout and genericOAuth's 10 s discovery retry still apply when shorter, and the Stripe
 * SDK's `timeout`, 80 s by default, is capped at `ms` when its client uses the global fetch), and fails with a
 * `TimeoutError` naming the URL once the time is up, even when the underlying `fetch` ignores the signal.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One per isolate, not per copy of this module: two copies (dist and source, a bundle that inlines it twice) share the
 * scope, and the wrapper is marked with the same key, so either copy sees it installed and bounds its calls through it.
 */
const STATE = Symbol.for("@freecorps/ember-auth/fetch-timeout");
type State = { scope: AsyncLocalStorage<number> };
const state: State = ((globalThis as { [STATE]?: State })[STATE] ??= { scope: new AsyncLocalStorage<number>() });
const scope = state.scope;
const isWrapper = (f: unknown) => typeof f === "function" && (f as { [STATE]?: true })[STATE] === true;

function timeoutError(input: RequestInfo | URL, ms: number): Error {
  let where = "a request";
  try {
    const u = new URL(input instanceof Request ? input.url : String(input));
    // No query string: it may hold a code or a secret.
    where = u.origin + u.pathname;
  } catch {}
  return new DOMException(`auth: ${where} did not answer within ${ms} ms (ember.fetchTimeoutMs)`, "TimeoutError");
}

/**
 * Wraps the global `fetch`, unless it already is the wrapper. `defineAuth`'s module calls it when imported, so a client
 * that captures `globalThis.fetch` when it is built (the Stripe SDK's `createFetchHttpClient()` without an argument) at
 * the top of auth.config.ts gets the wrapper; `withFetchTimeout` calls it again, so a `fetch` replaced since then
 * (instrumentation, a test's fake) is wrapped too. Outside `withFetchTimeout` the wrapper is the `fetch` it wraps.
 */
export function installFetchTimeout(): void {
  if (isWrapper(globalThis.fetch)) return;
  const inner = globalThis.fetch;
  const bounded = function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const ms = scope.getStore();
    if (!ms) return inner.call(globalThis, input, init);
    const timer = AbortSignal.timeout(ms);
    // A caller's own signal still works (its abort or shorter timeout comes first); ours is the ceiling. Presence of a
    // signal says nothing about a bound: better-fetch, which core and most plugins use, always passes its own.
    // `AbortSignal.any` adds no listener to the caller's signal (it keeps the body read bound to both); the one listener
    // this wrapper adds is on the combined signal of this call, removed once the fetch settles.
    const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = own ? AbortSignal.any([own, timer]) : timer;
    // Whichever aborts first, even when the underlying fetch ignores the signal: ours as a TimeoutError naming the URL,
    // the caller's with its own reason.
    const reason = () => (timer.aborted ? timeoutError(input, ms) : signal.reason);
    if (signal.aborted) return Promise.reject(reason());
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(reason());
      signal.addEventListener("abort", onAbort, { once: true });
      // A wrapper further down (a `fetch` replaced over an earlier one, delegating to it) passes through: one bound.
      scope.run(0, () => inner.call(globalThis, input, { ...init, signal })).then(
        (res) => (signal.removeEventListener("abort", onAbort), resolve(res)),
        (err: unknown) => (signal.removeEventListener("abort", onAbort), reject(timer.aborted ? timeoutError(input, ms) : err)),
      );
    });
  };
  Object.defineProperty(bounded, STATE, { value: true });
  globalThis.fetch = bounded as typeof fetch;
}

/** Runs `fn` (and everything it starts) with outbound fetch bounded to `ms`; `ms <= 0` runs it unbounded. */
export function withFetchTimeout<T>(ms: number, fn: () => T): T {
  if (!(ms > 0)) return fn();
  installFetchTimeout();
  return scope.run(ms, fn);
}
