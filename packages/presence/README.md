# @freecorps/ember-presence

Presence for [Ember](https://github.com/freecorps/ember): who is online in a room, typing indicators and live
cursors, over the shard's **ephemeral channels** (protocol feature `"ephemeral"`). Everything is broadcast in memory
by the room's Durable Object: **no row is written, the shard version does not move and nothing goes to the change
log**. Memberships live in the socket attachments, so they survive hibernation at no cost.

```sh
npm install @freecorps/ember-presence
```

## Server: declare the rooms

Rooms are channels of `defineApp({ channels })`. `presenceChannel` types the member state and the cursor with `v.*`;
the shard checks every message against them before the broadcast.

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { v } from "@freecorps/ember-values";
import { presenceChannel } from "@freecorps/ember-presence";

export default defineApp({
  channels: {
    // `room:<id>`, only on its own shard (`room:<id>`), signed-in users only.
    "room:*": presenceChannel({
      authorize: (identity, { param, shard }) => identity !== null && shard === `room:${param}`,
      state: v.object({ name: v.string(), color: v.string() }),
      cursor: v.object({ x: v.number(), y: v.number() }),
    }),
  },
});
```

`authorize(identity, { name, param, shard })` is **synchronous and pure** (no I/O, no `ctx`): it runs with the socket's
verified identity on every join, and again when the socket's identity changes (`auth`), so a user who is no longer
allowed leaves the room. Only `true` lets a socket in; a throw refuses.

## React

```tsx
import { usePresence, useTyping, useCursors } from "@freecorps/ember-presence/react";

function Room({ id, me }: { id: string; me: { name: string; color: string } }) {
  const room = `room:${id}`;
  const { members } = usePresence<typeof me>(room, { shard: room, state: me });
  const { typing, setTyping } = useTyping(room, { shard: room });
  const { cursors, moveCursor } = useCursors<{ x: number; y: number }>(room, { shard: room });
  return (
    <div onPointerMove={(e) => moveCursor({ x: e.clientX, y: e.clientY })} onPointerLeave={() => moveCursor(null)}>
      <Avatars members={members} />
      <input onInput={() => setTyping(true)} onBlur={() => setTyping(false)} />
      {typing.length > 0 && <p>{typing.map((t) => t.user).join(", ")} typing…</p>}
      {cursors.map((c) => <Pointer key={`${c.member}:${c.key}`} at={c.at} />)}
    </div>
  );
}
```

- Each hook reads its own store through `useSyncExternalStore`: a cursor move re-renders only `useCursors`
  components, a typing change only `useTyping` ones.
- The hooks of one room (same client, shard and name) share one channel; it is left a moment after the last of them
  unmounts (a StrictMode remount keeps it).
- Needs an `EmberProvider` (`@freecorps/ember-react`).

## Without React

```ts
import { Presence } from "@freecorps/ember-presence";

const room = new Presence<{ name: string }>(client, "room:42", { shard: "room:42", state: { name: "Ana" } });
room.subscribeMembers(() => console.log(room.members()));
room.subscribeTyping(() => console.log(room.typing()));
room.subscribeCursors(() => console.log(room.cursors()));
room.setTyping(true);
room.moveCursor({ x: 10, y: 20 });
room.close();
```

| Option | Default | |
|---|---|---|
| `shard` | client's `defaultShard` | rooms are per shard |
| `state` | none | this member's state (at most 512 chars of JSON) |
| `cursorThrottleMs` | 50 | at most one cursor message per window; the last position always goes |
| `typingTimeoutMs` | 5000 | an indicator not refreshed for this long goes away (refreshed at half of it while on) |
| `cursorTimeoutMs` | 0 | an idle cursor goes away after this long (0: when its member leaves) |

## What you get

- **Members** are the room's sockets (one per socket: tabs of the same identity sharing a socket with `multiTab` are
  one member), with `user` (the identity's subject) and `state`. A closed socket leaves at once; one that went silent
  (no frame and no heartbeat ping) for 90 s is closed by the shard and leaves.
- **Typing** and **cursors** are per tab (`key`); a late joiner gets the others' current ones; they go when their
  member leaves.
- **Limits** (per socket): 8 channels, a message of at most 4096 chars of JSON, 20 messages per second (burst 40).
  A socket whose token expired or was revoked neither sends nor receives until it sends a fresh one.
- Nothing is persisted or replayed: a client that reconnects joins again and gets the current member list.

Contract: `docs/design/contracts.md`, "Feature `ephemeral`".
