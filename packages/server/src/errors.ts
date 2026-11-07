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
  | "PrivateSql";

/** A typed engine error. `code` is stable and goes on the wire (`{code, message}`). */
export class EmberError extends Error {
  override readonly name = "EmberError";
  constructor(
    readonly code: EmberErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export const isEmberError = (e: unknown): e is EmberError => e instanceof EmberError;

/** Wire form of any thrown value. */
export function errorInfo(e: unknown): { code: string; message: string; data?: unknown } {
  if (e instanceof EmberError) return e.data === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, data: e.data };
  if (e instanceof Error) return { code: "Error", message: e.message };
  return { code: "Error", message: String(e) };
}
