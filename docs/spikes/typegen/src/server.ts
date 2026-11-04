// Function builders, ctx/db types, and function references (`api`). Mirrors the shape of convex/server so
// codegen can emit `QueryBuilder<DataModel, "public">` etc., but written from scratch.

import type { GenericDataModel, TableInfo } from "./schema";
import type { Expand, GenericId, GenericValidator, ObjectType, PropertyValidators, Shape } from "./values";
import { v } from "./values";

// ------------------------------------------------------------------------------------------------ db types

type DocOf<TI extends TableInfo> = TI["document"];

/** Type of a (dotted) field path in a document; missing -> undefined. */
export type FieldTypeFromPath<D, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof D
    ? FieldTypeFromPath<NonNullable<D[H]>, R> | (undefined extends D[H] ? undefined : never)
    : undefined
  : P extends keyof D
    ? D[P]
    : undefined;

type Plus1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

export interface IndexRange {
  readonly __indexRange?: true;
}
export interface UpperBoundBuilder<D, F extends string> extends IndexRange {
  lt(field: F, value: FieldTypeFromPath<D, F>): IndexRange;
  lte(field: F, value: FieldTypeFromPath<D, F>): IndexRange;
}
export interface LowerBoundBuilder<D, F extends string> extends UpperBoundBuilder<D, F> {
  gt(field: F, value: FieldTypeFromPath<D, F>): UpperBoundBuilder<D, F>;
  gte(field: F, value: FieldTypeFromPath<D, F>): UpperBoundBuilder<D, F>;
}
/** `eq` walks the index fields in order; then at most one lower and one upper bound on the next field. */
export interface IndexRangeBuilder<D, Fs extends string[], N extends number = 0> extends LowerBoundBuilder<D, Fs[N]> {
  eq(
    field: Fs[N],
    value: FieldTypeFromPath<D, Fs[N]>,
  ): Plus1[N] extends Fs["length"] ? IndexRange : IndexRangeBuilder<D, Fs, Plus1[N]>;
}

export interface Expression<T> {
  readonly __expr?: T;
}
export type ExprOrValue<T> = Expression<T> | T;
export interface FilterBuilder<TI extends TableInfo> {
  field<P extends TI["fieldPaths"]>(path: P): Expression<FieldTypeFromPath<DocOf<TI>, P>>;
  eq<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  neq<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  lt<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  lte<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  gt<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  gte<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  and(...e: ExprOrValue<boolean>[]): Expression<boolean>;
  or(...e: ExprOrValue<boolean>[]): Expression<boolean>;
  not(e: ExprOrValue<boolean>): Expression<boolean>;
}

export type PaginationOptions = { numItems: number; cursor: string | null; endCursor?: string | null };
export type PaginationResult<T> = { page: T[]; isDone: boolean; continueCursor: string };

export interface OrderedQuery<TI extends TableInfo> {
  filter(predicate: (q: FilterBuilder<TI>) => ExprOrValue<boolean>): this;
  take(n: number): Promise<DocOf<TI>[]>;
  collect(): Promise<DocOf<TI>[]>;
  first(): Promise<DocOf<TI> | null>;
  unique(): Promise<DocOf<TI> | null>;
  paginate(opts: PaginationOptions): Promise<PaginationResult<DocOf<TI>>>;
}
export interface Query<TI extends TableInfo> extends OrderedQuery<TI> {
  order(order: "asc" | "desc"): OrderedQuery<TI>;
}
/** Augment (same type parameter) to add a plugin's query method, e.g. `withSearchIndex`. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IndexKindQueryMethods<TI extends TableInfo> {}
export interface QueryInitializer<TI extends TableInfo> extends Query<TI>, IndexKindQueryMethods<TI> {
  fullTableScan(): Query<TI>;
  withIndex<N extends keyof TI["indexes"] & string>(
    name: N,
    range?: (q: IndexRangeBuilder<DocOf<TI>, TI["indexes"][N]>) => IndexRange,
  ): Query<TI>;
}

export type TableNamesIn<DM extends GenericDataModel> = keyof DM & string;
export type WithoutSystemFields<D> = Expand<Omit<D, "_id" | "_creationTime">>;

export interface DatabaseReader<DM extends GenericDataModel> {
  get<T extends TableNamesIn<DM>>(id: GenericId<T>): Promise<DM[T]["document"] | null>;
  query<T extends TableNamesIn<DM>>(table: T): QueryInitializer<DM[T]>;
}
export interface DatabaseWriter<DM extends GenericDataModel> extends DatabaseReader<DM> {
  insert<T extends TableNamesIn<DM>>(table: T, value: WithoutSystemFields<DM[T]["document"]>): Promise<GenericId<T>>;
  patch<T extends TableNamesIn<DM>>(id: GenericId<T>, value: Partial<WithoutSystemFields<DM[T]["document"]>>): Promise<void>;
  replace<T extends TableNamesIn<DM>>(id: GenericId<T>, value: WithoutSystemFields<DM[T]["document"]>): Promise<void>;
  delete(id: GenericId<string>): Promise<void>;
}

export type QueryCtx<DM extends GenericDataModel> = { db: DatabaseReader<DM> };
export type MutationCtx<DM extends GenericDataModel> = { db: DatabaseWriter<DM> };
export type ActionCtx = {
  runQuery<F extends FunctionReference<"query", any>>(f: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
  runMutation<F extends FunctionReference<"mutation", any>>(f: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
};

// ------------------------------------------------------------------------------------------------ functions

export type FunctionType = "query" | "mutation" | "action";
export type Visibility = "public" | "internal";

export type RegisteredFunction<Type extends FunctionType, Vis extends Visibility, Args, Ret> = {
  readonly isRegistered: true;
  readonly type: Type;
  readonly visibility: Vis;
  readonly args: Shape;
  readonly returns?: Shape;
  readonly handler: (ctx: any, args: any) => unknown;
  /** Phantom. */
  readonly __args?: Args;
  /** Phantom. */
  readonly __returns?: Ret;
};
export type RegisteredHttpAction = {
  readonly isRegistered: true;
  readonly type: "httpAction";
  readonly handler: (ctx: ActionCtx, request: Request) => Promise<Response>;
};

type FunctionDef<Ctx, A extends PropertyValidators, R> = {
  args?: A;
  returns?: GenericValidator;
  handler: (ctx: Ctx, args: ObjectType<A>) => R;
};

export type QueryBuilder<DM extends GenericDataModel, Vis extends Visibility> = <A extends PropertyValidators = {}, R = unknown>(
  def: FunctionDef<QueryCtx<DM>, A, R>,
) => RegisteredFunction<"query", Vis, ObjectType<A>, Awaited<R>>;
export type MutationBuilder<DM extends GenericDataModel, Vis extends Visibility> = <A extends PropertyValidators = {}, R = unknown>(
  def: FunctionDef<MutationCtx<DM>, A, R>,
) => RegisteredFunction<"mutation", Vis, ObjectType<A>, Awaited<R>>;
export type ActionBuilder<Vis extends Visibility> = <A extends PropertyValidators = {}, R = unknown>(
  def: FunctionDef<ActionCtx, A, R>,
) => RegisteredFunction<"action", Vis, ObjectType<A>, Awaited<R>>;
export type HttpActionBuilder = (handler: (ctx: ActionCtx, request: Request) => Promise<Response>) => RegisteredHttpAction;

function builder(type: FunctionType, visibility: Visibility) {
  return (def: FunctionDef<any, PropertyValidators, unknown>) =>
    Object.freeze({
      isRegistered: true,
      type,
      visibility,
      args: v.object(def.args ?? {}).shape,
      returns: def.returns?.shape,
      handler: def.handler,
    });
}

export const queryGeneric = builder("query", "public") as QueryBuilder<any, "public">;
export const internalQueryGeneric = builder("query", "internal") as QueryBuilder<any, "internal">;
export const mutationGeneric = builder("mutation", "public") as MutationBuilder<any, "public">;
export const internalMutationGeneric = builder("mutation", "internal") as MutationBuilder<any, "internal">;
export const actionGeneric = builder("action", "public") as ActionBuilder<"public">;
export const internalActionGeneric = builder("action", "internal") as ActionBuilder<"internal">;
export const httpActionGeneric: HttpActionBuilder = (handler) => Object.freeze({ isRegistered: true, type: "httpAction", handler });

// ------------------------------------------------------------------------------------------ function refs

export const functionName = Symbol.for("cfx.functionName");

export type FunctionReference<Type extends FunctionType, Vis extends Visibility = Visibility, Args = any, Ret = any> = {
  _type: Type;
  _visibility: Vis;
  _args: Args;
  _returnType: Ret;
};
export type AnyFunctionReference = FunctionReference<any, any, any, any>;
export type FunctionArgs<F extends AnyFunctionReference> = F["_args"];
export type FunctionReturnType<F extends AnyFunctionReference> = F["_returnType"];
/** `[]` or `[args?]` when the function takes no arguments, `[args]` otherwise. */
export type OptionalRestArgs<F extends AnyFunctionReference> = {} extends F["_args"] ? [args?: F["_args"]] : [args: F["_args"]];

type RefFromExport<E> =
  E extends RegisteredFunction<infer T, infer V, infer A, infer R> ? FunctionReference<T, V, A, R> : never;
type RefsInModule<M> = {
  -readonly [K in keyof M as M[K] extends { isRegistered: true; type: FunctionType } ? K : never]: RefFromExport<M[K]>;
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

/** Runtime `api`: any property path; a reference resolves to "dir/module:export". */
function createApi(path: string[] = []): any {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === "string") return createApi([...path, prop]);
        if (prop === functionName) {
          if (path.length < 2) throw new Error(`Expected api.module.function, got api.${path.join(".")}`);
          return `${path.slice(0, -1).join("/")}:${path[path.length - 1]}`;
        }
        if (prop === Symbol.toStringTag) return "FunctionReference";
        return undefined;
      },
    },
  );
}
export const anyApi = createApi();

export function getFunctionName(ref: AnyFunctionReference | string): string {
  if (typeof ref === "string") return ref;
  const name = (ref as any)[functionName];
  if (typeof name !== "string") throw new Error("Not a function reference");
  return name;
}
