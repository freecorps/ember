// The server side of presence: a channel definition for `defineApp({ channels })` whose payloads are the presence
// messages (typing, cursor), typed and checked by the shard with `v.*`.
//
//   // ember/ember.config.ts
//   export default defineApp({
//     channels: {
//       "room:*": presenceChannel({
//         authorize: (identity, { param }) => identity !== null,
//         state: v.object({ name: v.string(), color: v.string() }),
//         cursor: v.object({ x: v.number(), y: v.number() }),
//       }),
//     },
//   });

import { v, type GenericValidator, type Infer, type Validator } from "@freecorps/ember-values";
import type { ChannelDefinition, ChannelRequest, Identity } from "@freecorps/ember-server";

/** The default cursor: a point. */
export const defaultCursor = v.object({ x: v.number(), y: v.number() });
export type DefaultCursor = Infer<typeof defaultCursor>;

/**
 * What a presence instance publishes. `key` names the instance (a tab: tabs of one identity share a socket, hence one
 * channel member), so typing and cursors are per tab.
 * - `typing`: on or off (on is refreshed while typing; it expires on the receivers' side).
 * - `cursor`: where it is, or null (gone from the surface).
 */
export type PresenceMessage<C = DefaultCursor> = { k: "typing"; key: string; on: boolean } | { k: "cursor"; key: string; at: C | null };

/** The validator of the presence messages, with `cursor` as the shape of a cursor. */
export function presenceMessage<C extends GenericValidator = typeof defaultCursor>(cursor?: C): Validator<PresenceMessage<Infer<C>>> {
  const at = (cursor ?? defaultCursor) as GenericValidator;
  return v.union(
    v.object({ k: v.literal("typing"), key: v.string().max(64), on: v.boolean() }),
    v.object({ k: v.literal("cursor"), key: v.string().max(64), at: v.union(at, v.null()) }),
  ) as unknown as Validator<PresenceMessage<Infer<C>>>;
}

export interface PresenceChannelOptions<S extends GenericValidator | undefined, C extends GenericValidator> {
  /** Who may be in the room (synchronous and pure; see `ChannelDefinition.authorize`). */
  authorize: (identity: Identity | null, channel: ChannelRequest) => boolean;
  /** The member state everyone in the room sees (`usePresence(room, { state })`): name, avatar, color. */
  state?: S;
  /** The shape of a cursor (default `{ x, y }`). */
  cursor?: C;
}

/** A channel definition for presence rooms: payloads are presence messages, member state typed by `state`. */
export function presenceChannel<S extends GenericValidator | undefined = undefined, C extends GenericValidator = typeof defaultCursor>(
  opts: PresenceChannelOptions<S, C>,
): ChannelDefinition<Validator<PresenceMessage<Infer<C>>>, S> {
  return {
    authorize: opts.authorize,
    payload: presenceMessage(opts.cursor),
    ...(opts.state !== undefined ? { state: opts.state } : {}),
  } as ChannelDefinition<Validator<PresenceMessage<Infer<C>>>, S>;
}
