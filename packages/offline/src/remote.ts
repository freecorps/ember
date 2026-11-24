// A `StorageAdapter` across a message boundary: the main thread ⇄ the Worker that owns an OPFS database
// (opfs.ts), and follower tabs ⇄ the leader tab (tabs.ts). One small request/response protocol over anything with
// `postMessage` + `message` events (Worker, worker global scope, MessagePort, BroadcastChannel); values cross by
// structured clone (bigint and Uint8Array included).
//
//   → { ember: "offline/1", k: "req", id, from, to, op, a, r? }      a call (to: the serving address; r: see below)
//   ← { ember: "offline/1", k: "res", id, to, ok, v | e }            its answer (to: the caller)
//   ← { ember: "offline/1", k: "watch", to, wid, r | e }             a watched local result (watchQueryLocally)
//   ← { ember: "offline/1", k: "leader", from, f? }                  a new server took over: resend in-flight calls
//   → { ember: "offline/1", k: "bye", from }                         the caller is gone: drop its watches
//   ← { ember: "offline/1", k: "saved", p, d }                       records the server's storage made durable / dropped
//
// Operations: load (+ the server's `sync` specs and `features`), getClientId, setClientId, loadPending, putPending,
// removePending, applyPatch, applyDiff, runQueryLocally, setIdentity, flush, clear, close, watch / unwatch.
//
// Diffs (feature "diff", in `load`'s answer and in `leader.f`): a value crosses the boundary once per query; after
// that `applyDiff [update without value, diff, baseSeq, seq]` carries a `RowDiff`/`ValueDiff` against the last value
// this caller sent for the same query (`seq` numbers them, per caller and query): O(k) rows structured-cloned per
// patch instead of O(n). The client keeps unchanged rows by identity, so the caller finds them with pointer checks
// (diff.ts). A server that does not hold that base (another leader, a restart, an older version) answers the error
// code `ember_offline_base` (an older one: unknown operation): the caller resends the whole value. Resent calls (a
// new leader) always carry whole values. Servers without the feature only ever get `applyPatch [update]`. The
// caller's order holds across that retry: after a refused diff the server holds every later call of that caller
// until the whole value comes back (`r`: the id of the refused call), runs it, then the held ones in order — so an
// unawaited `clear()` sent after the diff never runs before the value it followed.
//
// Saved notices: a server whose storage reports what it made durable (`OfflineStore.onSaved`) broadcasts them; a
// caller then does not hand over a value the storage already holds (another tab stored the same version for the same
// identity, or a newer one), nor resend such a call to the next leader — except while its own `clear()` is on its way
// (the notices describe what that clear is about to drop).
//
// Every operation is idempotent (results are keyed by query, the pending queue by `mid`, metadata by key), so a
// client resends whatever is still in flight when a new server announces itself — each call under a new `id`, so
// only the server it was last sent to can settle it. A stopped server (a leader leaving) answers nothing more: what
// it was still running is resent to the next one rather than failed with an error it got while closing.

import { applyAnyDiff, type RowDiff, type ValueDiff } from "@freecorps/ember-values";
import { recordKey, UNKNOWN_OWNER, updateOwner, type SavedNotice } from "./backend.ts";
import { identityDiff } from "./diff.ts";
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

/**
 * What can be served: a StorageAdapter, optionally with `watchQueryLocally`, `clear` and `onSaved` (OfflineStore has
 * all three).
 */
export type ServableStorage = StorageAdapter & { clear?(): Promise<void>; onSaved?(listener: (n: SavedNotice) => void): () => void };

type Op =
  | "load"
  | "getClientId"
  | "setClientId"
  | "loadPending"
  | "putPending"
  | "removePending"
  | "applyPatch"
  | "applyDiff"
  | "runQueryLocally"
  | "setIdentity"
  | "flush"
  | "clear"
  | "close"
  | "watch"
  | "unwatch";

const TAG = "offline/1";
type ErrJson = { name: string; message: string; code?: string };
type Req = { ember: typeof TAG; k: "req"; id: number; from: string; to: string; op: Op; a: unknown[]; r?: number };
type Res = { ember: typeof TAG; k: "res"; id: number; to: string; ok: boolean; v?: unknown; e?: ErrJson };
type WatchMsg = { ember: typeof TAG; k: "watch"; to: string; wid: number; r?: LocalQueryResult | null; e?: ErrJson };
type Leader = { ember: typeof TAG; k: "leader"; from: string; f?: string[] };
type Bye = { ember: typeof TAG; k: "bye"; from: string };
type Saved = { ember: typeof TAG; k: "saved"; p: SavedNotice["put"]; d: string[] };
type Msg = Req | Res | WatchMsg | Leader | Bye | Saved;

/** What this side of the protocol speaks beyond the original (`load` answer, `leader.f`). */
const FEATURES = ["diff"];
/** The error a server answers to `applyDiff` when it does not hold the caller's base: resend the whole value. */
const NO_BASE = "ember_offline_base";
/** Bases kept per caller (and per peer on the server): the queries patched most recently. */
const MAX_BASES = 256;
/** A notice of the same version for the same identity skips a write for this long (the store refreshes later). */
const SAVED_TTL_MS = 10 * 60_000;
const MAX_SAVED = 4000;

/** Sets `k` as the newest entry, dropping the oldest past `max`. */
function remember<V>(m: Map<string, V>, k: string, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > max) m.delete(m.keys().next().value!);
}
const keyOf = (u: QueryUpdate) => recordKey(u.shard, u.fn, u.argsJson);

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
      return { ...((await s.load()) ?? {}), sync: plainSync(s.sync), features: FEATURES };
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
  // Once stopped (a leader leaving), calls still running here are not answered: their callers resend them to the
  // next server (every op is idempotent), instead of settling with an error this server got while closing.
  let stopped = false;
  const peers = new Set<string>();
  const watches = new Map<string, Map<number, () => void>>();
  /** peer → query key → the last value it sent (what its next `applyDiff` applies to). */
  const bases = new Map<string, Map<string, { seq: number; value: unknown }>>();
  const post = (m: Msg) => {
    if (!stopped) endpoint.postMessage(m);
  };
  const basesOf = (peer: string) => {
    let b = bases.get(peer);
    if (!b) bases.set(peer, (b = new Map()));
    return b;
  };
  /** The update a call carries, whole (recording it as the peer's base). Throws `NO_BASE` for a diff without one. */
  const updateOf = (peer: string, op: "applyPatch" | "applyDiff", a: unknown[]): QueryUpdate => {
    const mine = basesOf(peer);
    if (op === "applyPatch") {
      const u = a[0] as QueryUpdate;
      if (typeof a[1] === "number") remember(mine, keyOf(u), { seq: a[1], value: u.value }, MAX_BASES);
      return u;
    }
    const [rest, diff, baseSeq, seq] = a as [Omit<QueryUpdate, "value">, RowDiff | ValueDiff, number, number];
    const key = recordKey(rest.shard, rest.fn, rest.argsJson);
    const base = mine.get(key);
    let value: unknown;
    try {
      if (!base || base.seq !== baseSeq) throw new Error("no base");
      value = applyAnyDiff(base.value, diff);
    } catch {
      mine.delete(key);
      throw Object.assign(new Error("offline storage: no base value for this diff"), { code: NO_BASE });
    }
    remember(mine, key, { seq, value }, MAX_BASES);
    return { ...rest, value } as QueryUpdate;
  };
  // What the storage made durable, for every caller (they skip handing it over again).
  const stopSaved = storage.onSaved?.((n) => post({ ember: TAG, k: "saved", p: n.put, d: n.drop }));
  const watchesOf = (peer: string) => {
    let w = watches.get(peer);
    if (!w) watches.set(peer, (w = new Map()));
    return w;
  };
  /** peer → the diff refused for lack of a base, and the calls that came after it (held until its retry). */
  const blocked = new Map<string, { failed: number; held: Req[] }>();
  const dropPeer = (peer: string) => {
    for (const off of watches.get(peer)?.values() ?? []) off();
    watches.delete(peer);
    bases.delete(peer);
    peers.delete(peer);
    blocked.delete(peer);
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
    const b = blocked.get(m.from);
    if (!b) return handle(m);
    // After a refused diff: nothing of that caller runs before the whole value it is resending.
    if (m.r !== b.failed) {
      b.held.push(m);
      return;
    }
    blocked.delete(m.from);
    handle(m);
    for (let i = 0; i < b.held.length; i++) {
      const again = blocked.get(m.from);
      if (again) {
        // Another diff of the held ones was refused: the rest waits for that retry, still in order.
        again.held.push(...b.held.slice(i));
        return;
      }
      handle(b.held[i]!);
    }
  };
  const handle = (m: Req) => {
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
    if (m.op === "applyPatch" || m.op === "applyDiff") {
      // The base is recorded as the call arrives (calls arrive in the caller's order), before the storage runs it.
      let u: QueryUpdate;
      try {
        u = updateOf(m.from, m.op, m.a);
      } catch (e) {
        if ((e as { code?: unknown }).code === NO_BASE) blocked.set(m.from, { failed: m.id, held: [] });
        return post({ ember: TAG, k: "res", id: m.id, to: m.from, ok: false, e: toErr(e) });
      }
      invoke(storage, "applyPatch", [u]).then(
        () => post({ ember: TAG, k: "res", id: m.id, to: m.from, ok: true }),
        (e) => post({ ember: TAG, k: "res", id: m.id, to: m.from, ok: false, e: toErr(e) }),
      );
      return;
    }
    invoke(storage, m.op, m.a).then(
      (v) => post({ ember: TAG, k: "res", id: m.id, to: m.from, ok: true, v }),
      (e) => post({ ember: TAG, k: "res", id: m.id, to: m.from, ok: false, e: toErr(e) }),
    );
  };
  endpoint.addEventListener("message", listener);
  return {
    announce: (from) => post({ ember: TAG, k: "leader", from, f: FEATURES }),
    dropPeer,
    stop() {
      if (stopped) return;
      stopped = true;
      stopSaved?.();
      endpoint.removeEventListener("message", listener);
      for (const p of [...watches.keys()]) dropPeer(p);
    },
  };
}

/** `whole`: send the value whole (the server lacked the base of a diff). */
/**
 * `whole`: send the value whole (the server lacked the base of a diff); `retryOf`: the id of that refused diff (the
 * server holds this caller's later calls until it), `seq`: the base number the value went out with.
 */
type Call = { op: Op; a: unknown[]; resolve(v: unknown): void; reject(e: unknown): void; whole?: boolean; diffed?: boolean; retryOf?: number | undefined; seq?: number };
type RemoteWatch = { req: LocalQueryRequest; onResult(r: LocalQueryResult | undefined): void; onError?(e: Error): void };

export interface RemoteStorageOptions {
  /** This caller's address (default: random). */
  id?: string;
  /** The server's address (default `"*"`). */
  to?: string;
  /** Instead of posting, run calls here (a tab that became the leader runs its own calls locally). */
  local?: ServableStorage | null;
  /** A server announced itself (after the calls in flight were resent to it). */
  onLeader?(from: string): void;
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
  /** No server to send to (see setUnavailable): calls fail with this until one announces itself. */
  private unavailable: Error | null = null;
  /** The server is gone for good (setUnavailable permanent): calls fail with this, announcements are ignored. */
  private dead: Error | null = null;
  private readonly to: string;
  private readonly onLeader: ((from: string) => void) | undefined;
  private closed = false;
  /** The current server takes `applyDiff` (feature "diff"). */
  private diffs = false;
  /** Query key → the last value sent to the current server (`seq` numbers it). */
  private readonly bases = new Map<string, { seq: number; value: unknown }>();
  private baseSeq = 0;
  /** `clear()` calls on their way: saved notices do not count meanwhile. */
  private clearing = 0;
  /** Query key → what the server's storage last said it holds (saved notices). */
  private readonly savedRecs = new Map<string, { version: number; epoch: string | null; owner: string | null; at: number }>();
  private readonly listener = (ev: { data: unknown }) => this.onMessage(ev.data);

  constructor(
    private readonly endpoint: Endpoint,
    options: RemoteStorageOptions = {},
  ) {
    this.id = options.id ?? randomId();
    this.to = options.to ?? "*";
    this.local = options.local ?? null;
    this.onLeader = options.onLeader;
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
    const r = (await this.call("load")) as { identity?: LocalIdentity | null; sync?: SyncSpec[]; features?: unknown };
    this.syncSpecs = r.sync ?? [];
    if (!this.local) this.diffs = Array.isArray(r.features) && r.features.includes("diff");
    return { identity: r.identity ?? null };
  }
  applyPatch(u: QueryUpdate): Promise<void> {
    // The storage holds this value already (another tab handed it over): nothing to send.
    if (!this.local && this.isSaved(u)) return Promise.resolve();
    return this.call("applyPatch", u) as Promise<void>;
  }

  /** The server's storage said it holds `u`'s value, or a newer one of the same epoch (the store would skip `u`). */
  private isSaved(u: QueryUpdate): boolean {
    // A clear queued before this update will drop what the notices describe: the update must follow it.
    if (this.clearing) return false;
    const s = this.savedRecs.get(keyOf(u));
    if (!s || s.epoch === null || s.epoch !== u.epoch) return false;
    if (u.version < s.version) return true;
    const owner = updateOwner(u);
    return u.version === s.version && owner !== undefined && owner !== UNKNOWN_OWNER && s.owner === owner && Date.now() - s.at < SAVED_TTL_MS;
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
    this.savedRecs.clear();
    this.clearing++;
    const p = this.call("clear") as Promise<void>;
    const done = () => void this.clearing--;
    p.then(done, done);
    return p;
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
      } else if (!this.closed && !this.unavailable) void this.call("unwatch", wid).catch(() => undefined);
    };
  }

  private establish(wid: number): void {
    const w = this.watches.get(wid);
    if (!w || this.closed) return;
    if (this.unavailable) {
      // Kept: established again when a server announces itself.
      w.onError?.(this.unavailable);
      return;
    }
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
    if (this.dead) return;
    for (const off of this.localWatches.values()) off();
    this.localWatches.clear();
    this.local = local;
    this.savedRecs.clear();
    this.unavailable = null;
    this.resend();
  }

  /**
   * Nobody serves now (a tab that could not open the storage gave up the lead): calls in flight and new calls
   * fail with `error` instead of waiting, watches get `error` once. The next server that announces itself ends
   * this — calls go to it and watches are re-established there.
   */
  setUnavailable(error: Error, options: { permanent?: boolean } = {}): void {
    if (this.closed || this.dead) return;
    for (const off of this.localWatches.values()) off();
    this.localWatches.clear();
    this.local = null;
    this.unavailable = error;
    // Permanent (the server itself died, e.g. a crashed Worker): no announcement brings it back.
    if (options.permanent) this.dead = error;
    for (const [id, c] of [...this.inflight]) {
      this.inflight.delete(id);
      if (c.op === "watch" || c.op === "unwatch") c.resolve(undefined);
      else c.reject(error);
    }
    for (const wid of this.watches.keys()) this.establish(wid);
  }

  private call(op: Op, ...a: unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("offline storage: closed"));
    if (this.unavailable) return Promise.reject(this.unavailable);
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
    let op = c.op;
    let a = c.a;
    if (op === "applyPatch") [op, a] = this.wireUpdate(c);
    const retry = c.retryOf;
    c.retryOf = undefined;
    this.endpoint.postMessage({ ember: TAG, k: "req", id, from: this.id, to: this.to, op, a, ...(retry !== undefined ? { r: retry } : {}) } satisfies Req);
  }

  /** An update as it goes out: a diff against the last value sent for its query when the server takes them. */
  private wireUpdate(c: Call): [Op, unknown[]] {
    const u = c.a[0] as QueryUpdate;
    // The retry of a refused diff: the same base number as then, so the calls after it (diffs against this value,
    // held by the server meanwhile) still find their base. What was sent since stays this caller's latest base.
    if (c.retryOf !== undefined && c.seq !== undefined) return ["applyPatch", [u, c.seq]];
    const key = keyOf(u);
    const seq = ++this.baseSeq;
    c.seq = seq;
    const base = this.bases.get(key);
    c.diffed = false;
    if (this.diffs && base && !c.whole) {
      let diff: RowDiff | ValueDiff | null = null;
      try {
        diff = identityDiff(base.value, u.value);
      } catch {
        diff = null;
      }
      if (diff) {
        remember(this.bases, key, { seq, value: u.value }, MAX_BASES);
        c.diffed = true;
        const { value: _value, ...rest } = u;
        return ["applyDiff", [rest, diff, base.seq, seq]];
      }
    }
    remember(this.bases, key, { seq, value: u.value }, MAX_BASES);
    return ["applyPatch", [u, seq]];
  }

  /**
   * A new server (or a local target): every call still in flight runs again there, in order; watches too. Each
   * call goes out under a new request id, so only the server it was last sent to can answer it: a late answer of
   * the previous server (to the old id) finds nothing.
   */
  private resend(): void {
    const calls = [...this.inflight].sort(([x], [y]) => x - y);
    this.inflight.clear();
    // The new server holds none of the values sent to the old one: whole values again.
    this.bases.clear();
    for (const [, c] of calls) {
      // (Un)watch calls addressed the old server: every live watch is established afresh below.
      if (c.op === "watch" || c.op === "unwatch") c.resolve(undefined);
      // Stored already (the old server said so before going): not sent again.
      else if (c.op === "applyPatch" && this.isSaved(c.a[0] as QueryUpdate)) c.resolve(undefined);
      else {
        const id = ++this.seq;
        this.inflight.set(id, c);
        this.dispatch(id);
      }
    }
    for (const wid of this.watches.keys()) this.establish(wid);
  }

  private onMessage(m: unknown): void {
    if (!isMsg(m) || this.closed) return;
    if (m.k === "saved") {
      const now = Date.now();
      for (const [key, version, epoch, owner] of m.p ?? []) remember(this.savedRecs, key, { version, epoch, owner, at: now }, MAX_SAVED);
      for (const key of m.d ?? []) this.savedRecs.delete(key);
      return;
    }
    if (m.k === "leader") {
      if (this.local || this.dead) return;
      this.unavailable = null;
      this.diffs = Array.isArray(m.f) && m.f.includes("diff");
      this.resend();
      // What the previous server said it held stays true of the storage, but the new one says it from now on.
      this.savedRecs.clear();
      this.onLeader?.(m.from);
      return;
    }
    if (m.k === "res" && m.to === this.id) {
      const c = this.inflight.get(m.id);
      if (!c) return;
      this.inflight.delete(m.id);
      if (m.ok) c.resolve(m.v);
      else if (c.diffed && (m.e?.code === NO_BASE || /unknown operation/.test(m.e?.message ?? ""))) {
        // The server does not hold our base (or does not speak diffs): the whole value, under a new id. A server
        // that refused it for lack of a base holds our later calls until this retry comes (`r`).
        if (m.e?.code !== NO_BASE) this.diffs = false;
        else c.retryOf = m.id;
        c.whole = true;
        const id = ++this.seq;
        this.inflight.set(id, c);
        this.dispatch(id);
      } else c.reject(fromErr(m.e!));
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
