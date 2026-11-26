declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import("@freecorps/ember-runtime").Shard>;
    EMBER_FILES: R2Bucket;
    EMBER_ADMIN_TOKEN: string;
    EXPO_UPDATES_PRIVATE_KEY: string;
    /** SPKI PEM of the signing key, to verify signatures in the test. */
    EXPO_TEST_PUBLIC_KEY: string;
  }
}
