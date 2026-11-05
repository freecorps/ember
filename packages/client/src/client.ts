import { browserConnectivity, type ConnectivityEvent, type ConnectivitySource } from "./connectivity.ts";
import { EmberError } from "./errors.ts";
import { getFunctionName, type FunctionLike, type FunctionReference } from "./functions.ts";
import { applyRowDiff } from "@freecorps/ember-values";
import { PING, PONG, PROTOCOL_VERSION, type ClientMessage, type Id, type ServerMessage } from "./protocol.ts";
import {
  isStorageAdapter,
  MemoryPendingStorage,
  type LocalIdentity,
  type LocalQueryResult,
  type PendingMutationRecord,
  type PendingStorage,
  type StorageAdapter,
} from "./storage.ts";
import { fromBase64, parse, stableStringify, stringify } from "./wire.ts";

// ------------------------------------------------------------------------------------------------ public types

/** The subset of the WHATWG WebSocket the client uses (browsers, React Native, `ws`, undici). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}
export type WebSocketConstructor = new (url: string) => WebSocketLike;

export type AuthTokenFetcher = () => Promise<string | null | undefined> | string | null | undefined;

export interface EmberClientOptions {
  /** Deployment URL: `https://app.example.com` (or `wss://...`). Sockets go to `/ws`, one-shots to `/api/*`. */
  url: string;
  /** Returns the current auth token (a short JWT), or null when signed out. Called on connect and on `authExpired`. */
  auth?: AuthTokenFetcher;
  /**
   * Where unconfirmed mutations are kept (`PendingStorage`, default memory), or a full offline `StorageAdapter`
   * (`@freecorps/ember-offline`: IndexedDB, expo-sqlite) that also persists query results and runs registered
   * queries locally on cold start / offline.
   */
  storage?: PendingStorage | StorageAdapter;
  /**
   * Optimistic updates by mutation name, used when a call passes none, and for mutations restored from storage
   * after a restart (their closures are gone): with them, offline edits stay visible across reloads.
   */
  optimisticUpdates?: Record<string, OptimisticUpdate>;
  /** WebSocket implementation. Default: `globalThis.WebSocket`. */
  WebSocket?: WebSocketConstructor;
  /** fetch implementation for one-shot queries. Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Network / lifecycle hooks. Default: browser `online`/`offline`/`visibilitychange` when available; null disables. */
  connectivity?: ConnectivitySource | null;
  /** Shard used when an operation does not name one. */
  defaultShard?: string;
  /** Reconnect backoff with "equal jitter". Defaults: 250 ms, 30 s, factor 2. */
  backoff?: { initialMs?: number; maxMs?: number; factor?: number };
  /** Heartbeat with the literal "ping"/"pong" frames. Defaults: 25 s interval, 10 s timeout. `false` disables. */
  heartbeat?: { intervalMs?: number; timeoutMs?: number } | false;
  /**
   * Protocol v1.1 per-row patch diffs (feature "rowdiff"): array-of-docs results are patched with
   * `{remove, upsert, at?, order?}` instead of the whole value when that is smaller. Default true.
   */
  rowDiff?: boolean;
  /** How long a shard socket stays open without subscriptions or pending mutations. Default 10 s. */
  idleTimeoutMs?: number;
  /** Refresh a JWT this long before its `exp` and send `{t:"auth"}`. Default 30 s. `false` disables. */
  refreshAuthBeforeExpiryMs?: number | false;
  /** Stable client id (else read from storage, else generated and stored). */
  clientId?: string;
  /** Errors not tied to a call (`err` without qid, failed auth refresh, ...). */
  onError?: (error: EmberError, info: { shard?: string }) => void;
  /** Result of a mutation restored from storage after a restart (no caller is waiting for it). */
  onRestoredMutationResult?: (record: PendingMutationRecord, result: { ok: true; value: unknown } | { ok: false; error: EmberError }) => void;
  /** Injected for tests. */
  random?: () => number;
}

export type QueryStatus = "loading" | "success" | "error";

export interface QuerySnapshot<T = unknown> {
  readonly status: QueryStatus;
  /** Optimistic view: confirmed value with pending optimistic updates applied. */
  readonly value: T | undefined;
  readonly error: EmberError | undefined;
  /** True when `value` includes unconfirmed optimistic changes. */
  readonly optimistic: boolean;
  /**
   * Set while the value comes from offline storage, before the server's first answer in this session: `local`
   * (computed from replicated rows) or `cache` (the last stored server value). Absent once confirmed.
   */
  readonly source?: "local" | "cache";
}

export interface ShardOptions {
  shard?: string;
}

export interface OptimisticLocalStore {
  /** Current (optimistic) value of a subscribed query, or undefined when it is not loaded. */
  getQuery<Q extends FunctionReference<"query">>(ref: Q | string, args?: Q["_args"], opts?: ShardOptions): Q["_returnType"] | undefined;
  /** Overwrite a query's visible value until the mutation settles. */
  setQuery<Q extends FunctionReference<"query">>(ref: Q | string, args: Q["_args"], value: Q["_returnType"] | undefined, opts?: ShardOptions): void;
  /** Every loaded query of a function, with its args. */
  getAllQueries<Q extends FunctionReference<"query">>(ref: Q | string, opts?: ShardOptions): Array<{ args: Q["_args"]; value: Q["_returnType"] | undefined }>;
}

export type OptimisticUpdate<Args = any> = (store: OptimisticLocalStore, args: Args) => void;

export interface MutationOptions<Args = any> extends ShardOptions {
  optimisticUpdate?: OptimisticUpdate<Args>;
}

export type ShardConnectionState = "idle" | "connecting" | "open" | "waiting" | "offline";

export interface ConnectionState {
  readonly online: boolean;
  /** Every shard the client has touched. */
  readonly shards: Readonly<Record<string, ShardConnectionState>>;
  /** All shards that are needed are open. */
  readonly connected: boolean;
  readonly pendingMutations: number;
}

// ------------------------------------------------------------------------------------------------ internals

interface Sub {
  key: string;
  shard: string;
  fn: string;
  args: Record<string, unknown>;
  argsJson: string;
  /**
   * Stable for the life of the subscription (reused on every socket): the server only answers a `resume` with
   * `unchanged` when the last snapshot of `(clientId, qid)` was computed under the same identity.
   */
  qid: string;
  listeners: Set<() => void>;
  confirmed: { value: unknown } | null;
  /** From the offline StorageAdapter until `confirmed` arrives. */
  local: LocalQueryResult | null;
  /** Stops the adapter's local watch (`watchQueryLocally`). */
  unwatchLocal?: (() => void) | undefined;
  version: number;
  epoch: string | null;
  /** `authGen` at the time `confirmed` was produced: resume is only valid for the same identity. */
  authGen: number;
  error: EmberError | null;
  snapshot: QuerySnapshot;
}

interface Pending {
  record: PendingMutationRecord;
  /** Cleared once a `patch` lists the mid: the confirmed state already includes the mutation's effects. */
  update: OptimisticUpdate | undefined;
  /** An `auth_expired` mres was answered by re-auth + resend (done at most once). */
  authRetried: boolean;
  /** `conn.authSeq` when the `mut` was last sent. */
  sentAuthSeq: number;
  resolve(value: unknown): void;
  reject(e: EmberError): void;
}

interface Conn {
  shard: string;
  ws: WebSocketLike | null;
  gen: number;
  state: ShardConnectionState;
  ready: boolean;
  attempt: number;
  epoch: string | null;
  /** Subscriptions registered on the current socket, by qid. */
  qids: Map<string, Sub>;
  retryTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  /** Count of `auth` frames sent on this shard's sockets. */
  authSeq: number;
  /** In-flight refresh after `authExpired` (shared by every frame that bounced). */
  reauth: Promise<ReauthOutcome> | null;
}

/** sent: a fresh `auth` went out; failed: no token; gone: the socket was replaced (hello carries the token). */
type ReauthOutcome = "sent" | "failed" | "gone";

/** What optimistic updates build on: the confirmed value, else the offline adapter's local one. */
const baseOf = (s: Sub | undefined): { value: unknown } | null => (s ? (s.confirmed ?? s.local) : null);

const LOADING: QuerySnapshot = Object.freeze({ status: "loading", value: undefined, error: undefined, optimistic: false });

const OPEN = 1;

function randomId(random: () => number, len = 16): string {
  const c = typeof crypto !== "undefined" ? (crypto as Crypto) : undefined;
  if (c?.randomUUID && random === Math.random) return c.randomUUID().replace(/-/g, "").slice(0, len);
  let s = "";
  while (s.length < len) s += Math.floor(random() * 36).toString(36);
  return s;
}

function jwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(fromBase64(b64));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

/** `{subject: sub, issuer: iss}` of a JWT payload (not verified: only used to run queries on local data). */
function jwtIdentity(token: string): LocalIdentity | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromBase64(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")))) as { sub?: unknown; iss?: unknown };
    if (typeof p.sub !== "string") return null;
    return typeof p.iss === "string" ? { subject: p.sub, issuer: p.iss } : { subject: p.sub };
  } catch {
    return null;
  }
}

function toArgs(args: unknown): Record<string, unknown> {
  if (args === undefined) return {};
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new EmberError("bad_args", "args must be an object");
  return args as Record<string, unknown>;
}

// ------------------------------------------------------------------------------------------------ client

export class EmberClient {
  readonly url: string;
  private readonly wsBase: string;
  private readonly httpBase: string;
  private readonly WS: WebSocketConstructor | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly storage: PendingStorage;
  private offline: StorageAdapter | null;
  private storedIdentity: LocalIdentity | null = null;
  private readonly syncOffs: Array<() => void> = [];
  private readonly random: () => number;
  private readonly sessionId: string;
  private authFetcher: AuthTokenFetcher | undefined;
  private authGen = 0;
  private tokenInFlight: Promise<string | null> | null = null;
  private token: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  private clientIdValue: string | null;
  private readonly init: Promise<void>;
  private midCounter = 0;
  private qidCounter = 0;

  private readonly conns = new Map<string, Conn>();
  private readonly subs = new Map<string, Sub>();
  private readonly pending: Pending[] = [];
  private readonly pendingByMid = new Map<string, Pending>();

  private online: boolean;
  private closed = false;
  private readonly stopConnectivity: (() => void) | undefined;
  private stateSnapshot: ConnectionState;
  private readonly stateListeners = new Set<() => void>();

  constructor(private readonly options: EmberClientOptions) {
    const base = options.url.replace(/\/+$/, "");
    this.url = base;
    this.wsBase = base.replace(/^http(s?):/, "ws$1:");
    this.httpBase = base.replace(/^ws(s?):/, "http$1:");
    this.WS = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    this.fetchImpl = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    this.offline = isStorageAdapter(options.storage) ? options.storage : null;
    this.storage = this.offline ? this.offline.persistPending : ((options.storage as PendingStorage | undefined) ?? new MemoryPendingStorage());
    this.random = options.random ?? Math.random;
    this.sessionId = randomId(this.random, 10);
    this.authFetcher = options.auth;
    this.clientIdValue = options.clientId ?? null;

    const connectivity = options.connectivity === undefined ? browserConnectivity() : options.connectivity;
    this.online = connectivity?.isOnline?.() ?? true;
    this.stopConnectivity = connectivity?.subscribe((e) => this.onConnectivity(e));
    this.stateSnapshot = this.buildState();
    this.init = this.initialize();
  }

  // ---------------------------------------------------------------------------------------------- lifecycle

  private async initialize(): Promise<void> {
    if (this.offline) {
      try {
        const r = await this.offline.load();
        this.storedIdentity = (r && r.identity) ?? null;
      } catch (e) {
        this.offline = null;
        this.report(new EmberError("storage_error", `offline storage unavailable: ${(e as Error).message}`), {});
      }
    }
    if (!this.clientIdValue) {
      let id: string | null = null;
      try {
        id = await this.storage.getClientId();
      } catch {
        // storage unavailable: a fresh id still works, dedup just won't span restarts
      }
      if (!id) {
        id = randomId(this.random, 24);
        try {
          await this.storage.setClientId(id);
        } catch {
          /* ignore */
        }
      }
      this.clientIdValue = id;
    }
    let restored: PendingMutationRecord[] = [];
    try {
      restored = await this.storage.load();
    } catch (e) {
      this.report(new EmberError("storage_error", `could not load pending mutations: ${(e as Error).message}`), {});
    }
    const fresh: Pending[] = [];
    for (const record of restored) {
      if (this.pendingByMid.has(record.mid)) continue;
      const p: Pending = {
        record,
        update: this.options.optimisticUpdates?.[record.fn],
        authRetried: false,
        sentAuthSeq: -1,
        resolve: (value) => this.options.onRestoredMutationResult?.(record, { ok: true, value }),
        reject: (error) => this.options.onRestoredMutationResult?.(record, { ok: false, error }),
      };
      fresh.push(p);
      this.pendingByMid.set(record.mid, p);
    }
    if (fresh.length) {
      // Restored mutations are older than anything issued since construction: they go first.
      this.pending.unshift(...fresh);
      for (const p of fresh) this.ensure(p.record.shard);
      if (fresh.some((p) => p.update)) this.recompute();
      this.emitState();
    }
    for (const spec of this.offline?.sync ?? []) {
      if (this.closed) break;
      try {
        this.syncOffs.push(this.subscribe(spec.query, spec.args, spec.shard === undefined ? undefined : { shard: spec.shard }, () => {}));
      } catch (e) {
        this.report(e instanceof EmberError ? e : new EmberError("sync_failed", (e as Error).message), {});
      }
    }
  }

  /** Resolves once the clientId is known and stored pending mutations are loaded. */
  ready(): Promise<void> {
    return this.init;
  }

  get clientId(): string | null {
    return this.clientIdValue;
  }

  /** Close every socket and stop reconnecting. Pending in-memory callers are rejected; storage is kept. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopConnectivity?.();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const conn of this.conns.values()) {
      this.dropSocket(conn);
      this.clearTimer(conn, "retryTimer");
      this.clearTimer(conn, "idleTimer");
      conn.state = "idle";
    }
    for (const p of this.pending.splice(0)) p.reject(new EmberError("closed", "client closed"));
    this.pendingByMid.clear();
    for (const off of this.syncOffs.splice(0)) {
      try {
        off();
      } catch {
        /* closing anyway */
      }
    }
    for (const s of this.subs.values()) {
      const off = s.unwatchLocal;
      s.unwatchLocal = undefined;
      try {
        off?.();
      } catch {
        /* closing anyway */
      }
    }
    const offline = this.offline;
    if (offline?.close) void Promise.resolve().then(() => offline.close!()).catch(() => undefined);
    this.emitState();
  }

  /** Resolves when the offline StorageAdapter (if any) has written everything handed to it so far. */
  async flushStorage(): Promise<void> {
    await this.init;
    await this.offline?.flush?.();
  }

  // ---------------------------------------------------------------------------------------------- auth

  /** Replace the token source (sign in / out / switch user). Open sockets re-auth (`{t:"auth"}`) in place. */
  setAuth(fetcher: AuthTokenFetcher | undefined): void {
    this.authFetcher = fetcher;
    this.authGen++;
    this.token = null;
    this.tokenInFlight = null;
    if (!fetcher) this.rememberIdentity(null);
    void this.reauthAll(true);
  }

  /** Same as `setAuth(undefined)`: open sockets send `{t:"auth", token:null}` and get fresh anonymous snapshots. */
  clearAuth(): void {
    this.setAuth(undefined);
  }

  private fetchToken(): Promise<string | null> {
    if (!this.authFetcher) return Promise.resolve(null);
    if (this.tokenInFlight) return this.tokenInFlight;
    const gen = this.authGen;
    const fetcher = this.authFetcher;
    let p: Promise<string | null> | null = null;
    p = (async () => {
      try {
        const t = (await fetcher()) ?? null;
        if (gen === this.authGen) {
          this.token = t;
          this.armRefresh(t);
          if (t) {
            const id = jwtIdentity(t);
            if (id) this.rememberIdentity(id);
          } else this.rememberIdentity(null);
        }
        return t;
      } finally {
        if (this.tokenInFlight === p) this.tokenInFlight = null;
      }
    })();
    this.tokenInFlight = p;
    return p;
  }

  /** Who local queries run as: the current token's subject, else the one stored by the last session. */
  private localIdentity(): LocalIdentity | null {
    return (this.token && jwtIdentity(this.token)) || this.storedIdentity;
  }

  private rememberIdentity(id: LocalIdentity | null): void {
    const prev = this.storedIdentity;
    if (prev === id || (prev && id && prev.subject === id.subject && prev.issuer === id.issuer)) return;
    this.storedIdentity = id;
    const offline = this.offline;
    if (offline?.setIdentity) {
      void Promise.resolve()
        .then(() => offline.setIdentity!(id))
        .catch(() => undefined);
    }
  }

  private armRefresh(token: string | null): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const before = this.options.refreshAuthBeforeExpiryMs ?? 30_000;
    if (before === false || !token || this.closed) return;
    const exp = jwtExp(token);
    if (exp === null) return;
    const delay = Math.max(1_000, exp * 1000 - Date.now() - before);
    if (delay > 2 ** 31 - 1) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.reauthAll(false);
    }, delay);
  }

  /**
   * Fetch a fresh token and send `{t:"auth"}` on every open socket. After an identity change a missing token is sent
   * as `token: null` (sign out); a plain refresh that yields no token leaves the socket alone.
   */
  private async reauthAll(identityChanged: boolean): Promise<void> {
    let token: string | null;
    try {
      token = await this.fetchToken();
    } catch (e) {
      this.report(new EmberError("auth_failed", `auth token fetch failed: ${(e as Error).message}`), {});
      return;
    }
    for (const conn of this.conns.values()) {
      if (!conn.ws) continue;
      if (!conn.ready) {
        // hello not answered yet (or not sent): restart so hello carries the new token
        if (identityChanged) this.restart(conn);
        continue;
      }
      if (token || identityChanged) this.sendAuth(conn, token);
    }
  }

  private sendAuth(conn: Conn, token: string | null): void {
    conn.authSeq++;
    this.send(conn, { t: "auth", token });
  }

  /**
   * The server refused a frame because the token expired: fetch a fresh one and send `auth` (once per burst of
   * refusals). Frames sent after that `auth` run under the new identity, as the server handles frames in order.
   */
  private reauth(conn: Conn): Promise<ReauthOutcome> {
    if (conn.reauth) return conn.reauth;
    const gen = conn.gen;
    const p: Promise<ReauthOutcome> = (async () => {
      let token: string | null;
      try {
        token = await this.fetchToken();
      } catch (e) {
        this.report(new EmberError("auth_failed", `auth refresh failed: ${(e as Error).message}`), { shard: conn.shard });
        return gen === conn.gen ? "failed" : "gone";
      }
      if (gen !== conn.gen || !conn.ready) return "gone";
      if (!token) {
        this.report(new EmberError("auth_expired", "auth expired and no new token is available"), { shard: conn.shard });
        return "failed";
      }
      this.sendAuth(conn, token);
      return "sent";
    })().finally(() => {
      if (conn.reauth === p) conn.reauth = null;
    });
    conn.reauth = p;
    return p;
  }

  // ---------------------------------------------------------------------------------------------- queries

  private shardOf(opts: ShardOptions | undefined): string {
    const shard = opts?.shard ?? this.options.defaultShard;
    if (!shard) throw new EmberError("no_shard", "no shard given and no defaultShard configured");
    return shard;
  }

  private subKey(shard: string, fn: string, argsJson: string): string {
    return `${shard}\u0000${fn}\u0000${argsJson}`;
  }

  /**
   * Low-level handle for `useSyncExternalStore`: `getSnapshot` is stable between changes, `subscribe` ref-counts a
   * deduplicated server subscription for `(shard, fn, args)`.
   */
  watchQuery<Q extends FunctionReference<"query">>(
    ref: Q | string,
    args: Q["_args"] | undefined,
    opts?: ShardOptions,
  ): { subscribe(listener: () => void): () => void; getSnapshot(): QuerySnapshot<Q["_returnType"]> } {
    const shard = this.shardOf(opts);
    const fn = getFunctionName(ref);
    const a = toArgs(args);
    const argsJson = stableStringify(a);
    const key = this.subKey(shard, fn, argsJson);
    return {
      subscribe: (listener) => this.addListener(key, shard, fn, a, argsJson, listener),
      getSnapshot: () => (this.subs.get(key)?.snapshot ?? LOADING) as QuerySnapshot<Q["_returnType"]>,
    };
  }

  /**
   * Subscribe to a query. `cb` runs on every change (and right away if a deduplicated subscription already has a
   * value). Returns the unsubscribe function.
   */
  subscribe<Q extends FunctionReference<"query">>(
    ref: Q | string,
    args: Q["_args"] | undefined,
    opts: ShardOptions | undefined,
    cb: (snapshot: QuerySnapshot<Q["_returnType"]>) => void,
  ): () => void {
    const w = this.watchQuery(ref, args, opts);
    let last: QuerySnapshot | null = null;
    const listener = () => {
      const s = w.getSnapshot();
      if (s === last) return;
      last = s;
      cb(s);
    };
    const off = w.subscribe(listener);
    if (w.getSnapshot().status !== "loading") listener();
    return off;
  }

  /** The current snapshot of a subscribed query (LOADING when not subscribed). */
  localQueryResult<Q extends FunctionReference<"query">>(ref: Q | string, args?: Q["_args"], opts?: ShardOptions): QuerySnapshot<Q["_returnType"]> {
    return this.watchQuery(ref, args, opts).getSnapshot();
  }

  private addListener(key: string, shard: string, fn: string, args: Record<string, unknown>, argsJson: string, listener: () => void): () => void {
    if (this.closed) return () => {};
    let sub = this.subs.get(key);
    if (!sub) {
      sub = {
        key, shard, fn, args, argsJson,
        qid: `${this.sessionId}.${(++this.qidCounter).toString(36)}`,
        listeners: new Set(),
        confirmed: null,
        local: null,
        version: 0,
        epoch: null,
        authGen: -1,
        error: null,
        snapshot: LOADING,
      };
      this.subs.set(key, sub);
      this.recompute([sub]);
      const conn = this.ensure(shard);
      if (conn.ready) this.sendSub(conn, sub);
      if (this.offline) void this.loadLocal(sub);
    }
    const s = sub;
    // A fresh wrapper per call so the same function can be added twice and removed once.
    const entry = () => listener();
    s.listeners.add(entry);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      s.listeners.delete(entry);
      if (s.listeners.size) return;
      // Deferred so an unsubscribe + resubscribe in the same tick (React StrictMode, re-render) keeps the sub.
      queueMicrotask(() => {
        if (s.listeners.size || this.subs.get(s.key) !== s) return;
        this.subs.delete(s.key);
        this.dropLocal(s);
        const conn = this.conns.get(s.shard);
        if (conn && conn.qids.get(s.qid) === s) {
          conn.qids.delete(s.qid);
          if (conn.ready) this.send(conn, { t: "unsub", qid: s.qid });
        }
        this.release(s.shard);
      });
    };
  }

  /**
   * Until the server answers: the adapter's local result (registered offline query) or cached value — watched when
   * the adapter can (re-run as the replica changes), else computed once.
   */
  private async loadLocal(sub: Sub): Promise<void> {
    const failed = (e: unknown) => this.report(new EmberError("local_query_failed", `${sub.fn}: ${(e as Error).message}`), { shard: sub.shard });
    try {
      await this.init;
      const offline = this.offline;
      if (!offline || this.subs.get(sub.key) !== sub || sub.confirmed) return;
      const request = { shard: sub.shard, fn: sub.fn, args: sub.args, argsJson: sub.argsJson, identity: this.localIdentity() };
      if (offline.watchQueryLocally) {
        const live = () => this.subs.get(sub.key) === sub && !sub.confirmed;
        const off = offline.watchQueryLocally(
          request,
          (r) => {
            if (!live() || !r) return;
            sub.local = r;
            this.recompute([sub]);
          },
          failed,
        );
        if (live()) sub.unwatchLocal = off;
        else off();
        return;
      }
      const r = await offline.runQueryLocally(request);
      if (!r || this.subs.get(sub.key) !== sub || sub.confirmed) return;
      sub.local = r;
      this.recompute([sub]);
    } catch (e) {
      failed(e);
    }
  }

  /** The server value arrived (or the sub is gone): the local value and its watch are done. */
  private dropLocal(sub: Sub): void {
    sub.local = null;
    const off = sub.unwatchLocal;
    sub.unwatchLocal = undefined;
    if (off) {
      try {
        off();
      } catch {
        /* the adapter is closing */
      }
    }
  }

  /** Hand confirmed values to the offline adapter (in server order). */
  private persist(subs: Iterable<Sub>): void {
    const offline = this.offline;
    if (!offline) return;
    for (const sub of subs) {
      if (!sub.confirmed) continue;
      try {
        const r = offline.applyPatch({ shard: sub.shard, fn: sub.fn, args: sub.args, argsJson: sub.argsJson, value: sub.confirmed.value, version: sub.version });
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((e) => this.report(new EmberError("storage_error", `could not persist ${sub.fn}: ${(e as Error).message}`), { shard: sub.shard }));
        }
      } catch (e) {
        this.report(new EmberError("storage_error", `could not persist ${sub.fn}: ${(e as Error).message}`), { shard: sub.shard });
      }
    }
  }

  /** One-shot query over HTTP (`POST /api/query`); does not open a socket. */
  async query<Q extends FunctionReference<"query">>(ref: Q | string, args?: Q["_args"], opts?: ShardOptions): Promise<Q["_returnType"]> {
    return (await this.http("query", getFunctionName(ref), toArgs(args), this.shardOf(opts))) as Q["_returnType"];
  }

  private async http(kind: "query" | "mutation" | "action", fn: string, args: Record<string, unknown>, shard: string): Promise<unknown> {
    if (!this.fetchImpl) throw new EmberError("no_fetch", "no fetch implementation available");
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = this.token ?? (await this.fetchToken().catch(() => null));
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.httpBase}/api/${kind}`, { method: "POST", headers, body: stringify({ fn, args, shard }) });
    } catch (e) {
      throw new EmberError("network_error", (e as Error).message ?? "network error");
    }
    let body: unknown;
    try {
      body = parse(await res.text());
    } catch {
      throw new EmberError("bad_response", `HTTP ${res.status}: response is not JSON`);
    }
    const b = body as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
    if (b && b.ok === true) return b.value;
    throw new EmberError(b?.error?.code ?? `http_${res.status}`, b?.error?.message ?? `HTTP ${res.status}`);
  }

  // ---------------------------------------------------------------------------------------------- mutations

  /**
   * Run a mutation over the shard's socket. The optimistic update (if any) is applied right away over confirmed
   * results and re-applied on every server change until the result arrives; a rejection rolls it back.
   */
  mutation<M extends FunctionReference<"mutation">>(ref: M | string, args?: M["_args"], opts?: MutationOptions<M["_args"]>): Promise<M["_returnType"]> {
    if (this.closed) return Promise.reject(new EmberError("closed", "client closed"));
    let shard: string;
    let a: Record<string, unknown>;
    try {
      shard = this.shardOf(opts);
      a = toArgs(args);
    } catch (e) {
      return Promise.reject(e);
    }
    const record: PendingMutationRecord = {
      mid: `${this.sessionId}-${++this.midCounter}`,
      shard,
      fn: getFunctionName(ref),
      args: a,
      createdAt: Date.now(),
    };
    return new Promise((resolve, reject) => {
      const p: Pending = { record, update: opts?.optimisticUpdate ?? this.options.optimisticUpdates?.[record.fn], authRetried: false, sentAuthSeq: -1, resolve, reject };
      this.pending.push(p);
      this.pendingByMid.set(record.mid, p);
      void Promise.resolve()
        .then(() => this.storage.put(record))
        .catch((e) => this.report(new EmberError("storage_error", `could not persist mutation: ${(e as Error).message}`), { shard }));
      if (p.update) this.recompute();
      const conn = this.ensure(shard);
      if (conn.ready) this.sendMut(conn, p);
      this.emitState();
    });
  }

  /**
   * Run an action over HTTP (`POST /api/action`). Actions run in the Worker (not queued offline, not optimistic);
   * `shard` is the shard its `ctx.runQuery/runMutation` target by default. Rejects with a typed EmberError.
   */
  async action<A extends FunctionReference<"action">>(ref: A | string, args?: A["_args"], opts?: ShardOptions): Promise<A["_returnType"]> {
    return (await this.http("action", getFunctionName(ref), toArgs(args), this.shardOf(opts))) as A["_returnType"];
  }

  // ---------------------------------------------------------------------------------------------- optimistic view

  /** Rebuild the visible value of `only` (or every) subscription: confirmed state + pending updates in order. */
  private recompute(only?: Sub[]): void {
    const overlay = new Map<string, unknown>();
    const withUpdates = this.pending.filter((p) => p.update);
    for (const p of withUpdates) {
      const defaultShard = p.record.shard;
      const keyOf = (ref: FunctionLike, args: unknown, o?: ShardOptions) =>
        this.subKey(o?.shard ?? defaultShard, getFunctionName(ref), stableStringify(toArgs(args)));
      const store: OptimisticLocalStore = {
        getQuery: (ref, args, o) => {
          const k = keyOf(ref, args, o);
          if (overlay.has(k)) return overlay.get(k) as any;
          return baseOf(this.subs.get(k))?.value as any;
        },
        setQuery: (ref, args, value, o) => {
          overlay.set(keyOf(ref, args, o), value);
        },
        getAllQueries: (ref, o) => {
          const fn = getFunctionName(ref);
          const shard = o?.shard ?? defaultShard;
          const out: Array<{ args: any; value: any }> = [];
          for (const s of this.subs.values()) {
            if (s.fn !== fn || s.shard !== shard) continue;
            out.push({ args: s.args, value: overlay.has(s.key) ? overlay.get(s.key) : baseOf(s)?.value });
          }
          return out;
        },
      };
      try {
        p.update!(store, p.record.args);
      } catch (e) {
        this.report(new EmberError("optimistic_update_failed", (e as Error).message), { shard: defaultShard });
      }
    }
    const changed: Sub[] = [];
    for (const s of only ?? this.subs.values()) {
      const optimistic = overlay.has(s.key);
      const base = baseOf(s);
      const value = optimistic ? overlay.get(s.key) : base?.value;
      const hasValue = optimistic ? value !== undefined : base !== null;
      const status: QueryStatus = s.error && !optimistic ? "error" : hasValue ? "success" : "loading";
      const error = s.error ?? undefined;
      const source = !s.confirmed && s.local && status === "success" ? s.local.source : undefined;
      const cur = s.snapshot;
      if (cur.status === status && cur.value === value && cur.error === error && cur.optimistic === optimistic && cur.source === source) continue;
      s.snapshot =
        status === "loading" && !error
          ? LOADING
          : Object.freeze(source ? { status, value, error, optimistic, source } : { status, value, error, optimistic });
      changed.push(s);
    }
    for (const s of changed) for (const l of [...s.listeners]) l();
  }

  // ---------------------------------------------------------------------------------------------- connection state

  connectionState(): ConnectionState {
    return this.stateSnapshot;
  }

  onConnectionStateChange(cb: () => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private buildState(): ConnectionState {
    const shards: Record<string, ShardConnectionState> = {};
    let connected = true;
    for (const [k, c] of this.conns) {
      shards[k] = c.state;
      if (this.needed(c) && c.state !== "open") connected = false;
    }
    return Object.freeze({ online: this.online, shards: Object.freeze(shards), connected, pendingMutations: this.pending.length });
  }

  private emitState(): void {
    const next = this.buildState();
    const prev = this.stateSnapshot;
    const same =
      prev.online === next.online &&
      prev.connected === next.connected &&
      prev.pendingMutations === next.pendingMutations &&
      Object.keys(prev.shards).length === Object.keys(next.shards).length &&
      Object.entries(next.shards).every(([k, v]) => prev.shards[k] === v);
    if (same) return;
    this.stateSnapshot = next;
    for (const l of [...this.stateListeners]) l();
  }

  // ---------------------------------------------------------------------------------------------- sockets

  private conn(shard: string): Conn {
    let c = this.conns.get(shard);
    if (!c) {
      c = {
        shard, ws: null, gen: 0, state: this.online ? "idle" : "offline", ready: false, attempt: 0, epoch: null,
        qids: new Map(), retryTimer: null, idleTimer: null, pingTimer: null, deadlineTimer: null,
        authSeq: 0, reauth: null,
      };
      this.conns.set(shard, c);
    }
    return c;
  }

  private needed(conn: Conn): boolean {
    for (const s of this.subs.values()) if (s.shard === conn.shard) return true;
    for (const p of this.pending) if (p.record.shard === conn.shard) return true;
    return false;
  }

  /** Make sure the shard's socket is open or on its way. */
  private ensure(shard: string): Conn {
    const conn = this.conn(shard);
    this.clearTimer(conn, "idleTimer");
    if (!this.closed && this.online && !conn.ws && !conn.retryTimer && conn.state !== "connecting") void this.connect(conn);
    return conn;
  }

  /** Nothing needs the shard any more: close after `idleTimeoutMs`. */
  private release(shard: string): void {
    const conn = this.conns.get(shard);
    if (!conn || this.needed(conn)) return;
    this.emitState();
    if (conn.retryTimer) {
      this.clearTimer(conn, "retryTimer");
      conn.state = this.online ? "idle" : "offline";
      this.emitState();
      return;
    }
    if (!conn.ws || conn.idleTimer) return;
    conn.idleTimer = setTimeout(() => {
      conn.idleTimer = null;
      if (this.needed(conn)) return;
      this.dropSocket(conn);
      conn.state = this.online ? "idle" : "offline";
      this.emitState();
    }, this.options.idleTimeoutMs ?? 10_000);
  }

  private async connect(conn: Conn): Promise<void> {
    if (!this.WS) {
      this.report(new EmberError("no_websocket", "no WebSocket implementation available"), { shard: conn.shard });
      return;
    }
    this.clearTimer(conn, "retryTimer");
    const gen = ++conn.gen;
    conn.state = "connecting";
    this.emitState();
    let token: string | null = null;
    try {
      await this.init;
      token = await this.fetchToken();
    } catch (e) {
      if (gen !== conn.gen) return;
      this.report(new EmberError("auth_failed", `auth token fetch failed: ${(e as Error).message}`), { shard: conn.shard });
      this.scheduleRetry(conn);
      return;
    }
    if (gen !== conn.gen || conn.ws) return;
    if (this.closed || !this.online || !this.needed(conn)) {
      conn.state = this.online ? "idle" : "offline";
      this.emitState();
      return;
    }
    let ws: WebSocketLike;
    try {
      ws = new this.WS(`${this.wsBase}/ws?shard=${encodeURIComponent(conn.shard)}`);
    } catch (e) {
      this.report(new EmberError("connect_failed", (e as Error).message), { shard: conn.shard });
      this.scheduleRetry(conn);
      return;
    }
    conn.ws = ws;
    const authGen = this.authGen;
    ws.onopen = () => {
      if (conn.ws !== ws) return;
      // The token may have changed while the socket was opening.
      const t = authGen === this.authGen ? token : this.token;
      const hello: ClientMessage = { t: "hello", clientId: this.clientIdValue!, protocol: PROTOCOL_VERSION };
      if (t) hello.token = t;
      if (this.options.rowDiff !== false) hello.features = ["rowdiff"];
      this.send(conn, hello);
    };
    ws.onmessage = (ev) => {
      if (conn.ws !== ws) return;
      this.onFrame(conn, ev.data);
    };
    ws.onclose = () => {
      if (conn.ws !== ws) return;
      this.onSocketGone(conn);
    };
    ws.onerror = () => {
      /* a close event follows */
    };
  }

  private scheduleRetry(conn: Conn): void {
    if (this.closed || !this.online || !this.needed(conn)) {
      conn.state = this.online ? "idle" : "offline";
      this.emitState();
      return;
    }
    const b = this.options.backoff ?? {};
    const initial = b.initialMs ?? 250;
    const max = b.maxMs ?? 30_000;
    const factor = b.factor ?? 2;
    const cap = Math.min(max, initial * factor ** Math.min(conn.attempt, 32));
    const delay = Math.round(cap / 2 + (this.random() * cap) / 2);
    conn.attempt++;
    conn.state = "waiting";
    this.clearTimer(conn, "retryTimer");
    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = null;
      void this.connect(conn);
    }, delay);
    this.emitState();
  }

  /** Socket closed (by the server, the network or us): forget socket-scoped state and retry if still needed. */
  private onSocketGone(conn: Conn): void {
    this.detachSocket(conn);
    this.scheduleRetry(conn);
  }

  private detachSocket(conn: Conn): WebSocketLike | null {
    const ws = conn.ws;
    conn.ws = null;
    conn.ready = false;
    conn.gen++;
    conn.qids.clear();
    this.clearTimer(conn, "pingTimer");
    this.clearTimer(conn, "deadlineTimer");
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    }
    return ws;
  }

  private dropSocket(conn: Conn): void {
    const ws = this.detachSocket(conn);
    try {
      ws?.close(1000, "client");
    } catch {
      /* ignore */
    }
  }

  /** Close and reopen right away (identity change before `ready`, sign out). */
  private restart(conn: Conn): void {
    this.dropSocket(conn);
    conn.attempt = 0;
    if (this.needed(conn) && this.online && !this.closed) void this.connect(conn);
    else {
      conn.state = this.online ? "idle" : "offline";
      this.emitState();
    }
  }

  private clearTimer(conn: Conn, k: "retryTimer" | "idleTimer" | "pingTimer" | "deadlineTimer"): void {
    const t = conn[k];
    if (t) clearTimeout(t);
    conn[k] = null;
  }

  private send(conn: Conn, m: ClientMessage | typeof PING): void {
    const ws = conn.ws;
    if (!ws || ws.readyState !== OPEN) return;
    try {
      ws.send(m === PING ? PING : stringify(m));
    } catch {
      // the close event will follow
    }
  }

  private sendSub(conn: Conn, sub: Sub): void {
    conn.qids.set(sub.qid, sub);
    const m: ClientMessage = { t: "sub", qid: sub.qid, fn: sub.fn, args: sub.args };
    if (sub.confirmed && sub.epoch && sub.epoch === conn.epoch && sub.authGen === this.authGen && !sub.error) {
      m.resume = { version: sub.version, epoch: sub.epoch };
    }
    this.send(conn, m);
  }

  private sendMut(conn: Conn, p: Pending): void {
    p.sentAuthSeq = conn.authSeq;
    this.send(conn, { t: "mut", mid: p.record.mid, fn: p.record.fn, args: p.record.args });
  }

  // ---------------------------------------------------------------------------------------------- heartbeat

  private armPing(conn: Conn): void {
    const hb = this.options.heartbeat;
    if (hb === false || !conn.ready) return;
    this.clearTimer(conn, "pingTimer");
    const interval = hb?.intervalMs ?? 25_000;
    conn.pingTimer = setTimeout(() => {
      conn.pingTimer = null;
      this.ping(conn);
    }, Math.round(interval * (1 - this.random() / 5)));
  }

  private ping(conn: Conn): void {
    const hb = this.options.heartbeat;
    if (hb === false || !conn.ready || conn.deadlineTimer) return;
    this.clearTimer(conn, "pingTimer");
    this.send(conn, PING);
    conn.deadlineTimer = setTimeout(() => {
      conn.deadlineTimer = null;
      // Half-open socket: drop it and reconnect like after any close.
      this.dropSocket(conn);
      conn.attempt = 0;
      this.scheduleRetry(conn);
    }, hb?.timeoutMs ?? 10_000);
  }

  /** Any frame proves the socket alive. */
  private heard(conn: Conn): void {
    if (!conn.deadlineTimer) return;
    this.clearTimer(conn, "deadlineTimer");
    this.armPing(conn);
  }

  // ---------------------------------------------------------------------------------------------- connectivity

  private onConnectivity(e: ConnectivityEvent): void {
    if (this.closed) return;
    if (e === "offline") {
      this.online = false;
      for (const conn of this.conns.values()) {
        this.dropSocket(conn);
        this.clearTimer(conn, "retryTimer");
        conn.state = "offline";
      }
      this.emitState();
      return;
    }
    if (e === "online" || e === "foreground") {
      const wasOffline = !this.online;
      this.online = true;
      for (const conn of this.conns.values()) {
        if (!this.needed(conn)) {
          if (conn.state === "offline") conn.state = "idle";
          continue;
        }
        if (conn.ws && conn.ready) {
          // Back from background: a quick ping finds a socket the OS killed silently.
          if (e === "foreground") this.ping(conn);
          continue;
        }
        if (conn.ws) continue;
        conn.attempt = 0;
        void this.connect(conn);
      }
      if (wasOffline) this.emitState();
    }
  }

  // ---------------------------------------------------------------------------------------------- frames

  private onFrame(conn: Conn, data: unknown): void {
    this.heard(conn);
    if (typeof data !== "string") return;
    if (data === PONG) return;
    let m: ServerMessage;
    try {
      m = parse(data) as ServerMessage;
    } catch {
      this.report(new EmberError("bad_frame", "server sent invalid JSON"), { shard: conn.shard });
      return;
    }
    switch (m.t) {
      case "ready":
        return this.onReady(conn, m);
      case "snap": {
        const sub = conn.qids.get(String(m.qid));
        if (!sub) return;
        if (m.unchanged) {
          if (!sub.confirmed) return; // nothing to keep; a full snap would be needed (server bug)
        } else {
          sub.confirmed = { value: m.value };
          this.dropLocal(sub);
        }
        sub.version = m.version;
        sub.epoch = conn.epoch;
        sub.authGen = this.authGen;
        sub.error = null;
        if (!m.unchanged) this.persist([sub]);
        return this.recompute();
      }
      case "patch": {
        const changed: Sub[] = [];
        for (const c of m.changes) {
          const sub = conn.qids.get(String(c.qid));
          if (!sub) continue;
          if (c.diff) {
            // Applied to the confirmed value (optimistic layers are re-applied on top by recompute).
            let next: unknown;
            try {
              next = applyRowDiff(sub.confirmed?.value, c.diff);
            } catch (e) {
              // Our base is not the server's: resubscribe without resume for a full snapshot.
              this.report(new EmberError("rowdiff_mismatch", (e as Error).message), { shard: conn.shard });
              sub.epoch = null;
              this.send(conn, { t: "unsub", qid: sub.qid });
              this.sendSub(conn, sub);
              continue;
            }
            sub.confirmed = { value: next };
          } else sub.confirmed = { value: c.value };
          this.dropLocal(sub);
          sub.error = null;
          changed.push(sub);
        }
        // Every confirmed value on this socket is current as of this version.
        for (const sub of conn.qids.values()) if (sub.confirmed && sub.version < m.version) sub.version = m.version;
        this.persist(changed);
        // The confirmed values now include these mutations: drop their optimistic layers in the same recompute, so
        // the confirmed row and the optimistic row of one mutation are never shown together. Their mres follows.
        for (const mid of m.mids ?? []) {
          const p = this.pendingByMid.get(String(mid));
          if (p && p.record.shard === conn.shard) p.update = undefined;
        }
        return this.recompute();
      }
      case "mres": {
        const p = this.pendingByMid.get(String(m.mid));
        if (!p || p.record.shard !== conn.shard) return;
        if (!m.ok && m.error.code === "auth_expired" && !p.authRetried) {
          // Refused before running (not deduped): re-auth, then resend once with the same mid.
          p.authRetried = true;
          if (conn.authSeq > p.sentAuthSeq) {
            this.sendMut(conn, p);
            return;
          }
          void this.reauth(conn).then((r) => {
            if (this.pendingByMid.get(p.record.mid) !== p) return;
            if (r === "sent") this.sendMut(conn, p);
            else if (r === "failed") this.settle(conn, p, m);
            // "gone": the next socket resends every pending mutation after `ready`
          });
          return;
        }
        return this.settle(conn, p, m);
      }
      case "err": {
        const err = new EmberError(m.code, m.message);
        if (m.qid !== undefined) {
          const sub = conn.qids.get(String(m.qid));
          if (!sub) return;
          if (m.code === "auth_expired") {
            // The server dropped this `sub`: subscribe again once a fresh token is sent.
            conn.qids.delete(sub.qid);
            void this.reauth(conn).then((r) => {
              if (this.subs.get(sub.key) !== sub || conn.qids.has(sub.qid) || !conn.ready) return;
              if (r === "sent") this.sendSub(conn, sub);
              else if (r === "failed") {
                sub.error = err;
                this.recompute([sub]);
              }
            });
            return;
          }
          // The server keeps a failing subscription registered and sends a `patch` once it succeeds again.
          sub.error = err;
          return this.recompute([sub]);
        }
        this.report(err, { shard: conn.shard });
        return;
      }
      case "authExpired":
        void this.reauth(conn);
        return;
      default:
        return;
    }
  }

  private onReady(conn: Conn, m: Extract<ServerMessage, { t: "ready" }>): void {
    conn.ready = true;
    conn.attempt = 0;
    conn.epoch = m.epoch;
    conn.state = "open";
    for (const sub of this.subs.values()) if (sub.shard === conn.shard) this.sendSub(conn, sub);
    for (const p of this.pending) if (p.record.shard === conn.shard) this.sendMut(conn, p);
    this.armPing(conn);
    this.emitState();
    if (!this.needed(conn)) this.release(conn.shard);
  }

  /** The mutation's final answer: remove it, roll back or keep its effects, settle the caller. */
  private settle(conn: Conn, p: Pending, m: Extract<ServerMessage, { t: "mres" }>): void {
    if (this.pendingByMid.get(p.record.mid) !== p) return;
    this.pendingByMid.delete(p.record.mid);
    const i = this.pending.indexOf(p);
    if (i >= 0) this.pending.splice(i, 1);
    void Promise.resolve()
      .then(() => this.storage.remove(p.record.mid))
      .catch(() => undefined);
    // Usually already dropped by the patch listing this mid; a rejected (or patch-less) mutation drops it here.
    if (p.update) this.recompute();
    if (m.ok) p.resolve(m.value);
    else p.reject(new EmberError(m.error.code, m.error.message));
    this.emitState();
    this.release(conn.shard);
  }

  private report(e: EmberError, info: { shard?: string }): void {
    if (this.options.onError) this.options.onError(e, info);
  }
}

/** Mutation ids are strings; the server echoes them back as given. */
export type MutationId = Id;
