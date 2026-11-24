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
 * scope and the single wrapper, so fetch is never wrapped twice and either copy's `withFetchTimeout` bounds its calls.
 */
const STATE = Symbol.for("@freecorps/ember-auth/fetch-timeout");
type State = { scope: AsyncLocalStorage<number>; installed: boolean };
const state: State = ((globalThis as { [STATE]?: State })[STATE] ??= { scope: new AsyncLocalStorage<number>(), installed: false });
const scope = state.scope;

function timeoutError(input: RequestInfo | URL, ms: number): Error {
  let where = "a request";
  try {
    const u = new URL(input instanceof Request ? input.url : String(input));
    // No query string: it may hold a code or a secret.
    where = u.origin + u.pathname;
  } catch {}
  return new DOMException(`auth: ${where} did not answer within ${ms} ms (ember.fetchTimeoutMs)`, "TimeoutError");
}

function install(): void {
  if (state.installed) return;
  state.installed = true;
  const inner = globalThis.fetch;
  const bounded = function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const ms = scope.getStore();
    if (!ms) return inner.call(globalThis, input, init);
    const timer = AbortSignal.timeout(ms);
    // A caller's own signal still works (its abort or shorter timeout comes first); ours is the ceiling. Presence of a
    // signal says nothing about a bound: better-fetch, which core and most plugins use, always passes its own.
    // `AbortSignal.any` adds no listener to the caller's signal (it keeps the body read bound to both); the only one this
    // wrapper adds is on `timer`, removed once the fetch settles.
    const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = own ? AbortSignal.any([own, timer]) : timer;
    return new Promise<Response>((resolve, reject) => {
      const onTimeout = () => reject(timeoutError(input, ms));
      timer.addEventListener("abort", onTimeout, { once: true });
      inner.call(globalThis, input, { ...init, signal }).then(
        (res) => (timer.removeEventListener("abort", onTimeout), resolve(res)),
        (err: unknown) => (timer.removeEventListener("abort", onTimeout), reject(timer.aborted ? timeoutError(input, ms) : err)),
      );
    });
  };
  globalThis.fetch = bounded as typeof fetch;
}

/** Runs `fn` (and everything it starts) with outbound fetch bounded to `ms`; `ms <= 0` runs it unbounded. */
export function withFetchTimeout<T>(ms: number, fn: () => T): T {
  if (!(ms > 0)) return fn();
  install();
  return scope.run(ms, fn);
}
