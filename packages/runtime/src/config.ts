import {
  createEngine as defaultCreateEngine,
  cronFunctionName,
  cronList,
  flattenFunctions,
  type AppDefinition,
  type CronsExport,
  type HttpRouter,
  type ReplicaTableSpec,
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
  /** Absent when `argsJson` carries them. */
  args?: unknown;
  /**
   * The args in Ember's wire JSON (int64 values tagged), set instead of `args` on a Queue message whose args hold an
   * int64: a `bigint` does not survive the Queue's JSON content type. The consumer reads it before `args`.
   */
  argsJson?: string;
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
  /** Queues have it (up to 100 messages): an alarm turn hands its due action jobs over in one call. */
  sendBatch?(messages: Iterable<{ body: ActionJobMessage }>): Promise<unknown>;
}

export interface EmberAuthVerifyOptions {
  /** Authoritative session check (Auth DO): set for `sensitive` mutations and actions. */
  sensitive?: boolean;
  /**
   * `waitUntil` of the request being served (the Worker's `ExecutionContext`, or the Shard's `DurableObjectState`):
   * background work the hook starts (`@freecorps/ember-auth`: the JWKS refresh after its TTL) is handed to it, so
   * workerd does not cancel it when the response ends.
   */
  waitUntil?: (p: Promise<unknown>) => void;
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
  /**
   * Remote auth (`remoteAuth`: SSO, or the backend an app is moving from, PLAN §22 L14): where users, sessions and
   * signing keys live. The admin endpoints answer `no_local_auth` naming it, and the dashboard shows that.
   */
  remote?: { from: string };
  /**
   * Users and sessions for the dashboard's admin endpoints (`@freecorps/ember-auth` provides it): never credentials
   * nor session tokens.
   */
  admin?: {
    users(env: EmberEnv, q?: { q?: string; cursor?: number; limit?: number }): Promise<{ users: unknown[]; total: number; next: number | null }>;
    sessions(env: EmberEnv, userId: string): Promise<unknown[]>;
    revoke(env: EmberEnv, o: { userId: string; sessionId?: string }): Promise<{ revoked: number }>;
  };
}

/** A replication source as the admin endpoints reach it (the `Auth` class wrapped by `authOutbox().wrap`). */
export interface ReplicationSourceRpc {
  /** Resync one target shard from the source's current rows, or every target (`null`). */
  replicaResync(shard: string | null): Promise<{ ok: true; targets: number } | { ok: false; error: string }>;
  /** Backlog and per-target state (`shard`: just that one). */
  replicaStatus(shard?: string): Promise<unknown>;
}

/**
 * Replica tables (contracts.md "Replicação entre shards"): read-only tables in every shard, written by their sources'
 * deliveries. `authOutbox({ replicate }).replicas` gives both parts for Better Auth organizations (PLAN §22 L3).
 */
export interface ReplicasConfig {
  tables: ReplicaTableSpec[];
  /** By source name (`auth`): how the admin endpoints reach it. */
  sources?: Record<string, (env: EmberEnv) => ReplicationSourceRpc>;
}

export interface EmberConfig {
  schema: SchemaLike;
  /** Replica tables and their sources (`authOutbox({ replicate }).replicas`), added to the schema of every shard. */
  replicas?: ReplicasConfig | undefined;
  functions: unknown;
  /**
   * Mount point when the runtime is embedded in an existing Worker (contracts.md "Embutir o runtime"): `"/ember"`
   * serves `/ember/ws`, `/ember/api/query`, `/ember/api/storage/*` and so on, and file URLs carry the prefix. The
   * Worker's `fetch` answers 404 for paths outside it; `worker.handles(request)` tells the host which requests to hand
   * over. Default: none (the runtime owns the whole Worker, as `ember deploy` sets it up).
   */
  basePath?: string;
  /**
   * Where a shard's Durable Object is created, by code (PLAN §5): a hint for `shard` (`"probe:ws_1:weur"`), or undefined
   * for the schema's `defineShard({ locationHint })` and then `EMBER_LOCATION_HINT`. Only used when the object is
   * first created.
   */
  locationHint?: (shard: string) => string | undefined;
  /**
   * `ember/ember.config.ts` (`defineApp().use(component, ...)`): installed components (PLAN §12). The Worker composes
   * them with `schema`/`functions` (`composeApp`) before anything runs.
   */
  app?: AppDefinition<any>;
  /** `ember/http.ts` (`httpRouter()`): the app's HTTP routes; components add theirs under their prefix. */
  http?: HttpRouter;
  /**
   * `ember/triggers.ts` (`defineTriggers({...})`): per-table triggers every shard's engine runs in the mutation's
   * transaction (`createEngine({ triggers })`). App tables only; `createEmberWorker` refuses anything else.
   */
  triggers?: import("@freecorps/ember-server").TriggersDefinition | Record<string, unknown>;
  /** Set by `createEmberWorker`: the composed routes (app + components), with the scope each one runs in. */
  routes?: import("@freecorps/ember-server").ComposedApp["routes"];
  /** Set by `createEmberWorker`: component queues (consumed by the Worker) and `email()` hooks. */
  componentQueues?: import("@freecorps/ember-server").ComposedQueue[];
  emailHooks?: import("@freecorps/ember-server").ComposedEmailHook[];
  auth?: EmberAuthHook;
  /** Engine factory. Defaults to `createEngine` from `@freecorps/ember-server`. */
  createEngine?: CreateEngine;
  /**
   * The compact format of the tables every shard's migration creates from now on (`createEngine({ compactFormat })`,
   * contracts.md "Armazenamento compacto"). Default 3; 2 is the way back if format 3 shows a problem. Existing tables
   * keep their format (format 3 tables already created stay readable), and 3 never skips a pending classic → compact
   * conversion. Same as `defineApp({ storage: { compactFormat } })`; set in both with different values,
   * `createEmberWorker` refuses.
   */
  compactFormat?: 2 | 3;
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
    /**
     * How long finished jobs (`success`, `failed`, `canceled`) stay in `_jobs` for `ctx.scheduler.get/list` and the
     * dashboard, before the hourly maintenance deletes them (default 7 days). 0: successful and cancelled jobs are
     * deleted when they finish (failed ones still wait for the next maintenance).
     */
    retainMs?: number;
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
  /**
   * Largest change-log entry (UTF-8 bytes of a commit's changes as JSON; default 128 KiB). A commit over it (a huge
   * document written) keeps only its version in the ring: a client resuming across it gets a full snapshot of its
   * queries instead of a resume (`unchanged`). Smaller commits are unaffected. 0: no changes are kept (every resume
   * across a write is a snapshot).
   */
  changeLogEntryMaxBytes?: number;
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
/** A run the server started (scheduled jobs, crons, component hooks): no identity and no `fromAuth` claim check. */
export const SYSTEM: AuthCtx = { identity: null, system: true };

export function identityKey(identity: Identity | null): string {
  if (!identity) return "anon";
  return identity.issuer ? `${identity.issuer}|${identity.subject}` : identity.subject;
}

const SHARD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}:[^\s]{1,190}$/;

export function isValidShardName(name: string): boolean {
  return SHARD_RE.test(name);
}

/** A config value for an error message (`JSON.stringify` throws on a BigInt, and gives undefined for a symbol or function). */
function shown(x: unknown): string {
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

/**
 * The compact format the shards' engines create tables in: `compactFormat` of the config, else the app's
 * `defineApp({ storage: { compactFormat } })`, else undefined (the engine's default, 3). Throws on a value other than 2
 * or 3, and when both are set and differ.
 */
export function compactFormatOf(cfg: Pick<EmberConfig, "compactFormat" | "app">): 2 | 3 | undefined {
  const own = cfg.compactFormat;
  if (own !== undefined && own !== 2 && own !== 3) throw new Error(`compactFormat must be 2 or 3 (got ${shown(own)})`);
  // `storage` is optional here: an app defined by an older @freecorps/ember-server has none.
  const fromApp = (cfg.app as { storage?: { compactFormat?: unknown } } | undefined)?.storage?.compactFormat;
  if (fromApp !== undefined && fromApp !== 2 && fromApp !== 3) throw new Error(`defineApp({ storage }): compactFormat must be 2 or 3 (got ${shown(fromApp)})`);
  if (own !== undefined && fromApp !== undefined && own !== fromApp) {
    throw new Error(`compactFormat ${own} differs from the app's defineApp({ storage: { compactFormat: ${fromApp} } }): set it in one place`);
  }
  return own ?? fromApp;
}
