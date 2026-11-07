import { resolveLocationHint } from "@freecorps/ember-server";
import { getEmberConfig, type EmberEnv } from "./config.ts";
import type { SchemaManifest } from "./engine-types.ts";
import type { Shard } from "./shard.ts";
import type { System } from "./system.ts";

/**
 * Location hint for a shard's Durable Object (PLAN §5), first that gives one: the Worker's `locationHint(shard)`
 * (`createEmberWorker`), then `defineShard(..., { locationHint })` of the shard's kind in the schema manifest (a hint,
 * or one read from the key: `{ fromKey: true }`), then the Worker's `EMBER_LOCATION_HINT` (ember.json
 * `locationHint`). Only used when the object is first created (Cloudflare ignores hints for existing objects).
 */
export function locationHintFor(manifest: Pick<SchemaManifest, "shards">, env: EmberEnv, shard: string): string | undefined {
  const byCode = workerHint(shard);
  if (byCode) return byCode;
  const colon = shard.indexOf(":");
  const kind = shard.slice(0, colon);
  const shards = manifest.shards as unknown;
  const own =
    shards && typeof shards === "object" && !Array.isArray(shards)
      ? (shards as Record<string, { locationHint?: unknown } | undefined>)[kind]?.locationHint
      : undefined;
  const resolved = resolveLocationHint(own, shard.slice(colon + 1));
  if (resolved) return resolved;
  const fallback = env.EMBER_LOCATION_HINT;
  return typeof fallback === "string" && fallback ? fallback : undefined;
}

/** The Worker's own rule (`EmberConfig.locationHint`), when a config is registered and has one. */
function workerHint(shard: string): string | undefined {
  let rule: ((shard: string) => string | undefined) | undefined;
  try {
    rule = getEmberConfig().locationHint;
  } catch {
    return undefined; // no createEmberWorker in this isolate (a bare stub in tests or tools)
  }
  const hint = rule?.(shard);
  return typeof hint === "string" && hint ? hint : undefined;
}

export function shardStub(env: EmberEnv, manifest: Pick<SchemaManifest, "shards">, shard: string): DurableObjectStub<Shard> {
  const hint = locationHintFor(manifest, env, shard);
  const id = env.SHARD.idFromName(shard);
  const stub = hint ? env.SHARD.get(id, { locationHint: hint as DurableObjectLocationHint }) : env.SHARD.get(id);
  return stub as unknown as DurableObjectStub<Shard>;
}

/** The singleton System DO (crons, restore journal), or null when the Worker has no SYSTEM binding. */
export function systemStub(env: EmberEnv): DurableObjectStub<System> | null {
  const ns = env.SYSTEM;
  return ns ? (ns.get(ns.idFromName("system")) as unknown as DurableObjectStub<System>) : null;
}
