import { claimShardOf, componentQueueName, type AnyRegisteredFunction, type QueryCache, composeApp, cronList, flattenFunctions, hookShard, matchRoute, MAX_HTTP_BODY_BYTES as SERVER_MAX_HTTP_BODY_BYTES, replicaApplyFunction, replicatedTablesOf, REPLICATED_SOURCE, resolveTriggers, withReplicas, type ComposedQueue, type InboundEmailMessage } from "@freecorps/ember-server";
import { unverifiedJwtPayload, type ShardSpec } from "@freecorps/ember-values";
import { ActionRunner, type ShardApi } from "./actions.ts";
import type { AdminShardRpc } from "./admin-api.ts";
import { ADMIN_MODULE, adminDataFunctions } from "./admin-data.ts";
import { compactFormatOf, indexEnv, isValidShardName, resolvedCrons, setEmberConfig, type ActionJobMessage, type EmberAuthVerifyOptions, type EmberConfig, type EmberEnv, type ReplicationSourceRpc } from "./config.ts";
import type { Identity } from "./engine-types.ts";
import { actionStorage, bucketOf, isR2Event, type FileRpc, type R2EventMessage, type StorageDeps } from "./files.ts";
import { deliverIndexBatch, isIndexMessage, type ExternalIndexRpc, type IndexMessage } from "./ai-indexes.ts";
import { readLimited, readLimitedText } from "./body.ts";
import { MAX_FRAME_BYTES } from "./protocol.ts";
import { recordCall } from "./metrics.ts";
import type { RestoreRpc } from "./restore.ts";
import { MAX_LEASE_BATCH, MAX_QUERY_BATCH, revokeMatchError, type ActionJobOutcome, type MutationOutcome, type QueryBatchItem, type RevokeMatch, type ShardStatus } from "./shard.ts";
import { shardStub, systemStub } from "./stubs.ts";
import type { RestoreJournalRow, System } from "./system.ts";
import { CRON_HEARTBEAT_MINUTES, cronWakeDue } from "./cron.ts";
import { parse, stringify } from "./wire.ts";

/** An action job message's args: `argsJson` (wire text, int64 tagged) when set, else `args`. */
const jobArgs = (job: ActionJobMessage): unknown => (typeof job.argsJson === "string" ? parse(job.argsJson) : job.args) ?? {};

// Cold paths load on first use (`import()`): the admin endpoints, point-in-time restore, the storage routes and R2
// events. In the split Worker build (`ember deploy`/`ember dev`) each is a chunk of its own, so an isolate that only
// serves sync traffic never evaluates them (nor compiles them, under `new_module_registry`). Shared code (`bucketOf`,
// the Shard's own imports) stays in the main module.
const adminApi = () => import("./admin-api.ts");
const restoreApi = () => import("./restore.ts");
const filesApi = () => import("./files.ts");

export interface EmberWorker {
  fetch(request: Request, env: EmberEnv, ctx: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: EmberEnv, ctx: ExecutionContext): Promise<void>;
  /**
   * Queue consumer: action jobs (`EMBER_ACTIONS`), R2 event notifications of the files bucket (object-create
   * confirms uploads, PLAN §7) and external-index deliveries (`EMBER_INDEXING`, PLAN §6). Messages are told apart
   * by shape.
   */
  queue(batch: MessageBatch<ActionJobMessage | R2EventMessage | IndexMessage>, env: EmberEnv, ctx: ExecutionContext): Promise<void>;
  /**
   * Email Routing (`email()` handler): handed to the first installed component whose `email` hook matches the
   * recipient (contracts.md "Componentes", hooks); no match → rejected.
   */
  email(message: InboundEmailMessage, env: EmberEnv, ctx: ExecutionContext): Promise<void>;
  /**
   * Ends access now for an identity on `shard` (an app's session-end hook): its sockets are told `authExpired` (or
   * closed), and for `forMs` a token issued before now is refused there. `Shard.revokeSockets`; contracts.md "Auth".
   */
  revokeSockets(env: EmberEnv, shard: string, match: RevokeMatch, opts?: { forMs?: number; close?: boolean }): Promise<{ sockets: number }>;
  /** Whether `request` is under the runtime's `basePath` (always true without one): hand it to `fetch`. */
  handles(request: Request): boolean;
}

/**
 * `url` without the mount `basePath`. A clone with its path set, never a URL parsed from the rest: a rest starting
 * with `//` would parse as another host. The `pathname` setter keeps `%` escapes as they are.
 */
export function unmount(url: URL, basePath: string): URL {
  const out = new URL(url);
  out.pathname = url.pathname.slice(basePath.length) || "/";
  return out;
}

/** `"/ember"` from `"ember"`, `"/ember/"` or `"/ember"`; undefined for none or `"/"`. Throws on anything else. */
export function normalizeBasePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const p = `/${path.trim().replace(/^\/+|\/+$/g, "")}`;
  if (p === "/") return undefined;
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(p)) throw new Error(`createEmberWorker: basePath must be a URL path like "/ember", got ${JSON.stringify(path)}`);
  return p;
}

/** `GET /api/_ember/status` response. */
export interface StatusResponse {
  ok: true;
  expectedVersion: string;
  shards: ShardStatus[];
  /**
   * Restores of these shards journaled in the System DO and not completed yet (restore.ts), with their undo bookmark
   * and last error: one the Worker is finishing, or one waiting for a runtime that understands the restored tables
   * (`restore_still_ahead`).
   */
  restores: RestoreJournalRow[];
}

const json = (body: unknown, status = 200) =>
  new Response(stringify(body), { status, headers: { "content-type": "application/json" } });

const error = (status: number, code: string, message: string) => json({ ok: false, error: { code, message } }, status);

function bearer(request: Request, url: URL): string | null {
  const h = request.headers.get("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
  return url.searchParams.get("token");
}

/**
 * The shard a `shard: { kind: "argName" }` function derives from its arguments: `<kind>:<value>` for a string, number,
 * bigint or boolean value, undefined without the argument (or without `fromArg`), null for any other value (an object,
 * an array: never coerced, the caller gets a 400). Only consulted when no shard is named (`?shard=`, `x-ember-shard`).
 */
function shardFromArg(spec: ShardSpec | undefined, args: Record<string, unknown>): string | undefined | null {
  if (spec?.fromArg === undefined) return undefined;
  const v = args[spec.fromArg];
  if (v === undefined) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return `${spec.kind}:${String(v)}`;
  return null;
}
const badShardArg = (spec: ShardSpec) => error(400, "bad_shard", `argument ${spec.fromArg} names the shard: it must be a string or a number`);

function knownShardKinds(config: EmberConfig): Set<string> | null {
  const s = config.schema.manifest.shards;
  if (!s) return null;
  return new Set(Array.isArray(s) ? s : Object.keys(s));
}

/** Id of the running Worker version (`version_metadata` binding EMBER_VERSION, set by `ember deploy`). */
function deployVersion(env: EmberEnv): string | null {
  const v = env.EMBER_VERSION as { id?: unknown } | undefined;
  return v && typeof v.id === "string" && v.id ? v.id : null;
}

/** Constant-time string comparison (admin token). */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const MAX_STATUS_SHARDS = 50;
/** Queue messages of one batch handled at once by `queue()`. */
const QUEUE_CONCURRENCY = 8;

/** A shard reached from this isolate this recently is taken as awake: no pre-warm (`prewarm` in the Worker). */
export const WARM_TTL_MS = 30_000;
const WARM_CACHE_MAX = 1024;
/** Bearer tokens look like this (JWT, session token, cookie cache value): anything else is not worth waking a shard for. */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{8,8192}$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Whether verifying `token` likely goes over the network (so waking the shard meanwhile hides its boot): a
 * sensitive verify always asks the session store; a well-formed token that is not a JWT (a session token) is looked
 * up remotely. A JWT is checked locally against the cached JWKS. A malformed token wakes nothing.
 */
export function warmWorthIt(token: string, sensitive: boolean): boolean {
  if (!TOKEN_SHAPE.test(token)) return false;
  return sensitive || !JWT_SHAPE.test(token);
}
/** Secrets the reveal endpoint refuses besides EMBER_*: BETTER_AUTH_SECRET is the auth secret's legacy name (packages/auth). */
const NEVER_REVEALED = new Set(["BETTER_AUTH_SECRET"]);

/**
 * Build the Worker entry. Usage in the user's worker module:
 *
 *   export { Shard, System } from "@freecorps/ember-runtime";
 *   export default createEmberWorker({ schema, functions, crons });
 */
/**
 * The Shard DO's lease surface for action jobs: `claimActionJobs` / `settleActionJobs` (one RPC per shard and Queue
 * batch), and the one-job forms a shard instance of the runtime before them still has (mid-deploy).
 */
interface LeaseRpc {
  claimActionJob(shard: string, jobId: string): Promise<{ run: boolean }>;
  settleActionJob(shard: string, jobId: string, error: { code: string; message: string } | null): Promise<void>;
  claimActionJobs(shard: string, jobIds: string[]): Promise<Array<{ run: boolean; leaseMs?: number; leaseUntil?: number }>>;
  settleActionJobs(shard: string, outcomes: ActionJobOutcome[]): Promise<void>;
}

/**
 * One leased job on a shard of the runtime before the batch RPCs: claim, run, settle, as that runtime's consumer did.
 * A claim that fails retries the delivery; a settle that fails leaves the job to its lease (at least once).
 */
async function legacyLeasedJob(
  owner: LeaseRpc,
  shard: string,
  msg: { ack(): void; retry(): void },
  job: ActionJobMessage,
  run: (job: ActionJobMessage) => Promise<{ code: string; message: string } | null>,
): Promise<void> {
  let claim: { run: boolean };
  try {
    claim = await owner.claimActionJob(shard, job.jobId);
  } catch (e) {
    console.error(`ember: could not claim action job ${job.jobId} (${job.fn}) on ${shard}: ${(e as Error).message}`);
    msg.retry();
    return;
  }
  if (!claim.run) {
    msg.ack(); // cancelled, already run by the shard, or claimed by another delivery
    return;
  }
  let error: { code: string; message: string } | null;
  try {
    error = await run(job);
  } catch (e) {
    error = { code: "internal", message: (e as Error)?.message ?? String(e) };
  }
  if (error) console.error(`ember: action job ${job.jobId} (${job.fn}) failed: ${error.code}: ${error.message}`);
  try {
    await owner.settleActionJob(shard, job.jobId, error);
  } catch (e) {
    console.error(`ember: could not report action job ${job.jobId} (${job.fn}): ${(e as Error).message}`);
  }
  msg.ack();
}

/** A shard instance of the runtime before the batch RPCs (mid-deploy) has no `name`: the error names the method. */
const missingRpc = (e: unknown, name: string) => new RegExp(name).test(String((e as Error | null)?.message ?? ""));

/**
 * The longest a settled outcome waits for the rest of its shard's jobs of the batch before it is reported on its own
 * (one slow action does not hold the others' rows `claimed` for its whole run).
 */
export const SETTLE_MAX_WAIT_MS = 5_000;

/**
 * When a claimed job's lease ends, as the consumer can tell: the shard's `leaseUntil` (its clock), kept within the
 * claim's round trip (`sentAt + leaseMs` .. `receivedAt + leaseMs`: the lease was granted in between), so neither the
 * claim's own latency nor a skewed clock moves it by more than that round trip. Without `leaseUntil` (a shard of the
 * runtime before it), from when the claim was sent: the earliest the lease can have started.
 */
export function leaseDeadline(c: { leaseMs: number; leaseUntil?: number | undefined }, sentAt: number, receivedAt: number): number {
  const lo = sentAt + c.leaseMs;
  if (typeof c.leaseUntil !== "number" || !Number.isFinite(c.leaseUntil)) return lo;
  return Math.min(Math.max(c.leaseUntil, lo), receivedAt + c.leaseMs);
}

/**
 * The outcomes of one shard's claimed jobs of a Queue batch, reported together: one `settleActionJobs` once all
 * `count` ran, or the ones waiting when the first of them has waited `SETTLE_MAX_WAIT_MS`, or sooner when an outcome
 * waiting must reach the shard before its lease ends (`reportBy`: a quarter of the lease before it; an outcome
 * without one goes at once). Each message is acked once its outcome was sent, reported or not (as with one job: an
 * unreported job runs again when its lease runs out, at least once). The sends go into `settles`, which the batch
 * awaits (`flush` sends what is left).
 */
function settleGroup(owner: LeaseRpc, shard: string, count: number, settles: Promise<void>[]) {
  let remaining = count;
  let pending: Array<{ o: ActionJobOutcome; msg: { ack(): void } }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushAt = Infinity;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    flushAt = Infinity;
    const items = pending;
    pending = [];
    if (!items.length) return;
    settles.push(
      (async () => {
        const outcomes = items.map((i) => i.o);
        try {
          try {
            await owner.settleActionJobs(shard, outcomes);
          } catch (e) {
            if (!missingRpc(e, "settleActionJobs")) throw e;
            // A shard of the runtime before it: one RPC each, every one tried (one refused does not leave the others
            // unreported). A released job stays `claimed` there (its lease brings it back).
            const each = await Promise.allSettled(outcomes.map((o) => ("error" in o ? owner.settleActionJob(shard, o.jobId, o.error) : undefined)));
            each.forEach((r, k) => {
              if (r.status === "rejected") console.error(`ember: could not report action job ${outcomes[k]!.jobId} on ${shard}: ${(r.reason as Error)?.message ?? String(r.reason)}`);
            });
          }
        } catch (e) {
          // Not reported: the lease runs out and the shard runs the jobs again (at least once).
          console.error(`ember: could not report ${outcomes.length} action job(s) on ${shard} (${outcomes.map((o) => o.jobId).join(", ")}): ${(e as Error).message}`);
        }
        for (const i of items) i.msg.ack();
      })(),
    );
  };
  return {
    flush,
    done(o: ActionJobOutcome, msg: { ack(): void }, reportBy?: number) {
      const now = Date.now();
      pending.push({ o, msg });
      remaining--;
      const at = Math.min(flushAt, pending.length === 1 ? now + SETTLE_MAX_WAIT_MS : Infinity, reportBy ?? now);
      if (remaining === 0 || at <= now) return flush();
      if (at < flushAt) {
        if (timer) clearTimeout(timer);
        flushAt = at;
        timer = setTimeout(flush, at - now);
      }
    },
  };
}

export function createEmberWorker(input: EmberConfig): EmberWorker {
  // Components (PLAN §12): one composed schema + function map; the Shard, System and actions only see this.
  const composed = composeApp({ schema: input.schema, functions: input.functions, app: input.app ?? null, http: input.http ?? null });
  if (Object.prototype.hasOwnProperty.call(composed.functions, ADMIN_MODULE)) throw new Error(`createEmberWorker: the module name ${ADMIN_MODULE} is reserved (dashboard data functions)`);
  // Replica tables (`auth:member`, ...): in every shard's schema, written only by `_ember:replicaApply`.
  const schema = withReplicas(composed.schema, input.replicas?.tables);
  // Checked here, not first at a shard's boot: triggers only on the app's own tables (replica tables included: the
  // applier's writes fire them).
  if (input.triggers !== undefined) resolveTriggers(schema.manifest, input.triggers);
  // Also checked here, not first at a shard's boot: a bad value, or the config and the app disagreeing.
  compactFormatOf(input);
  const basePath = normalizeBasePath(input.basePath);
  const { basePath: _given, ...rest } = input;
  // `.replicated()` tables (replicated.ts): global:main is their source; the admin endpoints reach it like the others.
  const replicas: EmberConfig["replicas"] = replicatedTablesOf(schema.manifest).length
    ? {
        tables: input.replicas?.tables ?? [],
        sources: { ...input.replicas?.sources, [REPLICATED_SOURCE]: (env: EmberEnv) => shardStub(env, schema.manifest, REPLICATED_SOURCE) as unknown as ReplicationSourceRpc },
      }
    : input.replicas;
  const config: EmberConfig = {
    ...rest,
    // Normalized, or absent: `"/"` means none, everywhere (the Worker's routing and the Shard's file URLs).
    ...(basePath ? { basePath } : {}),
    schema,
    ...(replicas ? { replicas } : {}),
    // `_ember`: the dashboard's data functions (admin-data.ts), internal, called only through the admin endpoints,
    // and the replication applier (called by the replication sources).
    functions: { ...composed.functions, [ADMIN_MODULE]: { ...adminDataFunctions(() => schema.manifest), replicaApply: replicaApplyFunction(() => schema.manifest) } },
    routes: composed.routes,
    // Crons declared by components run next to the app's (System DO, one Cron Trigger).
    ...(composed.crons.length ? { crons: [...cronList(input.crons), ...composed.crons] } : {}),
    componentQueues: composed.queues,
    emailHooks: composed.email,
    dashboards: composed.dashboards,
  };
  setEmberConfig(config);
  const kinds = knownShardKinds(config);
  const manifest = config.schema.manifest;

  const checkShard = (shard: unknown): string | null => {
    if (typeof shard !== "string" || !isValidShardName(shard)) return null;
    if (kinds && kinds.size && !kinds.has(shard.slice(0, shard.indexOf(":"))) && !shard.startsWith("global:")) return null;
    return shard;
  };

  const stub = (env: EmberEnv, shard: string) => shardStub(env, manifest, shard);
  const actions = (env: EmberEnv) => new ActionRunner(config, env, (shard) => stub(env, shard) as unknown as ShardApi);
  /** An admin run as an identity obeys the shard's refusal, as `POST /api/action` does: no app code runs on a refused shard. */
  const runAdminAction = async (env: EmberEnv, fn: string, args: unknown, shard: string, identity: Identity | null) => {
    if (identity) {
      const refused = await (stub(env, shard) as unknown as { checkIdentity(shard: string, identity: Identity): Promise<{ code: string; message: string } | null> }).checkIdentity(shard, identity);
      if (refused) return { ok: false as const, error: refused };
    }
    return actions(env).run(fn, args, shard, identity, { internal: true });
  };
  const storageDeps = (env: EmberEnv): StorageDeps => ({ env, checkShard, rpc: (shard) => stub(env, shard) as unknown as FileRpc, ...(basePath ? { basePath } : {}) });
  /** Whether `pathname` is under the mount point (always, without one). */
  const mounted = (pathname: string) => !basePath || pathname === basePath || pathname.startsWith(`${basePath}/`);

  /**
   * undefined = no token; null = invalid token (or, with `sensitive`, a session that is gone). `ctx`: the request's,
   * whose `waitUntil` keeps the hook's background work (the JWKS refresh after its TTL) alive past the response.
   */
  const verify = async (token: string | null, sensitive = false, ctx?: ExecutionContext): Promise<Identity | null | undefined> => {
    if (!token) return undefined;
    if (!config.auth) return null;
    const opts: EmberAuthVerifyOptions = sensitive ? { sensitive: true } : {};
    if (typeof ctx?.waitUntil === "function") opts.waitUntil = (p) => ctx.waitUntil(p);
    try {
      return (await config.auth.verify(token, opts)) ?? null;
    } catch {
      return null;
    }
  };
  const componentQueueFor = (name: string, env: EmberEnv): ComposedQueue | undefined => {
    if (!config.componentQueues?.length) return undefined;
    const project = typeof env.EMBER_PROJECT === "string" ? env.EMBER_PROJECT : "";
    const envName = typeof env.EMBER_ENV === "string" ? env.EMBER_ENV : "";
    return config.componentQueues.find((q) => componentQueueName(project, envName, q.queue) === name);
  };

  /**
   * Pre-warm a shard while the token is verified, only when that pays: the verify goes over the network (a
   * `sensitive` call, or a token that is not a JWT: a session token is looked up in the Auth DO) and the shard was not
   * reached from this isolate in the last `WARM_TTL_MS` (it is awake then). A JWT verifies locally in under a
   * millisecond, so warming would only bill a second DO request (and wake a shard for a token about to be refused).
   */
  const contacted = new Map<string, number>();
  const prewarm = (env: EmberEnv, ctx: ExecutionContext, shard: string, tok: string | null, sensitive: boolean) => {
    if (!tok || !config.auth || !warmWorthIt(tok, sensitive)) return;
    const now = Date.now();
    const at = contacted.get(shard);
    if (at !== undefined && now - at < WARM_TTL_MS) return;
    if (contacted.size >= WARM_CACHE_MAX) contacted.clear();
    contacted.set(shard, now);
    ctx.waitUntil(stub(env, shard).warm(shard).catch(() => undefined));
  };
  /** The shard was just reached (a call, a socket): no pre-warm for a while. */
  const reached = (shard: string) => {
    if (contacted.size >= WARM_CACHE_MAX && !contacted.has(shard)) contacted.clear();
    contacted.set(shard, Date.now());
  };

  let fns: ReturnType<typeof flattenFunctions> | null = null;
  /** `sensitive: true` mutations/actions verify against the Auth DO (PLAN §9: revocation is immediate). */
  const isSensitive = (fn: string) => {
    fns ??= flattenFunctions(config.functions);
    const f = fns.get(fn);
    return !!f && f.type !== "httpAction" && f.sensitive === true;
  };

  /**
   * `POST /api/query/batch` with `{shard, queries: [{fn, args, resume?, warm?}]}` (at most `MAX_QUERY_BATCH`, the body
   * at most `MAX_QUERY_BATCH_BYTES`): the queries of one shard in one request and one `Shard.queryBatch` RPC (the
   * client's `httpFirst` of a turn). One bearer token, verified once, as `POST /api/query` verifies it (invalid: 401
   * for the whole request; nothing runs); every query then gets exactly the checks a `POST /api/query` gets in the
   * shard (public function, revocation, `authorize`, args), with its own outcome in `results` (same order): one
   * failing query never fails the others. The shard is named, never derived from a `fromAuth` claim (a query routed
   * by claim refuses a shard that is not its caller's, `WrongShard`).
   */
  const queryBatch = async (request: Request, url: URL, env: EmberEnv, ctx: ExecutionContext): Promise<Response> => {
    if (request.method !== "POST") return error(405, "method_not_allowed", "use POST");
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_QUERY_BATCH_BYTES) return error(413, "too_large", `a query batch is at most ${MAX_QUERY_BATCH_BYTES} bytes`);
    let body: Record<string, unknown>;
    try {
      // The header may be missing (a streamed body): the limit is enforced on the bytes while reading too.
      const bytes = await readLimited(request.body, MAX_QUERY_BATCH_BYTES);
      if (!bytes) return error(413, "too_large", `a query batch is at most ${MAX_QUERY_BATCH_BYTES} bytes`);
      const b = parse(new TextDecoder().decode(bytes));
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
      body = b as Record<string, unknown>;
    } catch {
      return error(400, "bad_request", "body must be a JSON object {shard, queries: [{fn, args}]}");
    }
    const shard = checkShard(body.shard ?? url.searchParams.get("shard"));
    if (!shard) return error(400, "bad_shard", "shard must be <kind>:<key>");
    const list = body.queries;
    if (!Array.isArray(list) || !list.length) return error(400, "bad_request", "queries must be a non-empty array");
    if (list.length > MAX_QUERY_BATCH) return error(413, "too_large", `at most ${MAX_QUERY_BATCH} queries per batch`);
    const items: QueryBatchItem[] = [];
    for (const q of list as unknown[]) {
      const { fn, args = {}, resume, warm } = (q && typeof q === "object" && !Array.isArray(q) ? q : {}) as Record<string, unknown>;
      if (typeof fn !== "string" || !fn) return error(400, "bad_request", "every query needs fn: string");
      if (typeof args !== "object" || args === null || Array.isArray(args)) return error(400, "bad_request", "args must be an object");
      items.push({ fn, args, ...(resumeOf(resume) ?? {}), ...(warm === true ? { warm: true } : {}) });
    }
    const tok = bearer(request, url);
    const s = stub(env, shard);
    prewarm(env, ctx, shard, tok, false);
    // Queries are never `sensitive` (as in `POST /api/query`).
    const identity = await verify(tok, false, ctx);
    if (identity === null) return error(401, "unauthenticated", "invalid token");
    reached(shard);
    const t0 = performance.now();
    let outs: MutationOutcome[];
    try {
      outs = await (s as unknown as { queryBatch(shard: string, items: QueryBatchItem[], identity: Identity | null): Promise<MutationOutcome[]> }).queryBatch(shard, items, identity ?? null);
    } catch (e) {
      // A shard instance of the runtime before this endpoint (mid-deploy) has no `queryBatch`: one RPC per query.
      if (!/queryBatch/.test(String((e as Error | null)?.message ?? ""))) throw e;
      outs = await Promise.all(items.map(({ fn, args, ...o }) => s.query(shard, fn, args, identity ?? null, false, { caller: true, ...o })));
    }
    // One RPC for all: each point gets its share of the wall time.
    const ms = (performance.now() - t0) / items.length;
    const results = outs.map((out, i) => {
      recordCall(env, "query", items[i]!.fn, shard, out, ms);
      const { metrics: _m, ...reply } = out;
      return reply;
    });
    return json({ ok: true, results });
  };

  /** Edge copies being refreshed from this isolate (a stale hit starts one refresh per key, not one per hit). */
  const refreshing = new Set<string>();
  /** Cache-key version when `EMBER_VERSION` is absent: this isolate's (made on first use: no random at startup). */
  let isolateVersion: string | undefined;

  /**
   * `GET /api/query/<module:fn>?args=<JSON>&shard=<shard>` (contracts.md "Queries HTTP cacheáveis"): only for public
   * queries declared with `cache: { maxAge, swr? }` (any other function: 405, as before). `args`: the arguments as
   * wire JSON (int64/bytes tagged), URL-encoded; absent = `{}`. The shard as in `POST /api/query/<fn>`.
   *
   * Anonymous calls (no bearer token, no session cookie) get `Cache-Control: public, max-age, stale-while-revalidate`
   * and go through `caches.default`: the key is the function, the shard, the canonical args (keys sorted) and the
   * Worker version (`EMBER_VERSION.id`, else a key of the isolate), so a deploy starts from an empty cache. A copy
   * younger than `maxAge` answers without waking the shard; one younger than `maxAge + swr` answers stale while one
   * refresh runs in the background (`waitUntil`). Only `ok: true` answers are stored. Signed-in calls are never cached
   * (`Cache-Control: private, no-store`) and run exactly as `POST /api/query/<fn>` does.
   */
  const getQuery = async (request: Request, url: URL, env: EmberEnv, ctx: ExecutionContext, rawFn: string): Promise<Response> => {
    let fnName: string;
    try {
      fnName = decodeURIComponent(rawFn);
    } catch {
      return error(400, "bad_request", "malformed percent-encoding in the function name");
    }
    fns ??= flattenFunctions(config.functions);
    const f = fns.get(fnName) as AnyRegisteredFunction | undefined;
    const cache = f && f.type === "query" && f.visibility === "public" ? f.cache : undefined;
    // Not revealing whether the function exists: the same answer as any GET before this route.
    if (!cache) return error(405, "method_not_allowed", "use POST (GET is only for queries declared with cache)");
    const raw = url.searchParams.get("args");
    if (raw !== null && raw.length > MAX_GET_ARGS_CHARS) return error(414, "too_large", `args in the URL are at most ${MAX_GET_ARGS_CHARS} characters: use POST`);
    let args: unknown = {};
    try {
      if (raw !== null && raw !== "") args = parse(raw);
    } catch {
      return error(400, "bad_request", "args must be URL-encoded JSON (an object)");
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) return error(400, "bad_request", "args must be an object");
    const spec = f!.shard;
    // A named shard first; the argument only without one (and never coerced from an object).
    const named = url.searchParams.get("shard") ?? request.headers.get("x-ember-shard");
    const routed = named === null ? shardFromArg(spec, args as Record<string, unknown>) : undefined;
    if (routed === null) return badShardArg(spec!);
    const shard = checkShard(named ?? routed ?? "global:main");
    if (!shard) return error(400, "bad_shard", "shard must be <kind>:<key>");
    const s = stub(env, shard);
    const tok = bearer(request, url);
    const run = async (identity: Identity | null) => {
      reached(shard);
      const t0 = performance.now();
      const out = await s.query(shard, fnName, args, identity, false, { caller: true });
      recordCall(env, "query", fnName, shard, out, performance.now() - t0);
      const { metrics: _m, ...reply } = out;
      return { ok: out.ok, body: stringify(reply) };
    };
    const send = (body: string, ok: boolean, headers: Record<string, string>) => new Response(body, { status: ok ? 200 : 400, headers: { "content-type": "application/json", ...headers } });

    // Anonymous = no `Authorization` header (of any scheme), no `?token=` and no session cookie.
    if (tok || request.headers.has("authorization") || SESSION_COOKIE.test(request.headers.get("cookie") ?? "")) {
      // Signed in (or claiming to be): never cached, anywhere; the same checks as POST (revocation in the shard). A
      // session cookie or another scheme only takes the call off the cache: the identity comes from a bearer token.
      prewarm(env, ctx, shard, tok, false);
      const identity = await verify(tok, false, ctx);
      if (identity === null) return new Response(stringify({ ok: false, error: { code: "unauthenticated", message: "invalid token" } }), { status: 401, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
      const r = await run(identity ?? null);
      return send(r.body, r.ok, { "cache-control": "private, no-store" });
    }

    const edge = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    // Without the version binding (a deploy not made by `ember deploy`, `wrangler dev`), the code version is unknown: a
    // key of this isolate, so no copy written by other code is ever served (fewer hits, never stale code).
    const version = deployVersion(env) ?? (isolateVersion ??= `isolate-${manifest.version}-${crypto.randomUUID()}`);
    const key = new Request(`${url.origin}/__ember/query-cache/${encodeURIComponent(fnName)}?shard=${encodeURIComponent(shard)}&args=${encodeURIComponent(stringify(canonical(args)))}&v=${encodeURIComponent(version)}`);
    const swr = cache.swr ?? 0;
    /** Writes the copy; the promise settles (never rejects) once the cache has it (or refused it). */
    const store = (body: string): Promise<void> => {
      if (!edge) return Promise.resolve();
      const copy = new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${cache.maxAge + swr}`, [CACHED_AT]: String(Date.now()) } });
      return edge.put(key, copy).catch(() => undefined);
    };
    const answer = (body: string, state: "HIT" | "STALE" | "MISS", ageS: number) =>
      send(body, true, { "cache-control": publicCacheControl(cache), vary: QUERY_CACHE_VARY, "x-ember-cache": state, age: String(Math.max(0, Math.floor(ageS))) });
    if (edge) {
      const hit = await edge.match(key).catch(() => undefined);
      if (hit) {
        const age = (Date.now() - Number(hit.headers.get(CACHED_AT) ?? 0)) / 1000;
        if (age < cache.maxAge) return answer(await hit.text(), "HIT", age);
        if (age < cache.maxAge + swr) {
          if (!refreshing.has(key.url)) {
            refreshing.add(key.url);
            // The mark stays until the new copy is in the cache (a stale hit meanwhile starts no second refresh), and
            // goes on failure too (a later stale hit retries).
            ctx.waitUntil(
              run(null)
                .then((r) => (r.ok ? store(r.body) : undefined))
                .catch(() => undefined)
                .finally(() => refreshing.delete(key.url)),
            );
          }
          return answer(await hit.text(), "STALE", age);
        }
      }
    }
    const r = await run(null);
    if (!r.ok) return send(r.body, false, { "cache-control": "no-store" });
    ctx.waitUntil(store(r.body));
    return answer(r.body, "MISS", 0);
  };

  return {
    handles(request) {
      return mounted(new URL(request.url).pathname);
    },

    async revokeSockets(env, shard, match, opts) {
      if (!checkShard(shard)) throw Object.assign(new Error(`revokeSockets: invalid shard ${JSON.stringify(shard)}`), { code: "InvalidArgument" });
      const invalid = revokeMatchError(match);
      if (invalid) throw Object.assign(new Error(invalid), { code: "InvalidArgument" });
      const owner = stub(env, shard) as unknown as { revokeSockets(shard: string, match: RevokeMatch, opts?: { forMs?: number; close?: boolean }): Promise<{ sockets: number }> };
      return owner.revokeSockets(shard, match, opts ?? {});
    },

    async fetch(request, env, ctx) {
      let url = new URL(request.url);
      // The auth hook sees the request as the browser sent it: Better Auth's callbacks, redirects and cookie paths
      // need the public URL, mount included (the auth component's `basePath` is `${mount}/api/auth`).
      const original = request;
      if (basePath) {
        // Embedded: only paths under the mount point are ours; the rest of the runtime sees them without it.
        if (!mounted(url.pathname)) return error(404, "not_found", "not found");
        url = unmount(url, basePath);
        // Auth goes to its hook untouched: rewriting the request would move its body (a sign-in POST) into the copy.
        if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
          const authResponse = config.auth?.fetch ? await config.auth.fetch(original, env) : null;
          return authResponse ?? error(404, "not_found", "not found");
        }
        // A WebSocket upgrade is left as it came (the `/ws` branch builds its own request for the shard): workerd
        // may refuse to copy an incoming upgrade. Everything else is rebuilt on the unmounted URL, so HTTP actions
        // and the handlers below see the path without the mount.
        if (url.pathname !== "/ws") request = new Request(url, request);
      }
      if (url.pathname === "/health") return json({ ok: true });

      if (url.pathname === "/ws") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "upgrade_required", "expected websocket");
        const shard = checkShard(url.searchParams.get("shard"));
        if (!shard) return error(400, "bad_shard", "expected ?shard=<kind>:<key>");
        const s = stub(env, shard);
        // Pre-warm: with a token in the upgrade that is verified over the network, wake the shard (cold wake ~60 ms,
        // R8) meanwhile. Not awaited: the upgrade queues behind the boot anyway, so waiting would only add a Worker→DO
        // round trip. (Clients send the token in `hello`: the upgrade itself is what wakes the shard, in parallel with
        // the client's token fetch — see EmberClientOptions.pipelineConnect.)
        const tok = bearer(request, url);
        prewarm(env, ctx, shard, tok, false);
        const identity = await verify(tok, false, ctx);
        if (identity === null) return error(401, "unauthenticated", "invalid token");
        const headers = new Headers(request.headers);
        for (const k of [...headers.keys()]) if (k.startsWith("x-ember-")) headers.delete(k);
        headers.set("x-ember-shard", shard);
        if (identity) {
          headers.set("x-ember-identity", JSON.stringify(identity));
          // The Shard keeps the token to re-check the session for `sensitive` mutations.
          headers.set("x-ember-token", bearer(request, url)!);
        }
        reached(shard);
        return s.fetch(new Request(url, { headers }));
      }

      if (url.pathname.startsWith("/api/storage/")) return (await (await filesApi()).handleStorageRequest(request, url, storageDeps(env)))!;

      if (url.pathname.startsWith("/api/_ember/")) {
        // EMBER_ADMIN_TOKEN (the operator's, `ember deploy --admin-token`) or EMBER_ADMIN_TOKEN_DASHBOARD (generated by
        // `ember deploy` for the Ember Dashboard, never shown): either opens the admin endpoints.
        const admins = [env.EMBER_ADMIN_TOKEN, env.EMBER_ADMIN_TOKEN_DASHBOARD].filter((t): t is string => typeof t === "string" && t.length > 0);
        if (!admins.length) return error(403, "admin_disabled", "set the EMBER_ADMIN_TOKEN secret on the Worker to enable admin endpoints");
        const token = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim() ?? "";
        // Every token compared (no early exit): which one matched does not show in the timing.
        const matched = admins.map((a) => !!token && sameSecret(token, a)).some(Boolean);
        if (!matched) return error(401, "unauthenticated", "invalid admin token");
        try {
          const [{ handleRestoreRequest }, { handleAdminApi, noLocalAuth, REFUSED_CODES, wrongEnvironment }, { sweepOrphans }] = await Promise.all([restoreApi(), adminApi(), filesApi()]);
          // A caller that names its environment (`x-ember-env`, `ember mcp`) is refused by a Worker of another one.
          const elsewhere = wrongEnvironment(request, env, error);
          if (elsewhere) return elsewhere;
          // Point-in-time recovery: list / record bookmarks, restore (restore.ts).
          const pitr = await handleRestoreRequest(request, url, (s) => stub(env, s) as unknown as RestoreRpc, isValidShardName, systemStub(env));
          if (pitr) return pitr;
          // Endpoints added for the dashboard (admin-api.ts: capabilities, ...).
          const extra = await handleAdminApi(request, url, { config, env, json, error, stub: (s) => stub(env, s) as unknown as AdminShardRpc, validShard: (s) => !!checkShard(s), runAction: (fn, args, s, identity) => runAdminAction(env, fn, args, s, identity), files: (s) => (bucketOf(env) ? actionStorage(env, s, () => stub(env, s) as unknown as FileRpc) : null), bucket: () => bucketOf(env), orphans: (o) => { const b = bucketOf(env); return b ? sweepOrphans(b, (s) => stub(env, s) as unknown as FileRpc, (s) => !!checkShard(s), o) : null; }, revokeSockets: (s, match, o) => (stub(env, s) as unknown as { revokeSockets(shard: string, m: RevokeMatch, o: object): Promise<{ sockets: number }> }).revokeSockets(s, match, o ?? {}) });
          if (extra) return extra;
          if (url.pathname === "/api/_ember/keys/rotate") {
            if (request.method !== "POST") return error(405, "method_not_allowed", "use POST");
            if (!config.auth?.rotateKeys) return error(404, "no_local_auth", noLocalAuth(config, "nothing to rotate"));
            const jwks = await config.auth.rotateKeys(env);
            return json({ ok: true, kids: jwks.keys.map((k) => k.kid) });
          }
          if (url.pathname === "/api/_ember/env/reveal") {
            // `ember env get NAME --reveal`: Worker secrets are write-only in the API, so the Worker reads its own
            // binding. Only user names (never EMBER_*: auth secret, admin token, storage keys; nor BETTER_AUTH_SECRET,
            // the legacy name the auth secret is still read from), never cached.
            if (request.method !== "POST") return error(405, "method_not_allowed", "use POST");
            let name: unknown;
            try {
              const text = await readLimitedText(request, MAX_HTTP_BODY_BYTES);
              if (text === null) return tooLarge();
              name = (parse(text) as { name?: unknown } | null)?.name;
            } catch {
              name = undefined;
            }
            if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return error(400, "bad_request", "body must be { name }");
            if (name.startsWith("EMBER_") || NEVER_REVEALED.has(name)) return error(403, "managed", `${name} is managed by ember and is never revealed`);
            const value = env[name];
            if (typeof value !== "string") return error(404, "not_found", `${name} is not set on this Worker`);
            return new Response(JSON.stringify({ ok: true, name, value }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
          }
          if (request.method !== "GET") return error(405, "method_not_allowed", "use GET");
          if (url.pathname === "/api/_ember/data") {
            // Read-only data browser: no `table` lists tables; `cursor` pages by row id (admin.ts).
            const shard = url.searchParams.get("shard") ?? "global:main";
            if (!isValidShardName(shard)) return error(400, "bad_shard", `invalid shard ${JSON.stringify(shard)}`);
            const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
            const jobs = url.searchParams.get("jobs");
            const r = await stub(env, shard).browse(shard, url.searchParams.get("table"), url.searchParams.get("cursor"), limit, jobs === "open" || jobs === "done" ? { jobs } : {});
            // A refused shard's code is a 409, as in the data calls; any other failure stays a 400.
            const refused = !r.ok && REFUSED_CODES.includes(r.error.code);
            return json(r, r.ok ? 200 : r.error.code === "not_found" ? 404 : refused ? 409 : 400);
          }
          if (url.pathname === "/api/_ember/crons") {
            const state = env.SYSTEM ? await (env.SYSTEM.get(env.SYSTEM.idFromName("system")) as unknown as DurableObjectStub<System>).state() : [];
            const byName = new Map(state.map((c) => [c.name, c]));
            return json({ ok: true, crons: resolvedCrons(config).map((c) => ({ ...c, state: byName.get(c.name) ?? null })) });
          }
          if (url.pathname === "/api/_ember/inspect") {
            // One shard's live counters (`Shard.inspect()`: batches, re-runs, SQL statements by kind, subscriptions).
            const shard = url.searchParams.get("shard") ?? "global:main";
            if (!isValidShardName(shard)) return error(400, "bad_shard", `invalid shard ${JSON.stringify(shard)}`);
            return json({ ok: true, shard: await stub(env, shard).inspect() });
          }
          if (url.pathname !== "/api/_ember/status") return error(404, "not_found", "not found");
          const names = url.searchParams.getAll("shard");
          if (!names.length) names.push("global:main");
          if (names.length > MAX_STATUS_SHARDS) return error(400, "bad_request", `at most ${MAX_STATUS_SHARDS} shards per call`);
          for (const n of names) if (!isValidShardName(n)) return error(400, "bad_shard", `invalid shard ${JSON.stringify(n)}`);
          const shards = await Promise.all([...new Set(names)].map((n) => stub(env, n).status(n)));
          const asked = new Set(names);
          const journal = systemStub(env);
          const restores = journal ? (await journal.restores()).filter((r) => asked.has(r.shard)) : [];
          const body: StatusResponse = { ok: true, expectedVersion: manifest.version, shards, restores };
          return json(body);
        } catch (e) {
          // A shard refused because its runtime tables are newer (RuntimeSchemaTooNew) answers admin RPCs by throwing:
          // the same 409 the data calls give.
          const code = (e as { code?: unknown } | null)?.code;
          if (code === "RuntimeSchemaTooNew") return error(409, code, (e as Error).message);
          throw e;
        }
      }

      // A function named plain "batch" (no module: only a hand-built function map) keeps its `/api/query/<fn>` form.
      if (url.pathname === "/api/query/batch" && !(fns ??= flattenFunctions(config.functions)).has("batch")) return queryBatch(request, url, env, ctx);

      // `POST /api/<kind>` with `{fn, args, shard}`, or `POST /api/<kind>/<module:fn>` with the args as the body (the
      // shard from `?shard=`, the function's routing argument, or global:main): the form OpenAPI describes.
      const perFn = /^\/api\/(query|mutation|action)\/(.+)$/.exec(url.pathname);
      if (url.pathname === "/api/query" || url.pathname === "/api/mutation" || url.pathname === "/api/action" || perFn) {
        // `GET /api/query/<fn>?args=`: queries declared with `cache` (edge-cached when anonymous); POST for the rest.
        if (request.method === "GET" && perFn?.[1] === "query") return getQuery(request, url, env, ctx, perFn[2]!);
        if (request.method !== "POST") return error(405, "method_not_allowed", "use POST");
        let body: Record<string, unknown>;
        try {
          // Read before the token is checked (the body may name the shard): bounded, so no caller, signed in or not,
          // makes the Worker buffer more than `MAX_HTTP_BODY_BYTES` (a `content-length` over it is refused unread).
          const text = await readLimitedText(request, MAX_HTTP_BODY_BYTES);
          if (text === null) return tooLarge();
          const b = text || !perFn ? parse(text) : {};
          if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
          body = b as Record<string, unknown>;
        } catch {
          return error(400, "bad_request", perFn ? "body must be a JSON object (the arguments)" : "body must be a JSON object {fn, args, shard}");
        }
        fns ??= flattenFunctions(config.functions);
        const specOf = (fn: unknown) => (typeof fn === "string" ? (fns!.get(fn) as { shard?: ShardSpec } | undefined)?.shard : undefined);
        if (perFn) {
          let fn: string;
          try {
            fn = decodeURIComponent(perFn[2]!);
          } catch {
            return error(400, "bad_request", "malformed percent-encoding in the function name");
          }
          const spec = specOf(fn);
          const explicit = url.searchParams.get("shard") ?? request.headers.get("x-ember-shard");
          const routed = explicit === null ? shardFromArg(spec, body) : undefined;
          if (routed === null) return badShardArg(spec!);
          const named = explicit ?? routed;
          // A `fromAuth` function without a named shard goes to its caller's claim (below, once the token is verified).
          body = { fn, args: body, ...(named !== undefined || spec?.fromClaim === undefined ? { shard: named ?? "global:main" } : {}) };
        }
        const kindPath = perFn ? `/api/${perFn[1]}` : url.pathname;
        if (typeof body.fn !== "string" || !body.fn) return error(400, "bad_request", "fn must be a string");
        const fnName = body.fn;
        const sensitive = kindPath !== "/api/query" && isSensitive(fnName);
        const tok = bearer(request, url);
        const spec = specOf(fnName);
        // `shard: { org: fromAuth("org") }` and no shard named: the shard of the verified identity's claim. A named
        // shard that disagrees still reaches the function, which refuses it (`WrongShard`).
        let verified: { identity: Identity | undefined } | undefined;
        if (body.shard === undefined && spec?.fromClaim !== undefined) {
          // Pre-warm the claim's shard while the token is verified (an unverified hint: the routing below uses the verified claim).
          const hint = kindPath === "/api/action" ? undefined : claimShardOf(spec, tok ? { subject: "", claims: unverifiedJwtPayload(tok) ?? {} } : null);
          if (hint && checkShard(hint)) prewarm(env, ctx, hint, tok, sensitive);
          const identity = await verify(tok, sensitive, ctx);
          if (identity === null) return error(401, "unauthenticated", "invalid token");
          if (!identity) return error(400, "Unauthenticated", `${fnName} runs in the "${spec.kind}" shard of the caller's ${spec.fromClaim} claim: not signed in`);
          const routed = claimShardOf(spec, identity);
          if (!routed) {
            return json({ ok: false, error: { code: "WrongShard", message: `${fnName} runs in the "${spec.kind}" shard of the caller's ${spec.fromClaim} claim, and the identity has none`, data: { expected: spec.kind, shard: null } } }, 400);
          }
          body.shard = routed;
          verified = { identity };
        }
        const shard = checkShard(body.shard);
        if (!shard) return error(400, "bad_shard", "shard must be <kind>:<key>");
        const args = body.args ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) return error(400, "bad_request", "args must be an object");

        if (kindPath === "/api/action") {
          // Actions run here, in the Worker; they reach shards through ctx.runQuery/runMutation (RPC).
          const identity = verified ? verified.identity : await verify(tok, sensitive, ctx);
          if (identity === null) return error(401, "unauthenticated", "invalid token");
          const runner = actions(env);
          // An unknown or invalid call fails here, before the shard is asked about the identity: it wakes no DO.
          const ready = runner.prepare(fnName, args);
          if (!ready.ok) {
            const out = await runner.run(fnName, args, shard, identity ?? null);
            return out.ok ? json({ ok: true, value: out.value }) : json(out, 400);
          }
          // The shard may hold this identity as revoked (`revokeSockets`): the action never starts with it.
          if (identity) {
            const refused = await (stub(env, shard) as unknown as { checkIdentity(shard: string, identity: Identity): Promise<{ code: string; message: string } | null> }).checkIdentity(shard, identity);
            if (refused) return error(401, refused.code, refused.message);
            reached(shard);
          }
          const out = await runner.run(fnName, ready.args, shard, identity ?? null, { prepared: true });
          return out.ok ? json({ ok: true, value: out.value }) : json(out, 400);
        }

        const s = stub(env, shard);
        // Pre-warm while the token is verified (not awaited: the call below queues behind the boot).
        if (!verified) prewarm(env, ctx, shard, tok, sensitive);
        const identity = verified ? verified.identity : await verify(tok, sensitive, ctx);
        if (identity === null) return error(401, "unauthenticated", "invalid token");
        reached(shard);
        // Wall time around the RPC (the DO's own clock does not advance during synchronous SQLite work): metrics.ts.
        const kind = kindPath === "/api/query" ? "query" : "mutation";
        const t0 = performance.now();
        const out: MutationOutcome =
          kind === "query"
            ? await s.query(shard, fnName, args, identity ?? null, false, { caller: true, ...(resumeOf(body.resume) ?? {}), ...(body.warm === true ? { warm: true } : {}) })
            : await s.mutation(shard, fnName, args, identity ?? null, false, { caller: true });
        recordCall(env, kind, fnName, shard, out, performance.now() - t0);
        const { metrics: _m, ...reply } = out;
        return json(reply, out.ok ? 200 : 400);
      }

      // HTTP routes (ember/http.ts and components), after Ember's own endpoints; auth paths are reserved.
      if (config.routes?.length && !url.pathname.startsWith("/api/auth/")) {
        const hit = matchRoute(config.routes, request.method, url.pathname);
        if (hit && "methodMismatch" in hit) return error(405, "method_not_allowed", `${request.method} is not allowed on ${url.pathname}`);
        if (hit) {
          // Optional auth: a valid bearer token sets ctx.auth; a missing or invalid one runs anonymous (webhooks).
          const identity = (await verify(bearer(request, url), false, ctx)) ?? null;
          return actions(env).runHttp(hit.route, request, identity);
        }
      }

      // Auth routes (`/api/auth/*` with @freecorps/ember-auth): the hook returns null for paths it does not own.
      const authResponse = config.auth?.fetch ? await config.auth.fetch(original, env) : null;
      if (authResponse) return authResponse;

      return error(404, "not_found", "not found");
    },

    async scheduled(controller, env, ctx) {
      const crons = resolvedCrons(config);
      if (!crons.length || !env.SYSTEM) return;
      // The trigger (`cronTriggers`: the minutes some cron may match, plus their heartbeat, or every minute) may tick more
      // often than needed; `System` is woken only on a minute some cron matches (plus a catch-up heartbeat).
      if (!cronWakeDue(crons, controller.scheduledTime, CRON_HEARTBEAT_MINUTES)) return;
      const system = env.SYSTEM.get(env.SYSTEM.idFromName("system")) as unknown as DurableObjectStub<System>;
      ctx.waitUntil(system.tick(controller.scheduledTime));
    },

    async queue(batch, env) {
      const runner = actions(env);
      // A component's own queue (`ember-<project>-<env>-<install>-<name>`): the whole batch goes to its handler.
      const own = componentQueueFor(batch.queue, env);
      if (own) {
        try {
          const ctx = runner.scopedCtx(own.scope, hookShard(own.def.shard, own.config));
          await own.def.handler(ctx as never, batch as never);
        } catch (e) {
          console.error(`ember: queue ${batch.queue} (component ${own.scope.join("/")}) failed: ${(e as Error).message}`);
          batch.retryAll();
        }
        return;
      }
      const handle = async (msg: Message<ActionJobMessage | R2EventMessage | IndexMessage>): Promise<void> => {
      if (isIndexMessage(msg.body)) {
        const body = msg.body;
        if (!isValidShardName(body.shard)) {
          msg.ack();
          return;
        }
        try {
          const t0 = Date.now();
          const r = await deliverIndexBatch({ env: indexEnv(config, env), rpc: (shard) => stub(env, shard) as unknown as ExternalIndexRpc }, body, {
            retried: msg.attempts > 1,
          });
          msg.ack();
          // EMBER_TRACE: queue delay (message age when delivered) vs. time spent writing to the service.
          if (env.EMBER_TRACE === "1") {
            console.log(`ember:index ${JSON.stringify({ shard: body.shard, index: `${body.table}.${body.index}`, ...r, attempt: msg.attempts, queuedMs: t0 - msg.timestamp.getTime(), deliverMs: Date.now() - t0 })}`);
          }
        } catch (e) {
          console.error(`ember: indexing ${body.table}.${body.index} (${body.ids.length} docs, ${body.shard}) failed: ${(e as Error).message}`);
          msg.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(6, msg.attempts - 1)) });
        }
        return;
      }
      if (isR2Event(msg.body)) {
        try {
          await (await filesApi()).handleR2Event(msg.body, storageDeps(env));
          msg.ack();
        } catch (e) {
          console.error(`ember: R2 event for ${msg.body.object.key} failed: ${(e as Error).message}`);
          msg.retry();
        }
        return;
      }
      const job = msg.body as ActionJobMessage;
      if (!job || typeof job.fn !== "string" || typeof job.shard !== "string" || !isValidShardName(job.shard)) {
        msg.ack(); // malformed: retrying cannot help
        return;
      }
      const out = await runner.run(job.fn, jobArgs(job), job.shard, null, { internal: true, system: true });
      if (out.ok) msg.ack();
      else {
        console.error(`ember: action job ${job.jobId} (${job.fn}) failed: ${out.error.code}: ${out.error.message}`);
        msg.retry();
      }
      };
      // Leased action jobs (`lease: true`) are claimed and settled per shard: one `claimActionJobs` RPC for the batch's
      // jobs of a shard, one `settleActionJobs` once they ran (or sooner: `SETTLE_MAX_WAIT_MS`, or before a lease ends).
      // The rest go one by one.
      const msgs = [...batch.messages];
      const byShard = new Map<string, Array<{ msg: (typeof msgs)[number]; job: ActionJobMessage }>>();
      const tasks: Array<() => Promise<void>> = [];
      const runJob = async (j: ActionJobMessage): Promise<{ code: string; message: string } | null> => {
        const out = await runner.run(j.fn, jobArgs(j), j.shard, null, { internal: true, system: true });
        return out.ok ? null : { code: out.error.code, message: out.error.message };
      };
      for (const msg of msgs) {
        const job = msg.body as ActionJobMessage;
        const leased = !!job && typeof job === "object" && !isIndexMessage(msg.body) && !isR2Event(msg.body) && job.lease === true && typeof job.jobId === "string" && typeof job.fn === "string" && typeof job.shard === "string" && isValidShardName(job.shard);
        if (!leased) {
          tasks.push(async () => {
            try {
              await handle(msg);
            } catch (e) {
              console.error(`ember: queue message failed: ${(e as Error).message}`);
              msg.retry();
            }
          });
          continue;
        }
        let l = byShard.get(job.shard);
        if (!l) byShard.set(job.shard, (l = []));
        l.push({ msg, job });
      }
      const settles: Promise<void>[] = [];
      const settlers: Array<{ flush(): void }> = [];
      await Promise.all(
        [...byShard].map(async ([shard, all]) => {
          for (let i = 0; i < all.length; i += MAX_LEASE_BATCH) {
            const group = all.slice(i, i + MAX_LEASE_BATCH);
            const owner = stub(env, shard) as unknown as LeaseRpc;
            const sentAt = Date.now();
            // null: that job's claim failed (one RPC each, a shard of the runtime before the batch): its delivery is
            // tried again on its own, and the claims granted next to it run.
            let claims: Array<{ run: boolean; leaseMs?: number; leaseUntil?: number } | null>;
            try {
              const ids = group.map((g) => g.job.jobId);
              try {
                claims = await owner.claimActionJobs(shard, ids);
              } catch (e) {
                if (!missingRpc(e, "claimActionJobs")) throw e;
                // A shard of the runtime before the batch RPCs (mid-deploy): as before them, each job is claimed when
                // its turn comes, run right after its own claim (its lease is unknown here, so no other shard's claim
                // may delay its start) and settled on its own.
                for (const g of group) tasks.push(() => legacyLeasedJob(owner, shard, g.msg, g.job, runJob));
                continue;
              }
            } catch (e) {
              // The shard is out of reach: try the deliveries again (the lease brings a job back if it never comes).
              console.error(`ember: could not claim ${group.length} action job(s) on ${shard}: ${(e as Error).message}`);
              for (const g of group) g.msg.retry();
              continue;
            }
            const receivedAt = Date.now();
            const run = group.filter((g, k) => {
              if (claims[k] === null) {
                g.msg.retry();
                return false;
              }
              if (claims[k]?.run === true) return true;
              g.msg.ack(); // cancelled, already run by the shard, or claimed by another delivery
              return false;
            });
            if (!run.length) continue;
            const settler = settleGroup(owner, shard, run.length, settles);
            settlers.push(settler);
            run.forEach((g) => {
              const claim = claims[group.indexOf(g)]!;
              const leaseMs = typeof claim.leaseMs === "number" && Number.isFinite(claim.leaseMs) ? claim.leaseMs : undefined;
              // Unknown lease (a shard before `leaseMs`): no start check, and its outcome is reported at once.
              const deadline = leaseMs !== undefined ? leaseDeadline({ leaseMs, leaseUntil: claim.leaseUntil }, sentAt, receivedAt) : undefined;
              // The settle must reach the shard before the lease ends: from the earliest that can be (`sentAt +
              // leaseMs`, never after the real end), so the quarter lease is all left for the settle's own transit.
              const reportBy = leaseMs !== undefined ? sentAt + leaseMs - leaseMs / 4 : undefined;
              tasks.push(async () => {
                const { msg, job } = g;
                // Claimed with the batch, not reached before half its lease went by (a long batch): left to the shard
                // now rather than started this close to the end of the lease.
                if (deadline !== undefined && Date.now() > deadline - leaseMs! / 2) {
                  console.warn(`ember: action job ${job.jobId} (${job.fn}) not started within half its lease; released to the shard`);
                  settler.done({ jobId: job.jobId, released: true }, msg, reportBy);
                  return;
                }
                let error: { code: string; message: string } | null;
                try {
                  const out = await runner.run(job.fn, jobArgs(job), job.shard, null, { internal: true, system: true });
                  error = out.ok ? null : { code: out.error.code, message: out.error.message };
                } catch (e) {
                  error = { code: "internal", message: (e as Error)?.message ?? String(e) };
                }
                if (error) console.error(`ember: action job ${job.jobId} (${job.fn}) failed: ${error.code}: ${error.message}`);
                settler.done({ jobId: job.jobId, error }, msg, reportBy);
              });
            });
          }
        }),
      );
      // Messages are independent (each one runs, confirms or indexes on its own): a bounded number at a time, not
      // one after the other.
      let next = 0;
      const lane = async () => {
        while (next < tasks.length) await tasks[next++]!();
      };
      await Promise.all(Array.from({ length: Math.min(QUEUE_CONCURRENCY, tasks.length) }, lane));
      // Every settle sent and finished before the batch returns: what still waits goes now (each group's last outcome
      // already sent its own; this is the backstop), and a send pushed while awaiting is awaited too.
      for (const g of settlers) g.flush();
      while (settles.length) await Promise.all(settles.splice(0));
    },

    async email(message, env) {
      const to = String(message.to ?? "").toLowerCase();
      const hook = (config.emailHooks ?? []).find((h) => !h.def.match || h.def.match(to, h.config));
      if (!hook) {
        message.setReject("Address not found");
        return;
      }
      const ctx = actions(env).scopedCtx(hook.scope, hookShard(hook.def.shard, hook.config));
      try {
        await hook.def.handler(ctx as never, message);
      } catch (e) {
        // Thrown out of email(): Email Routing does not accept the message (the sender's server sees a failure).
        console.error(`ember: email() for ${to} (component ${hook.scope.join("/")}) failed: ${(e as Error).message}`);
        throw e;
      }
    },
  };
}

/**
 * Largest body in bytes of `POST /api/query`, `/api/mutation`, `/api/action` (and `/api/<kind>/<fn>`) and of the
 * storage JSON calls: the WebSocket frame limit (`MAX_FRAME_BYTES`, 1 MiB), so whatever a client can send over the
 * socket also fits over HTTP. A `content-length` above it is refused before reading (413 `too_large`); without one
 * (or with a wrong one), while reading, which stops and cancels the stream as soon as the bytes pass it. The same
 * constant as `@freecorps/ember-server`'s, which typed HTTP routes read their bodies with.
 */
export const MAX_HTTP_BODY_BYTES: number = SERVER_MAX_HTTP_BODY_BYTES;

/** Largest `POST /api/query/batch` body in bytes (a `content-length` above it is refused before reading; without one, while reading). */
export const MAX_QUERY_BATCH_BYTES = MAX_FRAME_BYTES;

const tooLarge = () => error(413, "too_large", `the request body is at most ${MAX_HTTP_BODY_BYTES} bytes`);

/** Longest `args` (characters of the URL-decoded JSON) of `GET /api/query/<fn>`: past it, 414 (use POST). */
export const MAX_GET_ARGS_CHARS = 8 * 1024;

/**
 * A cookie whose name says it is a session (`<prefix>.session_token`, `session_data`, `__Secure-…`): the call is not
 * anonymous for the edge cache of `GET /api/query/<fn>`, even though queries authenticate by bearer token only.
 */
const SESSION_COOKIE = /(?:^|;)\s*[^=;]*session[^=;]*=/i;

/** `v` with every plain object's keys sorted: two spellings of the same args share one cache entry. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v === null || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return v;
  const out: Record<string, unknown> = {};
  // Own data properties, `__proto__` included (the wire decoder keeps it as one): never the inherited setter, which
  // would drop it and give `{ __proto__: "x" }` the key of `{}`.
  for (const k of Object.keys(v).sort()) Object.defineProperty(out, k, { value: canonical((v as Record<string, unknown>)[k]), enumerable: true, writable: true, configurable: true });
  return out;
}

/**
 * `Vary` of a cacheable query's anonymous answer: the headers that change it for the same URL (who calls, and the
 * shard when it comes from `x-ember-shard`), so a cache in front never answers one shard's call with another's copy.
 */
const QUERY_CACHE_VARY = "authorization, cookie, x-ember-shard";

/** The `Cache-Control` a cacheable query's anonymous answer carries (`swr` only when set). */
const publicCacheControl = (c: QueryCache) => `public, max-age=${c.maxAge}${c.swr ? `, stale-while-revalidate=${c.swr}` : ""}`;
/** Header of the edge copy: when it was computed (ms), for its age (the Cache API keeps it `maxAge + swr`). */
const CACHED_AT = "x-ember-cached-at";

/** `resume` of a `POST /api/query` body (the value the caller holds): `{ version, epoch, ik }`, else ignored. */
function resumeOf(r: unknown): { resume: { version: number; epoch: string; ik: string } } | undefined {
  if (!r || typeof r !== "object") return undefined;
  const { version, epoch, ik } = r as Record<string, unknown>;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 || typeof epoch !== "string" || typeof ik !== "string" || epoch.length > 128 || ik.length > 64) return undefined;
  return { resume: { version, epoch, ik } };
}
