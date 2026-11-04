import type { AuthShard } from "./auth-shard";
import type { PasswordHasher } from "./index";

export interface Env {
  AUTH_SHARD: DurableObjectNamespace<AuthShard>;
  HASHER: Service<PasswordHasher>;
  /** "1" = Worker passes an EdgeHasher RpcTarget; the DO calls back for scrypt */
  HASH_OFFLOAD?: string;
}

declare global {
  namespace Cloudflare {
    interface Env extends EnvForTests {}
  }
}
type EnvForTests = Env;
