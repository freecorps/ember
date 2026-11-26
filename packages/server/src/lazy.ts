// Actions loaded on first use: what the generated Worker entry registers for a module that exports only actions
// (`ember` build, packages/cli/src/build.ts). The module is reached through `import()`, so a split build puts it and
// the SDKs it imports in a chunk of their own, which a Shard isolate never evaluates while it only runs queries and
// mutations. What the engine reads synchronously (type, visibility, args to check a scheduled call, shard, dispatch)
// comes from the build, as plain data; the handler, its middlewares, declared errors and return validator come with
// the module, and `loadFunction` hands the real definition to whoever runs it (`ActionRunner`).

import type { ObjectShape, Shape, ShardSpec, Visibility } from "@freecorps/ember-values";
import { IS_FUNCTION, isRegisteredFunction, type AnyRegisteredFunction } from "./functions.ts";

/** What the build records of one action (all plain JSON). */
export interface LazyActionMeta {
  type: "action";
  visibility: Visibility;
  args: ObjectShape;
  returns?: Shape;
  shard?: ShardSpec;
  dispatch?: "shard";
  leaseMs?: number;
  sensitive?: true;
  declaresErrors?: true;
  /** Codes of its declared errors (listings; the factories come with the module). */
  errorCodes?: string[];
}

const LAZY = Symbol.for("ember.lazyFunction");

type Lazy = AnyRegisteredFunction & { readonly [LAZY]: () => Promise<AnyRegisteredFunction>; readonly errorCodes?: readonly string[] };

/**
 * The actions of a module loaded on first use: one stand-in per export, carrying the build's metadata. Its handler
 * loads the module and runs the real one (a runtime that knows `loadFunction` runs the real definition directly). A
 * failed load is retried by the next call.
 */
export function lazyActions(load: () => Promise<Record<string, unknown>>, meta: Record<string, LazyActionMeta>): Record<string, AnyRegisteredFunction> {
  let loading: Promise<Record<string, unknown>> | undefined;
  const mod = () => {
    if (!loading) {
      const p = load();
      loading = p;
      p.catch(() => {
        if (loading === p) loading = undefined;
      });
    }
    return loading;
  };
  const out: Record<string, AnyRegisteredFunction> = {};
  for (const [name, m] of Object.entries(meta)) {
    const real = async (): Promise<AnyRegisteredFunction> => {
      const f = (await mod())[name];
      if (!isRegisteredFunction(f) || f.type !== "action") throw new Error(`lazy action ${name}: the module no longer exports it as an action (rebuild the Worker)`);
      return f as AnyRegisteredFunction;
    };
    const stub: Record<PropertyKey, unknown> = {
      [IS_FUNCTION]: true,
      [LAZY]: real,
      ...m,
      handler: async (ctx: unknown, args: unknown) => (await real()).handler(ctx, args),
    };
    if (m.errorCodes) stub.errorCodes = Object.freeze([...m.errorCodes]);
    out[name] = Object.freeze(stub) as unknown as AnyRegisteredFunction;
  }
  return out;
}

/** Whether `f` is a stand-in of `lazyActions` (its module not necessarily loaded). */
export const isLazyFunction = (f: unknown): boolean => typeof f === "object" && f !== null && typeof (f as Partial<Lazy>)[LAZY] === "function";

/** The definition to run: the real one of a lazy action (loading its module), else `f` itself. */
export async function loadFunction<F>(f: F): Promise<F> {
  return isLazyFunction(f) ? ((await (f as unknown as Lazy)[LAZY]()) as unknown as F) : f;
}

/** Declared error codes of a function, lazy or not (listings). */
export function errorCodesOf(f: { errors?: ReadonlyArray<{ code?: string }> }): string[] {
  const lazy = (f as { errorCodes?: readonly string[] }).errorCodes;
  if (isLazyFunction(f) && lazy) return [...lazy];
  return (f.errors ?? []).map((e) => String(e.code ?? "")).filter(Boolean);
}
