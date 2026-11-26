/**
 * Ephemeral channels on the client (feature "ephemeral", contracts.md): `client.channel(name, { shard, state })` joins
 * a room of the shard's sockets. Messages are broadcast in memory by the shard (no row, no version): nothing is
 * persisted, replayed or queued here. A message published while the channel is not joined is dropped (`publish`
 * returns false). The channel is joined again on every new socket (and after an identity change that let it in), with
 * its last state; the member list is the shard's (one member per socket: tabs sharing a socket with `multiTab` share
 * one member).
 */
import { EmberError } from "./errors.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";

/** A member of a channel: one per socket. `user` is the subject of its identity (null: anonymous). */
export interface ChannelMember<S = unknown> {
  readonly id: string;
  readonly user: string | null;
  readonly state: S | undefined;
  /** This client's own member (its socket's). */
  readonly self: boolean;
}

/** A message another member published. */
export interface ChannelMessage<T = unknown> {
  readonly data: T;
  /** The member that sent it (`ChannelMember.id`). */
  readonly from: string;
  readonly user: string | null;
}

/**
 * - `connecting`: no socket yet, or waiting for `joined`.
 * - `joined`: in; messages flow.
 * - `refused`: the shard did not let it in (`error()` says why: `channel_denied`, `auth_expired`, …). Tried again on the
 *   next socket and after an identity change.
 * - `unsupported`: the shard's runtime does not speak feature "ephemeral".
 * - `closed`: `leave()` (or the client closed).
 */
export type ChannelStatus = "connecting" | "joined" | "refused" | "unsupported" | "closed";

export interface ChannelOptions<S = unknown> {
  /** The shard whose sockets the channel lives on (default: the client's `defaultShard`). Channels are per shard. */
  shard?: string;
  /** This member's state, seen by every member (at most 512 chars of JSON; typed by the app's `state` validator). */
  state?: S;
}

export interface Channel<T = unknown, S = unknown> {
  readonly name: string;
  readonly shard: string;
  status(): ChannelStatus;
  /** The last refusal (`left` or an `err` about this channel), or null. */
  error(): EmberError | null;
  /** The members, in the order they joined (a new array whenever it changes; the same one otherwise). */
  members(): readonly ChannelMember<S>[];
  /** This client's member id while joined. */
  self(): string | null;
  /** Broadcast to the other members: false (dropped) unless joined. */
  publish(data: T): boolean;
  /** Replace this member's state (a `join` again; the others see it). */
  setState(state: S): void;
  /** Messages from the other members. */
  subscribe(listener: (message: ChannelMessage<T>) => void): () => void;
  /** Status, error or member list changed. */
  onChange(listener: () => void): () => void;
  /** Leave (this handle; the channel is left once every handle of it has). */
  leave(): void;
}

/** What the channels need from the client. */
export interface ChannelHost {
  /** The shard of a channel (the default shard when none is given); throws without one. */
  shardOf(shard: string | undefined): string;
  /** The shard's socket is wanted (opened if needed). */
  ensure(shard: string): void;
  /** Nothing of the shard is wanted any more (it may close after the idle timeout). */
  release(shard: string): void;
  /** `ready` (with whether the shard speaks "ephemeral"), or null while there is no ready socket. */
  ready(shard: string): { ephemeral: boolean } | null;
  send(shard: string, m: ClientMessage): void;
  report(e: EmberError, shard: string): void;
}

interface Entry {
  shard: string;
  name: string;
  handles: number;
  state: { v: unknown } | undefined;
  status: ChannelStatus;
  error: EmberError | null;
  self: string | null;
  byId: Map<string, { id: string; user: string | null; state: unknown }>;
  members: readonly ChannelMember[];
  listeners: Set<(m: ChannelMessage) => void>;
  watchers: Set<() => void>;
  retry: ReturnType<typeof setTimeout> | null;
}

const EMPTY: readonly ChannelMember[] = Object.freeze([]);

export class Channels {
  private readonly entries = new Map<string, Entry>();
  private readonly byShard = new Map<string, Set<Entry>>();

  constructor(private readonly host: ChannelHost) {}

  /** Channels want this shard's socket. */
  has(shard: string): boolean {
    return (this.byShard.get(shard)?.size ?? 0) > 0;
  }

  /** Joined channels on the shard: its socket must look alive to the shard even when it only listens. */
  joined(shard: string): boolean {
    for (const e of this.byShard.get(shard) ?? []) if (e.status === "joined") return true;
    return false;
  }

  open<T, S>(name: string, opts: ChannelOptions<S>): Channel<T, S> {
    const shard = this.host.shardOf(opts.shard);
    const key = `${shard}\u0000${name}`;
    let e = this.entries.get(key);
    if (!e) {
      e = { shard, name, handles: 0, state: undefined, status: "connecting", error: null, self: null, byId: new Map(), members: EMPTY, listeners: new Set(), watchers: new Set(), retry: null };
      this.entries.set(key, e);
      let set = this.byShard.get(shard);
      if (!set) this.byShard.set(shard, (set = new Set()));
      set.add(e);
    }
    e.handles++;
    if (opts.state !== undefined) e.state = { v: opts.state };
    const entry = e;
    const mine = { listeners: new Set<(m: ChannelMessage) => void>(), watchers: new Set<() => void>(), left: false };
    this.host.ensure(shard);
    if (entry.handles === 1 || opts.state !== undefined) this.sendJoin(entry);
    const handle: Channel<T, S> = {
      name,
      shard,
      status: () => (mine.left ? "closed" : entry.status),
      error: () => entry.error,
      members: () => (mine.left ? EMPTY : entry.members) as readonly ChannelMember<S>[],
      self: () => (mine.left ? null : entry.self),
      publish: (data: T) => {
        if (mine.left || entry.status !== "joined" || !this.host.ready(shard)?.ephemeral) return false;
        this.host.send(shard, { t: "pub", ch: name, data });
        return true;
      },
      setState: (state: S) => {
        if (mine.left) return;
        entry.state = { v: state };
        this.sendJoin(entry);
      },
      subscribe: (listener) => {
        if (mine.left) return () => undefined;
        const l = listener as (m: ChannelMessage) => void;
        // A wrapper per call: the same function subscribed twice gets two deliveries and two unsubscribes.
        const w = (m: ChannelMessage) => l(m);
        entry.listeners.add(w);
        mine.listeners.add(w);
        return () => {
          entry.listeners.delete(w);
          mine.listeners.delete(w);
        };
      },
      onChange: (listener) => {
        if (mine.left) return () => undefined;
        const w = () => listener();
        entry.watchers.add(w);
        mine.watchers.add(w);
        return () => {
          entry.watchers.delete(w);
          mine.watchers.delete(w);
        };
      },
      leave: () => {
        if (mine.left) return;
        mine.left = true;
        for (const l of mine.listeners) entry.listeners.delete(l);
        for (const w of mine.watchers) entry.watchers.delete(w);
        if (--entry.handles > 0) return;
        this.forget(entry, true);
      },
    };
    return handle;
  }

  private forget(e: Entry, sendLeave: boolean): void {
    if (e.retry) clearTimeout(e.retry);
    e.retry = null;
    this.entries.delete(`${e.shard}\u0000${e.name}`);
    const set = this.byShard.get(e.shard);
    set?.delete(e);
    if (set && !set.size) this.byShard.delete(e.shard);
    const was = e.status;
    e.status = "closed";
    e.self = null;
    e.byId.clear();
    e.members = EMPTY;
    if (sendLeave && (was === "joined" || was === "connecting") && this.host.ready(e.shard)?.ephemeral) this.host.send(e.shard, { t: "leave", ch: e.name });
    this.notify(e);
    if (sendLeave) this.host.release(e.shard);
  }

  private sendJoin(e: Entry): void {
    const r = this.host.ready(e.shard);
    if (!r) return;
    if (!r.ephemeral) return this.unsupported(e);
    this.host.send(e.shard, e.state ? { t: "join", ch: e.name, state: e.state.v } : { t: "join", ch: e.name });
  }

  private unsupported(e: Entry): void {
    if (e.status === "unsupported") return;
    e.status = "unsupported";
    e.error = new EmberError("unsupported", `the runtime of shard ${e.shard} does not speak feature "ephemeral" (channels)`);
    this.notify(e);
  }

  private notify(e: Entry): void {
    for (const w of [...e.watchers]) {
      try {
        w();
      } catch {
        /* a watcher's own problem */
      }
    }
  }

  private rebuild(e: Entry): void {
    const self = e.self;
    e.members = Object.freeze([...e.byId.values()].map((m) => Object.freeze({ id: m.id, user: m.user, state: m.state, self: m.id === self })));
  }

  /** The shard's socket said `ready`: every channel of it joins (again). */
  onReady(shard: string): void {
    for (const e of this.byShard.get(shard) ?? []) {
      if (e.status !== "unsupported") e.status = "connecting";
      this.sendJoin(e);
      this.notify(e);
    }
  }

  /** The socket is gone: joined again on the next one. The member list stays until then. */
  onGone(shard: string): void {
    for (const e of this.byShard.get(shard) ?? []) {
      if (e.status === "joined") {
        e.status = "connecting";
        this.notify(e);
      }
    }
  }

  /** An `auth` went out (another identity, a fresh token): refused channels try again under it. */
  onAuth(shard: string): void {
    for (const e of this.byShard.get(shard) ?? []) if (e.status === "refused") this.sendJoin(e);
  }

  /** `close()` of the client. */
  closeAll(): void {
    for (const e of [...this.entries.values()]) this.forget(e, false);
  }

  /** A channel frame (`joined`, `members`, `msg`, `left`, or an `err` with `ch`): true when it was one. */
  onMessage(shard: string, m: ServerMessage): boolean {
    switch (m.t) {
      case "joined": {
        const e = this.entries.get(`${shard}\u0000${m.ch}`);
        if (!e) return true;
        e.status = "joined";
        e.error = null;
        e.self = m.self;
        e.byId.clear();
        for (const x of m.members) e.byId.set(x.id, { id: x.id, user: x.user ?? null, state: x.state });
        this.rebuild(e);
        this.notify(e);
        return true;
      }
      case "members": {
        const e = this.entries.get(`${shard}\u0000${m.ch}`);
        if (!e || e.status !== "joined") return true;
        for (const id of m.leave ?? []) e.byId.delete(id);
        for (const x of m.join ?? []) e.byId.set(x.id, { id: x.id, user: x.user ?? null, state: x.state });
        this.rebuild(e);
        this.notify(e);
        return true;
      }
      case "msg": {
        const e = this.entries.get(`${shard}\u0000${m.ch}`);
        if (!e || e.status !== "joined") return true;
        const msg: ChannelMessage = Object.freeze({ data: m.data, from: m.from, user: m.user ?? null });
        for (const l of [...e.listeners]) {
          try {
            l(msg);
          } catch (err) {
            this.host.report(new EmberError("listener_failed", (err as Error)?.message ?? String(err)), shard);
          }
        }
        return true;
      }
      case "left": {
        const e = this.entries.get(`${shard}\u0000${m.ch}`);
        if (!e) return true;
        e.status = "refused";
        e.error = new EmberError(m.code, m.message);
        e.self = null;
        e.byId.clear();
        e.members = EMPTY;
        this.notify(e);
        // Too many joins at once: a second later.
        if (m.code === "rate_limited" && !e.retry) {
          e.retry = setTimeout(() => {
            e.retry = null;
            if (this.entries.get(`${shard}\u0000${e.name}`) === e && e.status === "refused") this.sendJoin(e);
          }, 1_000);
        }
        return true;
      }
      case "err": {
        if (m.ch === undefined) return false;
        const e = this.entries.get(`${shard}\u0000${m.ch}`);
        if (!e) return true;
        e.error = new EmberError(m.code, m.message);
        this.notify(e);
        return true;
      }
      default:
        return false;
    }
  }
}
