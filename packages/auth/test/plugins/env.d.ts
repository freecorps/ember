/** Vite `?raw` imports (test fixtures). */
declare module "*?raw" {
  const text: string;
  export default text;
}

declare namespace Cloudflare {
  interface Env {
    AUTH: DurableObjectNamespace;
    SHARD: DurableObjectNamespace;
    SYSTEM: DurableObjectNamespace;
    EMBER_AUTH_SECRET: string;
    EMBER_AUTH_URL: string;
    STRIPE_WEBHOOK_SECRET: string;
    SCIM_TOKEN: string;
  }
}
