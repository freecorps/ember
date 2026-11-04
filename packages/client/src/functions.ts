/**
 * Function references (Convex-style). `anyApi.messages.list` is a reference to `"messages:list"`;
 * `anyApi.chat.messages.list` to `"chat/messages:list"`. Codegen later emits a typed `api` object with the same
 * runtime shape (`export const api: { messages: { list: FunctionReference<"query", {...}, ...> } } = anyApi`).
 */

export type FunctionType = "query" | "mutation" | "action";

export type DefaultArgs = Record<string, unknown>;

const NAME = Symbol.for("ember.functionName");

export interface FunctionReference<Type extends FunctionType = FunctionType, Args = any, Return = any> {
  /** Type-level only. */
  readonly _type: Type;
  /** Type-level only. */
  readonly _args: Args;
  /** Type-level only. */
  readonly _returnType: Return;
}

export type AnyFunctionReference = FunctionReference<any, any, any>;
export type FunctionArgs<F extends AnyFunctionReference> = F["_args"];
export type FunctionReturnType<F extends AnyFunctionReference> = F["_returnType"];

/** Either a reference or a plain `"module:export"` name (untyped). */
export type FunctionLike<Type extends FunctionType = FunctionType> = FunctionReference<Type> | string;

/** Args parameter list: optional when the function takes `{}` (or any). */
export type OptionalArgs<F extends AnyFunctionReference> = keyof F["_args"] extends never ? [args?: F["_args"]] : [args: F["_args"]];

type AnyModuleDirOrFunc = { [key: string]: AnyModuleDirOrFunc } & AnyFunctionReference;
export type AnyApi = Record<string, Record<string, AnyModuleDirOrFunc>>;

function pathToName(path: readonly string[]): string {
  if (path.length < 2) throw new Error(`Ember: a function reference needs a module and an export, got "${path.join(".")}"`);
  return `${path.slice(0, -1).join("/")}:${path[path.length - 1]}`;
}

function createApi(path: readonly string[] = []): any {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === NAME) return pathToName(path);
        if (typeof prop === "symbol") return undefined;
        if (prop === "toJSON" || prop === "then") return undefined;
        return createApi([...path, prop]);
      },
    },
  );
}

/** Untyped API object: every property path is a function reference. */
export const anyApi: AnyApi = createApi();

/** Build a typed reference from a name, e.g. in tests or hand-written API types. */
export function makeFunctionReference<Type extends FunctionType, Args = DefaultArgs, Return = unknown>(
  name: string,
): FunctionReference<Type, Args, Return> {
  return { [NAME]: name } as unknown as FunctionReference<Type, Args, Return>;
}

/** `"module:export"` for a reference or a name. */
export function getFunctionName(ref: FunctionLike): string {
  if (typeof ref === "string") return ref;
  const name = (ref as unknown as Record<symbol, unknown>)[NAME];
  if (typeof name !== "string") throw new Error("Ember: not a function reference");
  return name;
}
