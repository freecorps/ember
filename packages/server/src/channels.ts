// Ephemeral channels (contracts.md "Feature `ephemeral`"): named rooms on a shard's sockets whose messages are
// broadcast in memory to the sockets joined to them. Nothing is a mutation or touches SQLite: no row, no version, no
// change log. Declared by the app (`defineApp({ channels })`) with a synchronous, pure `authorize` per name pattern,
// checked by the shard with the socket's verified identity; payloads and member state may be typed by `v.*`.
//
// Pure TS (runs in the shard, in tests under Node, nowhere near Cloudflare APIs).

import { validate, type GenericValidator, type Infer } from "@freecorps/ember-values";
import type { Identity } from "./types.ts";

/** Channel names: 1 to 128 of `A-Z a-z 0-9 _ . : @ / -`. */
export const CHANNEL_NAME = /^[A-Za-z0-9_.:@/-]{1,128}$/;
/** A pattern of `defineApp({ channels })`: a name, or a prefix ending in `*` (`"room:*"`; `"*"` is every name). */
const CHANNEL_PATTERN = /^[A-Za-z0-9_.:@/-]{0,127}\*?$/;

/** What `authorize` gets about the channel a socket asks to join. */
export interface ChannelRequest {
  /** The full channel name (`"room:42"`). */
  name: string;
  /** What the pattern's `*` matched (`"42"` for `"room:*"`); `""` for an exact pattern. */
  param: string;
  /** The shard the socket is on (`"room:42"`, `"global:main"`): channels are per shard. */
  shard: string;
}

/**
 * One channel pattern of `defineApp({ channels })`.
 * - `authorize(identity, channel)`: synchronous and pure (no I/O, no `ctx`), with the socket's verified identity (null:
 *   anonymous). Only `true` lets the socket join; anything else, or a throw, refuses. It runs on every join and again
 *   when the socket's identity changes (`auth`), so a socket that is no longer allowed leaves.
 * - `payload`: validator of what `publish` sends (checked by the shard before the broadcast; refused otherwise).
 * - `state`: validator of a member's state (`join(…, state)`), which every member sees in the member list.
 */
export interface ChannelDefinition<P extends GenericValidator | undefined = GenericValidator | undefined, S extends GenericValidator | undefined = GenericValidator | undefined> {
  authorize: (identity: Identity | null, channel: ChannelRequest) => boolean;
  payload?: P;
  state?: S;
}

/** `defineApp({ channels })`: patterns to definitions. The longest matching pattern wins (an exact name first). */
export type ChannelsConfig = Record<string, ChannelDefinition>;

/** The payload type of a channel definition (`unknown` without a validator). */
export type ChannelPayload<D> = D extends ChannelDefinition<infer P, GenericValidator | undefined> ? (P extends GenericValidator ? Infer<P> : unknown) : unknown;
/** The member state type of a channel definition (`unknown` without a validator). */
export type ChannelState<D> = D extends ChannelDefinition<GenericValidator | undefined, infer S> ? (S extends GenericValidator ? Infer<S> : unknown) : unknown;

/** A typed channel definition (the identity of `def`, for inference of `payload` and `state`). */
export function defineChannel<P extends GenericValidator | undefined = undefined, S extends GenericValidator | undefined = undefined>(def: ChannelDefinition<P, S>): ChannelDefinition<P, S> {
  return def;
}

/** Checks `defineApp({ channels })`; frozen copy. */
export function checkChannels(channels: unknown): Readonly<ChannelsConfig> {
  if (channels === undefined) return Object.freeze({});
  if (typeof channels !== "object" || channels === null || Array.isArray(channels)) throw new Error("defineApp: channels must be an object ({ \"room:*\": { authorize } })");
  const out: ChannelsConfig = {};
  for (const [pattern, def] of Object.entries(channels as Record<string, unknown>)) {
    if (!CHANNEL_PATTERN.test(pattern) || pattern === "") throw new Error(`defineApp: channel pattern ${JSON.stringify(pattern)}: a name of A-Z a-z 0-9 _ . : @ / - (at most 128), optionally ending in *`);
    if (typeof def !== "object" || def === null) throw new Error(`defineApp: channel ${pattern} must be { authorize, payload?, state? }`);
    const d = def as Record<string, unknown>;
    for (const k of Object.keys(d)) if (k !== "authorize" && k !== "payload" && k !== "state") throw new Error(`defineApp: channel ${pattern}: unknown option ${JSON.stringify(k)} (known: authorize, payload, state)`);
    if (typeof d.authorize !== "function") throw new Error(`defineApp: channel ${pattern} needs authorize(identity, channel) => boolean (use () => true for a public channel)`);
    for (const k of ["payload", "state"] as const) {
      const val = d[k] as { shape?: unknown } | undefined;
      if (val !== undefined && (typeof val !== "object" || val === null || typeof val.shape !== "object")) throw new Error(`defineApp: channel ${pattern}: ${k} must be a v.* validator`);
    }
    out[pattern] = Object.freeze({ ...(d as unknown as ChannelDefinition) });
  }
  return Object.freeze(out);
}

/** The definition a channel name falls under (exact pattern first, then the longest `prefix*`), or null. */
export function matchChannel(channels: Readonly<ChannelsConfig> | undefined, name: string): { def: ChannelDefinition; param: string } | null {
  if (!channels || !CHANNEL_NAME.test(name)) return null;
  const exact = Object.hasOwn(channels, name) ? channels[name] : undefined;
  if (exact) return { def: exact, param: "" };
  let best: { def: ChannelDefinition; param: string; len: number } | null = null;
  for (const [pattern, def] of Object.entries(channels)) {
    if (!pattern.endsWith("*")) continue;
    const prefix = pattern.slice(0, -1);
    if (!name.startsWith(prefix) || (best && best.len >= prefix.length)) continue;
    best = { def, param: name.slice(prefix.length), len: prefix.length };
  }
  return best ? { def: best.def, param: best.param } : null;
}

/** Runs `authorize`: only a literal `true` allows; a throw refuses. */
export function authorizeChannel(def: ChannelDefinition, identity: Identity | null, request: ChannelRequest): boolean {
  try {
    return def.authorize(identity, request) === true;
  } catch {
    return false;
  }
}

/** Checks a value against the definition's `payload` or `state` validator: null when it passes (or there is none). */
export function checkChannelValue(def: ChannelDefinition, which: "payload" | "state", value: unknown): string | null {
  const val = def[which];
  if (!val) return null;
  // `v.optional(...)`: none given is fine.
  if (value === undefined && val.isOptional === "optional") return null;
  const r = validate(val.shape, value);
  if (r.ok) return null;
  const path = r.path.replace(/^\$\.?/, "");
  return `${which}${path ? (path.startsWith("[") ? path : `.${path}`) : ""}: ${r.message}`;
}
