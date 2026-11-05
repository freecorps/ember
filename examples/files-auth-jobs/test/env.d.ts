declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import("@freecorps/ember-runtime").Shard>;
    SYSTEM: DurableObjectNamespace<import("@freecorps/ember-runtime").System>;
    AUTH: DurableObjectNamespace;
    EMBER_FILES: R2Bucket;
  }
}
