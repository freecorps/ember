// Function builders (query / mutation / action / internal* / httpAction), ctx and db types, and function
// references. Queries and mutations are synchronous inside (PLAN D6): the database API returns values, not
// Promises, and a handler that returns a Promise is rejected at the type level and at runtime.

import {
  v,
  type Expand,
  type GenericId,
  type GenericValidator,
  type Infer,
  type ObjectShape,
  type ObjectType,
  type PropertyValidators,
  type Shape,
  type Validator,
} from "@freecorps/ember-values";
import {
  FUNCTION_NAME,
  getFunctionName as getName,
  makeFunctionReference as makeRef,
  type AnyFunctionReference,
  type ErrorSpec,
  type FunctionReference,
  type FunctionReturnType,
  type FunctionType,
  type OptionalRestArgs,
  type Visibility,
} from "@freecorps/ember-values";
import { EmberError, isErrorFactory, type AnyErrorFactory, type ErrorFactory, type ErrorSpecsOf } from "./errors.ts";
import type { ActionImages, ActionStorage } from "./actionFiles.ts";
import type { ActionBrowser } from "./actionBrowser.ts";
import type { StorageReader, StorageWriter } from "./files.ts";
import type { AggregateRangeOptions } from "./aggregate.ts";
import type { FieldTypeFromPath, IndexRange, IndexRangeBuilder, QueryInitializer } from "./query.ts";
import type { SqlReader } from "./sqlQuery.ts";
import type { SqlValue } from "@freecorps/ember-values";
import type { AnyDataModel, GenericDataModel } from "./schema.ts";
import type { Identity } from "./types.ts";
import type { VectorSearchQuery, VectorSearchResult } from "./vector.ts";
import type { AiSearchQuery, AiSearchResult } from "./aiSearch.ts";

// ------------------------------------------------------------------------------------------------ db types

export type TableNamesIn<DM extends GenericDataModel> = keyof DM & string;
export type WithoutSystemFields<D> = Expand<Omit<D, "_id" | "_creationTime">>;

/** Top-level fields holding a number or an int64 (`ctx.db.increment`). */
export type NumericFieldsOf<D> = Exclude<{ [K in keyof D]-?: NonNullable<D[K]> extends number | bigint ? K : never }[keyof D], "_creationTime"> & string;
type AggregatesOf<TI> = TI extends { ext: { aggregates: infer A } } ? A : {};
type AggInfo = { by: string[]; sum: string; min: string; max: string };
export type AggregateGroup<D, B extends string[]> = { [K in keyof B]: FieldTypeFromPath<D, B[K] & string> };
/** One group of an aggregate: `count`, then `sum`/`min`/`max` per configured field (`min`/`max` null when empty). */
export type AggregateResult<D, A extends AggInfo> = {
  count: number;
  sum: { [F in A["sum"]]: NonNullable<FieldTypeFromPath<D, F>> extends bigint ? bigint : number };
  min: { [F in A["min"]]: NonNullable<FieldTypeFromPath<D, F>> | null };
  max: { [F in A["max"]]: NonNullable<FieldTypeFromPath<D, F>> | null };
};
export interface AggregateReader<D, A extends AggInfo> {
  /** One group (a primary-key lookup); a group without documents reads as count 0. Reactive for that group. */
  get(group: AggregateGroup<D, A["by"]>): AggregateResult<D, A>;
  /** Groups in key order over a range of the group fields (eq on a prefix, then one lower/upper bound). */
  range(
    range?: (q: IndexRangeBuilder<D, A["by"]>) => IndexRange,
    opts?: AggregateRangeOptions,
  ): Array<AggregateResult<D, A> & { group: AggregateGroup<D, A["by"]> }>;
}

export interface DatabaseReader<DM extends GenericDataModel> {
  get<T extends TableNamesIn<DM>>(id: GenericId<T>): DM[T]["document"] | null;
  query<T extends TableNamesIn<DM>>(table: T): QueryInitializer<DM[T]>;
  /** The id if it is a well-formed id of `table`, else null. */
  normalizeId<T extends TableNamesIn<DM>>(table: T, id: string): GenericId<T> | null;
  /** A materialized aggregate declared with `defineTable(...).aggregate(name, ...)`. */
  aggregate<T extends TableNamesIn<DM>, N extends keyof AggregatesOf<DM[T]> & string>(
    table: T,
    name: N,
  ): AggregateReader<DM[T]["document"], AggregatesOf<DM[T]>[N] extends AggInfo ? AggregatesOf<DM[T]>[N] : AggInfo>;
  /**
   * Read-only SQL over this shard's tables (one SELECT / WITH statement; values are bound parameters, identifiers
   * via `sql.id()`). Reactive per table: any write to a referenced table re-runs the query.
   */
  sql: SqlReader;
}
export interface DatabaseWriter<DM extends GenericDataModel> extends DatabaseReader<DM> {
  insert<T extends TableNamesIn<DM>>(table: T, value: WithoutSystemFields<DM[T]["document"]>): GenericId<T>;
  /** Shallow merge; a field set to `undefined` is removed. */
  patch<T extends TableNamesIn<DM>>(id: GenericId<T>, value: Partial<WithoutSystemFields<DM[T]["document"]>>): void;
  replace<T extends TableNamesIn<DM>>(id: GenericId<T>, value: WithoutSystemFields<DM[T]["document"]>): void;
  delete(id: GenericId<string>): void;
  /** Adds `delta` to a number / int64 field without reading the document in user code; returns the new value. */
  increment<T extends TableNamesIn<DM>, F extends NumericFieldsOf<DM[T]["document"]>>(
    id: GenericId<T>,
    field: F,
    delta: NonNullable<DM[T]["document"][F]> extends bigint ? bigint : number,
  ): NonNullable<DM[T]["document"][F]>;
}

export interface Auth {
  getUserIdentity(): Identity | null;
  /** The caller's identity; throws `Unauthenticated` (a system error) when nobody is signed in. */
  require(): Identity;
}

export interface Scheduler {
  /** Schedules `fn` to run `delayMs` after this mutation commits. Returns the job id. */
  runAfter<F extends SchedulableReference>(delayMs: number, fn: F, ...args: OptionalRestArgs<F>): string;
  /** Schedules `fn` at `timestamp` (ms since epoch, or a Date). */
  runAt<F extends SchedulableReference>(timestamp: number | Date, fn: F, ...args: OptionalRestArgs<F>): string;
  /**
   * Cancels a pending job by the id `runAfter`/`runAt` returned, atomically with this mutation. A job that already
   * ran (or is being dispatched) is not affected; an unknown id is a no-op.
   */
  cancel(id: string): void;
}

/**
 * Inside a component's functions: its install name and install config (`app.use(c, { config })`). Undefined in
 * the app's own functions.
 */
export interface ComponentInfo<Config = unknown> {
  /** Install name ("rateLimit", or nested "email/rateLimit"). */
  name: string;
  config: Config;
}

export interface QueryCtx<DM extends GenericDataModel = AnyDataModel> {
  db: DatabaseReader<DM>;
  auth: Auth;
  /** Fixed for the whole function (deterministic). */
  now: number;
  /** File metadata and short-lived download URLs (PLAN §7). */
  storage: StorageReader;
  /**
   * Runs a query in this transaction and returns its value (synchronous, PLAN D6): a function of this scope, a
   * public function of a direct child component (`components.rateLimit.lib.check`), or a function handle. Its
   * reads join this query's read set (reactivity).
   */
  runQuery<F extends FunctionReference<"query", any>>(fn: F, ...args: OptionalRestArgs<F>): FunctionReturnType<F>;
  /** Set inside component functions. */
  component?: ComponentInfo;
}
export interface MutationCtx<DM extends GenericDataModel = AnyDataModel> {
  db: DatabaseWriter<DM>;
  auth: Auth;
  now: number;
  /** Seeded per mutation, so a client can replay it. */
  random(): number;
  scheduler: Scheduler;
  /** Upload tickets, download URLs, metadata, delete (PLAN §7). Refcounts follow `v.file()` fields automatically. */
  storage: StorageWriter;
  /** Runs a query in this transaction (see `QueryCtx.runQuery`). */
  runQuery<F extends FunctionReference<"query", any>>(fn: F, ...args: OptionalRestArgs<F>): FunctionReturnType<F>;
  /**
   * Runs a mutation **inside this mutation's transaction** (a savepoint): synchronous, returns its value. If it
   * throws, its writes and scheduled jobs are undone and the error propagates (catch it to continue). Same
   * targets as `runQuery`: own scope, a direct child component's public functions, or a function handle.
   */
  runMutation<F extends FunctionReference<"mutation", any>>(fn: F, ...args: OptionalRestArgs<F>): FunctionReturnType<F>;
  /** Set inside component functions. */
  component?: ComponentInfo;
  /**
   * The app's private SQL tables (`defineSchema({ privateSql })`), read and written in this mutation's transaction.
   * Not synced, validated or reactive. Throws when the schema declares none.
   */
  sql: PrivateSqlCtx;
}
/**
 * SQL over the app's private tables, inside a mutation. `exec` runs one statement with bound parameters and returns
 * its rows; reads and writes count against the transaction's limits. A statement naming a schema table or an Ember
 * internal (anything starting with "_") is refused. `transaction(fn)` is a savepoint: if `fn` throws, everything it
 * wrote (private rows, documents, scheduled jobs) is undone and the error propagates.
 */
export interface PrivateSqlCtx {
  exec(sql: string, ...params: SqlValue[]): Record<string, SqlValue>[];
  transaction<T>(fn: () => T): T;
}
/** Scheduling from an action: the job is written to the target shard's `_jobs` right away (not transactional). */
export interface ActionScheduler {
  runAfter<F extends SchedulableReference>(delayMs: number, fn: F, ...args: OptionalRestArgs<F>): Promise<string>;
  runAt<F extends SchedulableReference>(timestamp: number | Date, fn: F, ...args: OptionalRestArgs<F>): Promise<string>;
  /** Cancels a pending job of this shard (see `Scheduler.cancel`). Resolves to whether a pending job was removed. */
  cancel(id: string): Promise<boolean>;
}

/** Database access of one shard from an action (each call is its own transaction; internal functions allowed). */
export interface ShardHandle {
  /** `<kind>:<key>` */
  readonly shard: string;
  runQuery<F extends FunctionReference<"query", any>>(fn: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
  runMutation<F extends FunctionReference<"mutation", any>>(fn: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
  scheduler: ActionScheduler;
}

/**
 * Provided by @freecorps/ember-runtime. Actions run in the Worker (not in a shard) and may do I/O (`fetch`, bindings in
 * `ctx.env`). `runQuery`/`runMutation`/`scheduler` target the shard the action was called on; `ctx.onShard(s)`
 * targets another one (reads across shards are not consistent with each other, PLAN §5). Calls run under the
 * caller's identity.
 */
/** Untyped data models (`ext: any`) accept any index name. */
type IsAny<T> = 0 extends 1 & T ? true : false;
type VectorIndexesOf<TI> = TI extends { ext: infer E } ? (IsAny<E> extends true ? Record<string, any> : E extends { vector: infer V } ? V : {}) : {};
type AiSearchIndexesOf<TI> = TI extends { ext: infer E } ? (IsAny<E> extends true ? Record<string, any> : E extends { aiSearch: infer A } ? A : {}) : {};

/** External index searches of an action (PLAN §6): Vectorize and AI Search, by table and index name. */
export interface ActionSearch<DM extends GenericDataModel = AnyDataModel> {
  /**
   * Nearest neighbours in a `.vectorIndex()` (Vectorize; namespace = shard): `{ vector }`, or `{ text }` when the
   * index has `embed`. Best first; `_score` is the metric's score (cosine similarity by default). Results are
   * eventually consistent with the database (writes reach Vectorize through the outbox in seconds) and may name
   * documents deleted since: load them with `runQuery` and skip the missing ones.
   */
  vectorSearch<T extends TableNamesIn<DM>, N extends keyof VectorIndexesOf<DM[T]> & string>(
    table: T,
    index: N,
    query: VectorSearchQuery<DM[T]["document"], VectorIndexesOf<DM[T]>[N]>,
  ): Promise<Array<VectorSearchResult<GenericId<T>>>>;
  /**
   * Hybrid (BM25 + vector) search in an `.aiSearchIndex()` (Cloudflare AI Search; the shard is a filter), one
   * entry per document with its best chunk. Eventually consistent (AI Search indexes asynchronously).
   */
  aiSearch<T extends TableNamesIn<DM>, N extends keyof AiSearchIndexesOf<DM[T]> & string>(
    table: T,
    index: N,
    query: AiSearchQuery<DM[T]["document"], AiSearchIndexesOf<DM[T]>[N]>,
  ): Promise<Array<AiSearchResult<GenericId<T>>>>;
}

export interface ActionCtx<DM extends GenericDataModel = AnyDataModel> extends ShardHandle, ActionSearch<DM> {
  /** Set inside component functions. */
  component?: ComponentInfo;
  auth: { getUserIdentity(): Promise<Identity | null>; require(): Promise<Identity> };
  runAction<F extends FunctionReference<"action", any>>(fn: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
  onShard(shard: string): ShardHandle;
  /** The Worker's env bindings (R2, AI, Queues, secrets...). */
  env: Record<string, unknown>;
  /** Time at the start of the action (actions are not deterministic: `Date.now()` is fine too). */
  now: number;
  /** Files of this action's shard: read bytes, store new ones, URLs (PLAN §7). */
  storage: ActionStorage;
  /** Images binding helpers (thumbnails). Throws when the Worker has no `EMBER_IMAGES` binding. */
  images: ActionImages;
  /**
   * Browser Rendering (ember.json `resources.browser`): HTML or a URL → PDF, screenshot or rendered HTML. Throws
   * `BrowserNotConfigured` without the `EMBER_BROWSER` binding (in `ember dev`: use `ember dev --remote`).
   */
  browser: ActionBrowser;
}

// ------------------------------------------------------------------------------------------------ functions

export type { FunctionType, Visibility, FunctionReference, AnyFunctionReference, OptionalRestArgs, ErrorSpec };
export type { FunctionReturnType };
export type { FunctionArgs, FunctionErrors, Args, Returns, Errors, Item } from "@freecorps/ember-values";

export const IS_FUNCTION = Symbol.for("ember.function");

export interface RegisteredFunction<Type extends FunctionType, Vis extends Visibility, Args, Ret, Errs extends ErrorSpec = never> {
  readonly [IS_FUNCTION]: true;
  readonly type: Type;
  readonly visibility: Vis;
  /** Shape of the args object. */
  readonly args: ObjectShape;
  readonly returns?: Shape;
  /** Declared application errors (`errors: [...]`): their codes and payload shapes. */
  readonly errors?: readonly AnyErrorFactory[];
  readonly handler: (ctx: any, args: any) => unknown;
  /**
   * Revocation-exact auth (PLAN §9): the caller's session is checked against the Auth DO on every call instead of
   * trusting a still-valid JWT. Mutations and actions only.
   */
  readonly sensitive?: true;
  /**
   * Actions only: where a scheduled run of this action executes. `"shard"`: always in the shard's alarm, never handed
   * to the actions Queue (for work that must not wait on a Queue that accepts and then stalls). Unset: the Queue when
   * one is bound, under a lease (`leaseMs`).
   */
  readonly dispatch?: "shard";
  /**
   * Actions only: how long a scheduled run handed to the Queue may go unclaimed (and then unfinished) before the shard
   * runs it itself in its alarm. Default `scheduler.actionLeaseMs` (5 minutes).
   */
  readonly leaseMs?: number;
  /** Phantom. */
  readonly __args?: Args;
  /** Phantom. */
  readonly __returns?: Ret;
  /** Phantom: declared errors (codegen adds the inferred ones). */
  readonly __errors?: Errs;
}
export type AnyRegisteredFunction = RegisteredFunction<FunctionType, Visibility, any, any, any>;
export type RegisteredQuery<Vis extends Visibility, Args, Ret, Errs extends ErrorSpec = never> = RegisteredFunction<"query", Vis, Args, Ret, Errs>;
export type RegisteredMutation<Vis extends Visibility, Args, Ret, Errs extends ErrorSpec = never> = RegisteredFunction<"mutation", Vis, Args, Ret, Errs>;
export type RegisteredAction<Vis extends Visibility, Args, Ret, Errs extends ErrorSpec = never> = RegisteredFunction<"action", Vis, Args, Ret, Errs>;

export interface RegisteredHttpAction {
  readonly [IS_FUNCTION]: true;
  readonly type: "httpAction";
  readonly handler: (ctx: ActionCtx, request: Request) => Promise<Response>;
}

export const isRegisteredFunction = (x: unknown): x is AnyRegisteredFunction | RegisteredHttpAction =>
  typeof x === "object" && x !== null && (x as any)[IS_FUNCTION] === true;

/** Args: an object of validators, or a `v.object(...)`. */
export type ArgsValidator = PropertyValidators | Validator<any, "required", any>;
export type ArgsType<A extends ArgsValidator> = A extends Validator<infer T, any, any> ? T : A extends PropertyValidators ? ObjectType<A> : never;

type Def<Ctx, A extends ArgsValidator, R, E extends readonly AnyErrorFactory[] = readonly []> = {
  args?: A;
  returns?: GenericValidator;
  /**
   * The application errors this function may throw (`defineErrors`). Optional: codegen infers them from the handler;
   * declared, they are its contract (codegen warns about a thrown error missing from the list) and `ctx.fail` offers them.
   */
  errors?: E;
  handler: (ctx: Ctx & FailCtx<E>, args: ArgsType<A>) => R;
};
/** `ctx.fail.X(data)` throws a declared error (typed by the `errors` list). */
export type FailCtx<E extends readonly AnyErrorFactory[]> = {
  fail: { readonly [F in E[number] as F["code"]]: F extends ErrorFactory<any, infer D> ? (...args: undefined extends D ? [data?: D] : [data: D]) => never : never };
};
/** Mutations and actions may be `sensitive`: the session is re-checked in the Auth DO (sign-out is immediate). */
type SensitiveDef = { sensitive?: boolean };
/** How a scheduled run of an action is dispatched (see `RegisteredFunction.dispatch` and `leaseMs`). */
type DispatchDef = { dispatch?: "queue" | "shard"; leaseMs?: number };

/** Makes a Promise-returning handler a type error (queries and mutations are synchronous). */
export type SyncOnly<R> = 0 extends 1 & R
  ? unknown
  : [R] extends [never]
  ? unknown // a handler that always throws
  : [R] extends [PromiseLike<any>]
  ? { "Handlers of queries and mutations must be synchronous (no async/await): the database API is synchronous": never }
  : unknown;

/** `X`: extra ctx fields (component builders add `component: ComponentInfo<Config>`). */
export type QueryBuilder<DM extends GenericDataModel, Vis extends Visibility, X = {}> = {
  <A extends ArgsValidator = {}, R = unknown, const E extends readonly AnyErrorFactory[] = readonly []>(
    def: Def<QueryCtx<DM> & X, A, R, E> & SyncOnly<R>,
  ): RegisteredQuery<Vis, ArgsType<A>, R, ErrorSpecsOf<E>>;
  <R = unknown>(handler: ((ctx: QueryCtx<DM> & X) => R) & SyncOnly<R>): RegisteredQuery<Vis, {}, R>;
};
export type MutationBuilder<DM extends GenericDataModel, Vis extends Visibility, X = {}> = {
  <A extends ArgsValidator = {}, R = unknown, const E extends readonly AnyErrorFactory[] = readonly []>(
    def: Def<MutationCtx<DM> & X, A, R, E> & SensitiveDef & SyncOnly<R>,
  ): RegisteredMutation<Vis, ArgsType<A>, R, ErrorSpecsOf<E>>;
  <R = unknown>(handler: ((ctx: MutationCtx<DM> & X) => R) & SyncOnly<R>): RegisteredMutation<Vis, {}, R>;
};
export type ActionBuilder<Vis extends Visibility, DM extends GenericDataModel = AnyDataModel, X = {}> = {
  <A extends ArgsValidator = {}, R = unknown, const E extends readonly AnyErrorFactory[] = readonly []>(
    def: Def<ActionCtx<DM> & X, A, R, E> & SensitiveDef & DispatchDef,
  ): RegisteredAction<Vis, ArgsType<A>, Awaited<R>, ErrorSpecsOf<E>>;
  <R = unknown>(handler: (ctx: ActionCtx<DM> & X) => R): RegisteredAction<Vis, {}, Awaited<R>>;
};
export type HttpActionBuilder<DM extends GenericDataModel = AnyDataModel, X = {}> = (handler: (ctx: ActionCtx<DM> & X, request: Request) => Promise<Response>) => RegisteredHttpAction;

/**
 * Typed builders for a component's own functions: `ctx.db` over the component's schema (logical table names) and
 * `ctx.component.config` typed. `const { query, mutation } = componentBuilders<typeof schema, Config>()`.
 */
export interface ComponentBuilders<DM extends GenericDataModel, Config> {
  query: QueryBuilder<DM, "public", { component: ComponentInfo<Config> }>;
  internalQuery: QueryBuilder<DM, "internal", { component: ComponentInfo<Config> }>;
  mutation: MutationBuilder<DM, "public", { component: ComponentInfo<Config> }>;
  internalMutation: MutationBuilder<DM, "internal", { component: ComponentInfo<Config> }>;
  action: ActionBuilder<"public", DM, { component: ComponentInfo<Config> }>;
  internalAction: ActionBuilder<"internal", DM, { component: ComponentInfo<Config> }>;
  httpAction: HttpActionBuilder<DM, { component: ComponentInfo<Config> }>;
}

/** `ctx.auth` of queries and mutations. */
export function authApi(identity: Identity | null): Auth {
  return {
    getUserIdentity: () => identity,
    require: () => {
      if (!identity) throw new EmberError("Unauthenticated", "Not signed in");
      return identity;
    },
  };
}

/** `ctx.fail`: one thrower per declared error. */
export function failApi(fn: { errors?: readonly AnyErrorFactory[] }): Record<string, (data?: unknown) => never> {
  const out: Record<string, (data?: unknown) => never> = {};
  for (const f of fn.errors ?? []) {
    out[f.code] = (data?: unknown) => {
      throw (f as (d?: unknown) => Error)(data);
    };
  }
  return Object.freeze(out);
}

function argsShape(a: ArgsValidator | undefined): ObjectShape {
  if (a === undefined) return { kind: "object", fields: {} };
  const shape = typeof (a as GenericValidator).validate === "function" && "shape" in a ? (a as GenericValidator).shape : v.object(a as PropertyValidators).shape;
  if (shape.kind !== "object") throw new Error("Function args must be an object of validators or v.object()");
  return shape;
}

type AnyDef = { args?: ArgsValidator; returns?: GenericValidator; errors?: readonly AnyErrorFactory[]; handler: (ctx: any, args: any) => unknown } & SensitiveDef & DispatchDef;
function builder(type: FunctionType, visibility: Visibility): any {
  return (def: AnyDef | ((ctx: any, args: any) => unknown)) => {
    const d: AnyDef = typeof def === "function" ? { handler: def } : def;
    if (typeof d?.handler !== "function") throw new Error(`${type}(): missing handler`);
    const fn: Record<string | symbol, unknown> = {
      [IS_FUNCTION]: true,
      type,
      visibility,
      args: argsShape(d.args),
      handler: d.handler,
    };
    if (d.returns) fn.returns = d.returns.shape;
    if (d.errors !== undefined) {
      if (!Array.isArray(d.errors) || !d.errors.every((e) => isErrorFactory(e))) throw new Error(`${type}(): \`errors\` must be a list of defineErrors() entries`);
      fn.errors = Object.freeze([...d.errors]);
    }
    if (d.sensitive) {
      if (type === "query") throw new Error("query(): `sensitive` applies to mutations and actions only");
      fn.sensitive = true;
    }
    if (d.dispatch !== undefined || d.leaseMs !== undefined) {
      if (type !== "action") throw new Error(`${type}(): \`dispatch\` and \`leaseMs\` apply to actions only`);
      if (d.dispatch !== undefined && d.dispatch !== "queue" && d.dispatch !== "shard") {
        throw new Error(`action(): dispatch must be "queue" or "shard", got ${JSON.stringify(d.dispatch)}`);
      }
      if (d.dispatch === "shard") fn.dispatch = "shard";
      if (d.leaseMs !== undefined) {
        if (!Number.isFinite(d.leaseMs) || d.leaseMs < 1000) throw new Error("action(): leaseMs must be at least 1000");
        fn.leaseMs = Math.floor(d.leaseMs);
      }
    }
    return Object.freeze(fn);
  };
}

export const queryGeneric = builder("query", "public") as QueryBuilder<any, "public">;
export const internalQueryGeneric = builder("query", "internal") as QueryBuilder<any, "internal">;
export const mutationGeneric = builder("mutation", "public") as MutationBuilder<any, "public">;
export const internalMutationGeneric = builder("mutation", "internal") as MutationBuilder<any, "internal">;
export const actionGeneric = builder("action", "public") as ActionBuilder<"public">;
export const internalActionGeneric = builder("action", "internal") as ActionBuilder<"internal">;
export const httpActionGeneric: HttpActionBuilder = (handler) => Object.freeze({ [IS_FUNCTION]: true as const, type: "httpAction" as const, handler });

/** Untyped builders (codegen re-exports them typed with the app's DataModel). */
export const query = queryGeneric as QueryBuilder<AnyDataModel, "public">;
export const internalQuery = internalQueryGeneric as QueryBuilder<AnyDataModel, "internal">;
export const mutation = mutationGeneric as MutationBuilder<AnyDataModel, "public">;
export const internalMutation = internalMutationGeneric as MutationBuilder<AnyDataModel, "internal">;
export const action = actionGeneric;
export const internalAction = internalActionGeneric;
export const httpAction = httpActionGeneric;

/** See `ComponentBuilders`. `S` is the component's `defineSchema(...)` type (or a DataModel). */
export function componentBuilders<S = AnyDataModel, Config = unknown>(): ComponentBuilders<
  S extends GenericDataModel ? S : S extends { manifest: unknown } ? import("./schema.ts").DataModelFromSchema<S> : AnyDataModel,
  Config
> {
  return {
    query: queryGeneric,
    internalQuery: internalQueryGeneric,
    mutation: mutationGeneric,
    internalMutation: internalMutationGeneric,
    action: actionGeneric,
    internalAction: internalActionGeneric,
    httpAction: httpActionGeneric,
  } as any;
}

// ------------------------------------------------------------------------------------------ function refs

export { FUNCTION_NAME };
export type SchedulableReference = FunctionReference<"mutation" | "action", any> | string;

/** A reference to `"module:export"` (or `"dir/module:export"`). */
export function makeFunctionReference<Type extends FunctionType, Args = any, Ret = any>(name: string): FunctionReference<Type, Visibility, Args, Ret> {
  return makeRef<Type, Args, Ret>(name);
}

export function getFunctionName(ref: AnyFunctionReference | string): string {
  return getName(ref);
}

type RefFromExport<E> = E extends RegisteredFunction<infer T, infer V, infer A, infer R, infer Er> ? FunctionReference<T, V, A, R, Er, null> : never;
type RefsInModule<M> = {
  -readonly [K in keyof M as M[K] extends { type: FunctionType; visibility: Visibility } ? K : never]: RefFromExport<M[K]>;
};
type ApiForModule<Path extends string, M> = Path extends `${infer Head}/${infer Rest}`
  ? { [_ in Head]: ApiForModule<Rest, M> }
  : { [_ in Path]: RefsInModule<M> };
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
type ExpandApi<T> = T extends AnyFunctionReference ? T : { [K in keyof T]: ExpandApi<T[K]> };

export type ApiFromModules<Modules extends Record<string, object>> = ExpandApi<
  UnionToIntersection<{ [P in keyof Modules & string]: ApiForModule<P, Modules[P]> }[keyof Modules & string]>
>;

/** Keeps only references with the given visibility; drops emptied modules. */
export type FilterApi<API, Vis extends Visibility> = {
  [K in keyof API as API[K] extends AnyFunctionReference
    ? API[K]["_visibility"] extends Vis
      ? K
      : never
    : keyof FilterApi<API[K], Vis> extends never
      ? never
      : K]: API[K] extends AnyFunctionReference ? API[K] : FilterApi<API[K], Vis>;
};

/** Runtime `api`: any property path; `api.dir.mod.fn` resolves to "dir/mod:fn". */
function createApi(path: string[] = []): any {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === "string") return createApi([...path, prop]);
        if (prop === FUNCTION_NAME) {
          if (path.length < 2) throw new Error(`Expected api.module.function, got api.${path.join(".")}`);
          return `${path.slice(0, -1).join("/")}:${path[path.length - 1]}`;
        }
        return undefined;
      },
    },
  );
}
export const anyApi: any = createApi();

/**
 * Flattens `{ "dir/mod": { fn: registered } }` modules (or an already flat `{ "mod:fn": registered }` map) into
 * `{ "dir/mod:fn": registered }`.
 */
export function flattenFunctions(functions: unknown): Map<string, AnyRegisteredFunction | RegisteredHttpAction> {
  const out = new Map<string, AnyRegisteredFunction | RegisteredHttpAction>();
  const walk = (obj: unknown, prefix: string) => {
    if (typeof obj !== "object" || obj === null) return;
    for (const [k, x] of Object.entries(obj)) {
      if (isRegisteredFunction(x)) {
        const name = k.includes(":") ? (prefix ? `${prefix}/${k}` : k) : prefix ? `${prefix}:${k}` : k;
        out.set(name, x);
      } else if (typeof x === "object" && x !== null && !k.includes(":")) walk(x, prefix ? `${prefix}/${k}` : k);
    }
  };
  walk(functions, "");
  return out;
}

export type { Infer };
