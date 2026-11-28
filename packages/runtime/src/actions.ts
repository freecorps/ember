// Actions (PLAN §3): run in the Worker (or, for scheduled action jobs without a queue, in the shard's alarm), may do
// I/O, and reach shards only through `ctx.runQuery/runMutation/scheduler` — each call is one RPC to the shard's
// Durable Object (its own transaction). Internal functions are callable from actions; clients only reach public ones.

import {
  checkAccess,
  checkedEnv,
  checkShard,
  errorInfo,
  failApi,
  flattenFunctions,
  isForeignId,
  loadFunction,
  makeId,
  REPLICATED_SOURCE,
  resolveReference,
  scopesOf,
  type ActionBrowser,
  type ActionCtx,
  type AnyFunctionReference,
  type ComponentScopes,
  type HttpRoute,
  type Scope,
  type ActionScheduler,
  type AnyRegisteredFunction,
  type RegisteredHttpAction,
  type ShardHandle,
  type ListScheduledOptions,
  type ScheduledFunction,
  type WireError,
  type FanOutResult,
  type ShardEntry,
  type ShardsApi,
} from "@freecorps/ember-server";
import { validate, withDefaults } from "@freecorps/ember-values";
import { indexEnv, isValidShardName, type EmberConfig, type EmberEnv } from "./config.ts";
import type { Identity } from "./engine-types.ts";
import { actionImages, actionStorage, type FileRpc, type ImagesBindingLike } from "./files.ts";
import { recordCall, recordExecution } from "./metrics.ts";
import { reportFunctionError } from "./on-error.ts";
import type { aiSearch, ExternalIndexRpc, SearchDeps, vectorSearch } from "./ai-indexes.ts";
import type { JobInput, MutationOutcome } from "./shard.ts";
import { stringify } from "./wire.ts";

/** What an action needs from a shard: the Shard DO's RPC surface (a stub, or the DO itself). */
export interface ShardApi extends FileRpc, ExternalIndexRpc {
  query(shard: string, fn: string, args: unknown, identity: Identity | null, internal?: boolean, opts?: { caller?: boolean; system?: boolean }): Promise<MutationOutcome>;
  mutation(shard: string, fn: string, args: unknown, identity: Identity | null, internal?: boolean, opts?: { caller?: boolean; system?: boolean }): Promise<MutationOutcome>;
  enqueueJob(shard: string, job: JobInput): Promise<{ id: string | null }>;
  cancelJob(shard: string, id: string): Promise<boolean>;
  getScheduled(shard: string, id: string): Promise<ScheduledFunction | null>;
  listScheduled(shard: string, o?: ListScheduledOptions): Promise<ScheduledFunction[]>;
  /** `global:main` only: a page of the shard catalog (replicated.ts). */
  shardDirectory(kind: string, opts?: { cursor?: string | null; limit?: number }): Promise<{ shards: ShardEntry[]; next: string | null }>;
}

/** `ctx.shards.fanOut`: default and highest concurrency. */
export const FANOUT_CONCURRENCY = 8;
export const FANOUT_MAX_CONCURRENCY = 32;

/** Thrown inside an action when a shard call fails; carries the shard's error code. */
export class ActionCallError extends Error {
  override readonly name = "ActionCallError";
  /** `"app"` for an application error (`defineErrors`) the callee threw: it reaches the client as such. */
  readonly kind: "app" | "system";
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
    kind?: "app",
    /** HTTP status of an app error (typed routes answer with it). */
    readonly status?: number,
  ) {
    super(message);
    this.kind = kind ?? "system";
  }
}
/** Rethrows a callee's failure with its code, payload and kind. */
const callError = (e: WireError) => new ActionCallError(e.code, e.message, e.data, e.kind, e.status);

type Fn = AnyRegisteredFunction | RegisteredHttpAction;
const registry = new WeakMap<EmberConfig, { fns: Map<string, Fn>; scopes: ComponentScopes; ephemeral?: ReadonlySet<string> }>();

function lookup(config: EmberConfig) {
  let r = registry.get(config);
  if (!r) {
    r = { fns: flattenFunctions(config.functions), scopes: scopesOf(config.schema) };
    registry.set(config, r);
  }
  return r;
}

/** The mutations and actions declared `retainMs: 0`: a finished scheduled run of them keeps no `_jobs` row. */
export function ephemeralJobs(config: EmberConfig): ReadonlySet<string> {
  const r = lookup(config);
  if (!r.ephemeral) {
    const out = new Set<string>();
    for (const [name, f] of r.fns) if (f.type !== "httpAction" && (f as AnyRegisteredFunction).retainMs === 0) out.add(name);
    r.ephemeral = out;
  }
  return r.ephemeral;
}

const fail = (code: string, message: string): MutationOutcome => ({ ok: false, error: { code, message } });
const failWith = (error: WireError): MutationOutcome => ({ ok: false, error });

/** How a scheduled run of `fn` is dispatched: its `action({ dispatch, leaseMs })` options (nothing for others). */
export function actionDispatch(config: EmberConfig, fn: string): { dispatch?: "shard"; leaseMs?: number } {
  const f = lookup(config).fns.get(fn) as AnyRegisteredFunction | undefined;
  if (!f || f.type !== "action") return {};
  return { ...(f.dispatch ? { dispatch: f.dispatch } : {}), ...(f.leaseMs ? { leaseMs: f.leaseMs } : {}) };
}

const errInfo = (e: unknown): WireError => errorInfo(e, "Error");

export interface RunActionOptions {
  /** Allow internal actions (scheduler, other actions). Clients: false. */
  internal?: boolean;
  /**
   * A run the server started (a scheduled job, a cron): with no identity, `fromAuth` shards check no claim, here and
   * in the action's own `ctx.runQuery/runMutation/runAction`.
   */
  system?: boolean;
  /** `args` already went through `prepare` (defaults applied, validated): not done again. */
  prepared?: boolean;
}

/**
 * Runs actions against shards resolved by `shardApi`. One instance per request (or per alarm turn) is fine: the
 * function registry is cached per config.
 */
/**
 * `ctx.browser` without loading browser.ts until an action renders something: each method imports it on first call
 * (one chunk of the split Worker build), and `binding` reads the env as `actionBrowser`'s does.
 */
export function lazyBrowser(env: Record<string, unknown>, importBrowser: () => Promise<Pick<typeof import("./browser.ts"), "actionBrowser">> = () => import("./browser.ts")): ActionBrowser {
  let real: Promise<ActionBrowser> | undefined;
  // A rejected load is forgotten, so a transient failure is retried by the next call instead of poisoning the runner.
  const load = () => {
    if (!real) {
      const p = importBrowser().then((m) => m.actionBrowser(env));
      real = p;
      p.catch(() => {
        if (real === p) real = undefined;
      });
    }
    return real;
  };
  return {
    get binding() {
      return env.EMBER_BROWSER;
    },
    pdf: async (page, o) => (await load()).pdf(page, o),
    screenshot: async (page, o) => (await load()).screenshot(page, o),
    content: async (page, o) => (await load()).content(page, o),
  };
}

export class ActionRunner {
  constructor(
    private readonly config: EmberConfig,
    private readonly env: EmberEnv,
    private readonly shardApi: (shard: string) => ShardApi,
  ) {}

  /** Visibility/type check, same rules as queries and mutations (contracts.md). */
  check(fn: string, internal: boolean): { code: string; message: string } | null {
    const f = lookup(this.config).fns.get(fn);
    // Component functions (`@x/...`) are never client-callable; the app reaches them through ctx.run*.
    if (!f || (!internal && (fn.startsWith("@") || (f.type !== "httpAction" && f.visibility !== "public")))) return { code: "FunctionNotFound", message: `Function ${fn} not found` };
    if (f.type !== "action") return { code: "InvalidFunction", message: `${fn} is a ${f.type}, not an action` };
    return null;
  }

  /**
   * The checks of `run` that need no shard and no identity (visibility, type, argument defaults and validation):
   * `POST /api/action` runs them before asking the shard about the identity, so a client mistake wakes no DO. A
   * failure is the outcome `run` would give (pass it to `run` to record it); else the args to pass with `prepared`.
   */
  prepare(fn: string, args: unknown, internal = false): { ok: true; args: unknown } | { ok: false } {
    if (this.check(fn, internal)) return { ok: false };
    const f = lookup(this.config).fns.get(fn) as AnyRegisteredFunction;
    if (!lookup(this.config).scopes.scopeOfFunction(fn)) return { ok: false };
    const ready = withDefaults(f.args, args ?? {});
    return this.validate(fn, f.args, ready, "arguments") ? { ok: false } : { ok: true, args: ready };
  }

  async run(fn: string, args: unknown, shard: string, identity: Identity | null, opts: RunActionOptions = {}): Promise<MutationOutcome> {
    const t = performance.now();
    const out = await this.runInner(fn, args, shard, identity, opts);
    // Rows are counted by the shard calls the action makes (recorded as their own query/mutation points).
    recordExecution(this.env, {
      fn,
      kind: "action",
      shard,
      status: out.ok ? "ok" : "error",
      ...(out.ok ? {} : { errorCode: out.error.code }),
      durationMs: performance.now() - t,
      ...(out.ok ? { bytesOut: () => stringify(out.value ?? null).length } : {}),
      timing: "wall",
    });
    return out;
  }

  private async runInner(fn: string, args: unknown, shard: string, identity: Identity | null, opts: RunActionOptions): Promise<MutationOutcome> {
    const denied = this.check(fn, !!opts.internal);
    if (denied) return { ok: false, error: denied };
    const scope = lookup(this.config).scopes.scopeOfFunction(fn);
    if (!scope) return fail("FunctionNotFound", `Function ${fn} not found`);
    let f: AnyRegisteredFunction;
    try {
      // A lazy action (a module of actions only, `lazyActions`): its module is imported now, on first use.
      f = await loadFunction(lookup(this.config).fns.get(fn) as AnyRegisteredFunction);
    } catch (e) {
      // A module that cannot load fails every call: `onError` hears of it like a handler's throw.
      const info = errInfo(e);
      await reportFunctionError(this.config.app?.onError, this.env, { fn, kind: "action", shard, error: info, thrown: e });
      return failWith(info);
    }
    // `check` saw the stand-in; the loaded definition gets the same rule (`lazyActions` already refuses one that
    // differs from the build's metadata: this keeps the gate here even if that check changes).
    if (f.type !== "action" || (!opts.internal && f.visibility !== "public")) return fail("FunctionNotFound", `Function ${fn} not found`);
    if (!opts.prepared) {
      args = withDefaults(f.args, args ?? {});
      const bad = this.validate(fn, f.args, args, "arguments");
      if (bad) return bad;
    }
    try {
      const system = !!opts.system && identity === null;
      checkShard(fn, f.shard, shard, args, system ? { identity: null, system: true } : { identity });
      const value = await f.handler({ ...this.ctx(shard, identity, scope, system), fail: failApi(f) }, args);
      if (f.returns) {
        const r = this.validate(fn, f.returns, value, "return value");
        if (r) return r;
      }
      return { ok: true, value, version: 0 };
    } catch (e) {
      const info = errInfo(e);
      // `defineApp({ onError })`: a failed shard call was reported by its shard (or was a refusal), not again here.
      if (!(e instanceof ActionCallError)) await reportFunctionError(this.config.app?.onError, this.env, { fn, kind: "action", shard, error: info, thrown: e });
      return failWith(info);
    }
  }

  private validate(fn: string, shape: Parameters<typeof validate>[0], value: unknown, what: string): MutationOutcome | null {
    const { scopes } = lookup(this.config);
    const scope = scopes.scopeOfFunction(fn) ?? scopes.root;
    // The Worker has no shard's table-number map: a foreign id (an import kept it) passes here, the shard checks it.
    const r = validate(shape, value, { tableOfId: (id) => scopes.tableOfIdIn(scope, id), acceptId: isForeignId });
    return r.ok ? null : failWith({ code: "ValidationError", message: `Invalid ${what} of ${fn}: ${r.path}: ${r.message}`, data: { path: r.path, issues: [{ path: r.path, message: r.message }] } });
  }

  /** A reference called from `scope` → its absolute name (own scope, a direct child's public function, a handle). */
  private resolve(scope: Scope, ref: unknown, type: "query" | "mutation" | "action" | "schedulable"): { name: string; fn: AnyRegisteredFunction } {
    let name = "?";
    try {
      const r = resolveReference(scope.path, ref as AnyFunctionReference);
      name = r.name;
      const f = checkAccess(lookup(this.config).fns, r);
      if (f.type === "httpAction") throw new ActionCallError("InvalidFunction", `${name} is an httpAction`);
      const ok = type === "schedulable" ? f.type === "mutation" || f.type === "action" : f.type === type;
      if (!ok) {
        throw new ActionCallError("InvalidFunction", type === "schedulable" ? `Cannot schedule ${name}: only mutations and actions can be scheduled` : `${name} is a ${f.type}, not a ${type}`);
      }
      return { name, fn: f };
    } catch (e) {
      if (e instanceof ActionCallError) throw e;
      const { code, message } = errInfo(e);
      throw new ActionCallError(code, type === "schedulable" ? `Cannot schedule ${name}: function not found` : message);
    }
  }

  /** An ActionCtx in a component's scope (queue consumers, `email()` hooks): `path` is the install path. */
  scopedCtx(path: readonly string[], shard: string): ActionCtx {
    const { scopes } = lookup(this.config);
    const scope = scopes.scope(path);
    if (!scope) throw new ActionCallError("FunctionNotFound", `Component ${path.join("/")} is not installed`);
    if (!isValidShardName(shard)) throw new ActionCallError("bad_shard", `Invalid shard ${JSON.stringify(shard)}`);
    return this.ctx(shard, null, scope, true);
  }

  /**
   * Runs an HTTP route's httpAction (ember/http.ts or a component's router) and returns its Response. A failure's
   * `onError` report goes to `waitUntil` (the 500 does not wait for it); without one it is awaited.
   */
  async runHttp(route: HttpRoute & { scope: string[] }, request: Request, identity: Identity | null, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
    const { scopes } = lookup(this.config);
    const scope = scopes.scope(route.scope) ?? scopes.root;
    const t = performance.now();
    const label = `http:${route.method} ${route.path ?? route.pathPrefix + "*"}`;
    let shard = "global:main";
    let status = 500;
    let errorCode: string | undefined;
    try {
      shard = typeof route.shard === "function" ? route.shard(request) : (route.shard ?? "global:main");
      if (!isValidShardName(shard)) throw new ActionCallError("bad_shard", `Invalid shard ${JSON.stringify(shard)} for ${label}`);
      const res = await route.handler.handler(this.ctx(shard, identity, scope), request);
      if (!(res instanceof Response)) throw new Error(`${label} did not return a Response`);
      status = res.status;
      return res;
    } catch (e) {
      const info = errInfo(e);
      errorCode = info.code;
      console.error(`ember: ${label} failed: ${info.code}: ${info.message}`);
      const report = e instanceof ActionCallError ? undefined : reportFunctionError(this.config.app?.onError, this.env, { fn: label, kind: "http", shard, error: info, thrown: e });
      if (report) {
        if (waitUntil) waitUntil(report);
        else await report;
      }
      return new Response(stringify({ ok: false, error: { code: "Error", message: "internal error" } }), { status: 500, headers: { "content-type": "application/json" } });
    } finally {
      recordExecution(this.env, {
        fn: label,
        kind: "action",
        shard,
        status: errorCode || status >= 500 ? "error" : "ok",
        ...(errorCode ? { errorCode } : {}),
        durationMs: performance.now() - t,
        timing: "wall",
      });
    }
  }

  /** `system`: a system run's ctx (no identity): its shard calls check no `fromAuth` claim. */
  ctx(shard: string, identity: Identity | null, scope: Scope = lookup(this.config).scopes.root, system = false): ActionCtx {
    system &&= identity === null;
    const handle = this.handle(shard, identity, scope, system);
    const storage = actionStorage(this.env, shard, () => this.shardApi(shard));
    const images = actionImages(this.config.files?.images ?? (this.env.EMBER_IMAGES as ImagesBindingLike | undefined), storage);
    return {
      ...handle,
      storage,
      images,
      browser: lazyBrowser(this.env as Record<string, unknown>),
      auth: {
        getUserIdentity: async () => identity,
        require: async () => {
          if (!identity) throw new ActionCallError("Unauthenticated", "Not signed in");
          return identity;
        },
      },
      runAction: async (ref: unknown, args?: unknown) => {
        const { name } = this.resolve(scope, ref, "action");
        const out = await this.run(name, args ?? {}, shard, identity, { internal: true, ...(system ? { system } : {}) });
        if (!out.ok) throw callError(out.error);
        return out.value;
      },
      onShard: (other: string) => {
        if (typeof other !== "string" || !isValidShardName(other)) throw new ActionCallError("bad_shard", `Invalid shard ${JSON.stringify(other)} (expected <kind>:<key>)`);
        return this.handle(other, identity, scope, system);
      },
      shards: this.shards(identity, scope, system),
      env: checkedEnv(this.env as Record<string, unknown>, this.config.app?.env),
      now: Date.now(),
      // External index search (ai-indexes.ts) loads on first use: most actions never search.
      vectorSearch: (table: string, index: string, query: Parameters<typeof vectorSearch>[4]) => {
        const deps = this.searchDeps(), phys = this.phys(scope, table);
        return import("./ai-indexes.ts").then((m) => m.vectorSearch(deps, shard, phys, index, query));
      },
      aiSearch: (table: string, index: string, query: Parameters<typeof aiSearch>[4]) => {
        const deps = this.searchDeps(), phys = this.phys(scope, table);
        return import("./ai-indexes.ts").then((m) => m.aiSearch(deps, shard, phys, index, query));
      },
      ...(scope.path.length ? { component: { name: scope.key, config: scope.config } } : {}),
    } as unknown as ActionCtx;
  }

  /** `ctx.shards` (PLAN §22 L5): the catalog `global:main` keeps, and a bounded fan-out over it. */
  private shards(identity: Identity | null, scope: Scope, system: boolean): ShardsApi {
    const list: ShardsApi["list"] = async (kind, o = {}) => {
      if (typeof kind !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(kind)) throw new ActionCallError("ValidationError", `ctx.shards.list: invalid shard kind ${JSON.stringify(kind)}`);
      const limit = o.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ActionCallError("ValidationError", "ctx.shards.list: limit must be an integer in 1..1000");
      return this.shardApi(REPLICATED_SOURCE).shardDirectory(kind, { cursor: o.cursor ?? null, limit });
    };
    return {
      list,
      fanOut: (async (kind: string, ref: unknown, args: unknown, o: { concurrency?: number; limit?: number } = {}) => {
        const concurrency = o.concurrency ?? FANOUT_CONCURRENCY;
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > FANOUT_MAX_CONCURRENCY) {
          throw new ActionCallError("ValidationError", `ctx.shards.fanOut: concurrency must be an integer in 1..${FANOUT_MAX_CONCURRENCY}`);
        }
        if (o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 1)) throw new ActionCallError("ValidationError", "ctx.shards.fanOut: limit must be a positive integer");
        const type = this.typeOf(scope, ref);
        const targets: string[] = [];
        for (let cursor: string | null = null; ; ) {
          const page = await list(kind, { cursor, limit: 1000 });
          for (const s of page.shards) if (o.limit === undefined || targets.length < o.limit) targets.push(s.shard);
          cursor = page.next;
          if (!cursor || (o.limit !== undefined && targets.length >= o.limit)) break;
        }
        const results: Array<FanOutResult<unknown>> = new Array(targets.length);
        let next = 0;
        const worker = async () => {
          for (let i = next++; i < targets.length; i = next++) {
            const shard = targets[i]!;
            const h = this.handle(shard, identity, scope, system);
            try {
              const run = (type === "query" ? h.runQuery : h.runMutation) as (fn: unknown, a: unknown) => Promise<unknown>;
              const value = await run(ref, args ?? {});
              results[i] = { shard, ok: true, value };
            } catch (e) {
              const err = e instanceof ActionCallError ? { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } : { code: errInfo(e).code, message: errInfo(e).message };
              results[i] = { shard, ok: false, error: err };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
        return results;
      }) as ShardsApi["fanOut"],
    };
  }

  /** Whether `ref` (from `scope`) is a query or a mutation (fan-out runs either). */
  private typeOf(scope: Scope, ref: unknown): "query" | "mutation" {
    try {
      const f = checkAccess(lookup(this.config).fns, resolveReference(scope.path, ref as AnyFunctionReference));
      if (f.type === "query" || f.type === "mutation") return f.type;
      throw new ActionCallError("InvalidFunction", `ctx.shards.fanOut runs a query or a mutation, not a ${f.type}`);
    } catch (e) {
      if (e instanceof ActionCallError) throw e;
      const { code, message } = errInfo(e);
      throw new ActionCallError(code, message);
    }
  }

  /** Logical table of `scope` → physical (unknown names pass through: the search reports them). */
  private phys(scope: Scope, table: string): string {
    return scope.tables.get(table) ?? (scope.path.length ? `${scope.prefix}${table}` : table);
  }

  private searchDeps(): SearchDeps {
    return { env: indexEnv(this.config, this.env), manifest: this.config.schema.manifest, rpc: (s) => this.shardApi(s) };
  }

  private handle(shard: string, identity: Identity | null, scope: Scope, system = false): ShardHandle {
    const api = () => this.shardApi(shard);
    const unwrap = (out: MutationOutcome) => {
      if (!out.ok) throw callError(out.error);
      return out.value;
    };
    const schedule = async (runAt: number, ref: unknown, args: unknown): Promise<string> => {
      const { name, fn: f } = this.resolve(scope, ref, "schedulable");
      const bad = this.validate(name, f.args, args ?? {}, "arguments");
      if (bad && !bad.ok) throw callError(bad.error);
      if (!Number.isFinite(runAt)) throw new ActionCallError("ValidationError", "Scheduled time must be a finite number");
      const jobId = makeId("job", Date.now(), Math.random);
      const r = await api().enqueueJob(shard, { fn: name, args: args ?? {}, kind: f.type as "mutation" | "action", runAt, jobId });
      return r.id ?? jobId;
    };
    const scheduler: ActionScheduler = {
      runAfter: (delayMs: number, ref: unknown, args?: unknown) => schedule(Date.now() + Math.max(0, delayMs), ref, args),
      runAt: (ts: number | Date, ref: unknown, args?: unknown) => schedule(ts instanceof Date ? ts.getTime() : ts, ref, args),
      cancel: (id: string) => api().cancelJob(shard, id),
      get: (id: string) => api().getScheduled(shard, id),
      list: (o?: ListScheduledOptions) => api().listScheduled(shard, o ?? {}),
    } as ActionScheduler;
    // Each call is recorded here with the wall time around the RPC (`timing: "rpc"`, metrics.ts).
    const call = async (kind: "query" | "mutation", ref: unknown, args: unknown) => {
      const { name: fn } = this.resolve(scope, ref, kind);
      const t0 = performance.now();
      const out = await api()[kind](shard, fn, args ?? {}, identity, true, { caller: true, ...(system ? { system } : {}) });
      recordCall(this.env, kind, fn, shard, out, performance.now() - t0);
      return unwrap(out);
    };
    return {
      shard,
      runQuery: ((ref: unknown, args?: unknown) => call("query", ref, args)) as ShardHandle["runQuery"],
      runMutation: ((ref: unknown, args?: unknown) => call("mutation", ref, args)) as ShardHandle["runMutation"],
      scheduler,
    };
  }
}
