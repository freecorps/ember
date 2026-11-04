import { createEngine as defaultCreateEngine, cronFunctionName, cronList, flattenFunctions, type CronsExport } from "@ember/server";
import type { AuthCtx, CreateEngine, Identity, SchemaLike } from "./engine-types.ts";

export type { CronDef } from "@ember/server";

/** A cron with its function resolved to a name and kind (what the System DO dispatches). */
export interface ResolvedCron {
  name: string;
  schedule: string;
  tz?: string;
  shard: string;
  fn: string;
  args?: unknown;
  kind: "mutation" | "action";
}

export interface ActionJobMessage {
  shard: string;
  /** The job's id (what `scheduler.runAfter/runAt` returned). */
  jobId: string;
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
  /** The `crons.ts` default export: `cronJobs()` or `CronDef[]` (fn by reference or name). */
  crons?: CronsExport;
  groupCommit?: { maxBatch?: number; windowMs?: number };
  scheduler?: { maxAttempts?: number; backoffBaseMs?: number; backoffMaxMs?: number };
  reactivity?: {
    /**
     * Max staleness of a search subscription's order (bm25 depends on the whole table): a write to a searched table
     * that cannot change the result set re-runs it after this delay (default 2000; 0 = immediately). Writes that
     * can change the set (a result row, or text containing a query term) re-run it at once.
     */
    searchDebounceMs?: number;
  };
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

const resolved = new WeakMap<EmberConfig, ResolvedCron[]>();

/** `config.crons` as a list, each fn resolved to its name and kind (mutation unless the function is an action). */
export function resolvedCrons(config: EmberConfig): ResolvedCron[] {
  let r = resolved.get(config);
  if (!r) {
    const fns = flattenFunctions(config.functions);
    r = cronList(config.crons).map((c) => {
      const fn = cronFunctionName(c);
      const kind = c.kind ?? (fns.get(fn)?.type === "action" ? "action" : "mutation");
      return { name: c.name, schedule: c.schedule, shard: c.shard, fn, kind, ...(c.tz ? { tz: c.tz } : {}), ...(c.args !== undefined ? { args: c.args } : {}) };
    });
    resolved.set(config, r);
  }
  return r;
}

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
