/**
 * `@freecorps/ember-flags`: feature flags and remote config as an Ember component (PLAN §12), evaluated with no round
 * trip in every shard.
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(flags);
 *
 *   // ember/flags.ts
 *   export const ff = new FeatureFlags(components.flags, {
 *     newCheckout: { type: "boolean", default: false },
 *     checkoutTheme: { type: "string", default: "classic" },
 *   });
 *   // in any query or mutation, on any shard: a synchronous read of the shard's local copy (0 RTT)
 *   if (ff.evaluate(ctx, "newCheckout", { unitId: userId, plan })) { ... }
 *   // the values a client may see (`clientVisible` flags), for `useFlag` in `@freecorps/ember-flags/react`
 *   export const forClient = query({ args: { context: vFlagContext }, handler: (ctx, a) => ff.forClient(ctx, a.context) });
 *
 * The flags table is `.replicated()`: admin writes (`setFlag`, `setRules`, `setRollout`, `toggle`, `deleteFlag`) run in
 * `global:main`, the runtime copies them to every shard, and evaluation reads the copy. The evaluator itself is pure
 * (`@freecorps/ember-flags/eval`): the same result on the client over a snapshot (`definitions`).
 */
import type { FunctionReference } from "@freecorps/ember-server";
import { evaluateDetail, flagValueError, type Evaluation, type FlagContext, type FlagDefinition, type FlagRollout, type FlagRule, type FlagType, type FlagValueOf } from "./eval.ts";

export * from "./eval.ts";
export { flags, functions as flagsFunctions, flagErrors, vFlagContext, vFlagType, vRule, vCondition, vRollout, KEY_PATTERN, MAX_RULES, MAX_CONDITIONS } from "./component.ts";

/** A flag as `get`/`definitions` return it. */
export type StoredFlag = FlagDefinition & { clientVisible: boolean; updatedAt: number; version: number };

export type SetFlagArgs = {
  key: string;
  type: FlagType;
  defaultValue: unknown;
  value?: unknown;
  enabled?: boolean;
  description?: string;
  clientVisible?: boolean;
  rules?: FlagRule[];
  rollout?: FlagRollout;
};
type Ctx = FlagContext;
type FlagNotFound = import("@freecorps/ember-server").ErrorSpec<"FlagNotFound", { key: string }>;

/** What `components.<name>` of the flags component looks like (structural: any install name works). */
export interface FlagsComponentApi {
  lib: {
    get: FunctionReference<"query", "public", { key: string }, StoredFlag | null>;
    definitions: FunctionReference<"query", "public", { clientVisible?: boolean }, StoredFlag[]>;
    evaluate: FunctionReference<"query", "public", { key: string; context?: Ctx }, Evaluation>;
    all: FunctionReference<"query", "public", { context?: Ctx }, Record<string, unknown>>;
    forClient: FunctionReference<"query", "public", { context?: Ctx }, Record<string, unknown>>;
    setFlag: FunctionReference<"mutation", "public", SetFlagArgs, number>;
    deleteFlag: FunctionReference<"mutation", "public", { key: string }, boolean>;
    setRules: FunctionReference<"mutation", "public", { key: string; rules: FlagRule[] }, number, FlagNotFound>;
    setRollout: FunctionReference<"mutation", "public", { key: string; percent: number | null; salt?: string }, number, FlagNotFound>;
    toggle: FunctionReference<"mutation", "public", { key: string; enabled: boolean }, number, FlagNotFound>;
  };
}

/** A flag the app declares: its type and the value served when the flag is missing or holds a value of another type. */
export type FlagSpec<T extends FlagType = FlagType> = { type: T; default: FlagValueOf<T> };
export type FlagSpecs = Record<string, FlagSpec>;
/** The value of a declared flag. */
export type SpecValue<S> = S extends FlagSpec<infer T> ? FlagValueOf<T> : unknown;
/** Every declared flag's value, plus the undeclared ones (`unknown`). */
export type FlagValues<Specs extends FlagSpecs> = { [K in keyof Specs]: SpecValue<Specs[K]> } & Record<string, unknown>;

// Method syntax: any ctx's typed `runQuery`/`runMutation` fits (parameters are compared bivariantly).
/** A query's or mutation's ctx: reads run in its transaction and return values (0 RTT: the shard's local copy). */
type SyncCtx = { db: unknown; runQuery(fn: unknown, args?: unknown): unknown };
type SyncWriteCtx = SyncCtx & { runMutation(fn: unknown, args?: unknown): unknown };
/** An action's ctx (or `ctx.onShard(s)`): each call is its own transaction on that shard. */
type AsyncCtx = { runQuery(fn: unknown, args?: unknown): Promise<unknown>; runMutation(fn: unknown, args?: unknown): Promise<unknown> };

const isSync = (ctx: SyncCtx | AsyncCtx): ctx is SyncCtx => "db" in ctx;
const isThenable = <T>(x: T | Promise<T>): x is Promise<T> => typeof (x as { then?: unknown } | null)?.then === "function";
const then = <T, R>(x: T | Promise<T>, f: (t: T) => R): R | Promise<R> => (isThenable(x) ? x.then(f) : f(x));

/**
 * Typed helper over an installed flags component. Reads work in queries and mutations (synchronous, the shard's local
 * copy) and in actions (a Promise). Writes must run in `global:main`: from a mutation there, or from an action via
 * `ctx.onShard("global:main")` (anywhere else the engine refuses them with `ReadOnlyTable`).
 */
export class FeatureFlags<Specs extends FlagSpecs = {}> {
  constructor(
    readonly component: FlagsComponentApi,
    readonly specs: Specs = {} as Specs,
  ) {}

  /** The value of a declared flag for `context` (its declared `default` when missing or of another type). */
  evaluate<K extends keyof Specs & string>(ctx: SyncCtx, key: K, context?: FlagContext): SpecValue<Specs[K]>;
  evaluate<K extends keyof Specs & string>(ctx: AsyncCtx, key: K, context?: FlagContext): Promise<SpecValue<Specs[K]>>;
  evaluate(ctx: SyncCtx | AsyncCtx, key: string, context: FlagContext = {}): unknown {
    return then(this.detail(ctx as SyncCtx, key, context), (d) => d.value);
  }

  /** `evaluate` with the reason (`rule`, `rollout`, `disabled`, `missing`, ...) and the flag's version. */
  detail<K extends keyof Specs & string>(ctx: SyncCtx, key: K, context?: FlagContext): Evaluation<SpecValue<Specs[K]>>;
  detail<K extends keyof Specs & string>(ctx: AsyncCtx, key: K, context?: FlagContext): Promise<Evaluation<SpecValue<Specs[K]>>>;
  detail(ctx: SyncCtx | AsyncCtx, key: string, context: FlagContext = {}): Evaluation | Promise<Evaluation> {
    const flag = ctx.runQuery(this.component.lib.get, { key }) as StoredFlag | null | Promise<StoredFlag | null>;
    return then(flag, (f) => this.typed(key, evaluateDetail(f, context, this.specs[key]?.default)));
  }

  /** Any flag's value, declared or not (`fallback` when it does not exist). */
  value<V = unknown>(ctx: SyncCtx, key: string, context?: FlagContext, fallback?: V): V;
  value<V = unknown>(ctx: AsyncCtx, key: string, context?: FlagContext, fallback?: V): Promise<V>;
  value<V = unknown>(ctx: SyncCtx | AsyncCtx, key: string, context: FlagContext = {}, fallback?: V): V | Promise<V> {
    const flag = ctx.runQuery(this.component.lib.get, { key }) as StoredFlag | null | Promise<StoredFlag | null>;
    return then(flag, (f) => this.typed(key, evaluateDetail(f, context, fallback)).value as V);
  }

  /** Every flag's value for `context` (declared ones always present, with their default when missing). */
  all(ctx: SyncCtx, context?: FlagContext): FlagValues<Specs>;
  all(ctx: AsyncCtx, context?: FlagContext): Promise<FlagValues<Specs>>;
  all(ctx: SyncCtx | AsyncCtx, context: FlagContext = {}): FlagValues<Specs> | Promise<FlagValues<Specs>> {
    const defs = ctx.runQuery(this.component.lib.definitions, {}) as StoredFlag[] | Promise<StoredFlag[]>;
    return then(defs, (list) => {
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(this.specs)) out[k] = s.default;
      for (const f of list) out[f.key] = this.typed(f.key, evaluateDetail(f, context)).value;
      return out as FlagValues<Specs>;
    });
  }

  /**
   * The values of the `clientVisible` flags for `context`: return it from an app query (clients never call component
   * functions). Declared client-visible flags missing in the table are not included (the client has its own default).
   */
  forClient(ctx: SyncCtx, context?: FlagContext): Record<string, unknown>;
  forClient(ctx: AsyncCtx, context?: FlagContext): Promise<Record<string, unknown>>;
  forClient(ctx: SyncCtx | AsyncCtx, context: FlagContext = {}): Record<string, unknown> | Promise<Record<string, unknown>> {
    const r = ctx.runQuery(this.component.lib.forClient, { context }) as Record<string, unknown> | Promise<Record<string, unknown>>;
    return then(r, (values) => {
      for (const k of Object.keys(values)) if (this.specs[k] && flagValueError(this.specs[k]!.type, values[k]) !== null) values[k] = this.specs[k]!.default;
      return values;
    });
  }

  /** Every flag as stored (or only the client-visible ones): a snapshot for `evaluate` from `/eval`, offline. */
  definitions(ctx: SyncCtx, opts?: { clientVisible?: boolean }): StoredFlag[];
  definitions(ctx: AsyncCtx, opts?: { clientVisible?: boolean }): Promise<StoredFlag[]>;
  definitions(ctx: SyncCtx | AsyncCtx, opts: { clientVisible?: boolean } = {}): StoredFlag[] | Promise<StoredFlag[]> {
    return ctx.runQuery(this.component.lib.definitions, opts.clientVisible ? { clientVisible: true } : {}) as StoredFlag[] | Promise<StoredFlag[]>;
  }

  // -------------------------------------------------------------------------------------- admin (global:main only)

  /** Creates or replaces a flag (see `lib:setFlag`). Returns its new version. */
  set(ctx: SyncWriteCtx, flag: SetFlagArgs): number;
  set(ctx: AsyncCtx, flag: SetFlagArgs): Promise<number>;
  set(ctx: SyncWriteCtx | AsyncCtx, flag: SetFlagArgs): number | Promise<number> {
    return this.writer(ctx).runMutation(this.component.lib.setFlag, flag) as number | Promise<number>;
  }
  /** Turns a flag on or off. */
  toggle(ctx: SyncWriteCtx, key: string, enabled: boolean): number;
  toggle(ctx: AsyncCtx, key: string, enabled: boolean): Promise<number>;
  toggle(ctx: SyncWriteCtx | AsyncCtx, key: string, enabled: boolean): number | Promise<number> {
    return this.writer(ctx).runMutation(this.component.lib.toggle, { key, enabled }) as number | Promise<number>;
  }
  /** Replaces the targeting rules. */
  setRules(ctx: SyncWriteCtx, key: string, rules: FlagRule[]): number;
  setRules(ctx: AsyncCtx, key: string, rules: FlagRule[]): Promise<number>;
  setRules(ctx: SyncWriteCtx | AsyncCtx, key: string, rules: FlagRule[]): number | Promise<number> {
    return this.writer(ctx).runMutation(this.component.lib.setRules, { key, rules }) as number | Promise<number>;
  }
  /** Sets (or with `null`, removes) the rollout percent; `salt` reshuffles who is in. */
  setRollout(ctx: SyncWriteCtx, key: string, percent: number | null, salt?: string): number;
  setRollout(ctx: AsyncCtx, key: string, percent: number | null, salt?: string): Promise<number>;
  setRollout(ctx: SyncWriteCtx | AsyncCtx, key: string, percent: number | null, salt?: string): number | Promise<number> {
    return this.writer(ctx).runMutation(this.component.lib.setRollout, salt !== undefined ? { key, percent, salt } : { key, percent }) as number | Promise<number>;
  }
  /** Deletes a flag. */
  delete(ctx: SyncWriteCtx, key: string): boolean;
  delete(ctx: AsyncCtx, key: string): Promise<boolean>;
  delete(ctx: SyncWriteCtx | AsyncCtx, key: string): boolean | Promise<boolean> {
    return this.writer(ctx).runMutation(this.component.lib.deleteFlag, { key }) as boolean | Promise<boolean>;
  }

  // ------------------------------------------------------------------------------------------------ internals

  /** A declared flag whose stored value has another type serves its declared default (reason kept). */
  private typed(key: string, e: Evaluation): Evaluation {
    const s = this.specs[key];
    if (s && flagValueError(s.type, e.value) !== null) return { ...e, value: s.default };
    return e;
  }

  private writer(ctx: SyncWriteCtx | AsyncCtx): SyncWriteCtx | AsyncCtx {
    if (isSync(ctx) && typeof (ctx as Partial<SyncWriteCtx>).runMutation !== "function") throw new Error("flags: writes need a mutation or action ctx");
    return ctx;
  }
}
