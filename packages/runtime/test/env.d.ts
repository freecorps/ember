declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import("../src/shard.ts").Shard>;
    SYSTEM: DurableObjectNamespace<import("../src/system.ts").System>;
    RUN_LONG: string;
    EMBER_ADMIN_TOKEN: string;
  }
}
