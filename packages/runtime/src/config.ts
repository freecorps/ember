import { createEngine as defaultCreateEngine } from "@ember/server";
import type { AuthCtx, CreateEngine, Identity, SchemaLike } from "./engine-types.ts";

export interface CronDef {
  /** Unique, stable name (used for locking and dedup). */
  name: string;
  /** 5-field cron expression or macro (@daily, ...). */
  schedule: string;
  /** IANA time zone, default UTC. */
  tz?: string;
  /** Target shard `<kind>:<key>`. */
  shard: string;
  fn: string;
  args?: unknown;
  kind?: "mutation" | "action";
}

export interface ActionJobMessage {
  shard: string;
  jobId: number;
  fn: string;
  args: unknown;
  attempt: number;
}

/** Minimal Queue producer surface (Cloudflare `Queue` satisfies it). */
export interface ActionQueue {
  send(body: ActionJobMessage): Promise<unknown>;
}

export interface EmberAuthHook {
  /**
   * Verify a bearer token. Return the identity, or null for an invalid token.
   * Runs in the Worker (HTTP and WS upgrade) and in the Shard (`hello`/`auth`).
   */
  verify(token: string): Promise<Identity | null> | Identity | null;
}

export interface EmberConfig {
  schema: SchemaLike;
  functions: unknown;
  auth?: EmberAuthHook;
  /** Engine factory. Defaults to `createEngine` from `@ember/server`. */
  createEngine?: CreateEngine;
  /** Rows backfilled per alarm turn for staged indexes (default 500). */
  backfillChunk?: number;
  crons?: CronDef[];
  groupCommit?: { maxBatch?: number; windowMs?: number };
  scheduler?: { maxAttempts?: number; backoffBaseMs?: number; backoffMaxMs?: number };
  /** Number of committed versions kept for `resume`. */
  changeLogVersions?: number;
  /** Override action-job dispatch (default: `env.EMBER_ACTIONS.send`). */
  dispatchAction?: (env: EmberEnv, msg: ActionJobMessage) => Promise<void>;
}

export interface EmberEnv {
  SHARD: DurableObjectNamespace;
  SYSTEM?: DurableObjectNamespace;
  EMBER_ACTIONS?: ActionQueue;
  [k: string]: unknown;
}

let current: EmberConfig | null = null;

export function setEmberConfig(c: EmberConfig): void {
  current = c;
}

export const DEFAULT_CREATE_ENGINE: CreateEngine = defaultCreateEngine;

export function getEmberConfig(): EmberConfig {
  if (!current) throw new Error("Ember: createEmberWorker(...) must be called in the Worker entry module before Shard/System run");
  return current;
}

export const ANON: AuthCtx = { identity: null };

export function identityKey(identity: Identity | null): string {
  if (!identity) return "anon";
  return identity.issuer ? `${identity.issuer}|${identity.subject}` : identity.subject;
}

const SHARD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}:[^\s]{1,190}$/;

export function isValidShardName(name: string): boolean {
  return SHARD_RE.test(name);
}
