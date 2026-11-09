declare namespace Cloudflare {
  interface Env {
    AUTH: DurableObjectNamespace;
    SQLBOX: DurableObjectNamespace;
    EMBER_AUTH_SECRET: string;
    EMBER_AUTH_URL: string;
    AUTH_TEST_BLOCKED: string;
  }
}
