// One WebSocket per shard for every tab of an origin (option `multiTab` of EmberClient). Opt-in.
//
// Every tab's EmberClient runs exactly as it does alone; only its WebSocket constructor changes. Each socket it opens
// is a `VirtualSocket`: the same frames, carried over a BroadcastChannel to the tab that leads (a Web Lock), which
// holds the real sockets and multiplexes the virtual ones onto them. Nothing about subscriptions, mutations, acks,
// resume or the identity gating of results moves out of the client: the leader only routes frames.
//
//   lock    "ember-ws:<name>"             the leader holds it for as long as it leads.
//   lock    "ember-ws:<name>:tab:<id>"    every tab holds its own for its life: the leader waits on it to learn that a
//                                         tab is gone, and drops its subscriptions from the shared socket.
//   channel "ember-ws:<name>"             control: `leader` announcements, `cid?`/`cid` (the shared clientId).
//   channel "ember-ws:<name>:leader"      tab → leader: `open`, `send`, `close` of a virtual socket.
//   channel "ember-ws:<name>:tab:<id>"    leader → tab: `opened`, `msg`, `closed`.
//
// Groups. The leader keeps one real socket per (url with the shard, clientId, protocol, features, identity), where
// the identity is the hello token's: anonymous, a JWT's claims minus `exp`/`iat`/`nbf`/`jti` (the same equivalence
// the shard uses for an in-place renewal, `sameIdentityClaims`), or the exact string of an opaque token. A virtual
// socket joins the group of its `hello`, so a frame computed for one identity can only reach a tab whose socket said
// hello as that identity. Tabs signed in as someone else get a socket of their own.
//
// Identity changes. A virtual socket that is asked to send `auth` with a token of another identity closes itself on
// the spot (synchronously, before anything is posted): no frame computed for the identity it said hello with is
// handed to the client after that point (they are dropped with the socket). The client reconnects as it does after any
// drop, and its new hello joins the group of its new identity. The leader checks the same thing again. An `auth` of
// the same identity (a renewal) goes to the shared socket only when it carries a later `exp` (or the socket expired).
//
// Expiry. The leader tracks each member's own token (`exp` of its hello, then of its renewals) and treats a member
// whose token expired as the shard treats an expired socket: nothing computed for the identity reaches it (its
// subscriptions are refused with `auth_expired` and dropped from the shared socket, a `qres` becomes an
// `auth_expired` refusal), its `sub`/`mut`/`q` are refused without reaching the shard, and it is told `authExpired`,
// until its own `auth` brings an unexpired token. Opaque tokens group by their exact string and carry no `exp`.
//
// Mutations. Tabs share one clientId (`cid?`: a tab with none stored adopts the leader's), and every mid carries its
// client's random session id, so the shard's dedup key (identity, clientId, mid) is the same whichever socket a
// mutation goes out on: a leader that dies (or a follower that gives up on it and opens its own socket) only makes the
// client resend what had no `mres`, and the shard answers those from its dedup. Pending mutations never leave the tab
// that issued them.
//
// Qids are rewritten per virtual socket (`<vid>~<qid>`) on the shared socket and routed back, so nothing sent for a
// socket that is gone reaches the next one of the same tab; mids are routed by the leader's table of who sent them
// (`patch.mids` too: the first sender still waiting for that mid's `mres`). Server frames without a qid or mid (`authExpired`, qid-less `err`) go to
// every tab of the group. The leader answers `ping` itself (it proves the leader is alive) and keeps its own heartbeat
// on the real socket. It never forwards anything before the real `ready`: a tab's frames wait, and are then handled as
// the shard would (an array frame without feature "batch", or a `resume.ik` without "ident", gets the qid-less
// `bad_frame` the shard would send, so the client's pipelining fallbacks work unchanged).
//
// Fallback. Without BroadcastChannel or Web Locks (React Native, older Node, old browsers) the option does nothing:
// one socket per client, as before. A virtual socket the leader does not acknowledge within `openTimeoutMs` (no leader
// yet, a frozen or busy leader tab) becomes a plain WebSocket of its own. A new leader announces itself: sockets
// attached to the previous one close (the client reconnects through the new one).
//
// Trust boundary: tabs of one origin run the same app and already share its storage (localStorage, IndexedDB, the
// offline replica); the leader does not verify signatures (the shard verified the shared socket's token). A tab whose
// unexpired token has the same identity and claims as the shared socket's sees what that socket sees, as it would with a
// socket of its own.

import { unverifiedJwtPayload } from "@freecorps/ember-values";
import type { WebSocketConstructor, WebSocketLike } from "./client.ts";
import { PING, PONG } from "./protocol.ts";
import { stableStringify } from "./wire.ts";

/** The part of `navigator.locks` (Web Locks API) used here. */
export interface LockManagerLike {
  request(name: string, callback: (lock: unknown) => unknown): Promise<unknown>;
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

/** The part of `BroadcastChannel` used here. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  close(): void;
}
export type BroadcastChannelConstructor = new (name: string) => BroadcastChannelLike;

/** `starting`: deciding; `leader`: holds the shared sockets; `follower`: goes through the leader; `closed`. */
export type TabRole = "starting" | "leader" | "follower" | "closed";

export interface MultiTabOptions {
  /** Tabs with the same name share sockets (the lock and channel names derive from it). Default: the client's url. */
  name?: string;
  /** Default `navigator.locks`; null: no coordination (the option does nothing). */
  locks?: LockManagerLike | null;
  /** Default `globalThis.BroadcastChannel`; null: no coordination (the option does nothing). */
  BroadcastChannel?: BroadcastChannelConstructor | null;
  /** A virtual socket the leader has not acknowledged by then opens a socket of its own. Default 1000 ms. */
  openTimeoutMs?: number;
  /** How long a tab without a stored clientId waits for the leader's (else it makes its own). Default 300 ms. */
  clientIdTimeoutMs?: number;
  /**
   * Step down while the page is frozen or in the back/forward cache (`freeze`, `pagehide` persisted), and queue for the
   * lead again on `resume`/`pageshow`: a frozen leader would stall every tab. Default true (when `document` exists).
   */
  lifecycle?: boolean;
  onRoleChange?(role: TabRole): void;
}

/** What the hub needs from its client. */
interface HubConfig extends MultiTabOptions {
  name: string;
  locks: LockManagerLike;
  BroadcastChannel: BroadcastChannelConstructor;
  WebSocket: WebSocketConstructor;
  heartbeat: { intervalMs: number; timeoutMs: number } | false;
}

/** Envelope tag of every message on the channels (another version of this protocol ignores them). */
const E = "ember-ws/1";

type Ctl = { e: typeof E; k: "leader"; lid: string } | { e: typeof E; k: "cid?"; from: string } | { e: typeof E; k: "cid"; to: string; id: string };
type ToLeader = { e: typeof E; k: "open"; from: string; vid: string; url: string } | { e: typeof E; k: "send"; from: string; vid: string; data: string } | { e: typeof E; k: "close"; from: string; vid: string };
/** Every leader → tab message carries the leader's `lid`: a tab only takes them from the leader its socket is with. */
type ToTab = { e: typeof E; k: "opened"; vid: string; lid: string } | { e: typeof E; k: "msg"; vid: string; lid: string; data: string } | { e: typeof E; k: "closed"; vid: string; lid: string; code: number; reason: string };

/** Close codes of virtual sockets (the client reconnects after any of them). */
const CLOSE_LEADER_GONE = 4100;
const CLOSE_IDENTITY = 4101;
const CLOSE_PROTOCOL = 4103;

const RENEWAL_CLAIMS = new Set(["exp", "iat", "nbf", "jti"]);

/**
 * Who a socket that said hello with `token` runs as, as a grouping key: anonymous, a JWT's identity and claims apart
 * from its timing (what a renewal of the same session changes), or an opaque token itself.
 */
export function socketIdentityKey(token: unknown): string {
  if (typeof token !== "string") return "anon";
  const payload = unverifiedJwtPayload(token);
  if (!payload) return `o:${token}`;
  // Defined, not assigned (`Object.fromEntries`): a claim named `__proto__` stays a claim (an assignment onto `{}` would
  // hit the prototype setter and lose it, and two identities would share a key).
  return `j:${stableStringify(Object.fromEntries(Object.entries(payload).filter(([k]) => !RENEWAL_CLAIMS.has(k))))}`;
}

function jwtExpOf(token: string | null): number | null {
  if (!token) return null;
  const exp = unverifiedJwtPayload(token)?.exp;
  return typeof exp === "number" ? exp : null;
}

/** As the shard's `isExpired`: an `exp` (seconds) at or before now. */
const expiredAt = (exp: number | null): boolean => exp !== null && exp * 1000 <= Date.now();

function randomId(len = 10): string {
  const c = typeof crypto !== "undefined" ? (crypto as Crypto) : undefined;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, len);
  let s = "";
  while (s.length < len) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Whether this environment can coordinate tabs (Web Locks and BroadcastChannel). */
export function multiTabSupported(options: MultiTabOptions = {}): boolean {
  return !!resolveLocks(options) && !!resolveChannel(options);
}

function resolveLocks(options: MultiTabOptions): LockManagerLike | null {
  if (options.locks !== undefined) return options.locks;
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null;
}

function resolveChannel(options: MultiTabOptions): BroadcastChannelConstructor | null {
  if (options.BroadcastChannel !== undefined) return options.BroadcastChannel;
  const bc = (globalThis as { BroadcastChannel?: BroadcastChannelConstructor }).BroadcastChannel;
  return typeof bc === "function" ? bc : null;
}

/**
 * The hub of one client: its virtual sockets, and (while it leads) the shared real sockets of every tab. Null when the
 * environment cannot coordinate tabs: the client then uses its WebSocket directly.
 */
export function createMultiTab(options: MultiTabOptions & { name: string; WebSocket: WebSocketConstructor; heartbeat: HubConfig["heartbeat"] }): MultiTab | null {
  const locks = resolveLocks(options);
  const BC = resolveChannel(options);
  if (!locks || !BC) return null;
  return new MultiTab({ ...options, locks, BroadcastChannel: BC });
}

export class MultiTab {
  /** This tab's id (also the qid prefix of its subscriptions on a shared socket). */
  readonly id = randomId(8);
  private roleValue: TabRole = "starting";
  private readonly base: string;
  private readonly ctl: BroadcastChannelLike;
  private readonly inbox: BroadcastChannelLike;
  private readonly toLeader: BroadcastChannelLike;
  private leader: Leader | null = null;
  /** The leader this tab last heard of (its own while it leads): leader → tab messages from another are stale. */
  private leaderLid: string | null = null;
  private readonly sockets = new Map<string, VirtualSocket>();
  private vidSeq = 0;
  private releaseLeader: (() => void) | null = null;
  private releaseTab: (() => void) | null = null;
  private abort = new AbortController();
  private decided: Promise<void>;
  private decide!: () => void;
  /** The clientId this tab's client runs with (offered by it); the leader answers `cid?` with it. */
  private clientIdValue: string | null = null;
  private readonly cidAskers = new Set<string>();
  private readonly cidWaiters = new Set<(id: string) => void>();
  private readonly stopLifecycle: (() => void) | undefined;
  /** While stepped down for a frozen / cached page: do not queue for the lead until it comes back. */
  private suspended = false;

  constructor(readonly config: HubConfig) {
    this.base = `ember-ws:${config.name}`;
    this.decided = new Promise<void>((r) => (this.decide = r));
    const BC = config.BroadcastChannel;
    this.ctl = new BC(this.base);
    this.inbox = new BC(`${this.base}:tab:${this.id}`);
    this.toLeader = new BC(`${this.base}:leader`);
    this.ctl.addEventListener("message", this.onCtl);
    this.inbox.addEventListener("message", this.onInbox);
    void config.locks.request(`${this.base}:tab:${this.id}`, () => new Promise<void>((r) => (this.releaseTab = r))).catch(() => undefined);
    this.tryLead();
    this.stopLifecycle = config.lifecycle === false ? undefined : this.watchLifecycle();
  }

  get role(): TabRole {
    return this.roleValue;
  }

  private setRole(r: TabRole): void {
    if (this.roleValue === r || this.roleValue === "closed") return;
    this.roleValue = r;
    if (r !== "starting") this.decide();
    try {
      this.config.onRoleChange?.(r);
    } catch {
      /* the app's problem */
    }
  }

  /** Lead if nobody does; else follow (and queue for the lead). */
  private tryLead(): void {
    void this.config.locks
      .request(this.base, { ifAvailable: true }, (lock) => {
        if (lock) return this.lead();
        this.follow();
        return undefined;
      })
      .catch(() => this.follow());
  }

  private follow(): void {
    if (this.roleValue === "closed" || this.suspended) return;
    this.setRole("follower");
    void this.config.locks.request(this.base, { signal: this.abort.signal }, () => this.lead()).catch(() => undefined);
  }

  /** Runs while this tab holds the leader lock. */
  private async lead(): Promise<void> {
    if (this.roleValue === "closed" || this.suspended) return;
    // The release is in place before anything else runs: an observer that closes the client (or steps down) from
    // `onRoleChange` frees the lock instead of holding it for the life of the page.
    const held = new Promise<void>((r) => (this.releaseLeader = r));
    const leader = new Leader(this, `${this.base}`);
    this.leader = leader;
    this.setRole("leader");
    if (this.leader !== leader) return;
    this.announce();
    this.onLeader(leader.lid);
    for (const asker of this.cidAskers) this.answerCid(asker);
    await held;
  }

  private announce(): void {
    if (this.leader) this.post(this.ctl, { e: E, k: "leader", lid: this.leader.lid });
  }

  /** Stop leading: every tab's virtual socket on our shared sockets closes (they reconnect through the next leader). */
  private stepDown(closing = false): void {
    const leader = this.leader;
    this.leader = null;
    leader?.stop();
    // The next leader is not known yet: its announcement (or, for a socket opened meanwhile, its `opened`) says.
    if (leader) this.leaderLid = null;
    const release = this.releaseLeader;
    this.releaseLeader = null;
    release?.();
    if (leader && !closing) this.setRole("follower");
  }

  private watchLifecycle(): (() => void) | undefined {
    const g = globalThis as { document?: EventTargetLike; addEventListener?: EventTargetLike["addEventListener"]; removeEventListener?: EventTargetLike["removeEventListener"] };
    const doc = g.document;
    if (!doc || typeof doc.addEventListener !== "function" || typeof g.addEventListener !== "function") return undefined;
    const away = () => {
      if (this.roleValue === "closed" || this.suspended) return;
      this.suspended = true;
      this.stepDown();
      this.abort.abort();
    };
    const back = () => {
      if (this.roleValue === "closed" || !this.suspended) return;
      this.suspended = false;
      this.leaderLid = null;
      this.abortNext();
      // An `open` posted while the page was away may have gone unanswered (or its answer was lost): ask again.
      for (const s of [...this.sockets.values()]) s.reoffer();
      this.tryLead();
    };
    const pagehide = (e: unknown) => {
      if ((e as { persisted?: boolean } | null)?.persisted) away();
    };
    doc.addEventListener("freeze", away);
    doc.addEventListener("resume", back);
    g.addEventListener("pagehide", pagehide);
    g.addEventListener("pageshow", back);
    return () => {
      doc.removeEventListener("freeze", away);
      doc.removeEventListener("resume", back);
      g.removeEventListener!("pagehide", pagehide);
      g.removeEventListener!("pageshow", back);
    };
  }

  /** A fresh abort signal for the next lock request (the previous one was aborted by a step-down). */
  private abortNext(): void {
    this.abort = new AbortController();
  }

  // ---------------------------------------------------------------------------------------------- clientId

  /** The client's clientId (stored, or adopted): the leader hands it to tabs that have none. */
  offerClientId(id: string): void {
    if (this.clientIdValue) return;
    this.clientIdValue = id;
    if (this.leader) for (const asker of this.cidAskers) this.answerCid(asker);
  }

  /** The clientId of the tab that leads, for a client that has none stored (null: lead ourselves, or no answer). */
  async sharedClientId(): Promise<string | null> {
    await Promise.race([this.decided, new Promise((r) => setTimeout(r, this.config.clientIdTimeoutMs ?? 300))]);
    if (this.roleValue !== "follower") return null;
    return new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (id: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.cidWaiters.delete(onId);
        resolve(id);
      };
      const onId = (id: string) => finish(id);
      const timer = setTimeout(() => finish(null), this.config.clientIdTimeoutMs ?? 300);
      this.cidWaiters.add(onId);
      this.post(this.ctl, { e: E, k: "cid?", from: this.id });
    });
  }

  private answerCid(asker: string): void {
    if (!this.clientIdValue) return;
    this.cidAskers.delete(asker);
    this.post(this.ctl, { e: E, k: "cid", to: asker, id: this.clientIdValue });
  }

  // ---------------------------------------------------------------------------------------------- channels

  private readonly onCtl = (ev: { data: unknown }) => {
    const m = ev.data as Ctl | null;
    if (!isObj(m) || m.e !== E) return;
    if (m.k === "leader" && typeof m.lid === "string") {
      if (this.leader) {
        // We hold the lock, so no other tab leads: this is a late announcement of a leader that stepped down before we
        // took over. Announce ourselves again, so a tab that took it for the current leader comes back to us.
        if (m.lid !== this.leader.lid) this.announce();
        return;
      }
      this.onLeader(m.lid);
    } else if (m.k === "cid?" && typeof m.from === "string") {
      if (!this.leader) return;
      this.cidAskers.add(m.from);
      this.answerCid(m.from);
    } else if (m.k === "cid" && m.to === this.id && typeof m.id === "string") {
      for (const w of [...this.cidWaiters]) w(m.id);
    }
  };

  private readonly onInbox = (ev: { data: unknown }) => {
    const m = ev.data as ToTab | null;
    if (!isObj(m) || m.e !== E || typeof m.vid !== "string") return;
    const s = this.sockets.get(m.vid);
    if (!s || typeof m.lid !== "string") return;
    if (m.k === "opened") {
      // Only from the current leader (a late `opened` of the one before would tie the socket to a leader that is gone).
      if (this.leaderLid !== null && m.lid !== this.leaderLid) return;
      this.leaderLid = m.lid;
      s.attached(m.lid);
    } else if (m.k === "msg" && typeof m.data === "string") s.deliver(m.data, m.vid, m.lid);
    else if (m.k === "closed") s.remoteClosed(m.lid, this.leaderLid, typeof m.code === "number" ? m.code : CLOSE_LEADER_GONE, typeof m.reason === "string" ? m.reason : "");
  };

  /** A (new) leader: sockets attached to another close; those still waiting ask it (their `open` may have been lost). */
  private onLeader(lid: string): void {
    this.leaderLid = lid;
    for (const s of [...this.sockets.values()]) s.leaderChanged(lid);
  }

  /** @internal */
  post(ch: BroadcastChannelLike, m: Ctl | ToLeader | ToTab): void {
    if (this.roleValue === "closed" && m.k !== "close") return;
    try {
      ch.postMessage(m);
    } catch {
      /* a closed channel: the other side times out or is told by the lock */
    }
  }

  /** @internal */
  postToLeader(m: ToLeader): void {
    this.post(this.toLeader, m);
  }

  // ---------------------------------------------------------------------------------------------- sockets

  /** The WebSocket constructor the client uses: virtual sockets through the leader. */
  socketConstructor(): WebSocketConstructor {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const hub = this;
    return class extends VirtualSocket {
      constructor(url: string) {
        super(hub, url);
      }
    } as unknown as WebSocketConstructor;
  }

  /** @internal */
  register(s: VirtualSocket): string {
    const vid = `${this.id}.${(++this.vidSeq).toString(36)}`;
    this.sockets.set(vid, s);
    return vid;
  }

  /** @internal */
  unregister(vid: string): void {
    this.sockets.delete(vid);
  }

  /** @internal */
  get closedHub(): boolean {
    return this.roleValue === "closed";
  }

  /** @internal Sockets of this hub (tests, devtools). */
  get socketCount(): number {
    return this.sockets.size;
  }

  /** @internal The leader's shared sockets (tests, devtools); 0 when this tab does not lead. */
  get sharedSocketCount(): number {
    return this.leader?.groupCount ?? 0;
  }

  /** Leave: our virtual sockets close; if we lead, every tab's shared socket closes and the next tab takes over. */
  close(): void {
    if (this.roleValue === "closed") return;
    for (const s of [...this.sockets.values()]) s.close(1000, "client closed");
    this.stepDown(true);
    this.roleValue = "closed";
    this.decide();
    try {
      this.config.onRoleChange?.("closed");
    } catch {
      /* the app's problem */
    }
    this.stopLifecycle?.();
    this.abort.abort();
    this.releaseTab?.();
    this.ctl.removeEventListener("message", this.onCtl);
    this.inbox.removeEventListener("message", this.onInbox);
    for (const ch of [this.ctl, this.inbox, this.toLeader]) {
      try {
        ch.close();
      } catch {
        /* closing anyway */
      }
    }
  }
}

interface EventTargetLike {
  addEventListener(type: string, listener: (e: unknown) => void): void;
  removeEventListener(type: string, listener: (e: unknown) => void): void;
}

// ------------------------------------------------------------------------------------------------ virtual socket

type Mode = "attaching" | "attached" | "direct" | "closed";

/**
 * A WebSocket for the client whose frames go to the leader tab. If the leader does not take it in time, it becomes a
 * real socket of its own (`direct`), invisibly to the client.
 */
class VirtualSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private mode: Mode = "attaching";
  private state = 0;
  private readonly vid: string;
  private lid: string | null = null;
  /** Identity of the `hello` this socket sent (undefined until it did). */
  private helloKey: string | undefined;
  private direct: WebSocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly hub: MultiTab,
    private readonly url: string,
  ) {
    this.vid = hub.register(this);
    if (hub.closedHub) {
      queueMicrotask(() => this.goDirect());
      return;
    }
    this.postOpen();
    this.timer = setTimeout(() => this.goDirect(), hub.config.openTimeoutMs ?? 1000);
  }

  get readyState(): number {
    return this.direct ? this.direct.readyState : this.state;
  }

  private postOpen(): void {
    this.hub.postToLeader({ e: E, k: "open", from: this.hub.id, vid: this.vid, url: this.url });
  }

  /** @internal The leader took it. */
  attached(lid: string): void {
    if (this.mode !== "attaching") return;
    this.clearTimer();
    this.mode = "attached";
    this.lid = lid;
    this.state = 1;
    this.onopen?.({});
  }

  /** @internal A frame from the shard, routed to us by the leader. */
  deliver(data: string, vid: string, lid: string): void {
    if (this.mode !== "attached" || vid !== this.vid || lid !== this.lid) return;
    this.onmessage?.({ data });
  }

  /** @internal The leader closed it (its shared socket closed, the leader stepped down, a protocol error). */
  remoteClosed(lid: string, current: string | null, code: number, reason: string): void {
    // From the leader it is attached to, or (still attaching) from the current one: a stale `closed` is ignored.
    if (this.mode === "attached" ? lid !== this.lid : this.mode !== "attaching" || (current !== null && lid !== current)) return;
    this.finish(code, reason);
  }

  /** @internal */
  leaderChanged(lid: string): void {
    if (this.mode === "attaching") this.postOpen();
    else if (this.mode === "attached" && this.lid !== lid) this.finish(CLOSE_LEADER_GONE, "leader changed");
  }

  /** @internal Ask again (the page was frozen or cached: the `open` may have gone unanswered). */
  reoffer(): void {
    if (this.mode === "attaching") this.postOpen();
  }

  send(data: string): void {
    if (this.direct) return this.direct.send(data);
    if (this.mode === "closed") return;
    if (this.mode !== "attached") throw new Error("WebSocket is not open");
    if (data !== PING && (this.helloKey === undefined || data.includes('"auth"'))) {
      const parsed = safeParse(data);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!isObj(m)) continue;
        if (m.t === "hello" && this.helloKey === undefined) this.helloKey = socketIdentityKey(m.token);
        else if (m.t === "auth" && this.helloKey !== undefined && socketIdentityKey(m.token) !== this.helloKey) {
          // Another identity: everything from here on is theirs, and nothing the shared socket sends is. The socket
          // closes first, before anything is posted: no frame of the old identity is handed to the client after this.
          this.finish(CLOSE_IDENTITY, "identity changed");
          if (i > 0) this.hub.postToLeader({ e: E, k: "send", from: this.hub.id, vid: this.vid, data: JSON.stringify(list.slice(0, i)) });
          this.hub.postToLeader({ e: E, k: "close", from: this.hub.id, vid: this.vid });
          return;
        }
      }
    }
    this.hub.postToLeader({ e: E, k: "send", from: this.hub.id, vid: this.vid, data });
  }

  close(code = 1000, reason = ""): void {
    if (this.direct) return this.direct.close(code, reason);
    if (this.mode === "closed") return;
    this.hub.postToLeader({ e: E, k: "close", from: this.hub.id, vid: this.vid });
    this.finish(code, reason);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private finish(code: number, reason: string): void {
    this.clearTimer();
    this.mode = "closed";
    this.state = 3;
    this.hub.unregister(this.vid);
    // As a WebSocket: the close event comes later, never inside the call that caused it.
    setTimeout(() => this.onclose?.({ code, reason, wasClean: code === 1000 }), 0);
  }

  /** No leader took it in time (or the hub is gone): a socket of its own. */
  private goDirect(): void {
    if (this.mode !== "attaching") return;
    this.clearTimer();
    // The leader may still take it late: tell it to forget us.
    this.hub.postToLeader({ e: E, k: "close", from: this.hub.id, vid: this.vid });
    this.hub.unregister(this.vid);
    this.mode = "direct";
    let ws: WebSocketLike;
    try {
      ws = new this.hub.config.WebSocket(this.url);
    } catch {
      this.mode = "closed";
      this.state = 3;
      setTimeout(() => {
        this.onerror?.({});
        this.onclose?.({ code: 1006, reason: "connect failed", wasClean: false });
      }, 0);
      return;
    }
    this.direct = ws;
    ws.onopen = (ev) => this.onopen?.(ev);
    ws.onmessage = (ev) => this.onmessage?.(ev);
    ws.onclose = (ev) => this.onclose?.(ev);
    ws.onerror = (ev) => this.onerror?.(ev);
  }
}

function safeParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ leader

/** A tab's virtual socket, as the leader sees it. */
interface Member {
  tab: string;
  vid: string;
  url: string;
  /** Its own token: its hello's, then its last unexpired renewal's. */
  token: string | null;
  /** `exp` of that token (null: none, an opaque token, anonymous). Past it, nothing computed for the identity reaches it. */
  exp: number | null;
  /** Told `authExpired` for this token (once, as the shard does). */
  expiredTold: boolean;
  group: Group | null;
  /** Frames that came before the group's `ready` (handled once it comes). */
  waiting: string[] | null;
  /** Its subscriptions on the shared socket (prefixed qids): unsubscribed when it goes. */
  subs: Set<string>;
}

/** One shared real socket. */
interface Group {
  key: string;
  url: string;
  /** The first member's hello, sent as is. */
  hello: Record<string, unknown>;
  identity: string;
  /** The token the shared socket runs with now (hello or the last renewal). */
  token: string | null;
  ws: WebSocketLike;
  ready: Record<string, unknown> | null;
  batch: boolean;
  ident: boolean;
  members: Set<Member>;
  /** Members by vid (the qid prefix). */
  byVid: Map<string, Member>;
  /**
   * Who sent each mutation still waiting for its `mres`, oldest first (a client resends a mid on its next socket: the
   * first answer is the first send's, and goes nowhere if that socket is gone).
   */
  mids: Map<string, Member[]>;
  /** The shard said `authExpired` and no renewal went since. */
  expired: boolean;
  /**
   * The shard refused the hello's token (`err unauthenticated` before `ready`): the socket runs anonymous while its
   * members said hello as the identity. No `auth` ever goes to it (a valid one would hand that identity's values to
   * members whose own token was refused): a member that sends one is moved off, to a socket of its own.
   */
  refused: boolean;
  closed: boolean;
  heardAt: number;
  pingAt: number | undefined;
  timer: ReturnType<typeof setTimeout> | null;
}

class Leader {
  readonly lid = randomId(8);
  private readonly inbox: BroadcastChannelLike;
  private readonly members = new Map<string, Member>();
  private readonly groups = new Map<string, Group>();
  private readonly tabs = new Map<string, BroadcastChannelLike>();
  private readonly watching = new Set<string>();
  private readonly abort = new AbortController();
  private stopped = false;

  constructor(
    private readonly hub: MultiTab,
    private readonly base: string,
  ) {
    this.inbox = new hub.config.BroadcastChannel(`${base}:leader`);
    this.inbox.addEventListener("message", this.onInbox);
  }

  get groupCount(): number {
    let n = 0;
    for (const g of this.groups.values()) if (!g.closed) n++;
    return n;
  }

  /** Close everything: every member is told (it reconnects through the next leader). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.inbox.removeEventListener("message", this.onInbox);
    try {
      this.inbox.close();
    } catch {
      /* closing anyway */
    }
    for (const m of [...this.members.values()]) this.drop(m, { code: CLOSE_LEADER_GONE, reason: "leader stepped down" }, false);
    for (const g of [...this.groups.values()]) this.end(g, CLOSE_LEADER_GONE, "leader stepped down");
    for (const ch of this.tabs.values()) {
      try {
        ch.close();
      } catch {
        /* closing anyway */
      }
    }
    this.tabs.clear();
  }

  private toTab(tab: string, m: ToTab): void {
    let ch = this.tabs.get(tab);
    if (!ch) {
      ch = new this.hub.config.BroadcastChannel(`${this.base}:tab:${tab}`);
      this.tabs.set(tab, ch);
    }
    this.hub.post(ch, m);
  }

  private sendTo(m: Member, data: string): void {
    this.toTab(m.tab, { e: E, k: "msg", vid: m.vid, lid: this.lid, data });
  }

  /** The member's own token has expired (checked when something is about to reach it, as the shard does at patch time). */
  private lapsed(m: Member): boolean {
    return expiredAt(m.exp);
  }

  /** `authExpired`, once per expired token (the client fetches a fresh one and sends `auth`). */
  private tellExpired(m: Member, out: unknown[]): void {
    if (m.expiredTold) return;
    m.expiredTold = true;
    out.push({ t: "authExpired" });
  }

  /** `unsub` of prefixed qids on the shared socket. */
  private unsubShared(g: Group, qids: string[]): void {
    if (!g.ready || !qids.length) return;
    const unsubs = qids.map((qid) => ({ t: "unsub", qid }));
    if (g.batch) for (let i = 0; i < unsubs.length; i += 256) this.real(g, JSON.stringify(unsubs.slice(i, i + 256)));
    else for (const u of unsubs) this.real(g, JSON.stringify(u));
  }

  private readonly onInbox = (ev: { data: unknown }) => {
    if (this.stopped) return;
    const m = ev.data as ToLeader | null;
    if (!isObj(m) || m.e !== E || typeof m.from !== "string" || typeof m.vid !== "string") return;
    const id = `${m.from}\u0000${m.vid}`;
    const member = this.members.get(id);
    if (m.k === "open" && typeof m.url === "string") {
      if (!member) {
        this.members.set(id, { tab: m.from, vid: m.vid, url: m.url, token: null, exp: null, expiredTold: false, group: null, waiting: null, subs: new Set() });
        this.watchTab(m.from);
      }
      this.toTab(m.from, { e: E, k: "opened", vid: m.vid, lid: this.lid });
    } else if (m.k === "send" && typeof m.data === "string") {
      if (!member) return this.toTab(m.from, { e: E, k: "closed", vid: m.vid, lid: this.lid, code: CLOSE_LEADER_GONE, reason: "unknown socket" });
      this.onMemberFrame(member, m.data);
    } else if (m.k === "close") {
      if (member) this.drop(member, null, true);
    }
  };

  /** Learn when a tab is gone (its lock frees): its subscriptions leave the shared sockets. */
  private watchTab(tab: string): void {
    if (tab === this.hub.id || this.watching.has(tab)) return;
    this.watching.add(tab);
    void this.hub.config.locks
      .request(`${this.base}:tab:${tab}`, { signal: this.abort.signal }, () => {
        this.watching.delete(tab);
        if (this.stopped) return;
        for (const m of [...this.members.values()]) if (m.tab === tab) this.drop(m, null, true);
        const ch = this.tabs.get(tab);
        this.tabs.delete(tab);
        try {
          ch?.close();
        } catch {
          /* gone anyway */
        }
      })
      .catch(() => this.watching.delete(tab));
  }

  /**
   * A member leaves: told with `notify` (else it closed itself), its subscriptions unsubscribed on the shared socket
   * (`unsub`), and the shared socket closed when it was the last.
   */
  private drop(m: Member, notify: { code: number; reason: string } | null, unsub: boolean): void {
    this.members.delete(`${m.tab}\u0000${m.vid}`);
    if (notify) this.toTab(m.tab, { e: E, k: "closed", vid: m.vid, lid: this.lid, ...notify });
    const g = m.group;
    m.group = null;
    m.waiting = null;
    if (!g) return;
    g.members.delete(m);
    g.byVid.delete(m.vid);
    // Out of the mids' sender lists: the answer to a mid it sent goes to whoever sent it again (its client, on its
    // next socket of this group), never to a socket that is gone.
    for (const [mid, senders] of g.mids) {
      const rest = senders.filter((x) => x !== m);
      if (!rest.length) g.mids.delete(mid);
      else if (rest.length !== senders.length) g.mids.set(mid, rest);
    }
    if (g.closed) return;
    if (!g.members.size) return this.end(g, 1000, "no tabs left");
    if (unsub) this.unsubShared(g, [...m.subs]);
    m.subs.clear();
  }

  private onMemberFrame(m: Member, data: string): void {
    if (data === PING) return this.sendTo(m, PONG);
    if (!m.group) {
      const hello = safeParse(data);
      if (!isObj(hello) || hello.t !== "hello" || typeof hello.clientId !== "string") return this.drop(m, { code: CLOSE_PROTOCOL, reason: "hello expected" }, false);
      return this.join(m, hello);
    }
    if (m.waiting) {
      m.waiting.push(data);
      return;
    }
    this.handle(m, m.group, data);
  }

  private join(m: Member, hello: Record<string, unknown>): void {
    const token = typeof hello.token === "string" ? hello.token : null;
    const identity = socketIdentityKey(token);
    const features = Array.isArray(hello.features) ? hello.features.map(String).join(",") : "";
    const key = [m.url, hello.clientId, String(hello.protocol), features, identity].join("\n");
    let g = this.groups.get(key);
    if (!g || g.closed) g = this.open(key, m.url, hello, identity, token);
    if (g.closed) return this.drop(m, { code: 1006, reason: "shared socket closed" }, false);
    m.token = token;
    m.exp = jwtExpOf(token);
    m.expiredTold = false;
    g.members.add(m);
    g.byVid.set(m.vid, m);
    m.group = g;
    if (g.ready) this.greet(m, g);
    else m.waiting = [];
  }

  /** A member's `ready` (the shared socket's), then what it sent meanwhile, handled as the shard would. */
  private greet(m: Member, g: Group): void {
    const waiting = m.waiting ?? [];
    m.waiting = null;
    this.sendTo(m, JSON.stringify(g.ready));
    if (this.lapsed(m)) {
      // Said hello with a token that has expired: it runs nothing until its own `auth` brings a fresh one.
      m.expiredTold = true;
      this.sendTo(m, '{"t":"authExpired"}');
    } else if (!this.renew(g, m.token) && g.expired) this.sendTo(m, '{"t":"authExpired"}');
    for (const data of waiting) {
      if (m.group !== g) break;
      this.handle(m, g, data);
    }
  }

  /** A token of the group's identity with a later `exp` (or any, once expired) renews the shared socket in place. */
  private renew(g: Group, token: string | null): boolean {
    if (!g.ready || g.refused || token === null || token === g.token) return false;
    const exp = jwtExpOf(token);
    if (expiredAt(exp)) return false;
    const cur = jwtExpOf(g.token);
    if (!g.expired && !(exp !== null && cur !== null && exp > cur)) return false;
    g.token = token;
    g.expired = false;
    this.real(g, JSON.stringify({ t: "auth", token }));
    return true;
  }

  private open(key: string, url: string, hello: Record<string, unknown>, identity: string, token: string | null): Group {
    let ws: WebSocketLike;
    const g: Group = {
      key,
      url,
      hello,
      identity,
      token,
      ws: null as unknown as WebSocketLike,
      ready: null,
      batch: false,
      ident: false,
      members: new Set(),
      byVid: new Map(),
      mids: new Map(),
      expired: false,
      refused: false,
      closed: false,
      heardAt: Date.now(),
      pingAt: undefined,
      timer: null,
    };
    this.groups.set(key, g);
    try {
      ws = new this.hub.config.WebSocket(url);
    } catch {
      g.closed = true;
      this.groups.delete(key);
      return g;
    }
    g.ws = ws;
    ws.onopen = () => {
      if (g.closed) return;
      this.real(g, JSON.stringify(hello));
      this.armBeat(g);
    };
    ws.onmessage = (ev) => {
      if (g.closed) return;
      g.heardAt = Date.now();
      g.pingAt = undefined;
      if (typeof ev.data === "string") this.onReal(g, ev.data);
    };
    ws.onclose = (ev) => {
      const code = (ev as { code?: unknown } | null)?.code;
      this.end(g, typeof code === "number" && code !== 1000 ? code : 1006, "shared socket closed");
    };
    ws.onerror = () => {
      /* a close event follows */
    };
    return g;
  }

  /** The shared socket is gone: every member is told (each client reconnects as after any drop). */
  private end(g: Group, code: number, reason: string): void {
    if (g.closed) return;
    g.closed = true;
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
    if (this.groups.get(g.key) === g) this.groups.delete(g.key);
    for (const m of [...g.members]) this.drop(m, { code, reason }, false);
    try {
      g.ws?.close(1000, reason);
    } catch {
      /* already closed */
    }
  }

  private real(g: Group, frame: string): void {
    if (g.closed) return;
    try {
      g.ws.send(frame);
    } catch {
      this.end(g, 1006, "send failed");
    }
  }

  /** Heartbeat of the shared socket: a ping after `intervalMs` of silence, closed if nothing comes in `timeoutMs`. */
  private armBeat(g: Group): void {
    const hb = this.hub.config.heartbeat;
    if (!hb || g.closed) return;
    const beat = () => {
      g.timer = null;
      if (g.closed) return;
      const now = Date.now();
      // Any frame since the ping cleared `pingAt`.
      if (g.pingAt !== undefined) {
        if (now - g.pingAt >= hb.timeoutMs) return this.end(g, 1006, "heartbeat timeout");
        return void (g.timer = setTimeout(beat, hb.timeoutMs - (now - g.pingAt)));
      }
      const quiet = now - g.heardAt;
      if (quiet >= hb.intervalMs) {
        g.pingAt = now;
        this.real(g, PING);
        g.timer = setTimeout(beat, hb.timeoutMs);
      } else g.timer = setTimeout(beat, hb.intervalMs - quiet);
    };
    g.timer = setTimeout(beat, hb.intervalMs);
  }

  // ------------------------------------------------------------------------------------------------ routing

  /** A member's frame, after `ready`: qids prefixed, mids remembered, then out on the shared socket. */
  private handle(m: Member, g: Group, data: string): void {
    const parsed = safeParse(data);
    if (parsed === undefined) return this.sendTo(m, JSON.stringify({ t: "err", code: "bad_frame", message: "invalid JSON" }));
    const array = Array.isArray(parsed);
    // As the shard: an array frame needs feature "batch", a `resume.ik` feature "ident" (refused whole, without qid).
    if (array && !g.batch) return this.sendTo(m, JSON.stringify({ t: "err", code: "bad_frame", message: "array frames need feature batch" }));
    const out: unknown[] = [];
    /** Answers of the leader itself (refusals), after what goes to the shard. */
    const back: unknown[] = [];
    for (const msg of array ? parsed : [parsed]) {
      if (!isObj(msg)) {
        out.push(msg);
        continue;
      }
      if ((msg.t === "sub" || msg.t === "mut" || msg.t === "q") && this.lapsed(m)) {
        // As the shard with an expired socket: refused before running, until a fresh token comes (`auth`).
        const error = { code: "auth_expired", message: 'the token expired; send {t:"auth"} with a fresh one' };
        back.push({ t: "authExpired" });
        if (msg.t === "mut") back.push({ t: "mres", mid: msg.mid, ok: false, error });
        else if (msg.t === "q") back.push({ t: "qres", qid: msg.qid, ok: false, error });
        else back.push({ t: "err", ...error, qid: msg.qid });
        continue;
      }
      switch (msg.t) {
        case "hello":
          this.sendTo(m, JSON.stringify({ t: "err", code: "duplicate_hello", message: "hello already received" }));
          continue;
        case "sub": {
          const resume = msg.resume as { ik?: unknown } | undefined;
          if (isObj(resume) && resume.ik !== undefined && !g.ident) {
            this.sendTo(m, JSON.stringify({ t: "err", code: "bad_frame", message: 'unknown field "ik"' }));
            continue;
          }
          const qid = prefix(m.vid, msg.qid);
          m.subs.add(qid);
          out.push({ ...msg, qid });
          continue;
        }
        case "unsub": {
          const qid = prefix(m.vid, msg.qid);
          m.subs.delete(qid);
          out.push({ ...msg, qid });
          continue;
        }
        case "q":
          out.push({ ...msg, qid: prefix(m.vid, msg.qid) });
          continue;
        case "mut": {
          // One entry per `mut` frame: the shard answers each with one `mres` (a client resends a mid on the same
          // socket after an `auth_expired` refusal, and both answers must reach it).
          const key = String(msg.mid);
          const senders = g.mids.get(key);
          if (senders) senders.push(m);
          else g.mids.set(key, [m]);
          out.push(msg);
          continue;
        }
        case "auth": {
          const token = msg.token === null ? null : typeof msg.token === "string" ? msg.token : undefined;
          if (token === undefined || socketIdentityKey(token) !== g.identity || g.refused) {
            // Someone else now (or a socket whose hello token the shard refused): off this socket (its virtual socket
            // closed itself already when the identity changed). What came before goes.
            this.flush(g, out, array);
            this.answer(m, back, array);
            return this.drop(m, { code: CLOSE_IDENTITY, reason: "identity changed" }, true);
          }
          const exp = jwtExpOf(token);
          if (expiredAt(exp)) {
            // As the shard: an expired token is refused, and the member keeps the state it had.
            back.push({ t: "err", code: "unauthenticated", message: "invalid token" });
            continue;
          }
          // Its own token from now on (also when the shared socket keeps a later one).
          m.token = token;
          m.exp = exp;
          m.expiredTold = false;
          if (token !== null && token !== g.token) {
            const cur = jwtExpOf(g.token);
            if (g.expired || (exp !== null && cur !== null && exp > cur)) {
              g.token = token;
              g.expired = false;
              out.push({ t: "auth", token });
            }
          }
          continue;
        }
        default:
          out.push(msg);
      }
    }
    this.flush(g, out, array);
    this.answer(m, back, array);
  }

  private answer(m: Member, back: unknown[], array: boolean): void {
    if (!back.length) return;
    if (array) this.sendTo(m, JSON.stringify(back));
    else for (const x of back) this.sendTo(m, JSON.stringify(x));
  }

  private flush(g: Group, out: unknown[], array: boolean): void {
    if (!out.length) return;
    if (array) this.real(g, JSON.stringify(out));
    else for (const x of out) this.real(g, JSON.stringify(x));
  }

  /** A frame from the shard: each message to the member it belongs to (by qid prefix, or mid), the rest to all. */
  private onReal(g: Group, data: string): void {
    if (data === PONG) return;
    const parsed = safeParse(data);
    if (parsed === undefined) return;
    const array = Array.isArray(parsed);
    const per = new Map<Member, unknown[]>();
    const to = (m: Member | undefined, msg: unknown) => {
      if (!m || m.group !== g) return;
      const list = per.get(m);
      if (list) list.push(msg);
      else per.set(m, [msg]);
    };
    const all = (msg: unknown) => {
      for (const m of g.members) if (!m.waiting) to(m, msg);
    };
    for (const msg of array ? parsed : [parsed]) {
      if (!isObj(msg)) continue;
      switch (msg.t) {
        case "ready": {
          if (g.ready) continue;
          g.ready = msg;
          const features = Array.isArray(msg.features) ? msg.features : [];
          g.batch = features.includes("batch");
          g.ident = features.includes("ident");
          // Routed below, then the members waiting for it get theirs.
          continue;
        }
        case "snap":
        case "qres": {
          const r = this.route(g, msg.qid);
          if (r) to(r.m, { ...msg, qid: r.qid });
          continue;
        }
        case "err": {
          if (msg.qid !== undefined) {
            const r = this.route(g, msg.qid);
            if (r) to(r.m, { ...msg, qid: r.qid });
            continue;
          }
          if (msg.code === "unauthenticated" && !g.ready) {
            // The shard refused the hello's token: this socket runs anonymous. Its members are told (each client
            // treats its socket as signed out); nobody else joins it.
            // The group stays (its members run anonymous on it) but is out of the map and never renewed.
            g.refused = true;
            if (this.groups.get(g.key) === g) this.groups.delete(g.key);
            for (const m of g.members) to(m, msg);
            continue;
          }
          all(msg);
          continue;
        }
        case "patch": {
          const changes = new Map<Member, unknown[]>();
          for (const c of Array.isArray(msg.changes) ? msg.changes : []) {
            if (!isObj(c)) continue;
            const r = this.route(g, c.qid);
            if (!r) continue;
            const list = changes.get(r.m);
            const routed = { ...c, qid: r.qid };
            if (list) list.push(routed);
            else changes.set(r.m, [routed]);
          }
          const mids = new Map<Member, unknown[]>();
          for (const mid of Array.isArray(msg.mids) ? msg.mids : []) {
            // Not consumed: the mid's `mres` follows (protocol), and goes to this same sender.
            const m = g.mids.get(String(mid))?.[0];
            if (!m || m.group !== g) continue;
            const list = mids.get(m);
            if (list) list.push(mid);
            else mids.set(m, [mid]);
          }
          for (const m of new Set([...changes.keys(), ...mids.keys()])) to(m, { ...msg, changes: changes.get(m) ?? [], mids: mids.get(m) ?? [] });
          continue;
        }
        case "mres": {
          const key = String(msg.mid);
          // The oldest sender still here (one that left is out of the list): the answer reaches who sent the mid.
          const senders = g.mids.get(key);
          const m = senders?.shift();
          if (senders && !senders.length) g.mids.delete(key);
          if (m) to(m, msg);
          continue;
        }
        case "authExpired":
          g.expired = true;
          all(msg);
          continue;
        default:
          all(msg);
      }
    }
    for (const [m, routed] of per) {
      const list = this.lapsed(m) ? this.withhold(m, g, routed) : routed;
      if (!list.length) continue;
      if (array) this.sendTo(m, JSON.stringify(list));
      else for (const x of list) this.sendTo(m, JSON.stringify(x));
    }
    if (g.ready) for (const m of [...g.members]) if (m.waiting && m.group === g) this.greet(m, g);
  }

  /**
   * What reaches a member whose own token has expired, as the shard does for an expired socket: nothing computed for
   * the identity. A subscription's value (snap, patch, err) becomes an `auth_expired` refusal and the subscription
   * leaves the shared socket (the client subscribes again after its `auth`), a `qres` becomes a refusal. `mres` (the
   * answer to its own mutation, sent while its token was valid), `authExpired` and qid-less errors still go.
   */
  private withhold(m: Member, g: Group, list: unknown[]): unknown[] {
    const error = { code: "auth_expired", message: 'the token expired; send {t:"auth"} with a fresh one' };
    const out: unknown[] = [];
    const refused: unknown[] = [];
    const unsubs: string[] = [];
    const refuseSub = (qid: unknown) => {
      if (typeof qid !== "string" && typeof qid !== "number") return;
      const shared = prefix(m.vid, qid);
      if (m.subs.delete(shared)) unsubs.push(shared);
      refused.push({ t: "err", ...error, qid });
    };
    for (const msg of list) {
      if (!isObj(msg)) continue;
      switch (msg.t) {
        case "snap":
          refuseSub(msg.qid);
          continue;
        case "err":
          if (msg.qid === undefined) out.push(msg);
          else refuseSub(msg.qid);
          continue;
        case "patch":
          for (const c of Array.isArray(msg.changes) ? msg.changes : []) if (isObj(c)) refuseSub(c.qid);
          continue;
        case "qres":
          refused.push({ t: "qres", qid: msg.qid, ok: false, error });
          continue;
        case "authExpired":
          m.expiredTold = true;
          out.push(msg);
          continue;
        default:
          out.push(msg);
      }
    }
    if (refused.length) this.tellExpired(m, out);
    this.unsubShared(g, unsubs);
    return [...out, ...refused];
  }

  /** The member a prefixed qid belongs to, and the qid it sent. */
  private route(g: Group, qid: unknown): { m: Member; qid: string | number } | null {
    if (typeof qid !== "string") return null;
    const at = qid.search(/[~#]/);
    if (at < 0) return null;
    const m = g.byVid.get(qid.slice(0, at));
    if (!m) return null;
    const rest = qid.slice(at + 1);
    return { m, qid: qid[at] === "#" ? Number(rest) : rest };
  }
}

/** A member's qid on the shared socket: `<vid>~<qid>` (`<vid>#<n>` for a numeric one). */
function prefix(vid: string, qid: unknown): string {
  return typeof qid === "number" ? `${vid}#${qid}` : `${vid}~${String(qid)}`;
}
