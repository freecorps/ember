import type { AnyFunctionReference, ErrorSpec, FunctionErrors } from "@freecorps/ember-values";

/** `"app"`: thrown by the app (`defineErrors`), with a typed `data`; `"system"`: Ember, transport or the client. */
export type ErrorKind = "app" | "system";
/**
 * For mutations: whether it is known that nothing was written. `"rejected"`: the server answered with this error, so
 * the mutation did not commit. `"unknown"`: the request may or may not have reached the server (a network failure after
 * sending). Re-sending the same mutation is safe either way (the server deduplicates by mutation id).
 */
export type Outcome = "rejected" | "unknown";

/** A typed failure from the server (`mres ok:false`, `err`, HTTP error body) or from the client itself. */
export class EmberError<Code extends string = string, Data = unknown> extends Error {
  readonly kind: ErrorKind;
  readonly outcome: Outcome | undefined;
  constructor(
    readonly code: Code,
    message: string,
    readonly data?: Data,
    options: { kind?: ErrorKind; outcome?: Outcome } = {},
  ) {
    super(message);
    this.name = "EmberError";
    this.kind = options.kind ?? "system";
    this.outcome = options.outcome;
  }
}

export const isEmberError = (e: unknown): e is EmberError => e instanceof EmberError;

/** A failed call on the wire. */
export type WireErrorLike = { code?: string; message?: string; data?: unknown; kind?: string };

/** Builds the client error for a server failure. */
export function errorFromWire(w: WireErrorLike | undefined, fallbackCode: string, outcome?: Outcome): EmberError {
  const code = typeof w?.code === "string" ? w.code : fallbackCode;
  const message = typeof w?.message === "string" ? w.message : code;
  return new EmberError(code, message, w?.data, { kind: w?.kind === "app" ? "app" : "system", ...(outcome ? { outcome } : {}) });
}

/** The client error type of one application error. */
export type AppErrorOf<S> = S extends ErrorSpec<infer C, infer D> ? EmberError<C, D> & { readonly kind: "app"; readonly data: D } : never;
/** Any error that is not an application error (`ValidationError`, `Unauthenticated`, `network_error`, ...). */
export type SystemError = EmberError<string, unknown> & { readonly kind: "system" };
/** Everything a call of `F` can reject with: its application errors (typed `data`) or a system error. */
export type EmberErrorOf<F> = AppErrorOf<FunctionErrors<F>> | SystemError;

/**
 * Whether `e` is an application error (`kind: "app"`). Structural, so it also recognises errors from other copies of the
 * package and the server's `AppError` (tests calling the engine directly).
 */
export function isAppError(e: unknown): e is EmberError<string, unknown> & { readonly kind: "app" } {
  return typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "app" && typeof (e as { code?: unknown }).code === "string";
}

/**
 * Narrows `e` to one application error of `fn` (the reference only drives the types):
 * `if (isError(e, api.messages.send, "MessageTooLong")) e.data.max`.
 */
export function isError<F extends AnyFunctionReference, const C extends FunctionErrors<F>["code"]>(
  e: unknown,
  fn: F,
  code: C,
): e is AppErrorOf<Extract<FunctionErrors<F>, { code: C }>>;
/** With a generated error (`import { errors } from "../ember/_generated/errors"`): `isError(e, errors.RoomNotFound)`. */
export function isError<S extends ErrorSpec>(e: unknown, error: { readonly code: S["code"]; readonly __spec?: S }): e is AppErrorOf<S>;
export function isError(e: unknown, a: unknown, code?: string): boolean {
  const want = code ?? (a as { code?: unknown } | null)?.code;
  return isAppError(e) && e.code === want;
}

/** What `_generated/errors.js` builds for each app error (no server code). */
export function errorRef<S extends ErrorSpec>(code: S["code"]): { readonly code: S["code"]; is(e: unknown): e is AppErrorOf<S>; readonly __spec?: S } {
  return Object.freeze({ code, is: (e: unknown): e is AppErrorOf<S> => isAppError(e) && e.code === code });
}
