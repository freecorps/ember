import { type ErrorSpec, type GenericValidator, type Infer, type Shape } from "@freecorps/ember-values";

export type EmberErrorCode =
  | "ValidationError"
  | "NotFound"
  | "TooManyReads"
  | "TooManyWrites"
  | "DocumentTooLarge"
  | "SchemaError"
  | "MigrationRefused"
  | "IndexNotReady"
  | "FunctionNotFound"
  | "InvalidFunction"
  | "AsyncHandler"
  | "QueryError"
  | "InvalidCursor"
  | "FileNotFound"
  | "FileInUse"
  | "StorageError"
  /** A query run offline (on a client replica) used something only the server has: aggregates, ctx.db.sql, files. */
  | "OfflineUnsupported"
  /** `ctx.sql` used without `defineSchema({ privateSql })`, or naming a schema table or an Ember internal. */
  | "PrivateSql"
  /** `ctx.auth.require()` without a signed-in caller. */
  | "Unauthenticated"
  /** A function declared for one shard kind called on another (`shard:` in its definition). */
  | "WrongShard"
  /** An action read a declared env var (`defineApp({ env })`) that is not set or invalid. */
  | "EnvMissing";

/** A typed engine error. `code` is stable and goes on the wire (`{code, message, data?, kind?}`). */
export class EmberError<Code extends string = EmberErrorCode> extends Error {
  override readonly name: string = "EmberError";
  /** `"app"`: thrown by application code through `defineErrors`; `"system"`: everything else. */
  readonly kind: "app" | "system" = "system";
  constructor(
    readonly code: Code,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export const isEmberError = (e: unknown): e is EmberError<string> => e instanceof EmberError;

// ------------------------------------------------------------------------------------------- app errors

const ERROR_FACTORY = Symbol.for("ember.errorFactory");
/** Every code defined by `defineErrors` in this isolate (codegen reads it to describe inferred errors). */
const REGISTRY_KEY = Symbol.for("ember.errorRegistry");
export type ErrorRegistryEntry = { code: string; data: Shape | null; message?: string };
function registry(): Map<string, ErrorRegistryEntry> {
  const g = globalThis as unknown as Record<symbol, Map<string, ErrorRegistryEntry> | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}
/** The error codes `defineErrors` registered so far (in definition order). */
export const definedErrors = (): ErrorRegistryEntry[] => [...registry().values()];

/** An application error (`errors.X(data)`): `kind: "app"`, a code of the app, and a payload checked by its validator. */
export class AppError<Code extends string = string, Data = unknown> extends EmberError<Code> {
  override readonly name = "AppError";
  override readonly kind = "app" as const;
  declare readonly data: Data;
  constructor(code: Code, message: string, data: Data) {
    super(code, message, data);
  }
}

export type ErrorDefinition = {
  /** The payload's validator (omit for errors without data). */
  data?: GenericValidator;
  /** Default message: a string or a function of the payload. */
  message?: string | ((data: never) => string);
};
type DataOf<D> = D extends { data: infer V extends GenericValidator } ? Infer<V> : undefined;

export interface ErrorFactory<Code extends string = string, Data = unknown> {
  /** Builds the error (`throw errors.RoomNotFound({ roomId })`). The payload is validated. */
  (...args: undefined extends Data ? [data?: Data, options?: { message?: string }] : [data: Data, options?: { message?: string }]): AppError<Code, Data>;
  readonly code: Code;
  readonly shape: Shape | null;
  /** Whether `e` is this error (any `AppError` or wire error with this code). */
  is(e: unknown): e is AppError<Code, Data>;
  /** Phantom: the `ErrorSpec` this factory produces. */
  readonly __spec?: ErrorSpec<Code, Data>;
}
export type AnyErrorFactory = ErrorFactory<string, any>;
/** `ErrorSpec` union of a list of factories. */
export type ErrorSpecsOf<L extends readonly AnyErrorFactory[]> = SpecOf<L[number]>;
type SpecOf<F> = F extends { readonly code: infer C extends string; readonly __spec?: ErrorSpec<string, infer D> } ? ErrorSpec<C, D> : never;

export const isErrorFactory = (x: unknown): x is AnyErrorFactory => typeof x === "function" && (x as unknown as Record<symbol, unknown>)[ERROR_FACTORY] === true;

const CODE = /^[A-Z][A-Za-z0-9]{0,63}$/;

/**
 * The application's error codes (docs/design/dx.md §3.2). Each entry is a factory: `throw errors.RoomNotFound({ roomId })`.
 * Codes are PascalCase and unique across the app; the payload goes to the client validated and typed
 * (`isError(e, api.rooms.get, "RoomNotFound")` narrows `e.data`).
 */
export function defineErrors<const Defs extends Record<string, ErrorDefinition>>(defs: Defs): { readonly [K in keyof Defs & string]: ErrorFactory<K, DataOf<Defs[K]>> } {
  const out: Record<string, AnyErrorFactory> = {};
  const reg = registry();
  for (const [code, def] of Object.entries(defs)) {
    if (!CODE.test(code)) throw new Error(`defineErrors: ${JSON.stringify(code)} is not a PascalCase error code`);
    const shape = def.data?.shape ?? null;
    const prev = reg.get(code);
    if (prev && JSON.stringify(prev.data) !== JSON.stringify(shape)) throw new Error(`defineErrors: "${code}" is defined twice with different data`);
    reg.set(code, { code, data: shape, ...(typeof def.message === "string" ? { message: def.message } : {}) });
    const factory = (data?: unknown, options?: { message?: string }) => {
      if (def.data) {
        const r = def.data.validate(data);
        if (!r.ok) throw new EmberError("ValidationError", `errors.${code}: invalid data${r.path ? ` at ${r.path}` : ""}: ${r.message}`);
      } else if (data !== undefined) {
        throw new EmberError("ValidationError", `errors.${code} takes no data`);
      }
      const message = options?.message ?? (typeof def.message === "function" ? (def.message as (d: unknown) => string)(data) : def.message) ?? code;
      return new AppError(code, message, data);
    };
    Object.defineProperties(factory, {
      code: { value: code, enumerable: true },
      shape: { value: shape, enumerable: true },
      is: { value: (e: unknown) => isAppError(e) && e.code === code },
      [ERROR_FACTORY]: { value: true },
      name: { value: code },
    });
    out[code] = factory as unknown as AnyErrorFactory;
  }
  return Object.freeze(out) as never;
}

/** An application error, thrown here or received from another function (same shape on the wire). */
export const isAppError = (e: unknown): e is AppError<string, unknown> =>
  e instanceof AppError || (typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "app" && typeof (e as { code?: unknown }).code === "string");

// ------------------------------------------------------------------------------------------------ wire

/** A payload on the wire (any Ember value; typed this way so Durable Object RPC accepts it). */
export type WireData = object | string | number | boolean | bigint | null;
/** What travels to the client for a failed call. `data` only for errors that carry one. */
export type WireError = { code: string; message: string; data?: WireData; kind?: "app" };

/** Wire form of any thrown value. `fallback` is the code of values that carry none. */
export function errorInfo(e: unknown, fallback = "Error"): WireError {
  if (isAppError(e)) {
    const out: WireError = { code: e.code, message: String((e as { message?: unknown }).message ?? e.code), kind: "app" };
    if (e.data !== undefined) out.data = e.data as WireData;
    return out;
  }
  if (e instanceof EmberError) return e.data === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, data: e.data as WireData };
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : fallback;
  if (e instanceof Error) return { code, message: e.message };
  return { code, message: String(e) };
}

/** Rebuilds a thrown error from its wire form (an action calling a shard, a job outcome). */
export function errorFromWire(w: WireError): EmberError<string> {
  return w.kind === "app" ? new AppError(w.code, w.message, w.data) : new EmberError(w.code, w.message, w.data);
}
