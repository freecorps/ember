/**
 * A client that captures `globalThis.fetch` when it is built (the Stripe SDK's `createFetchHttpClient()` without an
 * argument), at the top of auth.config.ts: it gets the bounded fetch, because importing `defineAuth` installs it.
 */
import { expect, it } from "vitest";
import Stripe from "stripe";

it("a Stripe fetch client built in auth.config.ts, after importing defineAuth, is bounded by ember.fetchTimeoutMs", async () => {
  const real = globalThis.fetch;
  // The network: never answers, ignores the signal.
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  try {
    // What auth.config.ts does: import defineAuth, then build its clients at module level.
    await import("../../src/index.ts");
    const http = Stripe.createFetchHttpClient();
    const { withFetchTimeout } = await import("../../src/fetch-timeout.ts");
    const t0 = Date.now();
    const err = (await withFetchTimeout(50, () => http.makeRequest("api.stripe.com", "443", "/v1/customers", "POST", {}, "email=a%40b.c", "https", 80_000)).catch(
      (e: unknown) => e,
    )) as Error;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(String(err)).toMatch(/TimeoutError|timed? ?out/i);
  } finally {
    globalThis.fetch = real;
  }
});
