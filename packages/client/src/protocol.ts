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
  | { t: "auth"; token: string };

export type ServerMessage =
  | { t: "ready"; shard: string; version: number; epoch: string }
  | { t: "snap"; qid: Id; version: number; value: unknown; unchanged?: undefined }
  /** Answers a successful `resume`: the client's value is still current. */
  | { t: "snap"; qid: Id; version: number; unchanged: true; value?: undefined }
  | { t: "patch"; version: number; changes: Array<{ qid: Id; value: unknown }> }
  | { t: "mres"; mid: Id; ok: true; value: unknown; version: number }
  | { t: "mres"; mid: Id; ok: false; error: { code: string; message: string } }
  | { t: "err"; code: string; message: string; qid?: Id }
  | { t: "authExpired" };

export const PING = "ping";
export const PONG = "pong";
