/**
 * `@freecorps/ember-workpool`: bounded parallelism as an Ember component (PLAN §12, §22 L11), on the shard scheduler.
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(workpool, { name: "aiPool" }).use(workpool, { name: "emailPool" });
 *
 *   // ember/ai.ts
 *   const pool = new Workpool(components.aiPool, { maxParallelism: 4, retry: { maxAttempts: 5, initialBackoffMs: 1000, base: 2 } });
 *   export const start = mutation({ args: { id: v.string() }, handler: (ctx, a) =>
 *     pool.enqueueAction(ctx, internal.ai.summarize, { docId: a.id }, { onComplete: internal.ai.saved, context: { docId: a.id } }) });
 *   export const saved = internalMutation({ args: vOnCompleteArgs, handler: (ctx, { result, context }) => { ... } });
 *
 * In a mutation, enqueueing is synchronous and atomic with it; in an action it is its own transaction. The pool's
 * tables live in the caller's shard, so `maxParallelism` is per pool **per shard**. For one cap across shards, pin the
 * pool to a shard (`{ shard: "global:main" }`) and enqueue from actions (see the README).
 */
import { createFunctionHandle, v, type FunctionReference, type Visibility } from "@freecorps/ember-server";
import { DEFAULT_RETRY, vResultValidator, type RetryBehavior, type WorkResult, type WorkStatus, type WorkpoolStats } from "./component.ts";

export {
  workpool,
  functions as workpoolFunctions,
  installConfigValidator,
  retryValidator,
  vResultValidator,
  DEFAULT_MAX_PARALLELISM,
  DEFAULT_RECLAIM_INTERVAL_MS,
  DEFAULT_RETENTION_MS,
  DEFAULT_RETRY,
  MAX_PARALLELISM_LIMIT,
  MAX_POSITION,
  RUN_LEASE_MS,
  type RetryBehavior,
  type RunOutcome,
  type WorkResult,
  type WorkStatus,
  type WorkpoolInstallConfig,
  type WorkpoolStats,
} from "./component.ts";

/** The args of an `onComplete` mutation: `internalMutation({ args: vOnCompleteArgs, handler })`. */
export const vOnCompleteArgs = { workId: v.string(), context: v.any(), result: vResultValidator };
export type OnCompleteArgs<Context = unknown, Ret = unknown> = { workId: string; context: Context; result: WorkResult<Ret> };

export type WorkItem = {
  kind: "action" | "mutation";
  fn: string;
  args?: unknown;
  onComplete?: string;
  context?: unknown;
  retry?: RetryBehavior;
  priority?: number;
  key?: string;
};
type EnqueueArgs = { items: WorkItem[]; maxParallelism?: number; retentionMs?: number; reclaimIntervalMs?: number };

/** What `components.<name>` of the workpool component looks like (structural: any install name works). */
export interface WorkpoolComponentApi {
  lib: {
    enqueue: FunctionReference<"mutation", "public", EnqueueArgs, string[]>;
    status: FunctionReference<"query", "public", { id: string }, WorkStatus | null>;
    stats: FunctionReference<"query", "public", Record<string, never>, WorkpoolStats>;
    cancel: FunctionReference<"mutation", "public", { id: string }, boolean>;
    cancelAll: FunctionReference<"mutation", "public", Record<string, never>, number>;
  };
}

type QueryRef = FunctionReference<"query", "public">;
type MutationRef = FunctionReference<"mutation", "public">;
/** A mutation's ctx: calls run in its transaction and return values. */
export interface SyncWriteCtx {
  db: object;
  runQuery(fn: QueryRef, args: Record<string, unknown>): unknown;
  runMutation(fn: MutationRef, args: Record<string, unknown>): unknown;
}
/** A query's (or mutation's) ctx. */
export interface SyncReadCtx {
  db: object;
  runQuery(fn: QueryRef, args: Record<string, unknown>): unknown;
}
/** An action's ctx, or `ctx.onShard(shard)`: each call is its own transaction. */
export interface AsyncCtx {
  runQuery(fn: QueryRef, args: Record<string, unknown>): Promise<unknown>;
  runMutation(fn: MutationRef, args: Record<string, unknown>): Promise<unknown>;
  onShard?(shard: string): AsyncCtx;
}

export interface WorkpoolOptions {
  /** Items running at once (per shard). Default: the install config's, else 10. Sent with every enqueue. */
  maxParallelism?: number;
  /**
   * Retries for action items: a behavior (or `true` for `DEFAULT_RETRY`) retries every action unless the item says
   * `retry: false`. Default: no retries. Mutation items are only retried when the item asks (`retry`).
   */
  retry?: RetryBehavior | boolean;
  /** How long finished items are kept for `status` (default 1 day; 0 = deleted right after onComplete). */
  retentionMs?: number;
  /** How often running items are checked for a lost job (default 60 s). */
  reclaimIntervalMs?: number;
  /**
   * Pin the pool to one shard (e.g. `"global:main"`) for one cap across shards: every call goes through
   * `ctx.onShard(shard)`, so it needs an action ctx. Inside that shard, use `pool.here`.
   */
  shard?: string;
}

/** Any mutation usable as `onComplete` (args `vOnCompleteArgs`, or a typed `result`). */
export type OnCompleteRef = FunctionReference<"mutation", Visibility, OnCompleteArgs>;
/**
 * `onComplete` must accept the item's result: its `result` arg has to take `WorkResult<Ret>` (a handler typed with
 * `vOnCompleteArgs`, whose `returnValue` is `unknown`, takes any). A mismatch is a type error on `onComplete`. A work
 * function of unknown return (a hand-written `unsafeRef`) is not checked.
 */
export type AcceptsResult<C, Ret> = unknown extends Ret
  ? unknown
  : C extends { readonly _args: { result: infer A } }
  ? [WorkResult<Ret>] extends [A]
    ? unknown
    : { readonly "onComplete does not accept this work's result": WorkResult<Ret> }
  : unknown;

export interface EnqueueOptions<Ret = unknown, C extends OnCompleteRef = OnCompleteRef> {
  /**
   * A mutation run when the item finishes, in that transaction, with `OnCompleteArgs` (`vOnCompleteArgs`). Typed against
   * the work function's return (`F["_returnType"]`): its `result.returnValue` must accept it.
   */
  onComplete?: C & AcceptsResult<C, Ret>;
  /** Passed back to onComplete. */
  context?: unknown;
  /** Overrides the pool's retry for this item (`false`: never; `true`: the pool's behavior, else DEFAULT_RETRY). */
  retry?: RetryBehavior | boolean;
  /** Higher runs first (default 0); FIFO within a priority. */
  priority?: number;
  /** Idempotency key: while an item with this key is retained, enqueueing again returns its id. */
  key?: string;
}

/**
 * Options of `enqueueActionBatch`/`enqueueMutationBatch`: the same for every item, except `key`, which is a function
 * of each item's args and index. A fixed string would make the whole batch one item (the dedup keeps the first), so it
 * is a type error and throws at runtime.
 */
export interface BatchEnqueueOptions<Args = unknown, Ret = unknown, C extends OnCompleteRef = OnCompleteRef> extends Omit<EnqueueOptions<Ret, C>, "key"> {
  /** Idempotency key per item (`(args, i) => \`summarize:${args.docId}\``); items without a key when omitted. */
  key?: (args: Args, index: number) => string;
}

type ActionRef = FunctionReference<"action", Visibility>;
type WorkMutationRef = FunctionReference<"mutation", Visibility>;

const isSync = (ctx: SyncReadCtx | AsyncCtx): ctx is SyncReadCtx => "db" in ctx;

export class Workpool {
  constructor(
    readonly component: WorkpoolComponentApi,
    readonly options: WorkpoolOptions = {},
  ) {}

  /** The same pool without `shard`: for code that already runs in the pool's shard (its onComplete, its queries). */
  get here(): Workpool {
    const { shard: _shard, ...rest } = this.options;
    return new Workpool(this.component, rest);
  }

  /** Enqueues an action. In a mutation: synchronous and atomic with it. Returns the work id. */
  enqueueAction<F extends ActionRef, C extends OnCompleteRef = OnCompleteRef>(ctx: SyncWriteCtx, fn: F, args: F["_args"], opts?: EnqueueOptions<F["_returnType"], C>): string;
  enqueueAction<F extends ActionRef, C extends OnCompleteRef = OnCompleteRef>(ctx: AsyncCtx, fn: F, args: F["_args"], opts?: EnqueueOptions<F["_returnType"], C>): Promise<string>;
  enqueueAction(ctx: SyncWriteCtx | AsyncCtx, fn: ActionRef, args: unknown, opts: EnqueueOptions = {}): string | Promise<string> {
    return first(this.enqueue(ctx, [this.item("action", fn, args, opts)]));
  }

  /** Enqueues many actions in one call. `opts.key`, if any, is `(args, index) => string` (one key per item). */
  enqueueActionBatch<F extends ActionRef, C extends OnCompleteRef = OnCompleteRef>(ctx: SyncWriteCtx, fn: F, args: Array<F["_args"]>, opts?: BatchEnqueueOptions<F["_args"], F["_returnType"], C>): string[];
  enqueueActionBatch<F extends ActionRef, C extends OnCompleteRef = OnCompleteRef>(ctx: AsyncCtx, fn: F, args: Array<F["_args"]>, opts?: BatchEnqueueOptions<F["_args"], F["_returnType"], C>): Promise<string[]>;
  enqueueActionBatch(ctx: SyncWriteCtx | AsyncCtx, fn: ActionRef, args: unknown[], opts: BatchEnqueueOptions = {}): string[] | Promise<string[]> {
    return this.enqueue(ctx, this.batch("action", fn, args, opts));
  }

  /** Enqueues a mutation (run in its own transaction with its result and onComplete; not retried unless `retry`). */
  enqueueMutation<F extends WorkMutationRef, C extends OnCompleteRef = OnCompleteRef>(ctx: SyncWriteCtx, fn: F, args: F["_args"], opts?: EnqueueOptions<F["_returnType"], C>): string;
  enqueueMutation<F extends WorkMutationRef, C extends OnCompleteRef = OnCompleteRef>(ctx: AsyncCtx, fn: F, args: F["_args"], opts?: EnqueueOptions<F["_returnType"], C>): Promise<string>;
  enqueueMutation(ctx: SyncWriteCtx | AsyncCtx, fn: WorkMutationRef, args: unknown, opts: EnqueueOptions = {}): string | Promise<string> {
    return first(this.enqueue(ctx, [this.item("mutation", fn, args, opts)]));
  }

  /** Enqueues many mutations in one call. `opts.key`, if any, is `(args, index) => string` (one key per item). */
  enqueueMutationBatch<F extends WorkMutationRef, C extends OnCompleteRef = OnCompleteRef>(ctx: SyncWriteCtx, fn: F, args: Array<F["_args"]>, opts?: BatchEnqueueOptions<F["_args"], F["_returnType"], C>): string[];
  enqueueMutationBatch<F extends WorkMutationRef, C extends OnCompleteRef = OnCompleteRef>(ctx: AsyncCtx, fn: F, args: Array<F["_args"]>, opts?: BatchEnqueueOptions<F["_args"], F["_returnType"], C>): Promise<string[]>;
  enqueueMutationBatch(ctx: SyncWriteCtx | AsyncCtx, fn: WorkMutationRef, args: unknown[], opts: BatchEnqueueOptions = {}): string[] | Promise<string[]> {
    return this.enqueue(ctx, this.batch("mutation", fn, args, opts));
  }

  /** `pending` (with its position) / `running` / `finished` (with the result); null when unknown. Reactive in queries. */
  status(ctx: SyncReadCtx, id: string): WorkStatus | null;
  status(ctx: AsyncCtx, id: string): Promise<WorkStatus | null>;
  status(ctx: SyncReadCtx | AsyncCtx, id: string): WorkStatus | null | Promise<WorkStatus | null> {
    const c = this.target(ctx);
    return c.runQuery(this.component.lib.status, { id }) as WorkStatus | null | Promise<WorkStatus | null>;
  }

  /** Pending / running / retained finished counts and totals of this pool (in this shard). */
  stats(ctx: SyncReadCtx): WorkpoolStats;
  stats(ctx: AsyncCtx): Promise<WorkpoolStats>;
  stats(ctx: SyncReadCtx | AsyncCtx): WorkpoolStats | Promise<WorkpoolStats> {
    return this.target(ctx).runQuery(this.component.lib.stats, {}) as WorkpoolStats | Promise<WorkpoolStats>;
  }

  /** Cancels an item (see `lib:cancel`): onComplete gets `{ kind: "canceled" }`. False if unknown or finished. */
  cancel(ctx: SyncWriteCtx, id: string): boolean;
  cancel(ctx: AsyncCtx, id: string): Promise<boolean>;
  cancel(ctx: SyncWriteCtx | AsyncCtx, id: string): boolean | Promise<boolean> {
    return this.writer(ctx).runMutation(this.component.lib.cancel, { id }) as boolean | Promise<boolean>;
  }

  /** Cancels every item enqueued so far in this pool (in batches when there are many). */
  cancelAll(ctx: SyncWriteCtx): number;
  cancelAll(ctx: AsyncCtx): Promise<number>;
  cancelAll(ctx: SyncWriteCtx | AsyncCtx): number | Promise<number> {
    return this.writer(ctx).runMutation(this.component.lib.cancelAll, {}) as number | Promise<number>;
  }

  // ------------------------------------------------------------------------------------------------ internals

  private batch(kind: "action" | "mutation", fn: ActionRef | WorkMutationRef, args: unknown[], o: BatchEnqueueOptions): WorkItem[] {
    const { key, ...rest } = o;
    if (key !== undefined && typeof key !== "function") {
      throw new Error("workpool: in a batch, key must be (args, index) => string; a fixed key would make the whole batch one item");
    }
    return args.map((a, i) => this.item(kind, fn, a, key ? { ...rest, key: key(a, i) } : rest));
  }

  private item(kind: "action" | "mutation", fn: ActionRef | WorkMutationRef, args: unknown, o: EnqueueOptions): WorkItem {
    const it: WorkItem = { kind, fn: createFunctionHandle(fn), args: args ?? {} };
    if (o.onComplete) it.onComplete = createFunctionHandle(o.onComplete);
    if (o.context !== undefined) it.context = o.context;
    const retry = resolveRetry(kind, o.retry, this.options.retry);
    if (retry) it.retry = retry;
    if (o.priority !== undefined) it.priority = o.priority;
    if (o.key !== undefined) it.key = o.key;
    return it;
  }

  private enqueue(ctx: SyncWriteCtx | AsyncCtx, items: WorkItem[]): string[] | Promise<string[]> {
    const a: EnqueueArgs = { items };
    const { maxParallelism, retentionMs, reclaimIntervalMs } = this.options;
    if (maxParallelism !== undefined) a.maxParallelism = maxParallelism;
    if (retentionMs !== undefined) a.retentionMs = retentionMs;
    if (reclaimIntervalMs !== undefined) a.reclaimIntervalMs = reclaimIntervalMs;
    return this.writer(ctx).runMutation(this.component.lib.enqueue, a) as string[] | Promise<string[]>;
  }

  private target(ctx: SyncReadCtx | AsyncCtx): SyncReadCtx | AsyncCtx {
    const shard = this.options.shard;
    if (shard === undefined) return ctx;
    if (isSync(ctx) || !ctx.onShard) {
      throw new Error(`workpool: this pool is pinned to ${shard}: call it from an action (it uses ctx.onShard), or use pool.here in code that runs in ${shard}`);
    }
    return ctx.onShard(shard);
  }

  private writer(ctx: SyncWriteCtx | AsyncCtx): SyncWriteCtx | AsyncCtx {
    const c = this.target(ctx);
    if (isSync(c) && typeof (c as Partial<SyncWriteCtx>).runMutation !== "function") throw new Error("workpool: needs a mutation or action ctx");
    return c as SyncWriteCtx | AsyncCtx;
  }
}

function resolveRetry(kind: "action" | "mutation", item: RetryBehavior | boolean | undefined, pool: RetryBehavior | boolean | undefined): RetryBehavior | undefined {
  const poolBehavior = typeof pool === "object" ? pool : undefined;
  if (item === false) return undefined;
  if (item === true) return poolBehavior ?? DEFAULT_RETRY;
  if (item) return item;
  if (kind === "mutation") return undefined;
  return pool === true ? DEFAULT_RETRY : poolBehavior;
}

function first(ids: string[] | Promise<string[]>): string | Promise<string> {
  return Array.isArray(ids) ? ids[0]! : ids.then((x) => x[0]!);
}
