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
// Shared subscriptions. Tabs of one group that subscribe to the same query (`fn` and args, the group fixing shard and
// identity) share one subscription on the shard, under a qid of the leader's (`*<n>`): ref-counted (the last tab to
// leave sends the `unsub`), its patches routed to every tab subscribed, each under its own qid. The leader keeps the
// last value the shard confirmed (diffs applied as the clients apply them) with its version and identity tag: a tab
// that subscribes to a query already live gets its `snap` at once, from that value, or `unchanged` when its `resume`
// starts at or after the version the value has held since. When the leader does not hold the value (the shard
// answered `unchanged` to the first tab's `resume`, a diff it could not apply) and the tab's resume does not fit, the
// tab's subscription goes to the shard on its own, as without sharing.
//
// The leader's own tab talks to it in-process (a microtask), not over the BroadcastChannel loopback.
//
// Qids are rewritten per virtual socket (`<vid>~<qid>`) on the shared socket and routed back, so nothing sent for a
// socket that is gone reaches the next one of the same tab. Attempts of one mid go to the shard one at a time (the shard
// does not answer them in the order they came: a `sensitive` one awaits its session check, a refusal is immediate, a
// success comes after the commit), so each `mres` is the answer to the one attempt out: it goes to that attempt's
// sender, `patch.mids` too. A later attempt (a resend from the tab's next socket) waits at the leader until then, and
// goes out next; when the sender of the attempt out has left, a success (the outcome the shard's dedup would replay)
// settles the waiting attempt without a resend, and anything else sends it (a refusal is that attempt's alone, never a
// later one's). Server frames without a qid or mid (`authExpired`, qid-less `err`) go to
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

import type { WebSocketConstructor, WebSocketLike } from "./client.ts";
import { CHANNEL_KEEPALIVE_MS } from "./channels.ts";
import { jwtPayload } from "./jwt.ts";
import { MAX_BATCH_BYTES, MAX_BATCH_MESSAGES, PING, PONG } from "./protocol.ts";
import { FrameQueue } from "./zframe.ts";

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

/** A `patch` change carrying a diff (feature "rowdiff"/"vdiff"), as the wire has it. */
export type DiffChange = { diff?: unknown; vdiff?: unknown };

/** What the hub needs from its client. */
interface HubConfig extends MultiTabOptions {
  name: string;
  locks: LockManagerLike;
  BroadcastChannel: BroadcastChannelConstructor;
  WebSocket: WebSocketConstructor;
  heartbeat: { intervalMs: number; timeoutMs: number } | false;
  /** Applies a change's diff to the shared value the leader keeps (throws when it does not fit); none: diffs forget it. */
  applyDiff?: ((prev: unknown, change: DiffChange) => unknown) | undefined;
}

/** What a client gives the hub it builds (`MultiTabPlugin.create`). */
export interface MultiTabHost {
  /** Default name: the client's url. */
  name: string;
  WebSocket: WebSocketConstructor;
  heartbeat: { intervalMs: number; timeoutMs: number } | false;
  /**
   * The client's diff functions (`applyRowDiff` / `applyValueDiff`): the leader keeps shared values current with them.
   * Passed in so this module, loaded with `import()` for the older option, does not import the values package.
   */
  applyDiff?: (prev: unknown, change: DiffChange) => unknown;
}

/** Option `multiTab` of `EmberClient`, as `multiTab()` returns it. */
export interface MultiTabPlugin {
  readonly kind: "ember.multiTab";
  /** The hub of one client; null when the environment cannot coordinate tabs (the client then uses its WebSocket). */
  create(host: MultiTabHost): MultiTab | null;
}

/**
 * One WebSocket per shard for every tab of the origin: `new EmberClient({ url, multiTab: multiTab({ ... }) })`.
 * Imported from `@freecorps/ember-client/multitab`, so an app that does not share sockets does not ship the hub.
 */
export function multiTab(options: MultiTabOptions = {}): MultiTabPlugin {
  return {
    kind: "ember.multiTab",
    create: (host) => createMultiTab({ ...options, name: options.name ?? host.name, WebSocket: host.WebSocket, heartbeat: host.heartbeat, applyDiff: host.applyDiff }),
  };
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
  let key = identityKeys.get(token);
  if (key !== undefined) return key;
  const payload = jwtPayload(token);
  // Written out key by key, never assigned onto an object: a claim named `__proto__` stays a claim (an assignment onto
  // `{}` would hit the prototype setter and lose it, and two identities would share a key).
  key = payload ? `j:{${Object.keys(payload).filter((k) => !RENEWAL_CLAIMS.has(k)).sort().map((k) => `${JSON.stringify(k)}:${canonical(payload[k])}`).join(",")}}` : `o:${token}`;
  if (identityKeys.size >= 16) identityKeys.delete(identityKeys.keys().next().value!);
  identityKeys.set(token, key);
  return key;
}
/** `socketIdentityKey` of the last tokens (hellos and every `auth` frame of every tab ask it again). */
const identityKeys = new Map<string, string>();

/**
 * Deterministic JSON of a parsed JSON value (object keys sorted). Local, not `stableStringify` (wire.ts): this module
 * is loaded with `import()` for the older option, and importing the values package from it would make a bundler
 * without code splitting wrap that whole package for lazy init.
 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function jwtExpOf(token: string | null): number | null {
  if (!token) return null;
  const exp = jwtPayload(token)?.exp;
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
export function createMultiTab(options: MultiTabOptions & { name: string; WebSocket: WebSocketConstructor; heartbeat: HubConfig["heartbeat"]; applyDiff?: HubConfig["applyDiff"] }): MultiTab | null {
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
    // Held for the life of this tab; granted after `close()` (client built and closed in the same task), it frees at once.
    void config.locks
      .request(`${this.base}:tab:${this.id}`, () => (this.roleValue === "closed" ? undefined : new Promise<void>((r) => (this.releaseTab = r))))
      .catch(() => undefined);
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

  /** @internal To the leader: in-process when it is this tab's (no BroadcastChannel loopback), else over the channel. */
  postToLeader(m: ToLeader): void {
    const leader = this.leader;
    if (!leader) return this.post(this.toLeader, m);
    if (this.roleValue === "closed" && m.k !== "close") return;
    // A later microtask, as a message would come (never inside the call that sent it), in post order.
    queueMicrotask(() => leader.receive(m));
  }

  /** @internal From this tab's own leader, in-process. */
  local(m: ToTab): void {
    if (this.roleValue === "closed") return;
    queueMicrotask(() => this.onInbox({ data: m }));
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
    if ("binaryType" in ws) (ws as { binaryType: string }).binaryType = "arraybuffer";
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
  /** Its subscriptions on the shared socket of its own (prefixed qids): unsubscribed when it goes. */
  subs: Set<string>;
  /** Its subscriptions to a shared query, by prefixed qid: it leaves them when it goes. */
  keyed: Map<string, Shared>;
  /** Channels it joined (feature "ephemeral"): it leaves them when it goes. */
  chans: Set<string>;
  /** Channels whose member list changed while its token had expired: a fresh `joined` once it renews. */
  stale: Set<string>;
}

/**
 * A channel the members of a group are in (feature "ephemeral"): the shared socket is one member of it on the shard,
 * joined once for every tab; the last tab out leaves it. `joined` is the shard's member list as the leader follows it.
 */
interface GroupChan {
  /** Tabs answered (`joined`): the shard's channel frames reach them. */
  in: Set<Member>;
  /** Tabs whose `join` went to the shard and wait for its `joined`. */
  waiting: Set<Member>;
  joined: { self: string; members: Map<string, Record<string, unknown>> } | null;
  /** The member state the shard holds (JSON, from its last `joined`; undefined: none): never one it has not accepted. */
  state: string | undefined;
}

/**
 * A tab's `join` or `pub` out on the shared socket, under the leader's `ref` (the shard answers each with that `ref`):
 * its answer goes to that tab, and a `pub` (`msg`, the frame the other tabs get) reaches them only once the shard
 * says it went out (`published`), never one it refused.
 */
interface ChanRef {
  m: Member;
  ch: string;
  c: GroupChan;
  msg?: Record<string, unknown>;
}

/** A `resume` as a tab's `sub` carries it. */
type Resume = { version?: unknown; epoch?: unknown; ik?: unknown };

/** A tab's subscription to a shared query: the qid it sent, its `resume`. */
interface Holder {
  m: Member;
  qid: string | number;
  resume: Resume | undefined;
}

/**
 * One query (fn and args) the members of a group share: one `sub` on the shard, under the leader's qid. Its value is
 * the last one the shard confirmed for it (null: not known here), with the version it is current as of, the version it
 * has held since (a `resume` from there on is `unchanged`; null: not known) and its identity tag.
 */
interface Shared {
  key: string;
  qid: string;
  fn: unknown;
  args: unknown;
  /** Answered by the shard: their patches reach them. */
  holders: Map<string, Holder>;
  /** Waiting for the shard's first answer; `first` is the one whose `sub` (and `resume`) went out. */
  waiting: Map<string, Holder>;
  first: string;
  /** The `resume` of the first `sub` (what an `unchanged` answer to it is about), kept if that member leaves. */
  firstResume: Resume | undefined;
  answered: boolean;
  value: { v: unknown } | null;
  version: number;
  since: number | null;
  ik: unknown;
  /** The shard's last `err` for it (it stays subscribed; a patch follows once it succeeds again): no new member is answered here. */
  error: Record<string, unknown> | null;
}

/**
 * The attempts of one mid. The shard answers each `mut` it gets with one `mres`, but not in the order they came (a
 * `sensitive` attempt awaits its session check while a later one may be refused or committed first), so only one is
 * out at a time: its `mres` is that attempt's answer. Later ones (a client resends a mid on its next socket, or on the
 * same one after an `auth_expired` refusal) wait here, oldest first, and go out once the one out is answered.
 */
interface MidSlot {
  /** Who sent the attempt out (null: that member left; its answer goes to no socket that is gone). */
  sender: Member | null;
  /** Attempts not sent yet: the frame, as the member sent it. */
  queue: { m: Member; msg: Record<string, unknown> }[];
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
  /** Mids with an attempt out on the shared socket (one at a time per mid: see {@link MidSlot}). */
  mids: Map<string, MidSlot>;
  /** Shared queries by `fn` + canonical args, and by their qid on the shard. */
  shared: Map<string, Shared>;
  sharedByQid: Map<string, Shared>;
  sharedSeq: number;
  /** Version of the last `patch` (or `ready`): every answered subscription of the socket is current as of it. */
  patchVersion: number;
  /** The shard said `authExpired` and no renewal went since. */
  expired: boolean;
  /** Channels its members are in (feature "ephemeral"), by name. */
  chans: Map<string, GroupChan>;
  /** When the leader last sent a frame on the shared socket: a channel member must send one every so often. */
  sentAt: number;
  /** `join`/`pub` of its tabs waiting for the shard's answer, by `ref`. */
  refs: Map<number, ChanRef>;
  nextRef: number;
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

  /** @internal A message of this tab's own virtual sockets (in-process). */
  receive(m: ToLeader): void {
    this.onInbox({ data: m });
  }

  private toTab(tab: string, m: ToTab): void {
    if (tab === this.hub.id) return this.hub.local(m);
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
    this.flush(g, qids.map((qid) => ({ t: "unsub", qid })), g.batch);
  }

  private readonly onInbox = (ev: { data: unknown }) => {
    if (this.stopped) return;
    const m = ev.data as ToLeader | null;
    if (!isObj(m) || m.e !== E || typeof m.from !== "string" || typeof m.vid !== "string") return;
    const id = `${m.from}\u0000${m.vid}`;
    const member = this.members.get(id);
    if (m.k === "open" && typeof m.url === "string") {
      if (!member) {
        this.members.set(id, { tab: m.from, vid: m.vid, url: m.url, token: null, exp: null, expiredTold: false, group: null, waiting: null, subs: new Set(), keyed: new Map(), chans: new Set(), stale: new Set() });
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
    // The attempt it has out stays out, sender emptied (its answer decides what the next attempt gets, see `answered`);
    // the ones it had waiting were never sent and go (its client resends what had no `mres`).
    for (const slot of g.mids.values()) {
      if (slot.sender === m) slot.sender = null;
      if (slot.queue.some((q) => q.m === m)) slot.queue = slot.queue.filter((q) => q.m !== m);
    }
    // Out of every shared query (the last one out unsubscribes it).
    const left: string[] = [];
    for (const mq of [...m.keyed.keys()]) this.leave(g, m, mq, left);
    // Out of its channels (the last tab out leaves it on the shard).
    const leaves = [...m.chans].filter((ch) => this.leaveChan(g, m, ch));
    m.chans.clear();
    if (g.closed) return;
    if (!g.members.size) return this.end(g, 1000, "no tabs left");
    if (unsub) this.unsubShared(g, [...m.subs, ...left]);
    if (unsub && g.ready && leaves.length) this.flush(g, leaves.map((ch) => ({ t: "leave", ch })), g.batch);
    m.subs.clear();
  }

  /** `m` out of a channel of its group: true when it was the last tab in it (the shard should hear `leave`). */
  private leaveChan(g: Group, m: Member, ch: string): boolean {
    const c = g.chans.get(ch);
    if (!c) return false;
    c.in.delete(m);
    c.waiting.delete(m);
    if (c.in.size || c.waiting.size) return false;
    g.chans.delete(ch);
    return true;
  }

  /** The leader's own `joined` for a tab joining a channel the shared socket is already in. */
  private joinedOf(ch: string, c: GroupChan): string {
    return JSON.stringify({ t: "joined", ch, self: c.joined!.self, members: [...c.joined!.members.values()] });
  }

  /**
   * `m` leaves the shared query its `mq` (prefixed qid) is subscribed to: false when it is not one. The last subscriber
   * out ends it: its qid is pushed to `unsubs` (the caller sends the `unsub`).
   */
  private leave(g: Group, m: Member, mq: string, unsubs: string[]): boolean {
    const s = m.keyed.get(mq);
    if (!s) return false;
    m.keyed.delete(mq);
    s.holders.delete(mq);
    s.waiting.delete(mq);
    if (!s.holders.size && !s.waiting.size) {
      this.forget(g, s);
      unsubs.push(s.qid);
    }
    return true;
  }

  /** A shared query is gone (unsubscribed, or dropped by the shard): nobody holds it any more. */
  private forget(g: Group, s: Shared): void {
    if (g.shared.get(s.key) === s) g.shared.delete(s.key);
    if (g.sharedByQid.get(s.qid) === s) g.sharedByQid.delete(s.qid);
    for (const [mq, h] of [...s.holders, ...s.waiting]) if (h.m.keyed.get(mq) === s) h.m.keyed.delete(mq);
    s.holders.clear();
    s.waiting.clear();
  }

  /**
   * A member's `sub` of a query: shared with the other members of the group subscribed to it. The first one goes to the
   * shard (under the leader's qid, with its `resume`); one that comes while that answer is on its way waits for it; one
   * that comes after is answered here (`answerFrom`). False: it goes to the shard on its own (the leader cannot answer
   * it: see `answerFrom`).
   */
  private share(g: Group, m: Member, msg: Record<string, unknown>, out: unknown[], back: unknown[]): boolean {
    const qid = msg.qid as string | number;
    const mq = prefix(m.vid, qid);
    const resume = isObj(msg.resume) ? (msg.resume as Resume) : undefined;
    const key = `${String(msg.fn)}\u0000${canonical(msg.args ?? {})}`;
    const s = g.shared.get(key);
    const holder: Holder = { m, qid, resume };
    if (!s) {
      // `*<lid>.<n>`: never a member's (`<vid>~…`), never another leader's (the shard keys a few rows by clientId and qid).
      const created: Shared = { key, qid: `*${this.lid}.${(++g.sharedSeq).toString(36)}`, fn: msg.fn, args: msg.args, holders: new Map(), waiting: new Map([[mq, holder]]), first: mq, firstResume: resume, answered: false, value: null, version: 0, since: null, ik: undefined, error: null };
      g.shared.set(key, created);
      g.sharedByQid.set(created.qid, created);
      m.keyed.set(mq, created);
      out.push({ ...msg, qid: created.qid });
      return true;
    }
    if (!s.answered) {
      s.waiting.set(mq, holder);
      m.keyed.set(mq, s);
      return true;
    }
    const answer = this.answerFrom(g, s, qid, resume);
    if (!answer) return false;
    s.holders.set(mq, holder);
    m.keyed.set(mq, s);
    back.push(...answer);
    return true;
  }

  /**
   * The answer to a `sub` of a shared query the shard already answered, as the shard would give it: `unchanged` when
   * its `resume` is of this epoch and identity tag and starts at or after the version the value has held since, else
   * the value. Null when the leader cannot tell: it does not hold the value and the resume does not fit, or the query
   * fails now (the `sub` then goes to the shard on its own: the shard runs a failing query again for a new `sub`, so a
   * failure that cleared is not kept, and a value retained from before the failure is never confirmed as current).
   * Null too while the shared socket's token has expired (`authExpired`): the shard would refuse that `sub`, and the
   * leader never hands out a value it holds until a fresh token is in (the `sub` goes to the shard, which refuses it).
   */
  private answerFrom(g: Group, s: Shared, qid: string | number, resume: Resume | undefined): unknown[] | null {
    if (s.error || g.expired) return null;
    const version = Math.max(s.version, g.patchVersion);
    const fits =
      !!resume && g.ident && s.since !== null && resume.epoch === g.ready?.epoch && resume.ik !== undefined && resume.ik === s.ik && typeof resume.version === "number" && resume.version >= s.since && resume.version <= version;
    if (fits) return [{ t: "snap", qid, version, unchanged: true }];
    if (s.value) return [{ t: "snap", qid, version, ...(s.value.v === undefined ? {} : { value: s.value.v }), ...(s.ik !== undefined ? { ik: s.ik } : {}) }];
    return null;
  }

  /** A change of a shared query's value (`patch`): the leader's copy follows it, as each client's does. */
  private follow(s: Shared, c: Record<string, unknown>, version: number): void {
    s.version = version;
    s.since = version;
    s.error = null;
    if (c.diff !== undefined || c.vdiff !== undefined) {
      const apply = this.hub.config.applyDiff;
      if (!s.value || !apply) {
        s.value = null;
        return;
      }
      try {
        s.value = { v: apply(s.value.v, c as DiffChange) };
      } catch {
        s.value = null; // not the shard's base: the tabs resynchronize themselves; a new tab's `sub` goes on its own
      }
      return;
    }
    s.value = { v: c.value };
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
      shared: new Map(),
      sharedByQid: new Map(),
      sharedSeq: 0,
      patchVersion: 0,
      expired: false,
      chans: new Map(),
      sentAt: Date.now(),
      refs: new Map(),
      nextRef: 0,
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
    // Feature "zframe" (the members' hello asked for it): the leader decodes compressed frames, in order, and routes
    // their text (tabs get text over the channel).
    if ("binaryType" in ws) (ws as { binaryType: string }).binaryType = "arraybuffer";
    const inbox = new FrameQueue(
      (text) => {
        if (!g.closed) this.onReal(g, text);
      },
      () => this.end(g, CLOSE_PROTOCOL, "bad compressed frame"),
    );
    ws.onopen = () => {
      if (g.closed) return;
      this.real(g, JSON.stringify(hello));
      this.armBeat(g);
    };
    ws.onmessage = (ev) => {
      if (g.closed) return;
      g.heardAt = Date.now();
      g.pingAt = undefined;
      inbox.push(ev.data);
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
    // Nothing out survives the socket: every client resends what had no `mres` on its next one.
    g.mids.clear();
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
      g.sentAt = Date.now();
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
      // Feature "ephemeral": the shard closes a channel member whose socket sent nothing for a while. Frames coming in
      // do not count for that, frames going out (any tab's) do: with channels, a ping once nothing went out for an
      // interval, even while frames keep coming in.
      const sinceSent = now - g.sentAt;
      const keep = g.chans.size > 0 ? Math.min(hb.intervalMs, CHANNEL_KEEPALIVE_MS) : Infinity;
      if (quiet >= hb.intervalMs || sinceSent >= keep) {
        g.pingAt = now;
        this.real(g, PING);
        g.timer = setTimeout(beat, hb.timeoutMs);
      } else g.timer = setTimeout(beat, Math.min(hb.intervalMs - quiet, keep - sinceSent));
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
          // Again on a qid it holds (an errored subscription re-run): out of what it held first.
          const left: string[] = [];
          if (this.leave(g, m, qid, left)) for (const q of left) out.push({ t: "unsub", qid: q });
          if (this.share(g, m, msg, out, back)) {
            // It had fallen back to its own subscription on the shard under this qid: that one ends now that the qid
            // is shared again (else the shard keeps delivering it next to the shared one).
            if (m.subs.delete(qid)) out.push({ t: "unsub", qid });
            continue;
          }
          m.subs.add(qid);
          out.push({ ...msg, qid });
          continue;
        }
        case "unsub": {
          const qid = prefix(m.vid, msg.qid);
          const left: string[] = [];
          if (this.leave(g, m, qid, left)) {
            for (const q of left) out.push({ t: "unsub", qid: q });
            // A solo subscription still held under this qid (from a fallback) ends with it.
            if (m.subs.delete(qid)) out.push({ t: "unsub", qid });
            continue;
          }
          m.subs.delete(qid);
          out.push({ ...msg, qid });
          continue;
        }
        case "q":
          out.push({ ...msg, qid: prefix(m.vid, msg.qid) });
          continue;
        case "join":
        case "leave":
        case "pub": {
          if (typeof msg.ch !== "string") {
            out.push(msg);
            continue;
          }
          this.chanFrame(m, g, msg, msg.ch, out, back);
          continue;
        }
        case "mut": {
          // One attempt of a mid out at a time: a later one waits for the answer to the one out (see MidSlot).
          const key = String(msg.mid);
          const slot = g.mids.get(key);
          if (slot) slot.queue.push({ m, msg });
          else {
            g.mids.set(key, { sender: m, queue: [] });
            out.push(msg);
          }
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
          // Member lists it missed while expired: the current one of each (the shard sends none when the shared socket
          // stays valid, and its client sees the channel joined and sends no `join`).
          for (const ch of m.stale) {
            const c = g.chans.get(ch);
            if (c?.joined && c.in.has(m)) back.push(JSON.parse(this.joinedOf(ch, c)));
          }
          m.stale.clear();
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

  /**
   * A tab's channel frame (feature "ephemeral"). The shared socket is one member of the channel for every tab of the
   * group: a `join` goes to the shard (a tab joining a channel the socket is in with that state already is answered
   * here), a `leave` only when the last tab leaves. A `join` or `pub` goes out under a `ref` of the leader, so its
   * answer goes to the tab that sent it; a `pub` reaches the other tabs of the group (the shard never echoes a message
   * to the socket that sent it) only once the shard answers `published`: what it refuses reaches no tab.
   */
  private chanFrame(m: Member, g: Group, msg: Record<string, unknown>, ch: string, out: unknown[], back: unknown[]): void {
    if (msg.t !== "leave" && this.lapsed(m)) {
      // As the shard with an expired socket: refused, and nothing reaches it until its `auth`.
      const error = { code: "auth_expired", message: 'the token expired; send {t:"auth"} with a fresh one' };
      back.push({ t: "authExpired" });
      back.push(msg.t === "join" ? { t: "left", ch, ...error } : { t: "err", ...error, ch });
      return;
    }
    if (msg.t === "join") {
      let c = g.chans.get(ch);
      if (!c) g.chans.set(ch, (c = { in: new Set(), waiting: new Set(), joined: null, state: undefined }));
      m.chans.add(ch);
      const state = "state" in msg ? JSON.stringify(msg.state) : undefined;
      if (c.joined && (state === undefined || state === c.state)) {
        c.waiting.delete(m);
        c.in.add(m);
        back.push(JSON.parse(this.joinedOf(ch, c)));
        return;
      }
      // A tab already in stays in (its messages keep coming) while its state update waits for the shard.
      if (!c.in.has(m)) c.waiting.add(m);
      out.push({ ...msg, ref: this.chanRef(g, { m, ch, c }) });
      return;
    }
    if (msg.t === "leave") {
      if (!m.chans.delete(ch)) return;
      if (this.leaveChan(g, m, ch)) out.push(msg);
      return;
    }
    const c = g.chans.get(ch);
    if (!c?.joined || !c.in.has(m)) {
      // Not in (yet): as the shard would answer, without asking it.
      back.push({ t: "err", code: "not_joined", message: `join ${ch} before publishing to it`, ch });
      return;
    }
    const user = c.joined.members.get(c.joined.self)?.user ?? null;
    const relay = { t: "msg", ch, from: c.joined.self, user, data: msg.data };
    out.push({ ...msg, ref: this.chanRef(g, { m, ch, c, msg: relay }) });
  }

  private chanRef(g: Group, r: ChanRef): number {
    const ref = g.nextRef++;
    g.refs.set(ref, r);
    return ref;
  }

  /**
   * The shard's channel frame: to the tabs in that channel (`joined` and `left` also to those waiting for it); the
   * answer to a frame of one tab (its `ref`) to that tab.
   */
  private chanReal(g: Group, msg: Record<string, unknown>, to: (m: Member, msg: unknown) => void): void {
    const ch = msg.ch;
    let r: ChanRef | undefined;
    if (typeof msg.ref === "number") {
      r = g.refs.get(msg.ref);
      g.refs.delete(msg.ref);
      const { ref: _ref, ...rest } = msg;
      msg = rest;
    }
    const c = typeof ch === "string" ? g.chans.get(ch) : undefined;
    if (!c || typeof ch !== "string") return;
    // The answer to a frame sent before the channel was left (and joined again since): about a membership gone.
    if (r && r.c !== c) return;
    switch (msg.t) {
      case "published": {
        if (!r?.msg) return;
        for (const m of c.in) if (m !== r.m) to(m, r.msg);
        return;
      }
      case "joined": {
        const members = new Map<string, Record<string, unknown>>();
        for (const x of Array.isArray(msg.members) ? msg.members : []) if (isObj(x) && typeof x.id === "string") members.set(x.id, x);
        c.joined = { self: String(msg.self), members };
        const self = members.get(c.joined.self);
        c.state = self && "state" in self ? JSON.stringify(self.state) : undefined;
        for (const m of [...c.in, ...c.waiting]) to(m, msg);
        for (const m of c.waiting) c.in.add(m);
        c.waiting.clear();
        return;
      }
      case "members": {
        if (c.joined) {
          for (const id of Array.isArray(msg.leave) ? msg.leave : []) c.joined.members.delete(String(id));
          for (const x of Array.isArray(msg.join) ? msg.join : []) if (isObj(x) && typeof x.id === "string") c.joined.members.set(x.id, x);
        }
        for (const m of c.in) to(m, msg);
        return;
      }
      case "msg":
        for (const m of c.in) to(m, msg);
        return;
      case "left":
        if (r && !c.joined) {
          // The shared socket is not in: only this tab's join was refused (the others waiting get their own answer).
          c.waiting.delete(r.m);
          r.m.chans.delete(ch);
          if (!c.in.size && !c.waiting.size) g.chans.delete(ch);
          to(r.m, msg);
          return;
        }
        // Not (or no longer) a member on the shard: every tab in it is out.
        g.chans.delete(ch);
        for (const m of [...c.in, ...c.waiting]) {
          m.chans.delete(ch);
          to(m, msg);
        }
        return;
      default:
        if (r) {
          // This tab's own refusal (a `pub`, or a state update: the shared socket stays in, with the state it had).
          if (!r.m.chans.has(ch)) return;
          to(r.m, msg);
          if (!r.msg && c.joined && c.waiting.delete(r.m)) {
            c.in.add(r.m);
            to(r.m, JSON.parse(this.joinedOf(ch, c)));
          }
          return;
        }
        // An `err` about the channel: its tabs.
        for (const m of [...c.in, ...c.waiting]) to(m, msg);
    }
  }

  private answer(m: Member, back: unknown[], array: boolean): void {
    if (!back.length) return;
    if (array) this.sendTo(m, JSON.stringify(back));
    else for (const x of back) this.sendTo(m, JSON.stringify(x));
  }

  /**
   * Messages to the shard. Feature "batch": as array frames of at most `MAX_BATCH_MESSAGES` and `MAX_BATCH_BYTES` each
   * (the shard refuses a larger batch whole; split, they are still handled in order). Many fallback `sub`s of one
   * shard frame (`snapShared`), the unsubs of a tab that leaves, or a member's full frame with its qids prefixed can
   * go past them.
   */
  private flush(g: Group, out: unknown[], array: boolean): void {
    if (!out.length) return;
    if (!array) {
      for (const x of out) this.real(g, JSON.stringify(x));
      return;
    }
    let chunk: string[] = [];
    let bytes = 2;
    for (const x of out) {
      const f = JSON.stringify(x);
      if (chunk.length && (chunk.length >= MAX_BATCH_MESSAGES || bytes + f.length + 1 > MAX_BATCH_BYTES)) {
        this.real(g, `[${chunk.join(",")}]`);
        chunk = [];
        bytes = 2;
      }
      chunk.push(f);
      bytes += f.length + 1;
    }
    this.real(g, `[${chunk.join(",")}]`);
  }

  /** A frame from the shard: each message to the member it belongs to (by qid prefix, or mid), the rest to all. */
  private onReal(g: Group, data: string): void {
    if (data === PONG) return;
    const parsed = safeParse(data);
    if (parsed === undefined) return;
    const array = Array.isArray(parsed);
    const per = new Map<Member, unknown[]>();
    /** Subscriptions of shared queries the leader could not answer: they go to the shard on their own. */
    const solos: unknown[] = [];
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
          if (typeof msg.version === "number") g.patchVersion = msg.version;
          // Routed below, then the members waiting for it get theirs.
          continue;
        }
        case "snap": {
          const s = typeof msg.qid === "string" ? g.sharedByQid.get(msg.qid) : undefined;
          if (s) {
            this.snapShared(g, s, msg, to, solos);
            continue;
          }
          const r = this.route(g, msg.qid);
          if (r) to(r.m, { ...msg, qid: r.qid });
          continue;
        }
        case "qres": {
          const r = this.route(g, msg.qid);
          if (r) to(r.m, { ...msg, qid: r.qid });
          continue;
        }
        case "joined":
        case "members":
        case "msg":
        case "left":
        case "published":
          this.chanReal(g, msg, to);
          continue;
        case "err": {
          if (msg.ch !== undefined) {
            this.chanReal(g, msg, to);
            continue;
          }
          if (msg.qid !== undefined) {
            const s = typeof msg.qid === "string" ? g.sharedByQid.get(msg.qid) : undefined;
            if (s) {
              this.errShared(g, s, msg, to);
              continue;
            }
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
          const version = typeof msg.version === "number" ? msg.version : g.patchVersion;
          if (version > g.patchVersion) g.patchVersion = version;
          for (const c of Array.isArray(msg.changes) ? msg.changes : []) {
            if (!isObj(c)) continue;
            const s = typeof c.qid === "string" ? g.sharedByQid.get(c.qid) : undefined;
            if (s) {
              this.follow(s, c, version);
              for (const h of s.holders.values()) {
                const list = changes.get(h.m);
                const routed = { ...c, qid: h.qid };
                if (list) list.push(routed);
                else changes.set(h.m, [routed]);
              }
              continue;
            }
            const r = this.route(g, c.qid);
            if (!r) continue;
            const list = changes.get(r.m);
            const routed = { ...c, qid: r.qid };
            if (list) list.push(routed);
            else changes.set(r.m, [routed]);
          }
          const mids = new Map<Member, unknown[]>();
          for (const mid of Array.isArray(msg.mids) ? msg.mids : []) {
            // Not consumed: the mid's `mres` follows (protocol), and goes to this same sender (none if it left).
            const m = g.mids.get(String(mid))?.sender;
            if (!m || m.group !== g) continue;
            const list = mids.get(m);
            if (list) list.push(mid);
            else mids.set(m, [mid]);
          }
          for (const m of new Set([...changes.keys(), ...mids.keys()])) to(m, { ...msg, changes: changes.get(m) ?? [], mids: mids.get(m) ?? [] });
          continue;
        }
        case "mres":
          this.answered(g, msg, to);
          continue;
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
    if (solos.length) this.flush(g, solos, g.batch);
    if (g.ready) for (const m of [...g.members]) if (m.waiting && m.group === g) this.greet(m, g);
  }

  /**
   * The answer to a mid's attempt out (the only one out: see MidSlot), to its sender, then the next waiting attempt goes
   * out. When that sender left, a success settles the next waiting attempt as it is (same mutation, identity and
   * clientId: the shard would answer its resend from the dedup with this same outcome); anything else is not handed
   * over (a refusal such as `auth_expired`, `unauthenticated` or `reauth_required` is that attempt's alone, and an
   * application error is told apart from those by its code only, which the app names): the next attempt goes out and
   * the shard answers it (from the dedup when the mutation ran).
   */
  private answered(g: Group, msg: Record<string, unknown>, to: (m: Member, msg: unknown) => void): void {
    const key = String(msg.mid);
    const slot = g.mids.get(key);
    if (!slot) return;
    const sender = slot.sender;
    slot.sender = null;
    if (sender) to(sender, msg);
    let settle = !sender && msg.ok === true;
    for (;;) {
      const next = slot.queue.shift();
      if (!next) {
        g.mids.delete(key);
        return;
      }
      if (next.m.group !== g) continue;
      if (settle) {
        settle = false;
        to(next.m, msg);
        continue;
      }
      if (this.lapsed(next.m)) {
        // As `handle` for a member whose own token expired meanwhile: refused before it reaches the shard.
        to(next.m, { t: "authExpired" });
        to(next.m, { t: "mres", mid: next.msg.mid, ok: false, error: { code: "auth_expired", message: 'the token expired; send {t:"auth"} with a fresh one' } });
        continue;
      }
      slot.sender = next.m;
      this.real(g, JSON.stringify(next.msg));
      return;
    }
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
      if (!this.leave(g, m, shared, unsubs) && m.subs.delete(shared)) unsubs.push(shared);
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
        case "joined":
        case "members":
          // A channel's frames are for the identity too: nothing reaches it until its `auth`, which brings the member
          // list it missed.
          if (typeof msg.ch === "string") m.stale.add(msg.ch);
          this.tellExpired(m, out);
          continue;
        case "msg":
          this.tellExpired(m, out);
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

  /**
   * The shard's `snap` of a shared query. Its first answer goes as it is to the member whose `sub` went out, and answers
   * the members that waited for it (`answerFrom`; one it cannot answer goes to the shard on its own, into `solos`).
   * A later one (the socket's subscriptions re-evaluated after its expired token was renewed) goes to every holder.
   */
  private snapShared(g: Group, s: Shared, msg: Record<string, unknown>, to: (m: Member, msg: unknown) => void, solos: unknown[]): void {
    const version = typeof msg.version === "number" ? msg.version : g.patchVersion;
    const firstResume = s.firstResume;
    s.version = version;
    s.error = null;
    if (msg.unchanged === true) {
      // The value the first member offered is current: the leader does not have it, only how long it has held.
      if (!s.answered) {
        s.value = null;
        s.since = typeof firstResume?.version === "number" ? firstResume.version : null;
        s.ik = firstResume?.ik;
      }
    } else {
      s.value = { v: msg.value };
      s.since = version;
      s.ik = msg.ik;
    }
    if (s.answered) {
      for (const h of s.holders.values()) to(h.m, { ...msg, qid: h.qid });
      return;
    }
    s.answered = true;
    const waiting = [...s.waiting];
    s.waiting.clear();
    for (const [mq, h] of waiting) {
      if (h.m.group !== g) continue;
      const answer = mq === s.first ? [{ ...msg, qid: h.qid }] : this.answerFrom(g, s, h.qid, h.resume);
      if (answer) {
        s.holders.set(mq, h);
        for (const x of answer) to(h.m, x);
        continue;
      }
      // Its own subscription on the shard, as without sharing (with its own `resume`).
      h.m.keyed.delete(mq);
      h.m.subs.add(mq);
      solos.push({ t: "sub", qid: mq, fn: s.fn, args: s.args, ...(h.resume ? { resume: h.resume } : {}) });
    }
    if (!s.holders.size) {
      this.forget(g, s);
      solos.push({ t: "unsub", qid: s.qid });
    }
  }

  /**
   * The shard's `err` for a shared query, to everyone subscribed to it. `auth_expired` means the shard dropped it (each
   * client subscribes again after its `auth`); any other error leaves it subscribed, and a new member's `sub` goes to
   * the shard on its own until it succeeds again (`answerFrom`).
   */
  private errShared(g: Group, s: Shared, msg: Record<string, unknown>, to: (m: Member, msg: unknown) => void): void {
    const all = [...s.holders.values(), ...s.waiting.values()];
    for (const h of all) to(h.m, { ...msg, qid: h.qid });
    if (msg.code === "auth_expired") return this.forget(g, s);
    const { qid: _qid, ...error } = msg;
    s.error = error;
    if (!s.answered) {
      // The first answer is a failure: the ones that waited for it are told it, and hold the query from now on.
      s.answered = true;
      s.version = g.patchVersion;
      for (const [mq, h] of s.waiting) s.holders.set(mq, h);
      s.waiting.clear();
    }
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
