declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import("../src/shard.ts").Shard>;
    SYSTEM: DurableObjectNamespace<import("../src/system.ts").System>;
    OUTBOX: DurableObjectNamespace<import("./worker.ts").OutboxBoxInstance>;
    RUN_LONG: string;
    EMBER_ADMIN_TOKEN: string;
    EMBER_FILES: R2Bucket;
    EMBER_Q_HOOKS_EVENTS: Queue;
    EMBER_REGISTRY: D1Database;
  }
}
