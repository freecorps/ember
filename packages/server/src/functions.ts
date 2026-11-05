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
import type { ActionImages, ActionStorage } from "./actionFiles.ts";
import type { StorageReader, StorageWriter } from "./files.ts";
import type { AggregateRangeOptions } from "./aggregate.ts";
import type { FieldTypeFromPath, IndexRange, IndexRangeBuilder, QueryInitializer } from "./query.ts";
import type { SqlReader } from "./sqlQuery.ts";
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

export interface QueryCtx<DM extends GenericDataModel = AnyDataModel> {
  db: DatabaseReader<DM>;
  auth: Auth;
  /** Fixed for the whole function (deterministic). */
  now: number;
  /** File metadata and short-lived download URLs (PLAN §7). */
  storage: StorageReader;
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
  auth: { getUserIdentity(): Promise<Identity | null> };
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
}

// ------------------------------------------------------------------------------------------------ functions

export type FunctionType = "query" | "mutation" | "action";
export type Visibility = "public" | "internal";

export const IS_FUNCTION = Symbol.for("ember.function");

export interface RegisteredFunction<Type extends FunctionType, Vis extends Visibility, Args, Ret> {
  readonly [IS_FUNCTION]: true;
  readonly type: Type;
  readonly visibility: Vis;
  /** Shape of the args object. */
  readonly args: ObjectShape;
  readonly returns?: Shape;
  readonly handler: (ctx: any, args: any) => unknown;
  /**
   * Revocation-exact auth (PLAN §9): the caller's session is checked against the Auth DO on every call instead of
   * trusting a still-valid JWT. Mutations and actions only.
   */
  readonly sensitive?: true;
  /** Phantom. */
  readonly __args?: Args;
  /** Phantom. */
  readonly __returns?: Ret;
}
export type AnyRegisteredFunction = RegisteredFunction<FunctionType, Visibility, any, any>;
export type RegisteredQuery<Vis extends Visibility, Args, Ret> = RegisteredFunction<"query", Vis, Args, Ret>;
export type RegisteredMutation<Vis extends Visibility, Args, Ret> = RegisteredFunction<"mutation", Vis, Args, Ret>;
export type RegisteredAction<Vis extends Visibility, Args, Ret> = RegisteredFunction<"action", Vis, Args, Ret>;

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

type Def<Ctx, A extends ArgsValidator, R> = {
  args?: A;
  returns?: GenericValidator;
  handler: (ctx: Ctx, args: ArgsType<A>) => R;
};
/** Mutations and actions may be `sensitive`: the session is re-checked in the Auth DO (sign-out is immediate). */
type SensitiveDef = { sensitive?: boolean };

/** Makes a Promise-returning handler a type error (queries and mutations are synchronous). */
export type SyncOnly<R> = 0 extends 1 & R
  ? unknown
  : [R] extends [PromiseLike<any>]
  ? { "Handlers of queries and mutations must be synchronous (no async/await): the database API is synchronous": never }
  : unknown;

export type QueryBuilder<DM extends GenericDataModel, Vis extends Visibility> = {
  <A extends ArgsValidator = {}, R = unknown>(def: Def<QueryCtx<DM>, A, R> & SyncOnly<R>): RegisteredQuery<Vis, ArgsType<A>, R>;
  <R = unknown>(handler: ((ctx: QueryCtx<DM>) => R) & SyncOnly<R>): RegisteredQuery<Vis, {}, R>;
};
export type MutationBuilder<DM extends GenericDataModel, Vis extends Visibility> = {
  <A extends ArgsValidator = {}, R = unknown>(def: Def<MutationCtx<DM>, A, R> & SensitiveDef & SyncOnly<R>): RegisteredMutation<Vis, ArgsType<A>, R>;
  <R = unknown>(handler: ((ctx: MutationCtx<DM>) => R) & SyncOnly<R>): RegisteredMutation<Vis, {}, R>;
};
export type ActionBuilder<Vis extends Visibility, DM extends GenericDataModel = AnyDataModel> = {
  <A extends ArgsValidator = {}, R = unknown>(def: Def<ActionCtx<DM>, A, R> & SensitiveDef): RegisteredAction<Vis, ArgsType<A>, Awaited<R>>;
  <R = unknown>(handler: (ctx: ActionCtx<DM>) => R): RegisteredAction<Vis, {}, Awaited<R>>;
};
export type HttpActionBuilder<DM extends GenericDataModel = AnyDataModel> = (handler: (ctx: ActionCtx<DM>, request: Request) => Promise<Response>) => RegisteredHttpAction;

function argsShape(a: ArgsValidator | undefined): ObjectShape {
  if (a === undefined) return { kind: "object", fields: {} };
  const shape = typeof (a as GenericValidator).validate === "function" && "shape" in a ? (a as GenericValidator).shape : v.object(a as PropertyValidators).shape;
  if (shape.kind !== "object") throw new Error("Function args must be an object of validators or v.object()");
  return shape;
}

function builder(type: FunctionType, visibility: Visibility): any {
  return (def: (Def<any, any, unknown> & SensitiveDef) | ((ctx: any, args: any) => unknown)) => {
    const d: Def<any, any, unknown> & SensitiveDef = typeof def === "function" ? { handler: def } : def;
    if (typeof d?.handler !== "function") throw new Error(`${type}(): missing handler`);
    const fn: Record<string | symbol, unknown> = {
      [IS_FUNCTION]: true,
      type,
      visibility,
      args: argsShape(d.args),
      handler: d.handler,
    };
    if (d.returns) fn.returns = d.returns.shape;
    if (d.sensitive) {
      if (type === "query") throw new Error("query(): `sensitive` applies to mutations and actions only");
      fn.sensitive = true;
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

// ------------------------------------------------------------------------------------------ function refs

export const FUNCTION_NAME = Symbol.for("ember.functionName");

export type FunctionReference<Type extends FunctionType, Vis extends Visibility = Visibility, Args = any, Ret = any> = {
  _type: Type;
  _visibility: Vis;
  _args: Args;
  _returnType: Ret;
};
export type AnyFunctionReference = FunctionReference<any, any, any, any>;
export type FunctionArgs<F extends AnyFunctionReference> = F["_args"];
export type FunctionReturnType<F extends AnyFunctionReference> = F["_returnType"];
/** `[args?]` when the function takes no arguments, `[args]` otherwise. */
export type OptionalRestArgs<F> = F extends AnyFunctionReference ? ({} extends F["_args"] ? [args?: F["_args"]] : [args: F["_args"]]) : [args?: Record<string, unknown>];
export type SchedulableReference = FunctionReference<"mutation" | "action", any> | string;

/** A reference to `"module:export"` (or `"dir/module:export"`). */
export function makeFunctionReference<Type extends FunctionType, Args = any, Ret = any>(name: string): FunctionReference<Type, Visibility, Args, Ret> {
  return { [FUNCTION_NAME]: name } as unknown as FunctionReference<Type, Visibility, Args, Ret>;
}

export function getFunctionName(ref: AnyFunctionReference | string): string {
  if (typeof ref === "string") return ref;
  const name = (ref as any)?.[FUNCTION_NAME];
  if (typeof name !== "string") throw new Error("Not a function reference");
  return name;
}

type RefFromExport<E> = E extends RegisteredFunction<infer T, infer V, infer A, infer R> ? FunctionReference<T, V, A, R> : never;
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
