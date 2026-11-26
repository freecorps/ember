// `@freecorps/ember-presence`: presence over the shard's ephemeral channels (feature "ephemeral", contracts.md).
// Server: `presenceChannel({ authorize, state?, cursor? })` in `defineApp({ channels })`. Client: `new Presence(client,
// room)`. React: `@freecorps/ember-presence/react` (`usePresence`, `useTyping`, `useCursors`).

export { defaultCursor, presenceChannel, presenceMessage, type DefaultCursor, type PresenceChannelOptions, type PresenceMessage } from "./channel.ts";
export { Presence, type ChannelSource, type Cursor, type PresenceOptions, type Typing } from "./presence.ts";
export type { ChannelMember, ChannelStatus } from "@freecorps/ember-client";
