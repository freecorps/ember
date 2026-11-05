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
// Local results stay live across tabs: the leader's store re-runs watched queries on every write, whoever sent it,
// and streams them to the watching tab. Without Web Locks (very old browsers) each tab opens the storage alone —
// the previous behaviour.

import type { LocalIdentity, LocalQueryRequest, LocalQueryResult, PendingStorage, QueryUpdate, StorageAdapter, SyncSpec } from "@freecorps/ember-client";
import { randomId, RemoteStorage, serveStorage, type Endpoint, type Served, type ServableStorage } from "./remote.ts";

/** The part of `navigator.locks` (Web Locks API) used here. */
export interface LockManagerLike {
  request(name: string, callback: (lock: unknown) => unknown): Promise<unknown>;
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

export type TabRole = "starting" | "leader" | "follower" | "closed";

export interface TabsOptions {
  /** The storage name the tabs share (lock and channel names derive from it). */
  name: string;
  /** Opens the storage; called in the tab that becomes the leader (again in the next leader if it goes away). */
  open(): ServableStorage | Promise<ServableStorage>;
  /** Default `navigator.locks`; `null`: no coordination (this tab always leads). */
  locks?: LockManagerLike | null;
  /** Default `new BroadcastChannel("ember-offline:<name>")`. */
  channel?: Endpoint & { close(): void };
  onRoleChange?(role: TabRole): void;
}

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
  private readonly abort = new AbortController();

  constructor(private readonly options: TabsOptions) {
    this.base = `ember-offline:${options.name}`;
    const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
    this.locks = options.locks === undefined ? (nav?.locks ?? null) : options.locks;
    this.channel = options.channel ?? (new BroadcastChannel(this.base) as unknown as Endpoint & { close(): void });
    this.remote = new RemoteStorage(this.channel, { id: this.id, to: "leader" });
    if (!this.locks) {
      void this.lead();
      return;
    }
    const locks = this.locks;
    void locks.request(`${this.base}:tab:${this.id}`, () => new Promise<void>((r) => (this.releaseTab = r)));
    void locks.request(this.base, { ifAvailable: true }, (lock) => {
      if (lock) return this.lead();
      this.setRole("follower");
      void locks.request(this.base, { signal: this.abort.signal }, () => this.lead()).catch(() => undefined);
      return undefined;
    });
  }

  get role(): TabRole {
    return this.roleValue;
  }

  private setRole(r: TabRole) {
    if (this.roleValue === r || this.roleValue === "closed") return;
    this.roleValue = r;
    this.options.onRoleChange?.(r);
  }

  /** Holds the leader lock until close(): open the storage, serve the other tabs, run our own calls locally. */
  private get closed(): boolean {
    return this.roleValue === "closed";
  }

  private async lead(): Promise<void> {
    if (this.closed) return;
    let store: ServableStorage | null = null;
    let error: unknown;
    for (let attempt = 0; attempt < 10 && !this.closed; attempt++) {
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
        await sleep(Math.min(1000, 20 * 2 ** attempt));
      }
    }
    if (this.closed) {
      await store?.close?.();
      return;
    }
    if (!store) {
      // Nobody gets a half-open storage: our calls fail; the lock goes to the next tab, which may do better.
      this.remote.setLocal(failing(error));
      return;
    }
    this.store = store;
    this.served = serveStorage(store, this.channel, { address: "leader", onPeer: (p) => this.watchPeer(p) });
    this.remote.setLocal(store);
    this.served.announce(this.id);
    this.setRole("leader");
    await new Promise<void>((r) => (this.releaseLeader = r));
  }

  /** A follower's watches go when its tab does (its tab lock becomes free). */
  private watchPeer(peer: string): void {
    void this.locks?.request(`${this.base}:tab:${peer}`, () => this.served?.dropPeer(peer)).catch(() => undefined);
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
    this.abort.abort();
    this.remote.close();
    this.served?.stop();
    this.served = null;
    const store = this.store;
    this.store = null;
    await store?.close?.();
    this.releaseLeader?.();
    this.releaseTab?.();
    this.channel.close();
  }
}

function failing(error: unknown): ServableStorage {
  const fail = () => Promise.reject(error instanceof Error ? error : new Error(String(error)));
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
