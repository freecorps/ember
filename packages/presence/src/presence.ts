// The client side of presence, over `client.channel(room)` (feature "ephemeral"): the room's members (online), who is
// typing and where the cursors are. Everything is in memory on the shard and here: no row, no version, nothing kept
// across a reload.
//
//   const room = new Presence(client, "room:42", { state: { name: "Ana" } });
//   room.subscribeMembers(() => render(room.members()));
//   input.oninput = () => room.setTyping(true);
//   surface.onpointermove = (e) => room.moveCursor({ x: e.clientX, y: e.clientY });
//
// Each aspect has its own subscription and its own snapshot (a new array only when it changed), so a component that
// shows the members does not re-render on a cursor move (`useSyncExternalStore` in `/react`).

import type { Channel, ChannelMember, ChannelMessage, ChannelOptions, ChannelStatus } from "@freecorps/ember-client";
import type { DefaultCursor, PresenceMessage } from "./channel.ts";

/** What `Presence` needs of the client (an `EmberClient`). */
export interface ChannelSource {
  channel<T = unknown, S = unknown>(name: string, opts?: ChannelOptions<S>): Channel<T, S>;
}

export interface PresenceOptions<S = unknown> {
  /** The shard of the room (default: the client's `defaultShard`). Rooms are per shard. */
  shard?: string;
  /** This member's state, seen by everyone in the room. */
  state?: S;
  /** At most one cursor message per this many ms (the last position always goes, trailing). Default 50. */
  cursorThrottleMs?: number;
  /** A typing indicator not refreshed for this long goes away (the sender refreshes at half of it). Default 5000. */
  typingTimeoutMs?: number;
  /** A cursor that did not move for this long goes away (0: it stays until its member leaves). Default 0. */
  cursorTimeoutMs?: number;
}

/** Someone typing: the member, and which of its tabs (`key`). */
export interface Typing {
  readonly member: string;
  readonly user: string | null;
  readonly key: string;
}

/** Someone's cursor (one per tab). */
export interface Cursor<C = DefaultCursor> {
  readonly member: string;
  readonly user: string | null;
  readonly key: string;
  readonly at: C;
}

const EMPTY: readonly never[] = Object.freeze([]);

function randomKey(): string {
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

type Listener = () => void;

export class Presence<S = unknown, C = DefaultCursor> {
  readonly room: string;
  /** This instance (a tab): its typing and cursor are told apart from the other tabs of the same member by it. */
  readonly key = randomKey();
  private readonly ch: Channel<PresenceMessage<C>, S>;
  private readonly opts: Required<Pick<PresenceOptions, "cursorThrottleMs" | "typingTimeoutMs" | "cursorTimeoutMs">>;
  private readonly offs: Array<() => void> = [];
  private closed = false;

  private readonly typingBy = new Map<string, { t: Typing; until: number }>();
  private readonly cursorBy = new Map<string, { c: Cursor<C>; at: number }>();
  private typingSnap: readonly Typing[] = EMPTY;
  private cursorSnap: readonly Cursor<C>[] = EMPTY;
  private readonly memberListeners = new Set<Listener>();
  private readonly typingListeners = new Set<Listener>();
  private readonly cursorListeners = new Set<Listener>();
  private lastMembers: readonly ChannelMember<S>[] = EMPTY;
  private lastStatus: ChannelStatus = "connecting";
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;

  // Own state.
  private typingOn = false;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorAt: C | null = null;
  private cursorSentAt = 0;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: ChannelSource, room: string, opts: PresenceOptions<S> = {}) {
    this.room = room;
    this.opts = { cursorThrottleMs: opts.cursorThrottleMs ?? 50, typingTimeoutMs: opts.typingTimeoutMs ?? 5_000, cursorTimeoutMs: opts.cursorTimeoutMs ?? 0 };
    this.ch = client.channel<PresenceMessage<C>, S>(room, { ...(opts.shard !== undefined ? { shard: opts.shard } : {}), ...(opts.state !== undefined ? { state: opts.state } : {}) });
    this.offs.push(this.ch.subscribe((m) => this.onMessage(m)));
    this.offs.push(this.ch.onChange(() => this.onChannel()));
    this.onChannel();
  }

  // ------------------------------------------------------------------------------------------------ snapshots

  /** Who is in the room (online): one member per socket, this client's with `self: true`. */
  readonly members = (): readonly ChannelMember<S>[] => this.ch.members();
  /** The others typing now (this instance excluded). */
  readonly typing = (): readonly Typing[] => this.typingSnap;
  /** The others' cursors (this instance excluded). */
  readonly cursors = (): readonly Cursor<C>[] => this.cursorSnap;
  readonly status = (): ChannelStatus => this.ch.status();
  readonly error = () => this.ch.error();
  /** This client's member id (shared by the tabs of a `multiTab` group), while joined. */
  readonly self = (): string | null => this.ch.self();

  /** Members or status changed. */
  readonly subscribeMembers = (l: Listener): (() => void) => this.listen(this.memberListeners, l);
  readonly subscribeTyping = (l: Listener): (() => void) => this.listen(this.typingListeners, l);
  readonly subscribeCursors = (l: Listener): (() => void) => this.listen(this.cursorListeners, l);

  private listen(set: Set<Listener>, l: Listener): () => void {
    const w = () => l();
    set.add(w);
    return () => set.delete(w);
  }

  private emit(set: Set<Listener>): void {
    for (const l of [...set]) {
      try {
        l();
      } catch {
        /* a listener's own problem */
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ own state

  setState(state: S): void {
    if (!this.closed) this.ch.setState(state);
  }

  /** Typing or not. While on, refreshed every `typingTimeoutMs / 2`; call it on every keystroke, it sends at most that often. */
  setTyping(on: boolean): void {
    if (this.closed) return;
    if (on === this.typingOn) return;
    this.typingOn = on;
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = null;
    this.sendTyping();
  }

  private sendTyping(): void {
    this.ch.publish({ k: "typing", key: this.key, on: this.typingOn });
    if (!this.typingOn) return;
    this.typingTimer = setTimeout(() => {
      this.typingTimer = null;
      if (this.typingOn && !this.closed) this.sendTyping();
    }, Math.max(100, this.opts.typingTimeoutMs / 2));
  }

  /** Move this cursor (null: it left the surface). Throttled: at most one message per `cursorThrottleMs`, the last position always goes. */
  moveCursor(at: C | null): void {
    if (this.closed) return;
    this.cursorAt = at;
    if (this.cursorTimer) return;
    const wait = this.cursorSentAt + this.opts.cursorThrottleMs - Date.now();
    if (wait <= 0) return this.sendCursor();
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      if (!this.closed) this.sendCursor();
    }, wait);
  }

  private sendCursor(): void {
    this.cursorSentAt = Date.now();
    this.ch.publish({ k: "cursor", key: this.key, at: this.cursorAt });
  }

  /** Leave the room. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.typingOn) this.ch.publish({ k: "typing", key: this.key, on: false });
    if (this.cursorAt !== null) this.ch.publish({ k: "cursor", key: this.key, at: null });
    for (const t of [this.typingTimer, this.cursorTimer, this.sweepTimer]) if (t) clearTimeout(t);
    this.typingTimer = this.cursorTimer = this.sweepTimer = null;
    for (const off of this.offs.splice(0)) off();
    this.ch.leave();
    this.typingBy.clear();
    this.cursorBy.clear();
    this.typingSnap = EMPTY;
    this.cursorSnap = EMPTY;
  }

  // ------------------------------------------------------------------------------------------------ incoming

  private onChannel(): void {
    const members = this.ch.members();
    const status = this.ch.status();
    const membersChanged = members !== this.lastMembers || status !== this.lastStatus;
    const joinedNow = status === "joined" && this.lastStatus !== "joined";
    const before = this.lastMembers;
    this.lastMembers = members;
    this.lastStatus = status;
    if (!membersChanged) return;
    // Typing and cursors of members that left go with them.
    const ids = new Set(members.map((m) => m.id));
    let t = false;
    for (const [k, e] of this.typingBy) if (!ids.has(e.t.member)) t = this.typingBy.delete(k) || t;
    let c = false;
    for (const [k, e] of this.cursorBy) if (!ids.has(e.c.member)) c = this.cursorBy.delete(k) || c;
    if (t) this.rebuildTyping();
    if (c) this.rebuildCursors();
    this.emit(this.memberListeners);
    // Someone new (or this client, back in): what it would not know yet.
    const known = new Set(before.map((m) => m.id));
    if (joinedNow || members.some((m) => !known.has(m.id) && !m.self)) {
      if (this.typingOn) this.ch.publish({ k: "typing", key: this.key, on: true });
      if (this.cursorAt !== null) this.ch.publish({ k: "cursor", key: this.key, at: this.cursorAt });
    }
  }

  private onMessage(m: ChannelMessage<PresenceMessage<C>>): void {
    const d = m.data as PresenceMessage<C> | null;
    if (!d || typeof d !== "object" || typeof d.key !== "string" || d.key === this.key) return;
    const id = `${m.from}\u0000${d.key}`;
    const now = Date.now();
    if (d.k === "typing") {
      const had = this.typingBy.has(id);
      if (d.on) this.typingBy.set(id, { t: had ? this.typingBy.get(id)!.t : Object.freeze({ member: m.from, user: m.user, key: d.key }), until: now + this.opts.typingTimeoutMs });
      else this.typingBy.delete(id);
      if (had !== d.on) this.rebuildTyping();
      this.armSweep();
      return;
    }
    if (d.k === "cursor") {
      if (d.at === null) {
        if (this.cursorBy.delete(id)) this.rebuildCursors();
        return;
      }
      this.cursorBy.set(id, { c: Object.freeze({ member: m.from, user: m.user, key: d.key, at: d.at }), at: now });
      this.rebuildCursors();
      if (this.opts.cursorTimeoutMs > 0) this.armSweep();
    }
  }

  private rebuildTyping(): void {
    this.typingSnap = Object.freeze([...this.typingBy.values()].map((e) => e.t));
    this.emit(this.typingListeners);
  }

  private rebuildCursors(): void {
    this.cursorSnap = Object.freeze([...this.cursorBy.values()].map((e) => e.c));
    this.emit(this.cursorListeners);
  }

  /** Expiry of typing indicators (and idle cursors): one timer, at the next expiry. */
  private armSweep(): void {
    if (this.sweepTimer || this.closed) return;
    let next = Infinity;
    for (const e of this.typingBy.values()) next = Math.min(next, e.until);
    if (this.opts.cursorTimeoutMs > 0) for (const e of this.cursorBy.values()) next = Math.min(next, e.at + this.opts.cursorTimeoutMs);
    if (next === Infinity) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      const now = Date.now();
      let t = false;
      for (const [k, e] of this.typingBy) if (e.until <= now) t = this.typingBy.delete(k) || t;
      let c = false;
      if (this.opts.cursorTimeoutMs > 0) for (const [k, e] of this.cursorBy) if (e.at + this.opts.cursorTimeoutMs <= now) c = this.cursorBy.delete(k) || c;
      if (t) this.rebuildTyping();
      if (c) this.rebuildCursors();
      this.armSweep();
    }, Math.max(0, next - Date.now()));
  }
}
