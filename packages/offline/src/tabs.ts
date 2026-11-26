// Several tabs, one offline storage name. Exactly one tab — the leader — opens the storage and writes it (replicated
// rows, results, the pending queue); the others are followers that send every call to it. Leadership is a Web Lock;
// calls and results travel on a BroadcastChannel with the protocol of remote.ts.
//
//   lock  "ember-offline:<name>"            held by the leader for as long as it lives (or until close()).
//   lock  "ember-offline:<name>:tab:<id>"   held by each tab for its life; the leader waits on it to learn that a
//                                           follower is gone (and drops its watches).
//   channel "ember-offline:<name>"          follower → leader: { k: "req", to: "leader", ... }; answers and watched
//                                           results come back addressed to the follower's id.
//
// Start: a tab asks for the leader lock with `ifAvailable`. Granted → it opens the storage, serves the channel and
// announces itself (`k: "leader"`). Not granted → it is a follower and queues for the lock. When the leader goes
// away (tab closed, crashed, `close()`), the browser hands the lock to the next tab in the queue, which opens the
// storage (retrying while the old owner releases it, e.g. OPFS access handles) and announces itself; followers
// resend every call still in flight and re-establish their watches. A follower that becomes the leader re-runs its
// own in-flight calls locally. All calls are idempotent, so a call the old leader ran before dying is harmless.
//
// A tab that gets the lock but cannot open the storage (`openAttempts` tries) closes whatever it half-opened and
// gives the lock up as `failed`: its calls in flight and new ones fail at once (there may be no other tab to wait
// for), its watches get the error once. The next tab in the queue tries in turn; when one announces itself, the
// failed tab follows it like any follower (calls and watches go there) and queues for the lock again. Every tab that
// is neither leading nor failed is queued, so a call in flight always ends up answered or failed, never stuck.
//
// Local results stay live across tabs: the leader's store re-runs watched queries on every write, whoever sent it,
// and streams them to the watching tab. Without Web Locks (very old browsers) each tab opens the storage alone —
// the previous behaviour.
//
// A page frozen (`freeze`) or put in the back/forward cache (`pagehide` with `persisted`) leaves the lead as the
// client's multiTab does: its storage is flushed and closed (OPFS access handles released) and the leader lock goes
// to the next tab, so a page that may never run again holds neither; a follower drops out of the lock queue. Back
// (`resume`, `pageshow`) it asks for the lead again, and follows whoever leads; its calls and watches go there.
//
// Saved notices (`onSaved`, remote.ts): what the shared storage made durable, whoever wrote it — from the store
// while this tab leads, from the leader's `saved` broadcasts while it follows. Serving a coordinator onwards (the
// OPFS Worker serves the page) passes them on, so the page does not hand over a value another tab already stored.

import type { SavedNotice } from "./backend.ts";
import type { LocalIdentity, LocalQueryRequest, LocalQueryResult, PendingStorage, QueryUpdate, StorageAdapter, SyncSpec } from "@freecorps/ember-client";
import { randomId, RemoteStorage, serveStorage, type Endpoint, type Served, type ServableStorage } from "./remote.ts";

/** The part of `navigator.locks` (Web Locks API) used here. */
export interface LockManagerLike {
  request(name: string, callback: (lock: unknown) => unknown): Promise<unknown>;
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

/**
 * `failed`: this tab got the lead but could not open the storage, and no other tab leads yet — its calls fail.
 * It follows (and queues behind) the next tab that announces itself as the leader.
 */
export type TabRole = "starting" | "leader" | "follower" | "failed" | "closed";

export interface TabsOptions {
  /** The storage name the tabs share (lock and channel names derive from it). */
  name: string;
  /** Opens the storage; called in the tab that becomes the leader (again in the next leader if it goes away). */
  open(): ServableStorage | Promise<ServableStorage>;
  /** Default `navigator.locks`; `null`: no coordination (this tab always leads). */
  locks?: LockManagerLike | null;
  /** Default `new BroadcastChannel("ember-offline:<name>")`. */
  channel?: Endpoint & { close(): void };
  /** Tries to open (and load) the storage before giving up the lead (default 10, with backoff up to 1 s). */
  openAttempts?: number;
  /**
   * Leave the lead (storage closed, lock released) while the page is frozen or in the back/forward cache, and ask
   * for it again when the page comes back. Default true where there is a `document`.
   */
  lifecycle?: boolean;
  onRoleChange?(role: TabRole): void;
}

type EventTargetLike = { addEventListener(type: string, fn: (e: unknown) => void): void; removeEventListener(type: string, fn: (e: unknown) => void): void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A StorageAdapter that runs on the leader tab's storage, whichever tab that is. */
export class TabCoordinator implements StorageAdapter {
  readonly id = randomId();
  private roleValue: TabRole = "starting";
  private readonly remote: RemoteStorage;
  private readonly channel: Endpoint & { close(): void };
  private readonly locks: LockManagerLike | null;
  private readonly base: string;
  private store: ServableStorage | null = null;
  private served: Served | null = null;
  private releaseLeader: (() => void) | null = null;
  private releaseTab: (() => void) | null = null;
  private abort = new AbortController();
  /** Frozen or in the back/forward cache: not leading, not queued for the lead, until the page comes back. */
  private suspended = false;
  private stopLifecycle: (() => void) | undefined;
  /** A step-down in progress (flush, close the storage, release the lock): the next lead waits for it. */
  private steppingDown: Promise<void> | null = null;
  /** `lead()` runs: this tab holds the leader lock (opening the storage, or serving it) until it returns. */
  private leading = false;
  private readonly saved = new Set<(n: SavedNotice) => void>();
  private stopStoreSaved: (() => void) | null = null;
  /** The leader's `saved` broadcasts (followers: the storage is the leader's). */
  private readonly onChannel = (ev: { data: unknown }) => {
    const m = ev.data as { ember?: unknown; k?: unknown; p?: unknown; d?: unknown } | null;
    if (typeof m !== "object" || m === null || m.ember !== "offline/1" || m.k !== "saved") return;
    // While leading, the store's own notices are the source (a channel that echoes ours would repeat them).
    if (this.roleValue === "leader" || this.roleValue === "closed") return;
    this.emitSaved({ put: Array.isArray(m.p) ? (m.p as SavedNotice["put"]) : [], drop: Array.isArray(m.d) ? (m.d as string[]) : [] });
  };

  constructor(private readonly options: TabsOptions) {
    this.base = `ember-offline:${options.name}`;
    const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
    this.locks = options.locks === undefined ? (nav?.locks ?? null) : options.locks;
    this.channel = options.channel ?? (new BroadcastChannel(this.base) as unknown as Endpoint & { close(): void });
    this.remote = new RemoteStorage(this.channel, { id: this.id, to: "leader", onLeader: () => this.onLeader() });
    this.channel.addEventListener("message", this.onChannel);
    if (!this.locks) {
      void this.lead();
      return;
    }
    const locks = this.locks;
    void locks.request(`${this.base}:tab:${this.id}`, () => new Promise<void>((r) => (this.releaseTab = r)));
    this.tryLead();
    // Without Web Locks every tab leads alone: there is no lead to hand over.
    if (options.lifecycle !== false) this.stopLifecycle = this.watchLifecycle();
  }

  /** Lead if nobody does; else follow (and queue for the lead). */
  private tryLead(): void {
    if (this.closed || this.suspended || !this.locks) return;
    // No `signal` here: Web Locks refuse one together with `ifAvailable` (NotSupportedError).
    void this.locks
      .request(this.base, { ifAvailable: true }, (lock) => {
        if (lock) return this.lead();
        // Taken: maybe by this tab, whose `lead()` (from before a freeze and resume) is still opening the storage or
        // already serves it. Then it leads (or fails) as it is; following would report it as a follower.
        if (!this.leading) this.follow();
        return undefined;
      })
      .catch(() => this.follow());
  }

  /** Follower: queue for the leader lock (granted when the leader goes away). */
  private follow(): void {
    if (this.closed || this.suspended || !this.locks) return;
    this.setRole("follower");
    void this.locks.request(this.base, { signal: this.abort.signal }, () => this.lead()).catch(() => undefined);
  }

  /** `freeze` / `pagehide` (persisted) step down; `resume` / `pageshow` ask for the lead again. As multitab.ts. */
  private watchLifecycle(): (() => void) | undefined {
    const g = globalThis as { document?: EventTargetLike; addEventListener?: EventTargetLike["addEventListener"]; removeEventListener?: EventTargetLike["removeEventListener"] };
    const doc = g.document;
    if (!doc || typeof doc.addEventListener !== "function" || typeof g.addEventListener !== "function") return undefined;
    const away = () => {
      if (this.closed || this.suspended) return;
      this.suspended = true;
      // Out of the lock queue (a follower), or the lock given up once the storage is closed (the leader).
      this.abort.abort();
      void this.stepDown();
    };
    const back = () => {
      if (this.closed || !this.suspended) return;
      this.suspended = false;
      this.abort = new AbortController();
      // Calls that went out while nobody led (or whose answers the frozen page missed) go again to whoever leads. A tab
      // that failed to open keeps failing them at once (`setUnavailable`) until a leader announces itself.
      if (!this.store && this.roleValue !== "failed") this.remote.setLocal(null);
      void (this.steppingDown ?? Promise.resolve()).then(() => this.tryLead());
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

  /**
   * Leave the lead: stop serving, send this tab's own calls to the next leader, flush and close the storage (OPFS
   * handles go with it), then release the lock so the next tab in the queue opens it.
   */
  private stepDown(): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    this.store = null;
    this.stopStoreSaved?.();
    this.stopStoreSaved = null;
    this.served?.stop();
    this.served = null;
    // In place before any of the work starts: a `resume` (`back`) or `close()` that comes meanwhile waits for it.
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r));
    this.steppingDown = p;
    this.remote.setLocal(null);
    this.setRole("follower");
    void (async () => {
      try {
        await Promise.resolve()
          .then(() => store.flush?.())
          .catch(() => undefined);
        await Promise.resolve()
          .then(() => store.close?.())
          .catch(() => undefined);
        const release = this.releaseLeader;
        this.releaseLeader = null;
        release?.();
      } finally {
        if (this.steppingDown === p) this.steppingDown = null;
        done();
      }
    })();
    return p;
  }

  /** Another tab leads: a tab that failed to open follows it, and queues to try again when that one goes. */
  private onLeader(): void {
    if (this.roleValue === "failed") this.follow();
  }

  get role(): TabRole {
    return this.roleValue;
  }

  private setRole(r: TabRole) {
    if (this.roleValue === r || this.roleValue === "closed") return;
    this.roleValue = r;
    this.options.onRoleChange?.(r);
  }

  private get closed(): boolean {
    return this.roleValue === "closed";
  }

  /**
   * Runs while this tab holds the leader lock: open the storage, serve the other tabs, run our own calls locally,
   * until close(). If the storage does not open, return (releasing the lock) as `failed`.
   */
  private async lead(): Promise<void> {
    if (this.closed || this.suspended) return;
    this.leading = true;
    try {
      await this.leadHeld();
    } finally {
      this.leading = false;
    }
  }

  private async leadHeld(): Promise<void> {
    let store: ServableStorage | null = null;
    let error: unknown;
    const attempts = Math.max(1, this.options.openAttempts ?? 10);
    for (let attempt = 0; attempt < attempts && !this.closed && !this.suspended; attempt++) {
      try {
        store = await this.options.open();
        await store.load();
        break;
      } catch (e) {
        error = e;
        // Opened but not loaded: release it (e.g. OPFS access handles) before trying again or giving up.
        const opened = store;
        store = null;
        await Promise.resolve()
          .then(() => opened?.close?.())
          .catch(() => undefined);
        // The previous leader may still be releasing the storage (OPFS handles close with its worker).
        if (attempt + 1 < attempts) await sleep(Math.min(1000, 20 * 2 ** attempt));
      }
    }
    if (this.closed || this.suspended) {
      // close() (or a freeze) came during the takeover: what we opened meanwhile is closed here, and the lock goes.
      await Promise.resolve()
        .then(() => store?.close?.())
        .catch(() => undefined);
      return;
    }
    if (!store) {
      // Nobody gets a half-open storage. The lock goes to the next tab, which may do better; until a leader
      // announces itself our calls fail (none may ever come), then we follow it (onLeader).
      const e = error instanceof Error ? error : new Error(String(error));
      if (this.locks) this.remote.setUnavailable(e);
      // Without Web Locks every tab leads alone: there is nobody to follow.
      else this.remote.setLocal(failing(e));
      this.setRole("failed");
      return;
    }
    this.store = store;
    this.stopStoreSaved = store.onSaved?.((n) => this.emitSaved(n)) ?? null;
    this.served = serveStorage(store, this.channel, { address: "leader", onPeer: (p) => this.watchPeer(p) });
    this.remote.setLocal(store);
    this.served.announce(this.id);
    // The release is in place before anyone is told: an observer that closes the tab from `onRoleChange` frees it.
    const held = new Promise<void>((r) => (this.releaseLeader = r));
    this.setRole("leader");
    await held;
  }

  /** A follower's watches go when its tab does (its tab lock becomes free). */
  private watchPeer(peer: string): void {
    void this.locks?.request(`${this.base}:tab:${peer}`, () => this.served?.dropPeer(peer)).catch(() => undefined);
  }

  /**
   * Called with what the shared storage made durable (records written, records dropped), whichever tab wrote it:
   * the leader's store notices, here or broadcast to followers. `serveStorage` passes them on to its callers.
   */
  onSaved(listener: (n: SavedNotice) => void): () => void {
    this.saved.add(listener);
    return () => this.saved.delete(listener);
  }

  private emitSaved(n: SavedNotice): void {
    if (!n.put.length && !n.drop.length) return;
    for (const l of this.saved) {
      try {
        l(n);
      } catch {
        /* a listener's problem */
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- StorageAdapter

  get persistPending(): PendingStorage {
    return this.remote.persistPending;
  }
  get sync(): readonly SyncSpec[] {
    return this.remote.sync;
  }
  load() {
    return this.remote.load();
  }
  applyPatch(u: QueryUpdate) {
    return this.remote.applyPatch(u);
  }
  runQueryLocally(req: LocalQueryRequest) {
    return this.remote.runQueryLocally(req);
  }
  watchQueryLocally(req: LocalQueryRequest, onResult: (r: LocalQueryResult | undefined) => void, onError?: (e: Error) => void) {
    return this.remote.watchQueryLocally(req, onResult, onError);
  }
  setIdentity(identity: LocalIdentity | null) {
    return this.remote.setIdentity(identity);
  }
  flush() {
    return this.remote.flush();
  }
  clear() {
    return this.remote.clear();
  }

  /** Leave: a leader closes its storage and hands the lock to the next tab; a follower's watches are dropped. */
  async close(): Promise<void> {
    if (this.roleValue === "closed") return;
    if (this.store) await this.remote.flush().catch(() => undefined);
    this.roleValue = "closed";
    this.options.onRoleChange?.("closed");
    this.stopLifecycle?.();
    this.stopLifecycle = undefined;
    this.abort.abort();
    this.remote.close();
    this.channel.removeEventListener("message", this.onChannel);
    this.stopStoreSaved?.();
    this.stopStoreSaved = null;
    this.saved.clear();
    this.served?.stop();
    this.served = null;
    const store = this.store;
    this.store = null;
    await store?.close?.();
    // A step-down under way (a freeze) closes its storage first and then lets go of the lock itself: the lock never
    // goes while the storage is still open.
    await this.steppingDown;
    this.releaseLeader?.();
    this.releaseTab?.();
    this.channel.close();
  }
}

function failing(error: Error): ServableStorage {
  const fail = () => Promise.reject(error);
  return {
    load: fail,
    applyPatch: fail,
    runQueryLocally: fail,
    persistPending: { getClientId: fail, setClientId: fail, load: fail, put: fail, remove: fail },
  };
}

/**
 * Coordinates every tab that opens the storage `name`: one leader opens it (`open`), the others go through it.
 *
 *   storage: coordinateTabs({ name: "chat", open: () => indexedDbStorage({ name: "chat", schema, queries, sync }) })
 */
export function coordinateTabs(options: TabsOptions): TabCoordinator {
  return new TabCoordinator(options);
}
