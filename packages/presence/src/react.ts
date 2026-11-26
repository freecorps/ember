// `@freecorps/ember-presence/react`: presence hooks over `useSyncExternalStore`, one store per aspect, so a component
// re-renders only for what it shows (a cursor move does not re-render the member list).
//
//   const { members } = usePresence("room:42", { state: { name: user.name } });
//   const { typing, setTyping } = useTyping("room:42");
//   const { cursors, moveCursor } = useCursors<{ x: number; y: number }>("room:42");
//
// The hooks of one room (same client, shard and name) share one `Presence` and one channel; it is left a moment after
// the last of them unmounts (a remount in between, as in StrictMode, keeps it).

import { useEmberClient } from "@freecorps/ember-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChannelMember, ChannelStatus } from "@freecorps/ember-client";
import type { DefaultCursor } from "./channel.ts";
import { Presence, type ChannelSource, type Cursor, type PresenceOptions, type Typing } from "./presence.ts";

export { Presence, type Cursor, type Typing, type PresenceOptions } from "./presence.ts";

type RoomOptions = Omit<PresenceOptions, "state">;

interface Held {
  presence: Presence<any, any>;
  refs: number;
  closing: ReturnType<typeof setTimeout> | null;
}

const rooms = new WeakMap<object, Map<string, Held>>();

/** The room's shared `Presence` for this client: retained until `release` (closed a turn after the last one). */
export function retainPresence<S = unknown, C = DefaultCursor>(client: ChannelSource, room: string, opts: PresenceOptions<S> = {}): { presence: Presence<S, C>; release: () => void } {
  let map = rooms.get(client);
  if (!map) rooms.set(client, (map = new Map()));
  const key = `${opts.shard ?? ""}\u0000${room}`;
  let held = map.get(key);
  if (!held) map.set(key, (held = { presence: new Presence<S, C>(client, room, opts), refs: 0, closing: null }));
  else if (opts.state !== undefined) held.presence.setState(opts.state);
  if (held.closing) clearTimeout(held.closing);
  held.closing = null;
  held.refs++;
  const h = held;
  const m = map;
  let released = false;
  return {
    presence: h.presence as Presence<S, C>,
    release: () => {
      if (released) return;
      released = true;
      if (--h.refs > 0) return;
      h.closing = setTimeout(() => {
        if (h.refs > 0) return;
        if (m.get(key) === h) m.delete(key);
        h.presence.close();
      }, 0);
    },
  };
}

const noop = () => () => undefined;
const EMPTY: readonly never[] = Object.freeze([]);
const connecting = (): ChannelStatus => "connecting";
const none = () => EMPTY;

function useRoom<S, C>(room: string, opts: PresenceOptions<S>): Presence<S, C> | null {
  const client = useEmberClient() as unknown as ChannelSource;
  const [presence, setPresence] = useState<Presence<S, C> | null>(null);
  const state = useRef(opts.state);
  state.current = opts.state;
  const { shard, cursorThrottleMs, typingTimeoutMs, cursorTimeoutMs } = opts;
  useEffect(() => {
    const { presence: p, release } = retainPresence<S, C>(client, room, {
      ...(shard !== undefined ? { shard } : {}),
      ...(state.current !== undefined ? { state: state.current } : {}),
      ...(cursorThrottleMs !== undefined ? { cursorThrottleMs } : {}),
      ...(typingTimeoutMs !== undefined ? { typingTimeoutMs } : {}),
      ...(cursorTimeoutMs !== undefined ? { cursorTimeoutMs } : {}),
    });
    setPresence(p);
    return () => {
      release();
      setPresence(null);
    };
  }, [client, room, shard, cursorThrottleMs, typingTimeoutMs, cursorTimeoutMs]);
  // A new state (by value) is sent as a member update.
  const json = opts.state === undefined ? undefined : JSON.stringify(opts.state);
  const sent = useRef<string | undefined>(json);
  useEffect(() => {
    if (!presence || json === undefined || json === sent.current) return;
    sent.current = json;
    presence.setState(state.current as S);
  }, [presence, json]);
  return presence;
}

/** Who is in the room (online), this client included (`self: true`), and the channel's status. */
export function usePresence<S = unknown>(room: string, opts: PresenceOptions<S> = {}): { members: readonly ChannelMember<S>[]; status: ChannelStatus; self: string | null; setState: (state: S) => void } {
  const p = useRoom<S, unknown>(room, opts);
  const members = useSyncExternalStore(p ? p.subscribeMembers : noop, p ? p.members : none, p ? p.members : none) as readonly ChannelMember<S>[];
  const status = useSyncExternalStore(p ? p.subscribeMembers : noop, p ? p.status : connecting, p ? p.status : connecting);
  const self = useSyncExternalStore(p ? p.subscribeMembers : noop, p ? p.self : nullSelf, p ? p.self : nullSelf);
  const setState = useCallback((state: S) => p?.setState(state), [p]);
  return { members, status, self, setState };
}

const nullSelf = (): string | null => null;

/** Who else is typing in the room, and this client's own indicator (`setTyping(true)` on input, `false` on blur/send). */
export function useTyping(room: string, opts: RoomOptions = {}): { typing: readonly Typing[]; setTyping: (on: boolean) => void } {
  const p = useRoom<unknown, unknown>(room, opts);
  const typing = useSyncExternalStore(p ? p.subscribeTyping : noop, p ? p.typing : none, p ? p.typing : none);
  const setTyping = useCallback((on: boolean) => p?.setTyping(on), [p]);
  return { typing, setTyping };
}

/** The others' cursors in the room, and this client's (`moveCursor`, throttled; null when it leaves the surface). */
export function useCursors<C = DefaultCursor>(room: string, opts: RoomOptions = {}): { cursors: readonly Cursor<C>[]; moveCursor: (at: C | null) => void } {
  const p = useRoom<unknown, C>(room, opts);
  const cursors = useSyncExternalStore(p ? p.subscribeCursors : noop, p ? p.cursors : none, p ? p.cursors : none) as readonly Cursor<C>[];
  const moveCursor = useCallback((at: C | null) => p?.moveCursor(at), [p]);
  return { cursors, moveCursor };
}
