import type { EmberEnv } from "./config.ts";
import type { SchemaManifest } from "./engine-types.ts";
import type { Shard } from "./shard.ts";

/**
 * Location hint for a shard's Durable Object (PLAN §5): `defineShard(..., { locationHint })` of the shard's kind in
 * the schema manifest, else the Worker's `EMBER_LOCATION_HINT` (ember.json `locationHint`), else none. Only used
 * when the object is first created (Cloudflare ignores hints for existing objects).
 */
export function locationHintFor(manifest: Pick<SchemaManifest, "shards">, env: EmberEnv, shard: string): string | undefined {
  const kind = shard.slice(0, shard.indexOf(":"));
  const shards = manifest.shards as unknown;
  const own =
    shards && typeof shards === "object" && !Array.isArray(shards)
      ? (shards as Record<string, { locationHint?: unknown } | undefined>)[kind]?.locationHint
      : undefined;
  if (typeof own === "string" && own) return own;
  const fallback = env.EMBER_LOCATION_HINT;
  return typeof fallback === "string" && fallback ? fallback : undefined;
}

export function shardStub(env: EmberEnv, manifest: Pick<SchemaManifest, "shards">, shard: string): DurableObjectStub<Shard> {
  const hint = locationHintFor(manifest, env, shard);
  const id = env.SHARD.idFromName(shard);
  const stub = hint ? env.SHARD.get(id, { locationHint: hint as DurableObjectLocationHint }) : env.SHARD.get(id);
  return stub as unknown as DurableObjectStub<Shard>;
}
