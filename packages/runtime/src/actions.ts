// Actions (PLAN §3): run in the Worker (or, for scheduled action jobs without a queue, in the shard's alarm), may do
// I/O, and reach shards only through `ctx.runQuery/runMutation/scheduler` — each call is one RPC to the shard's
// Durable Object (its own transaction). Internal functions are callable from actions; clients only reach public ones.

import {
  flattenFunctions,
  getFunctionName,
  makeId,
  parseId,
  type ActionCtx,
  type ActionScheduler,
  type AnyRegisteredFunction,
  type RegisteredHttpAction,
  type ShardHandle,
} from "@freecorps/ember-server";
import { validate } from "@freecorps/ember-values";
import { indexEnv, isValidShardName, type EmberConfig, type EmberEnv } from "./config.ts";
import type { Identity } from "./engine-types.ts";
import { actionImages, actionStorage, type FileRpc, type ImagesBindingLike } from "./files.ts";
import { recordExecution } from "./metrics.ts";
import { aiSearch, vectorSearch, type ExternalIndexRpc, type SearchDeps } from "./ai-indexes.ts";
import type { JobInput, MutationOutcome } from "./shard.ts";
import { stringify } from "./wire.ts";

/** What an action needs from a shard: the Shard DO's RPC surface (a stub, or the DO itself). */
export interface ShardApi extends FileRpc, ExternalIndexRpc {
  query(shard: string, fn: string, args: unknown, identity: Identity | null, internal?: boolean): Promise<MutationOutcome>;
  mutation(shard: string, fn: string, args: unknown, identity: Identity | null, internal?: boolean): Promise<MutationOutcome>;
  enqueueJob(shard: string, job: JobInput): Promise<{ id: string | null }>;
  cancelJob(shard: string, id: string): Promise<boolean>;
}

/** Thrown inside an action when a shard call fails; carries the shard's error code. */
export class ActionCallError extends Error {
  override readonly name = "ActionCallError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Fn = AnyRegisteredFunction | RegisteredHttpAction;
const registry = new WeakMap<EmberConfig, { fns: Map<string, Fn>; prefixes: Map<string, string> }>();

function lookup(config: EmberConfig) {
  let r = registry.get(config);
  if (!r) {
    const prefixes = new Map<string, string>();
    for (const [name, t] of Object.entries(config.schema.manifest.tables)) prefixes.set(t.idPrefix, name);
    r = { fns: flattenFunctions(config.functions), prefixes };
    registry.set(config, r);
  }
  return r;
}

const fail = (code: string, message: string): MutationOutcome => ({ ok: false, error: { code, message } });

function errInfo(e: unknown): { code: string; message: string } {
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "Error";
  return { code, message: e instanceof Error ? e.message : String(e) };
}

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
    if (!f || (f.type !== "httpAction" && f.visibility !== "public" && !internal)) return { code: "FunctionNotFound", message: `Function ${fn} not found` };
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
    });
    return out;
  }

  private async runInner(fn: string, args: unknown, shard: string, identity: Identity | null, opts: RunActionOptions): Promise<MutationOutcome> {
    const denied = this.check(fn, !!opts.internal);
    if (denied) return { ok: false, error: denied };
    const f = lookup(this.config).fns.get(fn) as AnyRegisteredFunction;
    const bad = this.validate(fn, f.args, args ?? {}, "arguments");
    if (bad) return bad;
    try {
      const value = await f.handler(this.ctx(shard, identity), args ?? {});
      if (f.returns) {
        const r = this.validate(fn, f.returns, value, "return value");
        if (r) return r;
      }
      return { ok: true, value, version: 0 };
    } catch (e) {
      const { code, message } = errInfo(e);
      return fail(code, message);
    }
  }

  private validate(fn: string, shape: Parameters<typeof validate>[0], value: unknown, what: string): MutationOutcome | null {
    const { prefixes } = lookup(this.config);
    const r = validate(shape, value, { tableOfId: (id) => (id && parseId(id) ? prefixes.get(parseId(id)!.prefix) : undefined) });
    return r.ok ? null : fail("ValidationError", `Invalid ${what} of ${fn}: ${r.path}: ${r.message}`);
  }

  ctx(shard: string, identity: Identity | null): ActionCtx {
    const handle = this.handle(shard, identity);
    const storage = actionStorage(this.env, shard, () => this.shardApi(shard));
    const images = actionImages(this.config.files?.images ?? (this.env.EMBER_IMAGES as ImagesBindingLike | undefined), storage);
    return {
      ...handle,
      storage,
      images,
      auth: { getUserIdentity: async () => identity },
      runAction: async (ref: unknown, args?: unknown) => {
        const out = await this.run(getFunctionName(ref as string), args ?? {}, shard, identity, { internal: true });
        if (!out.ok) throw new ActionCallError(out.error.code, out.error.message);
        return out.value;
      },
      onShard: (other: string) => {
        if (typeof other !== "string" || !isValidShardName(other)) throw new ActionCallError("bad_shard", `Invalid shard ${JSON.stringify(other)} (expected <kind>:<key>)`);
        return this.handle(other, identity);
      },
      env: this.env as Record<string, unknown>,
      now: Date.now(),
      vectorSearch: (table: string, index: string, query: Parameters<typeof vectorSearch>[4]) => vectorSearch(this.searchDeps(), shard, table, index, query),
      aiSearch: (table: string, index: string, query: Parameters<typeof aiSearch>[4]) => aiSearch(this.searchDeps(), shard, table, index, query),
    } as unknown as ActionCtx;
  }

  private searchDeps(): SearchDeps {
    return { env: indexEnv(this.config, this.env), manifest: this.config.schema.manifest, rpc: (s) => this.shardApi(s) };
  }

  private handle(shard: string, identity: Identity | null): ShardHandle {
    const api = () => this.shardApi(shard);
    const unwrap = (out: MutationOutcome) => {
      if (!out.ok) throw new ActionCallError(out.error.code, out.error.message);
      return out.value;
    };
    const schedule = async (runAt: number, ref: unknown, args: unknown): Promise<string> => {
      const name = getFunctionName(ref as string);
      const f = lookup(this.config).fns.get(name);
      if (!f) throw new ActionCallError("FunctionNotFound", `Cannot schedule ${name}: function not found`);
      if (f.type !== "mutation" && f.type !== "action") throw new ActionCallError("InvalidFunction", `Cannot schedule ${name}: only mutations and actions can be scheduled`);
      const bad = this.validate(name, f.args, args ?? {}, "arguments");
      if (bad && !bad.ok) throw new ActionCallError(bad.error.code, bad.error.message);
      if (!Number.isFinite(runAt)) throw new ActionCallError("ValidationError", "Scheduled time must be a finite number");
      const jobId = makeId("job", Date.now(), Math.random);
      const r = await api().enqueueJob(shard, { fn: name, args: args ?? {}, kind: f.type, runAt, jobId });
      return r.id ?? jobId;
    };
    const scheduler: ActionScheduler = {
      runAfter: (delayMs: number, ref: unknown, args?: unknown) => schedule(Date.now() + Math.max(0, delayMs), ref, args),
      runAt: (ts: number | Date, ref: unknown, args?: unknown) => schedule(ts instanceof Date ? ts.getTime() : ts, ref, args),
      cancel: (id: string) => api().cancelJob(shard, id),
    } as ActionScheduler;
    return {
      shard,
      runQuery: (async (ref: unknown, args?: unknown) => unwrap(await api().query(shard, getFunctionName(ref as string), args ?? {}, identity, true))) as ShardHandle["runQuery"],
      runMutation: (async (ref: unknown, args?: unknown) => unwrap(await api().mutation(shard, getFunctionName(ref as string), args ?? {}, identity, true))) as ShardHandle["runMutation"],
      scheduler,
    };
  }
}
