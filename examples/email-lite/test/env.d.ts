declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace;
    SYSTEM: DurableObjectNamespace;
    EMBER_FILES: R2Bucket;
    EMBER_Q_EMAIL_EVENTS: Queue;
  }
}
