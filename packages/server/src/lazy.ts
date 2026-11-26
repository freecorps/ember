// Actions loaded on first use: what the generated Worker entry registers for a module that exports only actions
// (`ember` build, packages/cli/src/build.ts). The module is reached through `import()`, so a split build puts it and
// the SDKs it imports in a chunk of their own, which a Shard isolate never evaluates while it only runs queries and
// mutations. What the engine reads synchronously (type, visibility, args to check a scheduled call, shard, dispatch)
// comes from the build, as plain data; the handler, its middlewares, declared errors and return validator come with
// the module, and `loadFunction` hands the real definition to whoever runs it (`ActionRunner`). Decisions taken on the
// stand-in (visibility, the shard to route to, `sensitive`, scheduling) must hold for the real one: the loaded
// definition is checked against the metadata, and one that differs (a definition that depends on the environment it is
// evaluated in, a stale build) is refused before its handler runs.

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
      const differs = metaMismatch(m, f as AnyRegisteredFunction);
      if (differs) throw new Error(`lazy action ${name}: its \`${differs}\` differs from the one the build recorded (rebuild the Worker; a definition must not depend on the environment it is evaluated in)`);
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

/** Plain-data equality (key order ignored), for the build's JSON metadata against a loaded definition. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * The first field in which the loaded definition `f` differs from the metadata `m` (undefined: none). Every field of
 * the definition counts (one the build did not record, such as a future gate, differs too), except the handler and
 * the error factories, whose codes are compared instead.
 */
function metaMismatch(m: LazyActionMeta, f: AnyRegisteredFunction): string | undefined {
  const rec = f as unknown as Record<string, unknown>;
  const meta = m as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(rec), ...Object.keys(meta)]);
  for (const k of ["handler", "errors", "errorCodes"]) keys.delete(k);
  for (const k of keys) if (!sameData(meta[k], rec[k])) return k;
  const codes = (f.errors ?? []).map((e) => String(e.code ?? "")).filter(Boolean);
  return sameData(m.errorCodes ?? [], codes) ? undefined : "errors";
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
