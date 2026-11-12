// Function references and their contract (docs/design/dx.md §3.1), shared by @freecorps/ember-server,
// @freecorps/ember-client and the generated `_generated/api.d.ts` (which declares a structurally identical type, so a
// client never imports server code). Every `_*` field is phantom: at runtime a reference is a Proxy or a plain object
// carrying `Symbol.for("ember.functionName")`.

export type FunctionType = "query" | "mutation" | "action";
export type Visibility = "public" | "internal";

/** One application error a function may throw (`defineErrors`): its stable code and the type of its payload. */
export type ErrorSpec<Code extends string = string, Data = unknown> = { readonly code: Code; readonly data: Data };

/**
 * Where a function runs (docs/design/dx.md §3.6). `kind`: the shard kind from `defineSchema({ shards })`;
 * `fromArg`: the argument holding the shard key (the client routes by it), absent when the caller names the shard.
 */
export type ShardSpec = { readonly kind: string; readonly fromArg?: string };

export interface FunctionReference<
  Type extends FunctionType = FunctionType,
  Vis extends Visibility = Visibility,
  Args = any,
  Returns = any,
  Errors extends ErrorSpec = ErrorSpec,
  Shard extends ShardSpec | null = ShardSpec | null,
> {
  readonly _type: Type;
  readonly _visibility: Vis;
  readonly _args: Args;
  readonly _returnType: Returns;
  /** The application errors it may throw (`never`: none). Absent on hand-written references (= any error). */
  readonly _errors?: Errors;
  /** The shard kind it runs in (`null`: any shard). Absent on hand-written references. */
  readonly _shard?: Shard;
}

export type AnyFunctionReference = FunctionReference<any, any, any, any, any, any>;
export type FunctionArgs<F extends AnyFunctionReference> = F["_args"];
export type FunctionReturnType<F extends AnyFunctionReference> = F["_returnType"];
/** The application errors of a function (`ErrorSpec` union); `never` when it declares and infers none. */
export type FunctionErrors<F> = F extends { readonly _errors?: infer E } ? (unknown extends E ? ErrorSpec : Exclude<E, undefined>) : ErrorSpec;
export type FunctionShard<F> = F extends { readonly _shard?: infer S } ? (unknown extends S ? ShardSpec | null : Exclude<S, undefined>) : ShardSpec | null;

/** Short names for app code: `Args<typeof api.messages.send>`, `Returns<...>`, `Errors<...>`. */
export type Args<F extends AnyFunctionReference> = F["_args"];
export type Returns<F extends AnyFunctionReference> = F["_returnType"];
export type Errors<F extends AnyFunctionReference> = FunctionErrors<F>;
/** The item type of a paginated function (`Returns<F>["page"][number]`). */
export type Item<F extends AnyFunctionReference> = F["_returnType"] extends { page: Array<infer T> } ? T : never;

/** Whether `{}` (no arguments) is a valid call. */
type NoArgs<A> = {} extends A ? true : false;
/** `[args?]` when the function takes no (required) arguments, `[args]` otherwise. */
export type OptionalRestArgs<F> = F extends AnyFunctionReference
  ? NoArgs<F["_args"]> extends true
    ? [args?: F["_args"]]
    : [args: F["_args"]]
  : [args?: Record<string, unknown>]; // a function name (server-side scheduling by name): untyped
/** `[args?, options?]` / `[args, options?]`. */
export type ArgsAndOptions<F, O> = F extends AnyFunctionReference
  ? NoArgs<F["_args"]> extends true
    ? [args?: F["_args"], options?: O]
    : [args: F["_args"], options?: O]
  : never;
/** Like `ArgsAndOptions`, with `"skip"` (React hooks) in place of the args. */
export type ArgsOrSkipAndOptions<F, O> = F extends AnyFunctionReference
  ? NoArgs<F["_args"]> extends true
    ? [args?: F["_args"] | "skip", options?: O]
    : [args: F["_args"] | "skip", options?: O]
  : never;

export const FUNCTION_NAME = Symbol.for("ember.functionName");
export const FUNCTION_SHARD = Symbol.for("ember.functionShard");

/** A reference to `"module:export"` (or `"dir/module:export"`) with the types you give it. */
export function makeFunctionReference<Type extends FunctionType, Args = Record<string, unknown>, Returns = unknown, Vis extends Visibility = Visibility>(
  name: string,
): FunctionReference<Type, Vis, Args, Returns> {
  return { [FUNCTION_NAME]: name } as unknown as FunctionReference<Type, Vis, Args, Returns>;
}

/**
 * An untyped reference by name: args are `Record<string, unknown>` and the result `unknown`. Typed APIs take only
 * references (`api.x.y`); this is the explicit way out (tests, dynamic dispatch, a function outside the generated api).
 */
// The kind defaults to any kind (it is a reference by name: the server checks it).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unsafeRef<Type extends FunctionType = any>(name: string): FunctionReference<Type, Visibility, Record<string, unknown>, unknown> {
  if (typeof name !== "string" || !name.includes(":")) throw new Error(`Ember: unsafeRef expects "module:export", got ${JSON.stringify(name)}`);
  return makeFunctionReference<Type>(name);
}

/** `"module:export"` of a reference (or of a name, returned as is). */
export function getFunctionName(ref: AnyFunctionReference | string): string {
  if (typeof ref === "string") return ref;
  const name = (ref as unknown as Record<symbol, unknown> | null)?.[FUNCTION_NAME];
  if (typeof name !== "string") throw new Error("Ember: not a function reference");
  return name;
}

/** The routing spec the generated `api.js` attaches to a reference (`undefined` for hand-made references). */
export function getFunctionShard(ref: AnyFunctionReference | string): ShardSpec | null | undefined {
  if (typeof ref === "string") return undefined;
  return (ref as unknown as Record<symbol, ShardSpec | null | undefined> | null)?.[FUNCTION_SHARD];
}

// ------------------------------------------------------------------------------------------------ results

/** `{ ok: true, value } | { ok: false, error }`: a call that does not throw (`toResult`, `mutation.safe()`). */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Awaits `p` and returns a `Result` instead of throwing. */
export async function toResult<T, E = unknown>(p: Promise<T>): Promise<Result<T, E>> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error: error as E };
  }
}

// ------------------------------------------------------------------------------------------------ pagination

/** What a paginated query receives in `args.paginationOpts`. */
export type PaginationOptions = { numItems: number; cursor: string | null; endCursor?: string | null };
/** What a paginated query returns (`.paginate()`). */
export type PaginationResult<T> = { page: T[]; isDone: boolean; continueCursor: string };
