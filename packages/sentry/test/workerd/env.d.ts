declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import("@freecorps/ember-runtime").Shard>;
    EMBER_FILES: R2Bucket;
    EMBER_SENTRY_SENTRY_AE: AnalyticsEngineDataset;
  }
}
