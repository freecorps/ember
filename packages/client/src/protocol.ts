/**
 * WS protocol v1 as seen by the client (docs/design/contracts.md). Mirrors `packages/runtime/src/protocol.ts`.
 * "ping"/"pong" are literal strings (hibernation auto-response), never JSON.
 */
export const PROTOCOL_VERSION = 1;

export type Id = string | number;

export type ClientMessage =
  | { t: "hello"; clientId: string; token?: string; protocol: 1 }
  | { t: "sub"; qid: Id; fn: string; args: Record<string, unknown>; resume?: { version: number; epoch: string } }
  | { t: "unsub"; qid: Id }
  | { t: "mut"; mid: Id; fn: string; args: Record<string, unknown> }
  /** `token: null` signs the socket out (anonymous); its subscriptions are re-evaluated (new `snap`s). */
  | { t: "auth"; token: string | null };

export type ServerMessage =
  | { t: "ready"; shard: string; version: number; epoch: string }
  | { t: "snap"; qid: Id; version: number; value: unknown; unchanged?: undefined }
  /** Answers a successful `resume` (same epoch and identity): the client's value is still current. */
  | { t: "snap"; qid: Id; version: number; unchanged: true; value?: undefined }
  /** `mids`: this socket's mutations whose effects are in `version`, echoed as sent; their `mres` follows. */
  | { t: "patch"; version: number; changes: Array<{ qid: Id; value: unknown }>; mids: Id[] }
  | { t: "mres"; mid: Id; ok: true; value: unknown; version: number }
  | { t: "mres"; mid: Id; ok: false; error: { code: string; message: string } }
  | { t: "err"; code: string; message: string; qid?: Id }
  | { t: "authExpired" };

/**
 * Error codes the server sends. Engine errors keep their own code; errors thrown by user functions are `"Error"`.
 * Protocol/runtime codes are snake_case.
 */
export type ErrorCode =
  // engine (`EmberError`)
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
  /** thrown by a user function */
  | "Error"
  // protocol / runtime
  | "auth_expired"
  | "unauthenticated"
  | "bad_frame"
  | "frame_too_large"
  | "unsupported_protocol"
  | "no_hello"
  | "duplicate_hello"
  | "duplicate_qid"
  | "internal"
  | (string & {});

export const PING = "ping";
export const PONG = "pong";
