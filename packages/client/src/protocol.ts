/**
 * WS protocol v1 as seen by the client (docs/design/contracts.md). Mirrors `packages/runtime/src/protocol.ts`.
 * "ping"/"pong" are literal strings (hibernation auto-response), never JSON.
 */
import type { RowDiff, ValueDiff } from "@freecorps/ember-values";

export const PROTOCOL_VERSION = 1;
/**
 * Optional features (v1.1–v1.5) this client can speak; sent in `hello{features}`, confirmed by `ready{features}`.
 * "zframe" only with the client's option `zframe` (and where the platform decodes it).
 */
export const CLIENT_FEATURES = ["rowdiff", "vdiff", "ident", "query", "ack", "batch", "qbatch", "zframe", "ephemeral"] as const;
/** Feature "batch": most messages in one array frame (the server's MAX_BATCH_MESSAGES). */
export const MAX_BATCH_MESSAGES = 512;
/** Feature "batch": a batch frame stays well under the server's 1 MiB frame limit (UTF-16 units). */
export const MAX_BATCH_BYTES = 256 * 1024;

export type Id = string | number;

export type ClientMessage =
  | { t: "hello"; clientId: string; token?: string; protocol: 1; features?: string[] }
  | { t: "sub"; qid: Id; fn: string; args: Record<string, unknown>; resume?: { version: number; epoch: string; ik?: string } }
  | { t: "q"; qid: Id; fn: string; args: Record<string, unknown> }
  | { t: "unsub"; qid: Id }
  /** Feature "ack" (v1.2): these mutations' `mres` were settled (removed from pending storage). */
  | { t: "ack"; mids: Id[] }
  | { t: "mut"; mid: Id; fn: string; args: Record<string, unknown> }
  /** `token: null` signs the socket out (anonymous); its subscriptions are re-evaluated (new `snap`s). */
  | { t: "auth"; token: string | null }
  /** Feature "ephemeral" (v1.6): join a channel (again: update the member state; without `state`, keep it). */
  /** `ref` (the `multiTab` leader's): the answer to this frame carries it. */
  | { t: "join"; ch: string; state?: unknown; ref?: number }
  | { t: "leave"; ch: string }
  /** Feature "ephemeral": broadcast to the channel's other members (`ref`: answered `published` or `err` with it). */
  | { t: "pub"; ch: string; data: unknown; ref?: number };

/** A channel member on the wire (feature "ephemeral"): one per socket. */
export type WireChannelMember = { id: string; user: string | null; state?: unknown };

export type ServerMessage =
  | { t: "ready"; shard: string; version: number; epoch: string; features?: string[] }
  /** `ik` (feature "ident"): identity tag of the value, echoed in `resume.ik`. */
  | { t: "snap"; qid: Id; version: number; value: unknown; unchanged?: undefined; ik?: string }
  /** Answers a successful `resume` (same epoch and identity): the client's value is still current. */
  | { t: "snap"; qid: Id; version: number; unchanged: true; value?: undefined }
  /** `mids`: this socket's mutations whose effects are in `version`, echoed as sent; their `mres` follows. */
  | { t: "patch"; version: number; changes: PatchChange[]; mids: Id[] }
  | { t: "qres"; qid: Id; ok: true; value: unknown; version: number }
  | { t: "qres"; qid: Id; ok: false; error: WireError }
  | { t: "mres"; mid: Id; ok: true; value: unknown; version: number }
  | { t: "mres"; mid: Id; ok: false; error: WireError }
  /** `ch` (feature "ephemeral"): a refused `pub`, or a refused update of a channel the socket stays in. */
  | { t: "err"; code: string; message: string; data?: unknown; kind?: "app"; qid?: Id; ch?: string; ref?: number }
  | { t: "authExpired" }
  /** Feature "ephemeral": the answer to `join`, every member (`self` included). */
  | { t: "joined"; ch: string; self: string; members: WireChannelMember[]; ref?: number }
  | { t: "members"; ch: string; join?: WireChannelMember[]; leave?: string[] }
  | { t: "msg"; ch: string; from: string; user: string | null; data: unknown }
  /** Feature "ephemeral": not (or no longer) in the channel. */
  | { t: "left"; ch: string; code: string; message: string; ref?: number }
  /** Feature "ephemeral": a `pub` with `ref` went out to the other members. */
  | { t: "published"; ch: string; ref: number };

/**
 * A query's new value, or (feature "rowdiff") the per-row diff from the value this socket last received, or (feature
 * "vdiff") the value diff from it (arrays of documents inside an object).
 */
export type PatchChange =
  | { qid: Id; value: unknown; diff?: undefined; vdiff?: undefined }
  | { qid: Id; diff: RowDiff; value?: undefined; vdiff?: undefined }
  | { qid: Id; vdiff: ValueDiff; value?: undefined; diff?: undefined };

/**
 * Error codes the server sends. Engine errors keep their own code; errors thrown by user functions are `"Error"`.
 * Protocol/runtime codes are snake_case.
 */
export type ErrorCode =
  // engine (`EmberError`)
  | "ValidationError"
  | "NotFound"
  | "TooManyReads"
  | "TooManyDocumentsRead"
  | "TooManyWrites"
  | "DocumentTooLarge"
  | "SchemaError"
  | "MigrationRefused"
  | "StorageFormatTooNew"
  | "RuntimeSchemaTooNew"
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

/** A failed call on the wire: `kind: "app"` for application errors (`defineErrors`), with their `data`. */
export type WireError = { code: string; message: string; data?: object | string | number | boolean | bigint | null; kind?: "app"; status?: number };
