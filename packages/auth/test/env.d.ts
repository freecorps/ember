declare namespace Cloudflare {
  interface Env {
    AUTH: DurableObjectNamespace;
    SQLBOX: DurableObjectNamespace;
    AUTH_LAZY: DurableObjectNamespace;
    AUTH_PW: DurableObjectNamespace;
    EMBER_AUTH_SECRET: string;
    EMBER_AUTH_URL: string;
    AUTH_TEST_BLOCKED: string;
  }
}
