/**
 * WS protocol v1 (docs/design/contracts.md). JSON text frames; "ping"/"pong"
 * literals are handled by the hibernation auto-response and never reach here.
 *
 * The decoder is strict: unknown frame types, unknown keys, wrong types and
 * oversized frames are rejected with a ProtocolError.
 */
import { parse, stringify } from "./wire.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1 << 20;

export type Id = string | number;

export type ClientMessage =
  | { t: "hello"; clientId: string; token?: string; protocol: 1 }
  | { t: "sub"; qid: Id; fn: string; args: Record<string, unknown>; resume?: { version: number; epoch: string } }
  | { t: "unsub"; qid: Id }
  | { t: "mut"; mid: Id; fn: string; args: Record<string, unknown> }
  | { t: "auth"; token: string };

export type ServerMessage =
  | { t: "ready"; shard: string; version: number; epoch: string }
  /** `unchanged: true` (value omitted) answers a successful `resume`. Proposed v1 extension. */
  | { t: "snap"; qid: Id; version: number; value: unknown }
  | { t: "snap"; qid: Id; version: number; unchanged: true }
  | { t: "patch"; version: number; changes: Array<{ qid: Id; value: unknown }> }
  | { t: "mres"; mid: Id; ok: true; value: unknown; version: number }
  | { t: "mres"; mid: Id; ok: false; error: { code: string; message: string } }
  | { t: "err"; code: string; message: string; qid?: Id }
  | { t: "authExpired" };

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

const bad = (msg: string): never => {
  throw new ProtocolError("bad_frame", msg);
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

function onlyKeys(o: Record<string, unknown>, required: string[], optional: string[] = []) {
  for (const k of required) if (!(k in o)) bad(`missing field "${k}"`);
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) bad(`unknown field "${k}"`);
  }
}

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(`"${field}" must be a non-empty string of at most ${max} chars`);
  return v as string;
}

function id(v: unknown, field: string): Id {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) bad(`"${field}" must be a non-negative integer or string`);
    return v;
  }
  return str(v, field, 128);
}

function args(v: unknown): Record<string, unknown> {
  if (!isPlainObject(v)) bad(`"args" must be an object`);
  return v as Record<string, unknown>;
}

export function decodeClientMessage(raw: string | ArrayBuffer): ClientMessage {
  if (typeof raw !== "string") throw new ProtocolError("bad_frame", "binary frames are not supported in protocol v1");
  if (raw.length > MAX_FRAME_BYTES) throw new ProtocolError("frame_too_large", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  let m: unknown;
  try {
    m = parse(raw);
  } catch {
    return bad("invalid JSON");
  }
  if (!isPlainObject(m)) return bad("frame must be a JSON object");
  switch (m.t) {
    case "hello": {
      onlyKeys(m, ["t", "clientId", "protocol"], ["token"]);
      if (m.protocol !== PROTOCOL_VERSION) throw new ProtocolError("unsupported_protocol", `protocol must be ${PROTOCOL_VERSION}`);
      const out: ClientMessage = { t: "hello", clientId: str(m.clientId, "clientId", 128), protocol: 1 };
      if (m.token !== undefined) out.token = str(m.token, "token", 16384);
      return out;
    }
    case "sub": {
      onlyKeys(m, ["t", "qid", "fn", "args"], ["resume"]);
      const out: ClientMessage = { t: "sub", qid: id(m.qid, "qid"), fn: str(m.fn, "fn", 256), args: args(m.args) };
      if (m.resume !== undefined) {
        const r = m.resume;
        if (!isPlainObject(r)) return bad(`"resume" must be an object`);
        onlyKeys(r, ["version", "epoch"]);
        if (typeof r.version !== "number" || !Number.isSafeInteger(r.version) || r.version < 0) bad(`"resume.version" must be a non-negative integer`);
        out.resume = { version: r.version as number, epoch: str(r.epoch, "resume.epoch", 128) };
      }
      return out;
    }
    case "unsub":
      onlyKeys(m, ["t", "qid"]);
      return { t: "unsub", qid: id(m.qid, "qid") };
    case "mut":
      onlyKeys(m, ["t", "mid", "fn", "args"]);
      return { t: "mut", mid: id(m.mid, "mid"), fn: str(m.fn, "fn", 256), args: args(m.args) };
    case "auth":
      onlyKeys(m, ["t", "token"]);
      return { t: "auth", token: str(m.token, "token", 16384) };
    default:
      return bad(`unknown frame type ${JSON.stringify(m.t)}`);
  }
}

export function encodeServerMessage(m: ServerMessage): string {
  return stringify(m);
}

/** Used by tests and the future client: inverse of encodeServerMessage. */
export function decodeServerMessage(raw: string): ServerMessage {
  const m = parse(raw);
  if (!isPlainObject(m) || typeof m.t !== "string") throw new ProtocolError("bad_frame", "not a server frame");
  return m as ServerMessage;
}

export function encodeClientMessage(m: ClientMessage): string {
  return stringify(m);
}
