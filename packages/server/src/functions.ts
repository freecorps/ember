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
} from "@ember/values";
import type { QueryInitializer } from "./query.ts";
import type { AnyDataModel, GenericDataModel } from "./schema.ts";
import type { Identity } from "./types.ts";

// ------------------------------------------------------------------------------------------------ db types

export type TableNamesIn<DM extends GenericDataModel> = keyof DM & string;
export type WithoutSystemFields<D> = Expand<Omit<D, "_id" | "_creationTime">>;

export interface DatabaseReader<DM extends GenericDataModel> {
  get<T extends TableNamesIn<DM>>(id: GenericId<T>): DM[T]["document"] | null;
  query<T extends TableNamesIn<DM>>(table: T): QueryInitializer<DM[T]>;
  /** The id if it is a well-formed id of `table`, else null. */
  normalizeId<T extends TableNamesIn<DM>>(table: T, id: string): GenericId<T> | null;
}
export interface DatabaseWriter<DM extends GenericDataModel> extends DatabaseReader<DM> {
  insert<T extends TableNamesIn<DM>>(table: T, value: WithoutSystemFields<DM[T]["document"]>): GenericId<T>;
  /** Shallow merge; a field set to `undefined` is removed. */
  patch<T extends TableNamesIn<DM>>(id: GenericId<T>, value: Partial<WithoutSystemFields<DM[T]["document"]>>): void;
  replace<T extends TableNamesIn<DM>>(id: GenericId<T>, value: WithoutSystemFields<DM[T]["document"]>): void;
  delete(id: GenericId<string>): void;
}

export interface Auth {
  getUserIdentity(): Identity | null;
}

export interface Scheduler {
  /** Schedules `fn` to run `delayMs` after this mutation commits. Returns the job id. */
  runAfter<F extends SchedulableReference>(delayMs: number, fn: F, ...args: OptionalRestArgs<F>): string;
  /** Schedules `fn` at `timestamp` (ms since epoch, or a Date). */
  runAt<F extends SchedulableReference>(timestamp: number | Date, fn: F, ...args: OptionalRestArgs<F>): string;
}

export interface QueryCtx<DM extends GenericDataModel = AnyDataModel> {
  db: DatabaseReader<DM>;
  auth: Auth;
  /** Fixed for the whole function (deterministic). */
  now: number;
}
export interface MutationCtx<DM extends GenericDataModel = AnyDataModel> {
  db: DatabaseWriter<DM>;
  auth: Auth;
  now: number;
  /** Seeded per mutation, so a client can replay it. */
  random(): number;
  scheduler: Scheduler;
}
/** Provided by @ember/runtime (actions run in the Worker and may do I/O). */
export interface ActionCtx {
  auth: { getUserIdentity(): Promise<Identity | null> };
  runQuery<F extends FunctionReference<"query", any>>(fn: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
  runMutation<F extends FunctionReference<"mutation", any>>(fn: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
  runAction<F extends FunctionReference<"action", any>>(fn: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
  scheduler: {
    runAfter<F extends SchedulableReference>(delayMs: number, fn: F, ...args: OptionalRestArgs<F>): Promise<string>;
    runAt<F extends SchedulableReference>(timestamp: number | Date, fn: F, ...args: OptionalRestArgs<F>): Promise<string>;
  };
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
  <A extends ArgsValidator = {}, R = unknown>(def: Def<MutationCtx<DM>, A, R> & SyncOnly<R>): RegisteredMutation<Vis, ArgsType<A>, R>;
  <R = unknown>(handler: ((ctx: MutationCtx<DM>) => R) & SyncOnly<R>): RegisteredMutation<Vis, {}, R>;
};
export type ActionBuilder<Vis extends Visibility> = {
  <A extends ArgsValidator = {}, R = unknown>(def: Def<ActionCtx, A, R>): RegisteredAction<Vis, ArgsType<A>, Awaited<R>>;
  <R = unknown>(handler: (ctx: ActionCtx) => R): RegisteredAction<Vis, {}, Awaited<R>>;
};
export type HttpActionBuilder = (handler: (ctx: ActionCtx, request: Request) => Promise<Response>) => RegisteredHttpAction;

function argsShape(a: ArgsValidator | undefined): ObjectShape {
  if (a === undefined) return { kind: "object", fields: {} };
  const shape = typeof (a as GenericValidator).validate === "function" && "shape" in a ? (a as GenericValidator).shape : v.object(a as PropertyValidators).shape;
  if (shape.kind !== "object") throw new Error("Function args must be an object of validators or v.object()");
  return shape;
}

function builder(type: FunctionType, visibility: Visibility): any {
  return (def: Def<any, any, unknown> | ((ctx: any, args: any) => unknown)) => {
    const d = typeof def === "function" ? { handler: def } : def;
    if (typeof d?.handler !== "function") throw new Error(`${type}(): missing handler`);
    const fn: Record<string | symbol, unknown> = {
      [IS_FUNCTION]: true,
      type,
      visibility,
      args: argsShape(d.args),
      handler: d.handler,
    };
    if (d.returns) fn.returns = d.returns.shape;
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
