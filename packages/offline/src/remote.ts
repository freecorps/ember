// A `StorageAdapter` across a message boundary: the main thread ⇄ the Worker that owns an OPFS database
// (opfs.ts), and follower tabs ⇄ the leader tab (tabs.ts). One small request/response protocol over anything with
// `postMessage` + `message` events (Worker, worker global scope, MessagePort, BroadcastChannel); values cross by
// structured clone (bigint and Uint8Array included).
//
//   → { ember: "offline/1", k: "req", id, from, to, op, a }          a call (to: the serving address)
//   ← { ember: "offline/1", k: "res", id, to, ok, v | e }            its answer (to: the caller)
//   ← { ember: "offline/1", k: "watch", to, wid, r | e }             a watched local result (watchQueryLocally)
//   ← { ember: "offline/1", k: "leader", from }                      a new server took over: resend in-flight calls
//   → { ember: "offline/1", k: "bye", from }                         the caller is gone: drop its watches
//
// Operations: load (+ the server's `sync` specs), getClientId, setClientId, loadPending, putPending, removePending,
// applyPatch, runQueryLocally, setIdentity, flush, clear, close, watch / unwatch.
//
// Every operation is idempotent (results are keyed by query, the pending queue by `mid`, metadata by key), so a
// client resends whatever is still in flight when a new server announces itself.

import {
  getFunctionName,
  type LocalIdentity,
  type LocalQueryRequest,
  type LocalQueryResult,
  type PendingMutationRecord,
  type PendingStorage,
  type QueryUpdate,
  type StorageAdapter,
  type SyncSpec,
} from "@freecorps/ember-client";

/** Anything that carries messages both ways (Worker, `self` in a worker, MessagePort, BroadcastChannel). */
export interface Endpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
}

/** What can be served: a StorageAdapter, optionally with `watchQueryLocally` and `clear` (OfflineStore has both). */
export type ServableStorage = StorageAdapter & { clear?(): Promise<void> };

type Op =
  | "load"
  | "getClientId"
  | "setClientId"
  | "loadPending"
  | "putPending"
  | "removePending"
  | "applyPatch"
  | "runQueryLocally"
  | "setIdentity"
  | "flush"
  | "clear"
  | "close"
  | "watch"
  | "unwatch";

const TAG = "offline/1";
type ErrJson = { name: string; message: string; code?: string };
type Req = { ember: typeof TAG; k: "req"; id: number; from: string; to: string; op: Op; a: unknown[] };
type Res = { ember: typeof TAG; k: "res"; id: number; to: string; ok: boolean; v?: unknown; e?: ErrJson };
type WatchMsg = { ember: typeof TAG; k: "watch"; to: string; wid: number; r?: LocalQueryResult | null; e?: ErrJson };
type Leader = { ember: typeof TAG; k: "leader"; from: string };
type Bye = { ember: typeof TAG; k: "bye"; from: string };
type Msg = Req | Res | WatchMsg | Leader | Bye;

const isMsg = (x: unknown): x is Msg => typeof x === "object" && x !== null && (x as Msg).ember === TAG;
const toErr = (e: unknown): ErrJson => {
  const x = e as { name?: string; message?: string; code?: unknown };
  return { name: String(x?.name ?? "Error"), message: String(x?.message ?? e), ...(typeof x?.code === "string" ? { code: x.code } : {}) };
};
const fromErr = (e: ErrJson): Error => Object.assign(new Error(e.message), { name: e.name, ...(e.code ? { code: e.code } : {}) });

export const randomId = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** `sync` specs as plain data (function references are proxies: not cloneable). */
const plainSync = (s: readonly SyncSpec[] | undefined): SyncSpec[] =>
  (s ?? []).map((x) => ({ query: getFunctionName(x.query), ...(x.args ? { args: x.args } : {}), ...(x.shard !== undefined ? { shard: x.shard } : {}) }));

/** Calls `op` on an adapter (the serving side of the protocol, also used to re-run calls locally). */
export async function invoke(s: ServableStorage, op: Op, a: unknown[]): Promise<unknown> {
  switch (op) {
    case "load":
      return { ...((await s.load()) ?? {}), sync: plainSync(s.sync) };
    case "getClientId":
      return await s.persistPending.getClientId();
    case "setClientId":
      return void (await s.persistPending.setClientId(a[0] as string));
    case "loadPending":
      return await s.persistPending.load();
    case "putPending":
      return void (await s.persistPending.put(a[0] as PendingMutationRecord));
    case "removePending":
      return void (await s.persistPending.remove(a[0] as string));
    case "applyPatch":
      return void (await s.applyPatch(a[0] as QueryUpdate));
    case "runQueryLocally":
      return (await s.runQueryLocally(a[0] as LocalQueryRequest)) ?? null;
    case "setIdentity":
      return void (await s.setIdentity?.(a[0] as LocalIdentity | null));
    case "flush":
      return void (await s.flush?.());
    case "clear":
      return void (await s.clear?.());
    case "close":
      return void (await s.close?.());
    default:
      throw new Error(`offline storage: unknown operation ${op}`);
  }
}

export interface ServeOptions {
  /** The address requests must be sent to (default `"*"`: any). */
  address?: string;
  /** First message from a caller (tabs.ts watches its liveness). */
  onPeer?(peer: string): void;
}

export interface Served {
  /** Announce this server (callers resend what is in flight). */
  announce(from: string): void;
  /** Forget a caller's watches (it is gone). */
  dropPeer(peer: string): void;
  stop(): void;
}

/** Serves an adapter on an endpoint: answers calls addressed to it, streams watched results. */
export function serveStorage(storage: ServableStorage, endpoint: Endpoint, options: ServeOptions = {}): Served {
  const address = options.address ?? "*";
  const peers = new Set<string>();
  const watches = new Map<string, Map<number, () => void>>();
  const post = (m: Msg) => endpoint.postMessage(m);
  const watchesOf = (peer: string) => {
    let w = watches.get(peer);
    if (!w) watches.set(peer, (w = new Map()));
    return w;
  };
  const dropPeer = (peer: string) => {
    for (const off of watches.get(peer)?.values() ?? []) off();
    watches.delete(peer);
    peers.delete(peer);
  };
  const listener = (ev: { data: unknown }) => {
    const m = ev.data;
    if (!isMsg(m)) return;
    if (m.k === "bye") return dropPeer(m.from);
    if (m.k !== "req" || (address !== "*" && m.to !== address)) return;
    if (!peers.has(m.from)) {
      peers.add(m.from);
      options.onPeer?.(m.from);
    }
    if (m.op === "watch") {
      const [wid, req] = m.a as [number, LocalQueryRequest];
      const mine = watchesOf(m.from);
      mine.get(wid)?.();
      const send = (r: LocalQueryResult | undefined) => post({ ember: TAG, k: "watch", to: m.from, wid, r: r ?? null });
      const fail = (e: Error) => post({ ember: TAG, k: "watch", to: m.from, wid, e: toErr(e) });
      if (storage.watchQueryLocally) mine.set(wid, storage.watchQueryLocally(req, send, fail));
      else {
        // One-shot fallback for adapters without watches.
        Promise.resolve(storage.runQueryLocally(req)).then(send, fail);
        mine.set(wid, () => {});
      }
      return post({ ember: TAG, k: "res", id: m.id, to: m.from, ok: true });
    }
    if (m.op === "unwatch") {
      const mine = watchesOf(m.from);
      mine.get(m.a[0] as number)?.();
      mine.delete(m.a[0] as number);
      return post({ ember: TAG, k: "res", id: m.id, to: m.from, ok: true });
    }
    invoke(storage, m.op, m.a).then(
      (v) => post({ ember: TAG, k: "res", id: m.id, to: m.from, ok: true, v }),
      (e) => post({ ember: TAG, k: "res", id: m.id, to: m.from, ok: false, e: toErr(e) }),
    );
  };
  endpoint.addEventListener("message", listener);
  return {
    announce: (from) => post({ ember: TAG, k: "leader", from }),
    dropPeer,
    stop() {
      endpoint.removeEventListener("message", listener);
      for (const p of [...watches.keys()]) dropPeer(p);
    },
  };
}

type Call = { op: Op; a: unknown[]; resolve(v: unknown): void; reject(e: unknown): void };
type RemoteWatch = { req: LocalQueryRequest; onResult(r: LocalQueryResult | undefined): void; onError?(e: Error): void };

export interface RemoteStorageOptions {
  /** This caller's address (default: random). */
  id?: string;
  /** The server's address (default `"*"`). */
  to?: string;
  /** Instead of posting, run calls here (a tab that became the leader runs its own calls locally). */
  local?: ServableStorage | null;
}

/**
 * The client side: a StorageAdapter whose calls run on a remote `serveStorage`. Calls in flight are resent when a
 * new server announces itself (`k: "leader"`), and watches are re-established there.
 */
export class RemoteStorage implements StorageAdapter {
  readonly id: string;
  readonly persistPending: PendingStorage;
  private syncSpecs: SyncSpec[] = [];
  private seq = 0;
  private readonly inflight = new Map<number, Call>();
  private readonly watches = new Map<number, RemoteWatch>();
  /** Local unwatch functions while calls run locally. */
  private readonly localWatches = new Map<number, () => void>();
  private local: ServableStorage | null;
  private readonly to: string;
  private closed = false;
  private readonly listener = (ev: { data: unknown }) => this.onMessage(ev.data);

  constructor(
    private readonly endpoint: Endpoint,
    options: RemoteStorageOptions = {},
  ) {
    this.id = options.id ?? randomId();
    this.to = options.to ?? "*";
    this.local = options.local ?? null;
    endpoint.addEventListener("message", this.listener);
    this.persistPending = {
      getClientId: () => this.call("getClientId") as Promise<string | null>,
      setClientId: (id) => this.call("setClientId", id) as Promise<void>,
      load: () => this.call("loadPending") as Promise<PendingMutationRecord[]>,
      put: (r) => this.call("putPending", r) as Promise<void>,
      remove: (mid) => this.call("removePending", mid) as Promise<void>,
    };
  }

  /** Known after `load()` (the server's `sync` specs, as names). */
  get sync(): readonly SyncSpec[] {
    return this.syncSpecs;
  }

  async load(): Promise<{ identity?: LocalIdentity | null }> {
    const r = (await this.call("load")) as { identity?: LocalIdentity | null; sync?: SyncSpec[] };
    this.syncSpecs = r.sync ?? [];
    return { identity: r.identity ?? null };
  }
  applyPatch(u: QueryUpdate): Promise<void> {
    return this.call("applyPatch", u) as Promise<void>;
  }
  async runQueryLocally(req: LocalQueryRequest): Promise<LocalQueryResult | undefined> {
    return ((await this.call("runQueryLocally", req)) as LocalQueryResult | null) ?? undefined;
  }
  setIdentity(identity: LocalIdentity | null): Promise<void> {
    return this.call("setIdentity", identity) as Promise<void>;
  }
  flush(): Promise<void> {
    return this.call("flush") as Promise<void>;
  }
  clear(): Promise<void> {
    return this.call("clear") as Promise<void>;
  }

  watchQueryLocally(req: LocalQueryRequest, onResult: (r: LocalQueryResult | undefined) => void, onError?: (e: Error) => void): () => void {
    const wid = ++this.seq;
    this.watches.set(wid, { req, onResult, ...(onError ? { onError } : {}) });
    this.establish(wid);
    return () => {
      if (!this.watches.delete(wid)) return;
      const off = this.localWatches.get(wid);
      if (off) {
        this.localWatches.delete(wid);
        off();
      } else if (!this.closed) void this.call("unwatch", wid).catch(() => undefined);
    };
  }

  private establish(wid: number): void {
    const w = this.watches.get(wid);
    if (!w || this.closed) return;
    const local = this.local;
    if (local?.watchQueryLocally) {
      this.localWatches.set(wid, local.watchQueryLocally(w.req, w.onResult, w.onError));
      return;
    }
    if (local) {
      // One-shot fallback for adapters without watches, as serveStorage gives followers.
      this.localWatches.set(wid, () => {});
      const live = () => this.watches.get(wid) === w && this.local === local && !this.closed;
      Promise.resolve()
        .then(() => local.runQueryLocally(w.req))
        .then(
          (r) => live() && w.onResult(r),
          (e) => live() && w.onError?.(e as Error),
        );
      return;
    }
    this.call("watch", wid, w.req).catch((e) => w.onError?.(e as Error));
  }

  /**
   * Run calls here from now on (null: post them again). Calls in flight are re-run on the new target and watches
   * re-established there.
   */
  setLocal(local: ServableStorage | null): void {
    for (const off of this.localWatches.values()) off();
    this.localWatches.clear();
    this.local = local;
    this.resend();
  }

  private call(op: Op, ...a: unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("offline storage: closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.inflight.set(id, { op, a, resolve, reject });
      this.dispatch(id);
    });
  }

  private dispatch(id: number): void {
    const c = this.inflight.get(id);
    if (!c) return;
    if (this.local) {
      const local = this.local;
      invoke(local, c.op, c.a).then(
        (v) => {
          if (this.inflight.get(id) !== c || this.local !== local) return;
          this.inflight.delete(id);
          c.resolve(v);
        },
        (e) => {
          if (this.inflight.get(id) !== c || this.local !== local) return;
          this.inflight.delete(id);
          c.reject(e);
        },
      );
      return;
    }
    this.endpoint.postMessage({ ember: TAG, k: "req", id, from: this.id, to: this.to, op: c.op, a: c.a } satisfies Req);
  }

  /** A new server (or a local target): every call still in flight runs again there, in order; watches too. */
  private resend(): void {
    // (Un)watch calls addressed the old server: every live watch is established afresh below.
    for (const [id, c] of this.inflight) {
      if (c.op !== "watch" && c.op !== "unwatch") continue;
      this.inflight.delete(id);
      c.resolve(undefined);
    }
    for (const id of [...this.inflight.keys()].sort((x, y) => x - y)) this.dispatch(id);
    for (const wid of this.watches.keys()) this.establish(wid);
  }

  private onMessage(m: unknown): void {
    if (!isMsg(m) || this.closed) return;
    if (m.k === "leader") {
      if (!this.local) this.resend();
      return;
    }
    if (m.k === "res" && m.to === this.id) {
      const c = this.inflight.get(m.id);
      if (!c) return;
      this.inflight.delete(m.id);
      if (m.ok) c.resolve(m.v);
      else c.reject(fromErr(m.e!));
      return;
    }
    if (m.k === "watch" && m.to === this.id) {
      const w = this.watches.get(m.wid);
      if (!w) return;
      if (m.e) w.onError?.(fromErr(m.e));
      else w.onResult(m.r ?? undefined);
    }
  }

  /** Closes the served storage itself (then this caller): e.g. the Worker's database before terminating it. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    await this.call("close").catch(() => undefined);
    this.detach();
  }

  /** Stop: pending calls are rejected, the server drops this caller's watches. */
  close(): void | Promise<void> {
    this.detach();
  }

  protected detach(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.localWatches.values()) off();
    this.localWatches.clear();
    this.watches.clear();
    if (!this.local) this.endpoint.postMessage({ ember: TAG, k: "bye", from: this.id } satisfies Bye);
    this.endpoint.removeEventListener("message", this.listener);
    for (const c of this.inflight.values()) c.reject(new Error("offline storage: closed"));
    this.inflight.clear();
  }
}
