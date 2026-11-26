/**
 * Ephemeral channels of a shard (feature "ephemeral", contracts.md "Feature `ephemeral`"): rooms of sockets, a member
 * list per room and messages broadcast in memory. Nothing here is a mutation: no SQLite row is read or written, the
 * shard version does not move and nothing goes to `_ember_changes`. A socket's memberships live in its attachment
 * (`eph`), so they survive hibernation (the rooms are rebuilt from the attachments on wake) at no row cost.
 *
 * Who may join is the app's declarative `authorize` (`defineApp({ channels })`), synchronous and pure, run with the
 * socket's verified identity on every join and again when that identity changes. A socket whose access expired or was
 * revoked neither publishes nor receives. A member whose socket went silent (no frame and no auto-response ping) for
 * `EPHEMERAL_TTL_MS` is closed and leaves; a clean close leaves at once.
 */
import { authorizeChannel, CHANNEL_NAME, checkChannelValue, matchChannel, type ChannelsConfig, type Identity } from "@freecorps/ember-server";
import { stringify } from "./wire.ts";

/** Largest `pub` payload: its JSON (wire encoding) in UTF-16 units. */
export const EPHEMERAL_MAX_PAYLOAD_CHARS = 4096;
/** Largest member state (`join{state}`), JSON in UTF-16 units: it lives in the socket's 16 KB attachment. */
export const EPHEMERAL_MAX_STATE_CHARS = 512;
/** Channels one socket may be in at once. */
export const EPHEMERAL_MAX_CHANNELS = 8;
/** Members of one channel (one per socket). */
export const EPHEMERAL_MAX_MEMBERS = 1024;
/** Per socket token bucket over `pub` and `join`: refill per second and capacity. */
export const EPHEMERAL_RATE_PER_SEC = 20;
export const EPHEMERAL_BURST = 40;
/** A member whose socket sent nothing (no frame, no auto-response `ping`) for this long is closed and leaves. */
export const EPHEMERAL_TTL_MS = 90_000;
/** A channel's members are checked against the TTL at most this often (on a join or publish to it). */
export const EPHEMERAL_SWEEP_MS = 5_000;
/** Close code of a socket dropped by the TTL. */
export const EPHEMERAL_TTL_CLOSE = 4408;

/** In the socket attachment: the socket's member id and its channels with the member state (JSON, or null). */
export interface EphemeralAttachment {
  m: string;
  ch: Array<[string, string | null]>;
}

/** What the module needs from the shard. */
export interface EphemeralHost {
  socket(sid: string): WebSocket | undefined;
  attachment(sid: string): { identity: Identity | null; eph?: EphemeralAttachment } | undefined;
  /**
   * Writes `eph` into the socket's attachment (no row). False (nothing written) when a larger `eph` would not fit in
   * it as it is: its subscriptions would move to `_ember_subs` (a row each), or its identity lose its claims or token.
   */
  saveEph(ws: WebSocket, eph: EphemeralAttachment): boolean;
  send(ws: WebSocket, frame: string): void;
  /** The socket's access expired or was revoked (told `authExpired` once, as on a patch). */
  blocked(sid: string): boolean;
  /** Closes the socket and forgets it: its channels included (the shard's close drops it here, as any close does). */
  close(ws: WebSocket, code: number, reason: string): void;
  /** Last auto-response (`ping` → `pong`) of the socket, ms since epoch (0: none). */
  autoResponseAt(ws: WebSocket): number;
  shard(): string;
  channels(): Readonly<ChannelsConfig> | undefined;
}

interface Member {
  sid: string;
  id: string;
  /** The member state as JSON (wire encoding), or null. */
  state: string | null;
}

const q = (s: string): string => JSON.stringify(s);

/** A fresh member id (not the socket id: other members see it). */
export function memberId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export class EphemeralChannels {
  /** Channel name → sid → member. */
  private readonly rooms = new Map<string, Map<string, Member>>();
  /** sid → the channels it is in. */
  private readonly bySocket = new Map<string, Set<string>>();
  /** sid → `Date.now()` of its last frame (a wake starts everyone at the wake). */
  private readonly seen = new Map<string, number>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly swept = new Map<string, number>();
  readonly stats = { joins: 0, messages: 0, delivered: 0, refused: 0, timedOut: 0 };

  constructor(private readonly host: EphemeralHost) {}

  /** Channels and members held now. */
  counts(): { channels: number; members: number } {
    let members = 0;
    for (const r of this.rooms.values()) members += r.size;
    return { channels: this.rooms.size, members };
  }

  /** Wake: the socket's memberships from its attachment. */
  restore(sid: string, eph: EphemeralAttachment | undefined, now = Date.now()): void {
    if (!eph?.ch.length) return;
    this.seen.set(sid, now);
    for (const [name, state] of eph.ch) this.add(name, { sid, id: eph.m, state });
  }

  /** Any frame from the socket: it is alive. */
  touch(sid: string, now = Date.now()): void {
    if (this.bySocket.has(sid)) this.seen.set(sid, now);
  }

  private add(name: string, m: Member): void {
    let room = this.rooms.get(name);
    if (!room) this.rooms.set(name, (room = new Map()));
    room.set(m.sid, m);
    let mine = this.bySocket.get(m.sid);
    if (!mine) this.bySocket.set(m.sid, (mine = new Set()));
    mine.add(name);
  }

  /** Out of one room; true when it was in it. */
  private remove(name: string, sid: string): Member | null {
    const room = this.rooms.get(name);
    const m = room?.get(sid);
    if (!room || !m) return null;
    room.delete(sid);
    if (!room.size) {
      this.rooms.delete(name);
      this.swept.delete(name);
    }
    const mine = this.bySocket.get(sid);
    mine?.delete(name);
    if (mine && !mine.size) this.bySocket.delete(sid);
    return m;
  }

  private memberJson(m: Member): string {
    const user = this.host.attachment(m.sid)?.identity?.subject ?? null;
    return `{"id":${q(m.id)},"user":${user === null ? "null" : q(user)}${m.state !== null ? `,"state":${m.state}` : ""}}`;
  }

  /** `frame` to every member of `name` but `except`, skipping sockets whose access expired. */
  private broadcast(name: string, frame: string, except: string | null): number {
    const room = this.rooms.get(name);
    if (!room) return 0;
    let n = 0;
    for (const sid of [...room.keys()]) {
      if (sid === except) continue;
      if (this.host.blocked(sid)) continue;
      const ws = this.host.socket(sid);
      if (!ws) continue;
      this.host.send(ws, frame);
      n++;
    }
    return n;
  }

  private joinedFrame(name: string, self: string, ref?: number): string {
    const room = this.rooms.get(name);
    const list = room ? [...room.values()].map((m) => this.memberJson(m)).join(",") : "";
    return `{"t":"joined","ch":${q(name)},"self":${q(self)},"members":[${list}]${ref === undefined ? "" : `,"ref":${ref}`}}`;
  }

  /** The socket's memberships into its attachment, with `name` at `state` (`undefined`: out of it); false: did not fit. */
  private persist(ws: WebSocket, sid: string, name?: string, state?: string | null): boolean {
    const att = this.host.attachment(sid);
    if (!att?.eph) return true;
    const ch: Array<[string, string | null]> = [];
    for (const n of this.bySocket.get(sid) ?? []) if (n !== name) ch.push([n, this.rooms.get(n)?.get(sid)?.state ?? null]);
    if (name !== undefined && state !== undefined) ch.push([name, state]);
    return this.host.saveEph(ws, { m: att.eph.m, ch });
  }

  private take(sid: string, now = Date.now()): boolean {
    let b = this.buckets.get(sid);
    if (!b) this.buckets.set(sid, (b = { tokens: EPHEMERAL_BURST, at: now }));
    b.tokens = Math.min(EPHEMERAL_BURST, b.tokens + ((now - b.at) / 1000) * EPHEMERAL_RATE_PER_SEC);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Members of `name` silent past the TTL are closed (they leave everything; `drop` tells the others). */
  private sweep(name: string, now = Date.now()): void {
    const at = this.swept.get(name) ?? 0;
    if (now - at < EPHEMERAL_SWEEP_MS) return;
    this.swept.set(name, now);
    const room = this.rooms.get(name);
    if (!room) return;
    for (const sid of [...room.keys()]) {
      const ws = this.host.socket(sid);
      const last = Math.max(this.seen.get(sid) ?? now, ws ? this.host.autoResponseAt(ws) : 0);
      if (ws && now - last <= EPHEMERAL_TTL_MS) continue;
      this.stats.timedOut++;
      // A close drops the socket (and so its memberships, the others told); one already gone only has to leave.
      if (ws) this.host.close(ws, EPHEMERAL_TTL_CLOSE, "ember: silent in channels");
      else this.drop(sid);
    }
  }

  private error(ws: WebSocket, name: string, code: string, message: string, ref?: number): void {
    this.stats.refused++;
    this.host.send(ws, stringify(ref === undefined ? { t: "err", code, message, ch: name } : { t: "err", code, message, ch: name, ref }));
  }

  private left(ws: WebSocket, name: string, code: string, message: string, ref?: number): void {
    this.host.send(ws, stringify(ref === undefined ? { t: "left", ch: name, code, message } : { t: "left", ch: name, code, message, ref }));
  }

  /**
   * `{t:"join", ch, state?, ref?}`: join, or (already in) update the member state. Answered with `joined` or `left` (a
   * refused update of a member that stays in: `err`), carrying the frame's `ref`.
   */
  join(ws: WebSocket, sid: string, name: string, state: unknown, hasState: boolean, ref?: number): void {
    const att = this.host.attachment(sid);
    if (!att?.eph) return this.error(ws, name, "bad_frame", "channels need feature ephemeral", ref);
    const member = this.rooms.get(name)?.get(sid) ?? null;
    // Already in: a refused update leaves it in, with its state. Not in: it did not join.
    const refuse = (code: string, message: string) => {
      if (member) return this.error(ws, name, code, message, ref);
      this.stats.refused++;
      this.left(ws, name, code, message, ref);
    };
    if (!CHANNEL_NAME.test(name)) return refuse("bad_channel", "channel names are 1 to 128 of A-Z a-z 0-9 _ . : @ / -");
    if (this.host.blocked(sid)) return refuse("auth_expired", 'the token expired; send {t:"auth"} with a fresh one');
    const match = matchChannel(this.host.channels(), name);
    if (!match || !authorizeChannel(match.def, att.identity, { name, param: match.param, shard: this.host.shard() })) {
      // Not (or no longer) allowed: out.
      if (member) this.leaveRoom(ws, sid, name);
      this.stats.refused++;
      return this.left(ws, name, "channel_denied", `not allowed to join ${name}`, ref);
    }
    let stateJson: string | null = member?.state ?? null;
    if (hasState || !member) {
      if (hasState) {
        stateJson = stringify(state);
        if (stateJson.length > EPHEMERAL_MAX_STATE_CHARS) return refuse("too_large", `member state is at most ${EPHEMERAL_MAX_STATE_CHARS} chars of JSON`);
      }
      const bad = checkChannelValue(match.def, "state", hasState ? state : undefined);
      if (bad) return refuse("invalid_state", bad);
    }
    // Before the limits: every join (a refused one too) sweeps, so silent members do not keep a room full.
    this.sweep(name);
    if (!this.take(sid)) return refuse("rate_limited", `at most ${EPHEMERAL_RATE_PER_SEC} channel messages per second per socket`);
    if (!member) {
      if ((this.bySocket.get(sid)?.size ?? 0) >= EPHEMERAL_MAX_CHANNELS) return refuse("too_many_channels", `a socket is in at most ${EPHEMERAL_MAX_CHANNELS} channels`);
      if ((this.rooms.get(name)?.size ?? 0) >= EPHEMERAL_MAX_MEMBERS) return refuse("channel_full", `a channel has at most ${EPHEMERAL_MAX_MEMBERS} members`);
    }
    const changed = !member || member.state !== stateJson;
    // Into the attachment first: one that does not fit changes nothing (a channel never writes a row).
    if (changed && !this.persist(ws, sid, name, stateJson)) return refuse("too_large", "the socket's attachment is full (its subscriptions): no room for this channel");
    const m: Member = { sid, id: att.eph.m, state: stateJson };
    this.add(name, m);
    this.seen.set(sid, Date.now());
    this.stats.joins++;
    this.host.send(ws, this.joinedFrame(name, m.id, ref));
    if (changed) this.broadcast(name, `{"t":"members","ch":${q(name)},"join":[${this.memberJson(m)}]}`, sid);
  }

  /** `{t:"leave", ch}`: no answer. */
  leave(ws: WebSocket, sid: string, name: string): void {
    this.leaveRoom(ws, sid, name);
  }

  private leaveRoom(ws: WebSocket, sid: string, name: string): void {
    const m = this.remove(name, sid);
    if (!m) return;
    this.persist(ws, sid);
    this.broadcast(name, `{"t":"members","ch":${q(name)},"leave":[${q(m.id)}]}`, null);
  }

  /**
   * `{t:"pub", ch, data, ref?}`: to every other member, as `msg`. Refusals are `err` with `ch` (and the `ref`); with a
   * `ref`, one that went out is answered `published` (the `multiTab` leader hands it to the other tabs only then).
   */
  publish(ws: WebSocket, sid: string, name: string, data: unknown, ref?: number): void {
    const att = this.host.attachment(sid);
    if (!att?.eph) return this.error(ws, name, "bad_frame", "channels need feature ephemeral", ref);
    const member = this.rooms.get(name)?.get(sid);
    if (!member) return this.error(ws, name, "not_joined", `join ${name} before publishing to it`, ref);
    if (this.host.blocked(sid)) return this.error(ws, name, "auth_expired", 'the token expired; send {t:"auth"} with a fresh one', ref);
    const json = stringify(data);
    if (json.length > EPHEMERAL_MAX_PAYLOAD_CHARS) return this.error(ws, name, "too_large", `a message is at most ${EPHEMERAL_MAX_PAYLOAD_CHARS} chars of JSON`, ref);
    const match = matchChannel(this.host.channels(), name);
    if (!match) return this.error(ws, name, "channel_denied", `not allowed to publish to ${name}`, ref);
    const bad = checkChannelValue(match.def, "payload", data);
    if (bad) return this.error(ws, name, "invalid_payload", bad, ref);
    this.sweep(name);
    if (!this.take(sid)) return this.error(ws, name, "rate_limited", `at most ${EPHEMERAL_RATE_PER_SEC} channel messages per second per socket`, ref);
    const user = att.identity?.subject ?? null;
    this.stats.messages++;
    this.stats.delivered += this.broadcast(name, `{"t":"msg","ch":${q(name)},"from":${q(member.id)},"user":${user === null ? "null" : q(user)},"data":${json}}`, sid);
    if (ref !== undefined) this.host.send(ws, `{"t":"published","ch":${q(name)},"ref":${ref}}`);
  }

  /**
   * The socket's identity changed (an `auth` that is not an in-place renewal, or one after its access expired): every
   * channel it is in is authorized again under the new identity. Allowed: a fresh `joined` (what it missed while
   * expired) and the others see the member again (its user may differ). Refused: it leaves (`left channel_denied`).
   */
  reauth(ws: WebSocket, sid: string): void {
    const names = [...(this.bySocket.get(sid) ?? [])];
    if (!names.length) return;
    const att = this.host.attachment(sid);
    for (const name of names) {
      const match = matchChannel(this.host.channels(), name);
      const m = this.rooms.get(name)?.get(sid);
      if (!m) continue;
      if (!att || !match || !authorizeChannel(match.def, att.identity, { name, param: match.param, shard: this.host.shard() })) {
        this.leaveRoom(ws, sid, name);
        this.stats.refused++;
        this.left(ws, name, "channel_denied", `not allowed to join ${name}`);
        continue;
      }
      this.host.send(ws, this.joinedFrame(name, m.id));
      this.broadcast(name, `{"t":"members","ch":${q(name)},"join":[${this.memberJson(m)}]}`, sid);
    }
  }

  /** The socket is gone (closed, broken, revoked with close): out of every channel, the others told. */
  drop(sid: string): void {
    const names = this.bySocket.get(sid);
    this.seen.delete(sid);
    this.buckets.delete(sid);
    if (!names) return;
    for (const name of [...names]) {
      const m = this.remove(name, sid);
      if (m) this.broadcast(name, `{"t":"members","ch":${q(name)},"leave":[${q(m.id)}]}`, null);
    }
  }
}
