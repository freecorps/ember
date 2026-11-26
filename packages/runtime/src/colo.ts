// Where a Durable Object runs (RUM, rum.ts): a small module of its own, so the Shard imports it without the RUM
// endpoint (which the Worker loads on first use).


/**
 * Where this Durable Object runs, for the RUM `country × colo` view: `EMBER_COLO` when set (tests), none in local
 * development, else the `colo=` line of Cloudflare's `/cdn-cgi/trace` fetched from inside the object (one request per
 * object lifetime, and only once a sampled client asked for it). Null when unknown.
 */
export async function probeColo(env: { EMBER_COLO?: unknown; EMBER_ENV?: unknown }, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (typeof env.EMBER_COLO === "string") return /^[A-Z]{3}$/.test(env.EMBER_COLO) ? env.EMBER_COLO : null;
  if (env.EMBER_ENV === "local") return null;
  try {
    const res = await fetchImpl("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const m = /^colo=([A-Z]{3})$/m.exec(await res.text());
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}
