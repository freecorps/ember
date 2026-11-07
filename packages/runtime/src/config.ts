import {
  createEngine as defaultCreateEngine,
  cronFunctionName,
  cronList,
  flattenFunctions,
  type AppDefinition,
  type CronsExport,
  type HttpRouter,
} from "@freecorps/ember-server";
import type { AuthCtx, CreateEngine, Identity, SchemaLike } from "./engine-types.ts";
import type { FilesConfig } from "./files.ts";

export type { CronDef } from "@freecorps/ember-server";

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
  /**
   * The shard kept the job under a lease: the consumer claims it (`claimActionJob`) before running and reports the
   * outcome (`settleActionJob`); the shard owns retries. Absent on messages from older runtimes (ack/retry as before).
   */
  lease?: true;
}

/** Minimal Queue producer surface (Cloudflare `Queue` satisfies it). */
export interface ActionQueue {
  send(body: ActionJobMessage): Promise<unknown>;
}

export interface EmberAuthVerifyOptions {
  /** Authoritative session check (Auth DO): set for `sensitive` mutations and actions. */
  sensitive?: boolean;
}

/** `emberAuth(...)` / `remoteAuth(...)` from `@freecorps/ember-auth/worker` satisfy this. */
export interface EmberAuthHook {
  /**
   * Verify a bearer token. Return the identity, or null for an invalid token.
   * Runs in the Worker (HTTP and WS upgrade) and in the Shard (`hello`/`auth`, sensitive mutations).
   */
  verify(token: string, opts?: EmberAuthVerifyOptions): Promise<Identity | null> | Identity | null;
  /** Serves the auth routes (`/api/auth/*`); null/undefined for other paths. Tried before the 404. */
  fetch?(request: Request, env: EmberEnv): Promise<Response | null | undefined> | Response | null | undefined;
  /**
   * Key rotation (`ember keys rotate --jwt`, admin `POST /api/_ember/keys/rotate`): retire the current JWT signing
   * key(s) and mint a new one; returns the new public JWKS (old keys stay published for their grace period).
   */
  rotateKeys?(env: EmberEnv): Promise<{ keys: Array<Record<string, unknown>> }>;
}

export interface EmberConfig {
  schema: SchemaLike;
  functions: unknown;
  /**
   * Mount point when the runtime is embedded in an existing Worker (contracts.md "Embutir o runtime"): `"/ember"`
   * serves `/ember/ws`, `/ember/api/query`, `/ember/api/storage/*` and so on, and file URLs carry the prefix. The
   * Worker's `fetch` answers 404 for paths outside it; `worker.handles(request)` tells the host which requests to hand
   * over. Default: none (the runtime owns the whole Worker, as `ember deploy` sets it up).
   */
  basePath?: string;
  /**
   * `ember/ember.config.ts` (`defineApp().use(component, ...)`): installed components (PLAN §12). The Worker composes
   * them with `schema`/`functions` (`composeApp`) before anything runs.
   */
  app?: AppDefinition<any>;
  /** `ember/http.ts` (`httpRouter()`): the app's HTTP routes; components add theirs under their prefix. */
  http?: HttpRouter;
  /** Set by `createEmberWorker`: the composed routes (app + components), with the scope each one runs in. */
  routes?: import("@freecorps/ember-server").ComposedApp["routes"];
  /** Set by `createEmberWorker`: component queues (consumed by the Worker) and `email()` hooks. */
  componentQueues?: import("@freecorps/ember-server").ComposedQueue[];
  emailHooks?: import("@freecorps/ember-server").ComposedEmailHook[];
  auth?: EmberAuthHook;
  /** Engine factory. Defaults to `createEngine` from `@freecorps/ember-server`. */
  createEngine?: CreateEngine;
  /** Rows backfilled per alarm turn for staged indexes (default 500). */
  backfillChunk?: number;
  /** The `crons.ts` default export: `cronJobs()` or `CronDef[]` (fn by reference or name). */
  crons?: CronsExport;
  groupCommit?: { maxBatch?: number; windowMs?: number };
  scheduler?: {
    maxAttempts?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    /**
     * How long an action job handed to the Queue may go unclaimed, or claimed and unfinished, before the shard runs it
     * itself in its alarm (default 5 minutes, at least 1 s; per action: `action({ leaseMs })`). Covers a Queue that accepts a
     * message and then stalls, and a consumer that dies mid-run.
     */
    actionLeaseMs?: number;
  };
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
  /** Files (PLAN §7): GC grace, URL lifetime, Images binding override. */
  files?: FilesConfig;
  /**
   * External indexes (Vectorize / AI Search, PLAN §6). `env` overlays the bindings the indexer and
   * `ctx.vectorSearch`/`ctx.aiSearch` use (EMBER_VEC__*, EMBER_AIS__*, EMBER_AI, EMBER_INDEXING,
   * EMBER_AI_INDEXES): fakes in tests, or proxies to remote resources in development.
   */
  externalIndexes?: { env?: (env: EmberEnv) => Record<string, unknown> };
  /** Override action-job dispatch (default: `env.EMBER_ACTIONS.send`). */
  dispatchAction?: (env: EmberEnv, msg: ActionJobMessage) => Promise<void>;
}

export interface EmberEnv {
  SHARD: DurableObjectNamespace;
  SYSTEM?: DurableObjectNamespace;
  EMBER_ACTIONS?: ActionQueue;
  /** Files bucket (R2). With EMBER_R2_* S3 credentials URLs are presigned; otherwise they go through the Worker. */
  EMBER_FILES?: R2Bucket;
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

/** The env external indexes see: the Worker's bindings plus `config.externalIndexes.env` (ai-indexes.ts). */
export function indexEnv(config: EmberConfig, env: EmberEnv): Record<string, unknown> {
  const extra = config.externalIndexes?.env?.(env);
  return extra ? { ...env, ...extra } : env;
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
