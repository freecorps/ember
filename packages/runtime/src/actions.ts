// Actions (PLAN §3): run in the Worker (or, for scheduled action jobs without a queue, in the shard's alarm), may do
// I/O, and reach shards only through `ctx.runQuery/runMutation/scheduler` — each call is one RPC to the shard's
// Durable Object (its own transaction). Internal functions are callable from actions; clients only reach public ones.

import {
  checkAccess,
  errorInfo,
  failApi,
  flattenFunctions,
  makeId,
  resolveReference,
  scopesOf,
  type ActionCtx,
  type AnyFunctionReference,
  type ComponentScopes,
  type HttpRoute,
  type Scope,
  type ActionScheduler,
  type AnyRegisteredFunction,
  type RegisteredHttpAction,
  type ShardHandle,
  type WireError,
} from "@freecorps/ember-server";
import { validate } from "@freecorps/ember-values";
import { indexEnv, isValidShardName, type EmberConfig, type EmberEnv } from "./config.ts";
import type { Identity } from "./engine-types.ts";
import { actionImages, actionStorage, type FileRpc, type ImagesBindingLike } from "./files.ts";
import { actionBrowser } from "./browser.ts";
import { recordCall, recordExecution } from "./metrics.ts";
import { aiSearch, vectorSearch, type ExternalIndexRpc, type SearchDeps } from "./ai-indexes.ts";
import type { JobInput, MutationOutcome } from "./shard.ts";
import { stringify } from "./wire.ts";

/** What an action needs from a shard: the Shard DO's RPC surface (a stub, or the DO itself). */
export interface ShardApi extends FileRpc, ExternalIndexRpc {
  query(shard: string, fn: string, args: unknown, identity: Identity | null, internal?: boolean, opts?: { caller?: boolean }): Promise<MutationOutcome>;
  mutation(shard: string, fn: string, args: unknown, identity: Identity | null, internal?: boolean, opts?: { caller?: boolean }): Promise<MutationOutcome>;
  enqueueJob(shard: string, job: JobInput): Promise<{ id: string | null }>;
  cancelJob(shard: string, id: string): Promise<boolean>;
}

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
  ) {
    super(message);
    this.kind = kind ?? "system";
  }
}
/** Rethrows a callee's failure with its code, payload and kind. */
const callError = (e: WireError) => new ActionCallError(e.code, e.message, e.data, e.kind);

type Fn = AnyRegisteredFunction | RegisteredHttpAction;
const registry = new WeakMap<EmberConfig, { fns: Map<string, Fn>; scopes: ComponentScopes }>();

function lookup(config: EmberConfig) {
  let r = registry.get(config);
  if (!r) {
    r = { fns: flattenFunctions(config.functions), scopes: scopesOf(config.schema) };
    registry.set(config, r);
  }
  return r;
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
}

/**
 * Runs actions against shards resolved by `shardApi`. One instance per request (or per alarm turn) is fine: the
 * function registry is cached per config.
 */
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
    const f = lookup(this.config).fns.get(fn) as AnyRegisteredFunction;
    const scope = lookup(this.config).scopes.scopeOfFunction(fn);
    if (!scope) return fail("FunctionNotFound", `Function ${fn} not found`);
    const bad = this.validate(fn, f.args, args ?? {}, "arguments");
    if (bad) return bad;
    try {
      const value = await f.handler({ ...this.ctx(shard, identity, scope), fail: failApi(f) }, args ?? {});
      if (f.returns) {
        const r = this.validate(fn, f.returns, value, "return value");
        if (r) return r;
      }
      return { ok: true, value, version: 0 };
    } catch (e) {
      return failWith(errInfo(e));
    }
  }

  private validate(fn: string, shape: Parameters<typeof validate>[0], value: unknown, what: string): MutationOutcome | null {
    const { scopes } = lookup(this.config);
    const scope = scopes.scopeOfFunction(fn) ?? scopes.root;
    const r = validate(shape, value, { tableOfId: (id) => scopes.tableOfIdIn(scope, id) });
    return r.ok ? null : fail("ValidationError", `Invalid ${what} of ${fn}: ${r.path}: ${r.message}`);
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
    return this.ctx(shard, null, scope);
  }

  /** Runs an HTTP route's httpAction (ember/http.ts or a component's router) and returns its Response. */
  async runHttp(route: HttpRoute & { scope: string[] }, request: Request, identity: Identity | null): Promise<Response> {
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

  ctx(shard: string, identity: Identity | null, scope: Scope = lookup(this.config).scopes.root): ActionCtx {
    const handle = this.handle(shard, identity, scope);
    const storage = actionStorage(this.env, shard, () => this.shardApi(shard));
    const images = actionImages(this.config.files?.images ?? (this.env.EMBER_IMAGES as ImagesBindingLike | undefined), storage);
    return {
      ...handle,
      storage,
      images,
      browser: actionBrowser(this.env as Record<string, unknown>),
      auth: {
        getUserIdentity: async () => identity,
        require: async () => {
          if (!identity) throw new ActionCallError("Unauthenticated", "Not signed in");
          return identity;
        },
      },
      runAction: async (ref: unknown, args?: unknown) => {
        const { name } = this.resolve(scope, ref, "action");
        const out = await this.run(name, args ?? {}, shard, identity, { internal: true });
        if (!out.ok) throw callError(out.error);
        return out.value;
      },
      onShard: (other: string) => {
        if (typeof other !== "string" || !isValidShardName(other)) throw new ActionCallError("bad_shard", `Invalid shard ${JSON.stringify(other)} (expected <kind>:<key>)`);
        return this.handle(other, identity, scope);
      },
      env: this.env as Record<string, unknown>,
      now: Date.now(),
      vectorSearch: (table: string, index: string, query: Parameters<typeof vectorSearch>[4]) => vectorSearch(this.searchDeps(), shard, this.phys(scope, table), index, query),
      aiSearch: (table: string, index: string, query: Parameters<typeof aiSearch>[4]) => aiSearch(this.searchDeps(), shard, this.phys(scope, table), index, query),
      ...(scope.path.length ? { component: { name: scope.key, config: scope.config } } : {}),
    } as unknown as ActionCtx;
  }

  /** Logical table of `scope` → physical (unknown names pass through: the search reports them). */
  private phys(scope: Scope, table: string): string {
    return scope.tables.get(table) ?? (scope.path.length ? `${scope.prefix}${table}` : table);
  }

  private searchDeps(): SearchDeps {
    return { env: indexEnv(this.config, this.env), manifest: this.config.schema.manifest, rpc: (s) => this.shardApi(s) };
  }

  private handle(shard: string, identity: Identity | null, scope: Scope): ShardHandle {
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
    } as ActionScheduler;
    // Each call is recorded here with the wall time around the RPC (`timing: "rpc"`, metrics.ts).
    const call = async (kind: "query" | "mutation", ref: unknown, args: unknown) => {
      const { name: fn } = this.resolve(scope, ref, kind);
      const t0 = performance.now();
      const out = await api()[kind](shard, fn, args ?? {}, identity, true, { caller: true });
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
