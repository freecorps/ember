/**
 * Function references (Convex-style), shared with the server through @freecorps/ember-values. The generated
 * `_generated/api` exports `api.<module>.<fn>` references typed with their args, return value, errors and shard;
 * `api.dir.mod.fn` is `"dir/mod:fn"` at runtime.
 */

export {
  FUNCTION_NAME,
  FUNCTION_SHARD,
  getFunctionName,
  getFunctionShard,
  makeFunctionReference,
  toResult,
  unsafeRef,
  type AnyFunctionReference,
  type Args,
  type ArgsAndOptions,
  type ArgsOrSkipAndOptions,
  type ErrorSpec,
  type Errors,
  type FunctionArgs,
  type FunctionErrors,
  type FunctionReference,
  type FunctionReturnType,
  type FunctionShard,
  type FunctionType,
  type Item,
  type OptionalRestArgs,
  type PaginationOptions,
  type PaginationResult,
  type Result,
  type Returns,
  type ShardSpec,
  type Visibility,
} from "@freecorps/ember-values";

import { FUNCTION_NAME, type FunctionReference, type FunctionType, type Visibility } from "@freecorps/ember-values";

/** Untyped API object: every property path is a reference (`anyApi.dir.mod.fn` → `"dir/mod:fn"`), args and result untyped. */
export type AnyApi = { readonly [key: string]: AnyApi } & FunctionReference<FunctionType, Visibility, Record<string, unknown>, unknown>;

function pathToName(path: readonly string[]): string {
  if (path.length < 2) throw new Error(`Ember: a function reference needs a module and an export, got "${path.join(".")}"`);
  return `${path.slice(0, -1).join("/")}:${path[path.length - 1]}`;
}
function createApi(path: readonly string[] = []): AnyApi {
  return new Proxy({} as AnyApi, {
    get(_target, prop) {
      if (prop === FUNCTION_NAME) return pathToName(path);
      if (typeof prop === "symbol" || prop === "toJSON" || prop === "then") return undefined;
      return createApi([...path, prop]);
    },
  });
}
/** Untyped API object (prefer the generated, typed `api`). */
export const anyApi: AnyApi = createApi();
