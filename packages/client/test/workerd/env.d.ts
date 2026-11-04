declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import("@ember/runtime").Shard>;
  }
}
