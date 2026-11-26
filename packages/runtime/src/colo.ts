// Where a Durable Object runs (RUM, rum.ts): a small module of its own, so the Shard imports it without the RUM
// endpoint (which the Worker loads on first use).

type ColoEnv = { EMBER_COLO?: unknown; EMBER_ENV?: unknown };

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/** The colo the environment settles without a probe: `EMBER_COLO` (tests), none locally; undefined → probe. */
function fixedColo(env: ColoEnv): string | null | undefined {
  if (typeof env.EMBER_COLO === "string") return /^[A-Z]{3}$/.test(env.EMBER_COLO) ? env.EMBER_COLO : null;
  if (env.EMBER_ENV === "local") return null;
  return undefined;
}

/** The `colo=` line of Cloudflare's trace, or null when it could not be read (a failure: worth another try). */
async function traceColo(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(TRACE_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const m = /^colo=([A-Z]{3})$/m.exec(await res.text());
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Where this Durable Object runs, for the RUM `country × colo` view: `EMBER_COLO` when set (tests), none in local
 * development, else the `colo=` line of Cloudflare's `/cdn-cgi/trace` fetched from inside the object. Null when unknown.
 */
export async function probeColo(env: ColoEnv, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const fixed = fixedColo(env);
  return fixed !== undefined ? fixed : traceColo(fetchImpl);
}

/** First wait after a failed probe; it doubles per failure, up to COLO_RETRY_MAX_MS. */
export const COLO_RETRY_MS = 30_000;
export const COLO_RETRY_MAX_MS = 30 * 60_000;

/**
 * One object's colo, in memory only: settled by the environment at once, else probed when a RUM socket asks (one
 * probe at a time). A failed probe is not kept: the next ask after a backoff (30 s, doubling up to 30 min) tries again.
 */
export class ColoCache {
  private value: string | null | undefined;
  private inflight: Promise<void> | null = null;
  private failures = 0;
  private retryAt = 0;

  constructor(
    private readonly env: ColoEnv,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  /** The colo when known (else null); an unknown one starts a probe, and `onFound` gets it when that one finds it. */
  get(onFound: (colo: string) => void): string | null {
    if (this.value !== undefined) return this.value;
    const fixed = fixedColo(this.env);
    if (fixed !== undefined) return (this.value = fixed);
    if (this.inflight || this.now() < this.retryAt) return null;
    this.inflight = traceColo(this.fetchImpl)
      .catch(() => null)
      .then((c) => {
        this.inflight = null;
        if (c) {
          this.value = c;
          onFound(c);
          return;
        }
        this.failures++;
        this.retryAt = this.now() + Math.min(COLO_RETRY_MAX_MS, COLO_RETRY_MS * 2 ** (this.failures - 1));
      })
      .catch(() => undefined);
    return null;
  }

  /** The probe in flight (tests). */
  settled(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }
}
