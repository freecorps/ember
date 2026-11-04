declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import("@freecorps/ember-runtime").Shard>;
  }
}
