import { browserConnectivity, type ConnectivityEvent, type ConnectivitySource } from "./connectivity.ts";
import { EmberError, errorFromWire, type WireErrorLike } from "./errors.ts";
import type { ClientFiles, UploadData, UploadedFile, UploadFileOptions } from "./files.ts";
import {
  getFunctionName,
  getFunctionShard,
  routeShard,
  unsafeRef,
  type AnyFunctionReference,
  type ArgsAndOptions,
  type FunctionReference,
} from "./functions.ts";
import { applyRowDiff, applyValueDiff, claimKey, reuseUnchanged, validate, type ObjectShape, type RowDiff, type ShardSpec, type ValueDiff } from "@freecorps/ember-values";
import { jwtPayload } from "./jwt.ts";
import { MAX_BATCH_BYTES, MAX_BATCH_MESSAGES, PING, PONG, PROTOCOL_VERSION, type ClientMessage, type Id, type ServerMessage } from "./protocol.ts";
import {
  isStorageAdapter,
  MemoryPendingStorage,
  type LocalIdentity,
  type LocalQueryResult,
  type PendingMutationRecord,
  type PendingStorage,
  type StorageAdapter,
} from "./storage.ts";
import { parse, stableStringify, stringify } from "./wire.ts";
import type { PageHost } from "./paginate.ts";
import { RoutedStore, type ClaimRoute } from "./route.ts";
import { FrameQueue, withoutDeliveries, zframeSupported } from "./zframe.ts";
import type { CachedSnapshot, SnapshotCache } from "./snapshot-cache.ts";
// Type-only: the multi-tab hub and the upload helpers are subpaths (`@freecorps/ember-client/multitab`, `/files`), or a
// lazy `import()` for the old options, never in the static graph of an app that does not use them.
import type { MultiTab, MultiTabHost, MultiTabOptions, MultiTabPlugin, TabRole } from "./multitab.ts";

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
  optimisticUpdates?: Record<string, OptimisticUpdate<any>>;
  /**
   * WebSocket implementation. Default: `globalThis.WebSocket`. `null`: no sockets at all — a client that renders on a
   * server (SSR; Node 22+ and Workers have a global WebSocket): queries go over HTTP, and `useSuspenseQuery` reads them
   * once (`fetchForHydration` + `hydrate`) instead of subscribing.
   */
  WebSocket?: WebSocketConstructor | null;
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
   * `{remove, upsert, at?, order?}` instead of the whole value when that is smaller; and (feature "vdiff") objects
   * holding arrays of docs (`paginate()`'s `{page, ...}`) with a value diff. Default true.
   */
  rowDiff?: boolean;
  /**
   * Feature "zframe" (protocol v1.5): ask the shard to send frames above 2 KiB compressed (raw DEFLATE, binary
   * messages), decoded here with `DecompressionStream`. A large `snap` or `patch` is typically 5–10× smaller on the
   * wire (a 120-row list: 21.6 KB → 2.5 KB), at the cost of the shard's CPU to compress it (billed) and the client's to
   * decompress. Worth it on slow or metered links (mobile web); off by default. Announced only where the platform
   * decodes it (not React Native/Hermes); a runtime without the feature keeps sending text.
   */
  zframe?: boolean;
  /** How long a shard socket stays open without subscriptions or pending mutations. Default 10 s. */
  idleTimeoutMs?: number;
  /**
   * How long a subscription stays live after its last listener leaves. A listener that comes back within it (a route
   * change and back, a list item remounting) reuses the live subscription and its value: no `unsub` + `sub` round
   * trip. At most `UNSUBSCRIBE_GRACE_MAX` (64) wait at once; the oldest goes first. Default 0: dropped at the end of
   * the turn (an unsubscribe + resubscribe in the same tick still keeps it).
   */
  unsubscribeGraceMs?: number;
  /**
   * Pre-warm (PLAN §19 "Primeira requisição"): open the shard socket while the auth token is being fetched (the TLS
   * handshake and the Durable Object's cold wake overlap the token round trip) and send the subscriptions right after
   * `hello`, without waiting for `ready` (the server handles a socket's frames in order). Default true; `false` =
   * token first, then socket, then subscriptions after `ready`.
   */
  pipelineConnect?: boolean;
  /**
   * While a shard's socket is still opening, fetch the first value of a new subscription over HTTP (one round trip
   * to the shard instead of the upgrade plus `sub`) and subscribe with `resume`, so the socket answers `unchanged`.
   * Only when there is no auth, or the token is known before the socket opens (a token fetched over the network takes
   * as long as the upgrade: nothing to save). At most `httpFirstLimit` (default 8) per connection attempt. Default true.
   * The fetches of one turn for one shard go out as one `POST /api/query/batch` (one request and one shard call) on a
   * runtime that serves it (feature "qbatch"); an older one gets `POST /api/query` per query.
   */
  httpFirst?: boolean;
  httpFirstLimit?: number;
  /** Refresh a JWT this long before its `exp` and send `{t:"auth"}`. Default 30 s. `false` disables. */
  refreshAuthBeforeExpiryMs?: number | false;
  /** Stable client id (else read from storage, else generated and stored). */
  clientId?: string;
  /** Errors not tied to a call (`err` without qid, failed auth refresh, ...). */
  onError?: (error: EmberError, info: { shard?: string }) => void;
  /** Result of a mutation restored from storage after a restart (no caller is waiting for it). */
  onRestoredMutationResult?: (record: PendingMutationRecord, result: { ok: true; value: unknown } | { ok: false; error: EmberError }) => void;
  /**
   * Argument shapes by function name (`argShapes` from `_generated/validators`): arguments are validated before they
   * are sent (and before an offline mutation is queued); an invalid call rejects with `ValidationError`
   * (`data.issues`, `outcome: "rejected"`). Defaults and id tables are the server's business.
   */
  validate?: Readonly<Record<string, object>>;
  /**
   * A light snapshot cache without the offline engine (`keyValueSnapshotCache(localStorage)`, `memorySnapshotCache()`):
   * the last confirmed value of each subscription, per identity. A repeat visit shows it at once (`source: "cache"`)
   * and subscribes with `resume` from it: the shard answers `unchanged` when nothing the query read has changed. Never
   * holds errors; cleared on sign-out; a value stored under one identity is never shown or resumed under another, nor
   * with an expired token. Ignored when `storage` is a full offline `StorageAdapter` (it caches values itself).
   */
  snapshotCache?: SnapshotCache;
  /**
   * One WebSocket per shard for every tab of the origin (opt-in): the tab holding a Web Lock keeps the sockets and the
   * other tabs' clients go through it over a BroadcastChannel; each tab's subscriptions, mutations and identity stay
   * its own (a tab signed in as someone else gets a socket of its own), and a leader that goes away hands over to the
   * next tab (mutations without an answer are resent with the same mid and the shared clientId: the shard dedups
   * them). Tabs subscribed to the same query share one subscription on the shard (contracts.md "Várias abas").
   * Without Web Locks or BroadcastChannel (React Native, older Node, old browsers) nothing changes.
   *
   * `multiTab({ name, openTimeoutMs, ... })` from `@freecorps/ember-client/multitab`: the hub is in the app's bundle
   * only when it uses it. `true` or a plain `{ name, ... }` still work: the hub is then loaded with `import()` when the
   * client is built (a chunk of its own in a bundler that splits code), and the first socket waits for it.
   */
  multiTab?: boolean | MultiTabOptions | MultiTabPlugin;
  /**
   * `files()` from `@freecorps/ember-client/files`: `client.files` is the upload helper itself. Without it, the
   * first `client.files.upload()` loads it with `import()` (a chunk of its own in a bundler that splits code).
   */
  files?: (client: EmberClient) => FilesApi;
  /** Injected for tests. */
  random?: () => number;
}

/**
 * A query's value fetched on the server (SSR, a loader) with what the browser client needs to subscribe without
 * downloading it again (`client.fetchForHydration` → serialize with `encodeJson` → `client.hydrate`). Its args, shard
 * and value are the app's data; `version`, `epoch` and `ik` are the shard's.
 */
export interface HydratedQuery<T = unknown> {
  readonly fn: string;
  readonly args: Record<string, unknown>;
  readonly shard: string;
  readonly value: T;
  readonly version: number;
  readonly epoch: string;
  readonly ik: string;
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

export interface QueryOptions extends ShardOptions {
  /**
   * Override automatic transport selection. "socket" sends q on an existing ready socket even without negotiation
   * (requires a runtime that supports q). Without an open socket, queries always fall back to HTTP.
   */
  transport?: "socket" | "http";
}

/** A query reference (`api.x.y`). */
export type QueryReference = FunctionReference<"query", any, any, any, any, any>;
export type MutationReference = FunctionReference<"mutation", any, any, any, any, any>;
export type ActionReference = FunctionReference<"action", any, any, any, any, any>;

export interface OptimisticLocalStore {
  /** Current (optimistic) value of a subscribed query, or undefined when it is not loaded. */
  getQuery<Q extends QueryReference>(ref: Q, ...rest: ArgsAndOptions<Q, ShardOptions>): Q["_returnType"] | undefined;
  /** Overwrite a query's visible value until the mutation settles. */
  setQuery<Q extends QueryReference>(ref: Q, args: Q["_args"], value: Q["_returnType"] | undefined, opts?: ShardOptions): void;
  /**
   * `setQuery(ref, args, fn(current))` when the query is loaded (a no-op otherwise): the usual "add this row to the
   * list" update, typed by the query's result.
   */
  updateQuery<Q extends QueryReference>(ref: Q, args: Q["_args"], fn: (current: Q["_returnType"]) => Q["_returnType"], opts?: ShardOptions): void;
  /** Every loaded query of a function, with its args. */
  getAllQueries<Q extends QueryReference>(ref: Q, opts?: ShardOptions): Array<{ args: Q["_args"]; value: Q["_returnType"] | undefined }>;
}

/**
 * `mutation`: the pending mutation this update is for, the same object on every re-run while it is pending (a
 * stable key for anything the update derives once, such as local ids).
 */
export type OptimisticUpdate<Args = Record<string, unknown>> = (store: OptimisticLocalStore, args: Args, mutation: PendingMutationRecord) => void;

/** One entry of `optimisticUpdatesFor(...)`: a mutation and its update, typed by the mutation's args. */
export type OptimisticEntry = { readonly name: string; readonly update: OptimisticUpdate<any> };

/** `optimistic(api.todos.add, (store, { listId, text }) => ...)`: `args` typed by the mutation. */
export function optimistic<M extends MutationReference>(ref: M, update: OptimisticUpdate<M["_args"]>): OptimisticEntry {
  return { name: getFunctionName(ref), update: update as OptimisticUpdate<any> };
}

/**
 * The client's `optimisticUpdates` option from typed entries (they also apply to mutations restored after a restart):
 * `new EmberClient({ optimisticUpdates: optimisticUpdatesFor(optimistic(api.todos.add, ...), ...) })`.
 */
export function optimisticUpdatesFor(...entries: OptimisticEntry[]): Record<string, OptimisticUpdate<any>> {
  const out: Record<string, OptimisticUpdate<any>> = {};
  for (const e of entries) {
    if (out[e.name]) throw new EmberError("bad_args", `optimisticUpdatesFor: ${e.name} given twice`);
    out[e.name] = e.update;
  }
  return out;
}

export interface MutationOptions<Args = Record<string, unknown>> extends ShardOptions {
  optimisticUpdate?: OptimisticUpdate<Args>;
}

export type ShardConnectionState = "idle" | "connecting" | "open" | "waiting" | "offline";

export interface ConnectionState {
  readonly online: boolean;
  /**
   * Every shard the client has a socket for, or had one until it went idle and something of the shard is still kept
   * (waiting acks). A shard whose idle socket closed with nothing left (`idleTimeoutMs` after its last subscription,
   * query and mutation) leaves the list.
   */
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
  /** `identityGen` the request behind `local` was made under: it is someone else's value once that changes. */
  localGen?: number;
  /** Stops the adapter's local watch (`watchQueryLocally`). */
  unwatchLocal?: (() => void) | undefined;
  /** Bumped by each read of the offline adapter / snapshot cache: only the latest one may set `local`. */
  localSeq?: number;
  version: number;
  epoch: string | null;
  /** `authGen` at the time `confirmed` was produced: resume is only valid for the same identity. */
  authGen: number;
  /** `conn.authSeq` when its last `sub` went out: an `auth` sent after it covers that `sub`'s `auth_expired` refusal. */
  sentAuthSeq?: number;
  /** Identity tag of `confirmed` (feature "ident"), echoed in `resume.ik`. */
  ik?: string | undefined;
  /**
   * Its first value is being fetched over HTTP (`httpFirst`): the pipelined `sub` waits for it, or for `ready` (which
   * cancels the fetch: the socket's snapshot replaces it, one download instead of two).
   */
  httpFirst?: boolean;
  /** Cancels that fetch (`ready` first, unsubscribe, `close()`). */
  httpAbort?: AbortController | undefined;
  /** `confirmed` came over HTTP (`httpFirst`), not from a socket yet. */
  fromHttp?: boolean;
  /**
   * Whose value `confirmed` is, as a cache key (`identityCacheKey`): `"anon"` signed out; undefined when the client
   * cannot tell (an opaque token): such a value is never cached.
   */
  owner?: Owner | undefined;
  /** The offline/snapshot cache is being read: the `sub` waits for it (to resume from a cached value), briefly. */
  localPending?: boolean;
  localTimer?: ReturnType<typeof setTimeout> | undefined;
  /** The cached value the last `sub` asked to resume from (`unchanged` makes it the confirmed value). */
  resumeBase?: { value: unknown; ik: string } | undefined;
  /**
   * The value the last `sub` offered in `resume` (`unchanged` confirms that one only), and `conn.authSeq` when it went:
   * an `auth` frame sent since means the shard may have answered for the identity before it, not the socket's now.
   */
  resumeOffered?: { value: unknown; authSeq: number } | undefined;
  /**
   * A `sub` went out on this socket and its answer has not come: a `patch` for other queries does not make this value
   * current (the shard has not checked it yet), so neither the version nor the snapshot cache moves with it.
   */
  awaitingReply?: boolean;
  error: EmberError | null;
  snapshot: QuerySnapshot;
  /** `identityGen` when its last listener left: whose value it holds while it has none. */
  leftGen?: number;
  /** No listener left: dropped when this fires (`unsubscribeGraceMs`), unless one comes back. */
  graceTimer?: ReturnType<typeof setTimeout> | undefined;
}

interface Pending {
  record: PendingMutationRecord;
  /** Cleared once a `patch` lists the mid: the confirmed state already includes the mutation's effects. */
  update: OptimisticUpdate | undefined;
  /** An `auth_expired` mres was answered by re-auth + resend (done at most once). */
  authRetried: boolean;
  /** Not sent because no identity is signed in (it waits for its own): sent after the next `auth` frame. */
  held?: boolean;
  /** `conn.authSeq` when the `mut` was last sent. */
  sentAuthSeq: number;
  resolve(value: unknown): void;
  reject(e: EmberError): void;
}

interface Conn {
  /** Who this socket runs as: the subject of the token its `hello` or last `auth` frame carried (null: anonymous). */
  identity?: LocalIdentity | null;
  shard: string;
  ws: WebSocketLike | null;
  gen: number;
  state: ShardConnectionState;
  ready: boolean;
  /** `hello` went out on the current socket: with `pipelineConnect`, subscriptions may follow before `ready`. */
  helloSent: boolean;
  /** The socket's token is not a JWT: who it runs as is unknown here (its values are never cached). */
  opaque?: boolean;
  /** The server confirmed feature "ident" on the current socket: `resume` carries the snapshot's identity tag. */
  ident?: boolean;
  query?: boolean;
  /**
   * `authGen` of the identity this socket runs as (the token of its `hello` or last `auth`); -1 when unknown. A
   * one-shot query only uses the socket while it equals the client's: during a sign-in/out it goes over HTTP.
   */
  authGen?: number;
  /** One-shot callers belong only to this socket; never persisted or replayed on another socket. */
  queries: Map<string, { resolve: (value: unknown) => void; reject: (error: EmberError) => void; retry: () => void }>;
  /**
   * The server confirmed feature "ack" on the current socket: settled mutations are acknowledged (`{t:"ack"}`), so the
   * shard never writes a dedup row for them. `acks` waits for the next flush; `ackGen` is the socket they belong to
   * and `ackAuth` the `authGen` it ran as: a socket that drops keeps them for the next one of the same identity.
   */
  ack?: boolean;
  /**
   * The server confirmed feature "batch" on the current socket: what one turn sends goes out as one frame (a JSON
   * array), at the end of the turn. `out` waits for that flush.
   */
  batch?: boolean;
  /**
   * What the last `ready` from this shard said about "batch" (kept across sockets; undefined: never connected). Until
   * a server said no, subscriptions pipelined before `ready` go in one array frame too.
   */
  serverBatch?: boolean;
  /**
   * This turn's frame (`flushOut`): its messages, the qids of the `sub`s and `unsub`s among them, the index of each
   * `mut` by mid (a mutation dropped before the flush is taken out: `drop`) and of each `sub` by qid (an `unsub` of
   * the same turn takes both out: the shard never hears of that subscription). `acks`/`ackVersion`: the acks it
   * carries, put back if the send fails.
   */
  out?: { frames: string[]; bytes: number; subs: string[]; unsubs: string[]; muts: Map<Id, number>; subAt: Map<string, number>; acks: Id[]; ackVersion?: number | undefined } | undefined;
  /**
   * The socket whose `send` threw: nothing more goes out on it (a later frame of the same loop could run under the
   * identity of an `auth` frame that was lost), until it is dropped right after the loop (`sendFrame`).
   */
  failedWs?: WebSocketLike | undefined;
  /**
   * Array frames sent before `ready` (optimistically: the server has not confirmed "batch" yet) and the qids of the
   * `sub`s and `unsub`s they carried. A server without the feature refuses each such frame (one qid-less
   * `bad_frame`): those subs are sent again one by one (the unsubs too, unless their sub was refused as well), and
   * that many refusals are not reported.
   */
  batchPipelined?: { arrays: number; qids: Set<string>; unsubs: Set<string> } | undefined;
  acks?: Id[];
  ackGen?: number;
  ackAuth?: number;
  /** Lowest `mres` version among `acks` (they go out early once the shard's version has moved far past it). */
  ackVersion?: number | undefined;
  ackTimer?: ReturnType<typeof setTimeout> | null;
  /** Removals from pending storage still running before their `ack` can go out (the socket stays needed). */
  acking?: number;
  /**
   * Qids whose `sub` went out before `ready` with `resume.ik` (pipelined: the tag came from an "ident" server of the
   * same epoch). If `ready` does not confirm "ident" (a rolled-back runtime), that server refused them as bad frames:
   * they are sent again without the tag, and that many qid-less `bad_frame` errors are not reported.
   */
  ikPipelined?: Set<string> | undefined;
  /** Pending qid-less `bad_frame` refusals of `ikPipelined` subs, swallowed instead of reported. */
  ikRefusals?: number;
  attempt: number;
  epoch: string | null;
  /** Subscriptions registered on the current socket, by qid. */
  qids: Map<string, Sub>;
  /** Subscriptions the shard refused as `auth_expired` with no fresh token yet: sent again with the next `auth`. */
  authRefused?: Set<Sub> | undefined;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /**
   * `online`/`foreground` arrived while an attempt was in flight: if that attempt fails, its retry waits the short
   * spread delay (`spreadDelay`), not the backoff. Cleared on `ready` and on `offline`.
   */
  quickRetry?: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setTimeout> | null;
  /** `Date.now()` of the last frame from the current socket: the heartbeat pings only after that long a silence. */
  heardAt?: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  /** Count of `auth` frames sent on this shard's sockets. */
  authSeq: number;
  /** The token the current socket last sent (`hello` or `auth`; null: none): the same one is never sent again. */
  lastToken?: string | null | undefined;
  /** HTTP first fetches started for the current connection attempt (`httpFirst`). */
  httpFirsts?: number;
  /** Subscriptions of this shard whose first value is still coming over HTTP (`httpFirst`). */
  httpFirstWaiting?: Set<Sub> | undefined;
  /** Those whose answer came: their `sub`s go together once the last one settles (one frame, not one each). */
  httpFirstDone?: Sub[] | undefined;
  /** HTTP first fetches started this turn, sent together at its end (`flushHttpBatch`). */
  httpBatch?: HttpFirstItem[] | undefined;
  /** In-flight refresh after `authExpired` (shared by every frame that bounced). */
  reauth: Promise<ReauthOutcome> | null;
}

/** An HTTP first value: the shard's version, epoch and the caller's identity tag (`resume` of the `sub` after it). */
type HttpFirstValue = { value: unknown; version: number; epoch: string; ik: string };

/** One `httpFirst` fetch waiting for the end of its turn: the generations it was asked under, and its answer. */
interface HttpFirstItem {
  sub: Sub;
  signal: AbortSignal | undefined;
  authGen: number;
  identityGen: number;
  resolve: (r: HttpFirstValue | null) => void;
  reject: (e: unknown) => void;
}

/** An HTTP call's answer: status, parsed body, whose token it went with (`ownerKey`), the `authGen` it started under. */
/** `identityGen`: the identity it was sent as (after its token was read; null when no token was known yet). */
type HttpAnswer = { status: number; body: unknown; owner: string; authGen: number; identityGen: number | null };

/** One query of `query()` / `fetchForHydration` waiting for the end of its turn (`flushQueries`). */
interface QueuedQuery {
  fn: string;
  /** The arguments encoded when the query was asked (`stringify`): a caller changing its object later changes nothing. */
  args: string;
  /**
   * `authGen` / `identityGen` when it was asked: the request reads the token at flush, so a query asked as one identity
   * is never sent (or answered) with another's (`flushQueries` refuses it with `identity_changed`). `identityGen` is
   * null when the token was not known yet: the query goes as whoever the source's first answer says (as one alone would).
   */
  authGen: number;
  identityGen: number | null;
  resolve: (r: HttpAnswer) => void;
  reject: (e: unknown) => void;
}

/** Most queries one `POST /api/query/batch` carries (the runtime's `MAX_QUERY_BATCH`). */
const MAX_QUERY_BATCH = 32;

/** `{fn, args, shard?}` as JSON text, `args` already encoded (the canonical JSON composes: a value's text is its parts'). */
function queryEntry(fn: string, args: string, shard?: string): string {
  return `{"fn":${JSON.stringify(fn)},"args":${args}${shard === undefined ? "" : `,"shard":${JSON.stringify(shard)}`}}`;
}

/** An HTTP query answer as `httpFirst` uses it: a value with version, epoch and `ik` (an older runtime: null). */
function httpFirstValue(r: unknown): HttpFirstValue | null {
  const b = r as { ok?: unknown; value?: unknown; version?: unknown; epoch?: unknown; ik?: unknown } | null;
  if (b?.ok !== true || typeof b.version !== "number" || typeof b.epoch !== "string" || typeof b.ik !== "string") return null;
  return { value: b.value, version: b.version, epoch: b.epoch, ik: b.ik };
}

/** A confirmed value another subscription starts from (pagination pins a page with the value it already holds). */
interface Seed {
  value: unknown;
  version: number;
  epoch: string | null;
  ik: string | undefined;
  authGen: number;
  fromHttp: boolean;
  owner: Owner | undefined;
}

/** Who a confirmed value was computed for: its cache key (`identityCacheKey`) and the identity (null: signed out). */
type Owner = { key: string; identity: LocalIdentity | null };

/** How long a new subscription waits for the offline / snapshot cache before its `sub` goes without `resume`. */
const LOCAL_WAIT_MS = 250;
/** At most this many subscriptions without listeners wait out `unsubscribeGraceMs` at once. */
const UNSUBSCRIBE_GRACE_MAX = 64;
/** Reconnects after `online`/`foreground` are spread over up to this long (no thundering herd). */
const RECONNECT_SPREAD_MS = 250;
/** Longest wait between refreshes that keep getting the same token back. */
const REFRESH_BACKOFF_MAX_MS = 30_000;
/**
 * Feature "ack": settled mutations are acknowledged together, at most this long after the first (or with any other
 * frame going out, `ACK_MAX` waiting, a busy shard (`ACK_VERSION_SPAN`), the page hidden, or before the socket
 * closes). Only the fallback for an app that went quiet: an ack alone is one more Durable Object event (and wakes a
 * hibernated one), so it waits long enough for most to ride with the next frame instead. Waiting is safe: the shard
 * keeps an outcome in its ring for `changeLogVersions` (default 256) commits and then in the dedup generations, so a
 * retry always finds it; an ack that comes after its slot is reused only costs that one spill row.
 */
const ACK_DELAY_MS = 30_000;
/** Acks waiting that go out at once. */
const ACK_MAX = 64;
/** Most acks kept for the next socket while the shard has none (the oldest go first: their outcomes left the ring). */
const ACK_KEEP_MAX = 4_096;
/** Acks go out at once when the shard's version has moved this far past the oldest one waiting (a busy shard). */
const ACK_VERSION_SPAN = 64;

/** Cache key of an identity: who a cached value belongs to. */
const identityCacheKey = (id: LocalIdentity | null): string => (id ? `u\u0000${id.issuer ?? ""}\u0000${id.subject}` : "anon");

/** The owner of a value computed for `token` (undefined: an opaque token, nobody can tell whose). */
function tokenOwner(token: string | null): Owner | undefined {
  if (!token) return { key: "anon", identity: null };
  const id = jwtIdentity(token);
  return id ? { key: identityCacheKey(id), identity: id } : undefined;
}

/**
 * Whom a token answers for, to compare within this process: its identity's cache key, `"anon"` without one, the token
 * itself when opaque (no identity to read: another token may be anyone).
 */
function ownerKey(token: string | null): string {
  return tokenOwner(token)?.key ?? `opaque:${token}`;
}

/**
 * Two tokens of one identity (a renewed JWT): the same subject, or both opaque (nothing to compare: the fetcher is the
 * same, and `identityGen` catches a JWT that says otherwise).
 */
function sameOwner(a: string, b: string): boolean {
  return tokenOwner(a)?.key === tokenOwner(b)?.key;
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

/** What the client reads of a JWT (decoded once per token: the same token is looked at on every frame and refresh). */
type JwtInfo = { exp: number | null; identity: LocalIdentity | null };
const jwtCache = new Map<string, JwtInfo>();
const NOT_JWT: JwtInfo = Object.freeze({ exp: null, identity: null });

function jwtInfo(token: string): JwtInfo {
  const hit = jwtCache.get(token);
  if (hit) return hit;
  let info = NOT_JWT;
  const p = jwtPayload(token);
  if (p) {
    const identity = typeof p.sub !== "string" ? null : Object.freeze(typeof p.iss === "string" ? { subject: p.sub, issuer: p.iss } : { subject: p.sub });
    info = Object.freeze({ exp: typeof p.exp === "number" ? p.exp : null, identity });
  }
  // A few tokens live at once (the current one, the one being refreshed): keep the last ones.
  if (jwtCache.size >= 8) jwtCache.delete(jwtCache.keys().next().value!);
  jwtCache.set(token, info);
  return info;
}

function jwtExp(token: string): number | null {
  return jwtInfo(token).exp;
}

/** `{subject: sub, issuer: iss}` of a JWT payload (not verified: only used to run queries on local data). */
function jwtIdentity(token: string): LocalIdentity | null {
  const id = jwtInfo(token).identity;
  // A copy: callers may keep or compare it, never share the cached object.
  return id ? { ...id } : null;
}

function toArgs(args: unknown): Record<string, unknown> {
  if (args === undefined) return {};
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new EmberError("bad_args", "args must be an object");
  return args as Record<string, unknown>;
}

/** `client.files`: uploads (PLAN §7). `ClientFiles` (`@freecorps/ember-client/files`) is one. */
export interface FilesApi {
  /** Absolute URL for a path returned by the server (proxy-mode URLs are paths on the deployment). */
  url(pathOrUrl: string): string;
  upload(data: UploadData, opts?: UploadFileOptions): Promise<UploadedFile>;
}

/** `client.files` without option `files`: the helper is loaded on the first upload (`url` needs none of it). */
function lazyFiles(client: EmberClient): FilesApi {
  let real: Promise<ClientFiles> | undefined;
  const load = () =>
    (real ??= import("./files.ts").then(
      (m) => new m.ClientFiles(client),
      (e: unknown) => {
        real = undefined; // a chunk that failed to load (offline) is tried again on the next upload
        throw e;
      },
    ));
  return {
    url: (pathOrUrl) => (/^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${client.url.replace(/^ws(s?):/, "http$1:")}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`),
    upload: async (data, opts) => (await load()).upload(data, opts),
  };
}

/**
 * Web Locks and BroadcastChannel are there (as `multiTabSupported`, without loading its module): the older `multiTab`
 * option loads the hub only where it can run, and `tabRole` is null at once where it cannot.
 */
function canShareTabs(o: MultiTabOptions): boolean {
  const g = globalThis as { navigator?: { locks?: { request?: unknown } }; BroadcastChannel?: unknown };
  const locks = o.locks !== undefined ? o.locks : typeof g.navigator?.locks?.request === "function" ? g.navigator.locks : null;
  const bc = o.BroadcastChannel !== undefined ? o.BroadcastChannel : typeof g.BroadcastChannel === "function" ? g.BroadcastChannel : null;
  return !!locks && !!bc;
}

/** Option `multiTab` given as a plugin (`multiTab()`), not as the older `true` / options object. */
const isMultiTabPlugin = (x: unknown): x is MultiTabPlugin => typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "ember.multiTab" && typeof (x as { create?: unknown }).create === "function";

// ------------------------------------------------------------------------------------------------ client

export class EmberClient {
  readonly url: string;
  private readonly wsBase: string;
  private readonly httpBase: string;
  private WS: WebSocketConstructor | undefined;
  /** Option `multiTab` in an environment that can coordinate tabs: `WS` makes virtual sockets through the leader. */
  private tabs: MultiTab | null = null;
  /** The older `multiTab: true | {...}`: the hub's module is being loaded (`import()`); sockets and the clientId wait. */
  private tabsLoading: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly storage: PendingStorage;
  private offline: StorageAdapter | null;
  /** The light snapshot cache (option `snapshotCache`), when there is no offline adapter. */
  private readonly snapshots: SnapshotCache | null;
  /**
   * Values handed over by `hydrate()` until a subscription of the same key starts from them, with the snapshot
   * `watchQuery().getSnapshot()` shows meanwhile (one object per value: stable for `useSyncExternalStore`, so a server
   * render and the browser's hydration show the value, never a loading flash), and whose it is (`ownerKey`):
   * undefined until the client knows who it runs as (a browser's first token), then that identity's; dropped once the
   * fetcher answers for someone else.
   */
  private readonly hydrated = new Map<string, { query: HydratedQuery; snapshot: QuerySnapshot; owner: string | undefined }>();
  /**
   * Whose token read each `fetchForHydration` result (`ownerKey`) and under which `authGen`: `hydrate()` refuses it for
   * anyone else, and once `setAuth` replaced that source (even before the new one answers).
   */
  private readonly hydrationOwners = new WeakMap<HydratedQuery, { owner: string; authGen: number }>();
  /**
   * Whose a serialized entry (from a server render: no `hydrationOwners` record) is: undefined until the client learns
   * who it runs as (the first identity, the one the page was rendered for), then that identity's; null once the
   * identity changed (`setAuth` replaced or removed a source in use, or the fetcher answered for someone else). Then
   * nothing says whom a serialized entry was read for (a preload the app kept from before the switch, a remount that
   * hands it over again): it is never shown, and the hook waits for the live value.
   */
  private serializedOwner: string | null | undefined = undefined;
  private storedIdentity: LocalIdentity | null = null;
  private readonly syncOffs: Array<() => void> = [];
  private readonly random: () => number;
  private readonly sessionId: string;
  private authFetcher: AuthTokenFetcher | undefined;
  private authGen = 0;
  /**
   * Bumped whenever whoever the client runs as may have changed (`setAuth`, a token for someone else): a value
   * produced under an older one (confirmed, local, cached) is never kept for or handed to a listener of the new one.
   */
  private identityGen = 0;
  /**
   * Whether the runtime serves `POST /api/query/batch`: undefined until known (the first batch tries it), true once a
   * `ready` confirmed feature "qbatch", false once a `ready` lacked it or the runtime refused a batch.
   */
  private queryBatch: boolean | undefined;
  private tokenInFlight: Promise<string | null> | null = null;
  private token: string | null = null;
  /** `token` is the current fetcher's answer (false until the first fetch after `setAuth` settles). */
  private tokenKnown = false;
  /** Some fetch of this client settled a token (or none): a later `setAuth` with a fetcher may answer for someone else. */
  private tokenSeen = false;
  /**
   * `storedIdentity` is who the current token source answers for. False after `setAuth` replaced a source that was
   * in use, until a token of the new one says who it is: local queries then wait (or do not run), never as the last.
   */
  private storedCurrent = true;
  /** The last token fetch of this `authGen` failed (and none succeeded since): `fromAuth` stores show it. */
  private tokenError: Error | null = null;
  /** Stores of `fromAuth` functions: told when the token changes (its claim picks their shard). */
  private readonly claimListeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Refreshes that were due and got the same token back: the next one backs off (`armRefresh`). */
  private refreshMisses = 0;

  private clientIdValue: string | null;
  private readonly init: Promise<void>;
  private midCounter = 0;
  private qidCounter = 0;

  private readonly conns = new Map<string, Conn>();
  private readonly subs = new Map<string, Sub>();
  /** `subs` by shard and by function: a socket's own (`needed`, `hello`, `ready`) and `getAllQueries` walk only theirs. */
  private readonly subsByShard = new Map<string, Set<Sub>>();
  private readonly subsByFn = new Map<string, Set<Sub>>();
  /** Subscriptions with no listener waiting out `unsubscribeGraceMs`, oldest first. */
  private readonly lingering = new Set<Sub>();
  private readonly pending: Pending[] = [];
  private readonly pendingByMid = new Map<string, Pending>();

  private online: boolean;
  private closed = false;
  private readonly stopConnectivity: (() => void) | undefined;
  private stateSnapshot: ConnectionState;
  private readonly stateListeners = new Set<() => void>();
  /** `onIdentityChange` listeners. */
  private readonly identityListeners = new Set<() => void>();
  /** Inside `setAuth` (which tells `onIdentityChange` listeners once, at the end). */
  private settingAuth = false;

  private filesApi: FilesApi | undefined;

  /** File uploads (PLAN §7): `client.files.upload(data, opts)`. */
  get files(): FilesApi {
    return (this.filesApi ??= this.options.files ? this.options.files(this) : lazyFiles(this));
  }

  constructor(private readonly options: EmberClientOptions) {
    const base = options.url.replace(/\/+$/, "");
    this.url = base;
    this.wsBase = base.replace(/^http(s?):/, "ws$1:");
    this.httpBase = base.replace(/^ws(s?):/, "http$1:");
    const WS = options.WebSocket === null ? undefined : (options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket);
    this.WS = WS;
    const mt = options.multiTab;
    if (mt && WS) {
      const hb = options.heartbeat === false ? false : { intervalMs: options.heartbeat?.intervalMs ?? 25_000, timeoutMs: options.heartbeat?.timeoutMs ?? 10_000 };
      // The leader keeps the values of queries tabs share with the same diff functions as this client.
      const applyDiff = (prev: unknown, c: { diff?: unknown; vdiff?: unknown }) => (c.diff !== undefined ? applyRowDiff(prev, c.diff as RowDiff) : applyValueDiff(prev, c.vdiff as ValueDiff));
      const hub: MultiTabHost = { name: base, WebSocket: WS, heartbeat: hb, applyDiff };
      const use = (plugin: MultiTabPlugin) => {
        this.tabs = plugin.create(hub);
        if (this.tabs) this.WS = this.tabs.socketConstructor();
      };
      if (isMultiTabPlugin(mt)) use(mt);
      else if (canShareTabs(mt === true ? {} : mt)) {
        this.tabsLoading = import("./multitab.ts").then(
          (m) => {
            this.tabsLoading = null;
            if (!this.closed) use(m.multiTab(mt === true ? {} : mt));
          },
          (e: unknown) => {
            // The chunk did not load (offline): one socket per client, as without the option.
            this.tabsLoading = null;
            this.report(new EmberError("multitab_unavailable", `multiTab could not be loaded: ${(e as Error)?.message ?? String(e)}`), {});
          },
        );
      }
    }
    this.fetchImpl = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    this.offline = isStorageAdapter(options.storage) ? options.storage : null;
    this.storage = this.offline ? this.offline.persistPending : ((options.storage as PendingStorage | undefined) ?? new MemoryPendingStorage());
    this.snapshots = this.offline ? null : (options.snapshotCache ?? null);
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
    if (this.tabsLoading) await this.tabsLoading;
    if (!this.clientIdValue) {
      let id: string | null = null;
      try {
        id = await this.storage.getClientId();
      } catch {
        // storage unavailable: a fresh id still works, dedup just won't span restarts
      }
      // Several tabs (`multiTab`): one with no clientId of its own takes the leader's, so a mutation keeps its dedup key
      // (identity, clientId, mid) whichever tab's socket it goes out on.
      // An adopted id is stored like a generated one: this tab's queue restored after a reload (the leader gone) keeps
      // the dedup key its mutations went out with.
      const stored = id;
      if (!id && this.tabs) id = await this.tabs.sharedClientId();
      if (!id) id = randomId(this.random, 24);
      if (id !== stored) {
        try {
          await this.storage.setClientId(id);
        } catch {
          /* ignore */
        }
      }
      this.clientIdValue = id;
    }
    this.tabs?.offerClientId(this.clientIdValue);
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
        this.syncOffs.push(this.subscribe(typeof spec.query === "string" ? unsafeRef<"query">(spec.query) : spec.query, spec.args ?? {}, spec.shard === undefined ? undefined : { shard: spec.shard }, () => {}));
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

  /** This tab's part in sharing sockets across tabs (option `multiTab`); null when it does not share them. */
  get tabRole(): TabRole | null {
    return this.tabs?.role ?? (this.tabsLoading ? "starting" : null);
  }

  /** Close every socket and stop reconnecting. Pending in-memory callers are rejected; storage is kept. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopConnectivity?.();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const conn of this.conns.values()) {
      for (const sub of [...(conn.httpFirstWaiting ?? [])]) this.cancelHttpFirst(undefined, sub);
      conn.httpFirstWaiting = undefined;
      conn.httpFirstDone = undefined;
      this.flushAcks(conn);
      this.flushOut(conn);
      this.dropSocket(conn);
      this.clearTimer(conn, "retryTimer");
      this.clearTimer(conn, "idleTimer");
      conn.state = "idle";
    }
    for (const p of this.pending.splice(0)) p.reject(new EmberError("closed", "client closed"));
    this.pendingByMid.clear();
    for (const s of this.lingering) clearTimeout(s.graceTimer);
    this.lingering.clear();
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
    // After the sockets above: their last frames (acks) reach the leader before this tab leaves (or stops leading).
    this.tabs?.close();
    const offline = this.offline;
    if (offline?.close) void Promise.resolve().then(() => offline.close!()).catch(() => undefined);
    this.flushSnapshots();
    this.emitState();
  }

  /**
   * The snapshot cache, written now with every confirmed value's current version: a patch moves the version of every
   * value on its socket (they are current as of it), but only changed values were stored. `touch` updates the version
   * of a value the cache holds (the same object) without writing the value. Then `resume` after a reload starts from
   * the newest version the client knew, which the shard's change log still covers.
   */
  private flushSnapshots(): void {
    const snaps = this.snapshots;
    if (!snaps) return;
    const now = Date.now();
    if (snaps.touch) {
      for (const sub of this.subs.values()) {
        if (!sub.confirmed || !sub.owner || !sub.epoch || sub.ik === undefined || sub.error || sub.awaitingReply) continue;
        try {
          snaps.touch(sub.owner.key, sub.key, { value: sub.confirmed.value, version: sub.version, epoch: sub.epoch, ik: sub.ik, at: now });
        } catch {
          /* best effort */
        }
      }
    }
    try {
      snaps.flush?.();
    } catch {
      /* best effort */
    }
  }

  /** Resolves when the offline StorageAdapter (if any) has written everything handed to it so far. */
  async flushStorage(): Promise<void> {
    await this.init;
    await this.offline?.flush?.();
  }

  // ---------------------------------------------------------------------------------------------- auth

  /** Replace the token source (sign in / out / switch user). Open sockets re-auth (`{t:"auth"}`) in place. */
  setAuth(fetcher: AuthTokenFetcher | undefined): void {
    // A source replacing one in use may answer for someone else: until its token says who, the stored identity is not
    // who local queries run as. (The first source of a client built without one keeps the last session's, as `auth`.)
    const inUse = this.authFetcher !== undefined || this.tokenSeen;
    const replaced = !!fetcher && inUse;
    if (inUse) this.serializedOwner = null;
    this.authFetcher = fetcher;
    this.authGen++;
    if (replaced) this.storedCurrent = false;
    // Listener-free subscriptions waiting out `unsubscribeGraceMs` hold the previous identity's value: a listener of
    // the new one must not be handed it (offline nothing would replace it). They end now, timers and all.
    this.identityChanged(true);
    this.token = null;
    this.tokenKnown = false;
    this.tokenError = null;
    this.tokenInFlight = null;
    this.refreshMisses = 0;
    // Hydrated values belong to the request that rendered them: not to whoever signs in now.
    this.hydrated.clear();
    if (!fetcher) {
      // Sign-out: nothing of anyone stays cached on the device.
      try {
        this.snapshots?.clear();
      } catch {
        /* best effort */
      }
      this.settingAuth = true;
      try {
        this.rememberIdentity(null);
      } finally {
        this.settingAuth = false;
      }
      // Signed out: `fromAuth` subscriptions have no shard any more. (A new fetcher keeps them where they are until
      // its token is known.)
      this.emitClaims();
    }
    // Local values read for the previous identity leave the screen; read again once the new one is known.
    if (replaced) this.rereadLocal();
    void this.reauthAll(true);
    if (inUse) this.emitIdentityChange();
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
    // A fetcher that throws synchronously settles `p` before it is stored: it must not stay in flight.
    let settled = false;
    p = (async () => {
      try {
        const t = (await fetcher()) ?? null;
        if (gen === this.authGen) {
          const changed = !this.tokenKnown || this.token !== t;
          // A refresh was due (or overdue) and the fetcher had nothing newer: back off before asking again.
          if (changed) this.refreshMisses = 0;
          else if (t && this.refreshDue(t)) this.refreshMisses++;
          this.token = t;
          this.tokenKnown = true;
          this.tokenSeen = true;
          this.tokenError = null;
          this.armRefresh(t);
          if (t) {
            const id = jwtIdentity(t);
            if (id) this.rememberIdentity(id);
          } else this.rememberIdentity(null);
          // `fromAuth` stores follow the token's claim (another active org moves them).
          if (changed) this.emitClaims();
        }
        return t;
      } catch (e) {
        if (gen === this.authGen && !this.tokenKnown) {
          this.tokenError = e instanceof Error ? e : new Error(String(e));
          queueMicrotask(() => this.emitClaims());
        }
        throw e;
      } finally {
        settled = true;
        if (this.tokenInFlight === p) this.tokenInFlight = null;
      }
    })();
    if (!settled) this.tokenInFlight = p;
    return p;
  }

  private emitClaims(): void {
    for (const l of [...this.claimListeners]) {
      try {
        l();
      } catch (e) {
        this.report(e instanceof EmberError ? e : new EmberError("listener_error", (e as Error).message), {});
      }
    }
  }

  /**
   * The shard of a `fromAuth` function from the current token's claim (read from the JWT payload, not verified: the
   * shard checks it): its name; an error when it cannot be told (signed out, an opaque token, no such claim); or
   * undefined while the token is being fetched (`settled`: the fetch already ran, so that is an error too).
   */
  private claimShard(fn: string, spec: ShardSpec & { fromClaim: string }, settled = false): string | EmberError | undefined {
    const where = `${fn} runs in the "${spec.kind}" shard of the signed-in identity's ${spec.fromClaim} claim`;
    const pass = `pass { shard: "${spec.kind}:<key>" }`;
    const data = { kind: spec.kind, claim: spec.fromClaim };
    if (!this.authFetcher || (this.tokenKnown && !this.token)) return new EmberError("Unauthenticated", `${where}: not signed in`, { ...data, reason: "signed_out" });
    if (!this.tokenKnown) {
      const failed = this.tokenError;
      if (failed || settled) {
        // Calls fetch again (`awaitsToken`); stores keep the error until a fetch succeeds (connect, refresh, setAuth).
        return new EmberError("auth_failed", `${where}, and the auth token could not be fetched${failed ? `: ${failed.message}` : ""}`, { ...data, reason: "no_token" });
      }
      void this.fetchToken().catch(() => undefined);
      return undefined;
    }
    const payload = jwtPayload(this.token!);
    if (!payload) return new EmberError("no_shard", `${where}, and the auth token is not a JWT (its claims cannot be read here): ${pass}`, { ...data, reason: "opaque_token" });
    const key = claimKey(payload, spec.fromClaim);
    if (key === undefined) return new EmberError("no_shard", `${where}, and the token has no ${spec.fromClaim} claim: ${pass}`, { ...data, reason: "no_claim" });
    return `${spec.kind}:${key}`;
  }

  /**
   * The shard a `fromAuth` call without `{ shard }` routes to with the token known now, else undefined (not one, or
   * the claim cannot be read). No side effects: optimistic updates use it to find the live subscription.
   */
  private currentClaimShard(ref: AnyFunctionReference, opts: ShardOptions | undefined): string | undefined {
    const spec = this.claimSpec(ref, opts);
    if (!spec || !this.tokenKnown || !this.token) return undefined;
    const key = claimKey(jwtPayload(this.token), spec.fromClaim);
    return key === undefined ? undefined : `${spec.kind}:${key}`;
  }

  /** The `fromAuth` spec of a call that names no shard (it routes by the token), else undefined. */
  private claimSpec(ref: AnyFunctionReference | undefined, opts: ShardOptions | undefined): (ShardSpec & { fromClaim: string }) | undefined {
    if (!ref || opts?.shard) return undefined;
    const spec = getFunctionShard(ref);
    return spec?.fromClaim !== undefined ? (spec as ShardSpec & { fromClaim: string }) : undefined;
  }

  /**
   * @internal Where a `fromAuth` function called without `{ shard }` runs, as the token changes (null: it is not
   * one). `watchPaginatedQuery` follows it like `watchQuery` does.
   */
  claimRoute(ref: AnyFunctionReference, opts?: ShardOptions): ClaimRoute | null {
    const spec = this.claimSpec(ref, opts);
    if (!spec) return null;
    const fn = getFunctionName(ref);
    return {
      current: () => this.claimShard(fn, spec),
      onChange: (cb) => {
        this.claimListeners.add(cb);
        return () => void this.claimListeners.delete(cb);
      },
    };
  }

  /** A call of a `fromAuth` function whose token is not known yet (never fetched, or the last fetch failed). */
  private awaitsToken(ref: AnyFunctionReference, opts: ShardOptions | undefined): boolean {
    return !!this.authFetcher && !this.tokenKnown && !!this.claimSpec(ref, opts);
  }

  /** `shardOf`, after the token when a `fromAuth` function needs its claim and it is not known yet (else right away). */
  private shardOrWait(opts: ShardOptions | undefined, ref: AnyFunctionReference, args: unknown): string | Promise<string> {
    if (this.awaitsToken(ref, opts)) {
      return this.fetchToken()
        .catch(() => null)
        .then(() => this.shardOf(opts, ref, args));
    }
    return this.shardOf(opts, ref, args);
  }

  /** Whom the current token answers for (`ownerKey`), once the fetcher answered; undefined before. */
  private currentOwner(): string | undefined {
    if (!this.authFetcher) return "anon";
    return this.tokenKnown ? ownerKey(this.token) : undefined;
  }

  /** Who a queued mutation is recorded as: the current token's subject, else the one stored by the last session. */
  private localIdentity(): LocalIdentity | null {
    return (this.token && jwtIdentity(this.token)) || this.storedIdentity;
  }

  /**
   * Who local queries run as: the current token's subject, else the stored identity while it is the current source's
   * (`storedCurrent`); undefined when not known (a replaced source with no token yet, or an opaque one).
   */
  private localQueryIdentity(): LocalIdentity | null | undefined {
    const id = this.token ? jwtIdentity(this.token) : null;
    if (id) return id;
    return this.storedCurrent ? this.storedIdentity : undefined;
  }

  /**
   * Local values read under an identity that is no longer the client's: off the screen, and read again (or not).
   * Every unconfirmed subscription reads again, also one with nothing local yet: a read still in flight was for the
   * previous identity (its answer is dropped), so without this one nothing would read for the new identity.
   */
  private rereadLocal(): void {
    const changed: Sub[] = [];
    for (const sub of this.subs.values()) {
      if (sub.confirmed) continue;
      const shown = !!sub.local;
      this.dropLocal(sub);
      sub.resumeBase = undefined;
      if (shown) changed.push(sub);
      this.reloadLocal(sub);
    }
    if (changed.length) this.recompute(changed);
  }

  private rememberIdentity(id: LocalIdentity | null): void {
    // Hydrated values are the first identity's the client learns (the one the server rendered for, normally), and
    // nobody else's: a fetcher that now answers for someone else does not hand them over (nor `dehydrate()`).
    const owner = id ? identityCacheKey(id) : "anon";
    if (this.serializedOwner === undefined) this.serializedOwner = owner;
    else if (this.serializedOwner !== owner) this.serializedOwner = null;
    for (const [key, h] of this.hydrated) {
      if (h.owner === undefined) h.owner = owner;
      else if (h.owner !== owner) this.hydrated.delete(key);
    }
    // Called with the current source's answer: the stored identity is (or now becomes) who it answers for.
    const suspended = !this.storedCurrent;
    this.storedCurrent = true;
    if (id) this.dropForeign(id);
    const prev = this.storedIdentity;
    if (prev === id || (prev && id && prev.subject === id.subject && prev.issuer === id.issuer)) {
      // A replaced source answered (maybe after a failed fetch) for the same user: local reads were suspended until it
      // said who it is (a failed one read nothing); they start again. A plain refresh did not suspend them: nothing.
      if (suspended) this.rereadLocal();
      return;
    }
    this.storedIdentity = id;
    // The same fetcher now answers for someone else (or for nobody): what waits out its grace was not theirs.
    this.identityChanged(!!prev);
    if (prev && !this.settingAuth) this.emitIdentityChange(); // setAuth emits once, at its end
    // A local value read for the previous identity is not this one's: read again (or nothing) under the new one.
    this.rereadLocal();
    const offline = this.offline;
    if (offline?.setIdentity) {
      void Promise.resolve()
        .then(() => offline.setIdentity!(id))
        .catch(() => undefined);
    }
  }

  /** The token is inside its refresh window (`refreshAuthBeforeExpiryMs` before `exp`, or past it). */
  private refreshDue(token: string): boolean {
    const before = this.options.refreshAuthBeforeExpiryMs ?? 30_000;
    const exp = before === false ? null : jwtExp(token);
    return exp !== null && exp * 1000 - (before as number) <= Date.now();
  }

  private armRefresh(token: string | null): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const before = this.options.refreshAuthBeforeExpiryMs ?? 30_000;
    if (before === false || !token || this.closed) return;
    const exp = jwtExp(token);
    if (exp === null) return;
    // Same token again from a due refresh (a fetcher caching it until closer to `exp`): 2 s, 4 s, ... up to 30 s,
    // instead of asking every second; a new token resets it.
    const backoff = this.refreshMisses > 0 ? Math.min(REFRESH_BACKOFF_MAX_MS, 1_000 * 2 ** this.refreshMisses) : 0;
    const delay = Math.max(1_000, backoff, exp * 1000 - Date.now() - before);
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
    const gen = this.authGen;
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
      if (token || identityChanged) {
        // Acks of the identity being replaced go first: after the `auth` frame the shard would look for them under
        // the new one.
        if (identityChanged) this.flushAcks(conn);
        // The socket already runs with this very token (a refresh that got the same one back): nothing to send.
        if (conn.lastToken !== token) this.sendAuth(conn, token);
        conn.authGen = gen === this.authGen ? gen : -1;
        // Mutations that waited for their identity go now, after the `auth` frame (frames run in order).
        for (const p of [...this.pending]) if (p.held && p.record.shard === conn.shard) this.sendMut(conn, p);
      }
    }
  }

  /** Who the socket runs as now (what `sendAuth` / `hello` last set): the tag of the frames that arrive. */
  private connIdentityKey(conn: Conn): string {
    return conn.opaque ? `opaque:${conn.lastToken ?? ""}` : identityCacheKey(conn.identity ?? null);
  }

  private sendAuth(conn: Conn, token: string | null): void {
    conn.authSeq++;
    conn.lastToken = token;
    conn.identity = token ? jwtIdentity(token) : null;
    conn.opaque = !!token && !conn.identity;
    this.send(conn, { t: "auth", token });
    // Subscriptions refused as expired while no fresh token was available: they run under this `auth` (a fresh token,
    // or signed out: no token never expires; a later sign-in re-evaluates them like every registered subscription).
    const refused = conn.authRefused;
    conn.authRefused = undefined;
    if (refused) for (const sub of refused) if (this.subs.get(sub.key) === sub && !conn.qids.has(sub.qid)) this.sendSub(conn, sub);
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
      // No token, or the very one the shard just refused as expired: sending it again would only bounce.
      if (!token || token === conn.lastToken) {
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

  /** Rejects invalid args when the client knows the function's shape (`validate` option). */
  private checkArgs(fn: string, args: Record<string, unknown>): void {
    const shape = this.options.validate?.[fn] as ObjectShape | undefined;
    if (!shape) return;
    const r = validate(shape, args);
    if (!r.ok) throw new EmberError("ValidationError", `Invalid arguments for ${fn}: ${r.path}: ${r.message}`, { path: r.path, issues: [{ path: r.path, message: r.message }] }, { outcome: "rejected" });
  }

  /**
   * The shard of a call: `opts.shard`, else the function's routing argument or token claim (generated api), else
   * `defaultShard`. Throws when there is none (a `fromAuth` function whose token is not known yet included).
   */
  private shardOf(opts: ShardOptions | undefined, ref?: AnyFunctionReference, args?: unknown): string {
    const claimed = this.claimSpec(ref, opts);
    if (claimed) {
      const s = this.claimShard(getFunctionName(ref!), claimed, true);
      if (typeof s !== "string") throw s;
      return s;
    }
    const shard = ref ? routeShard(ref, args, opts?.shard, this.options.defaultShard) : (opts?.shard ?? this.options.defaultShard);
    if (!shard) {
      const spec = ref && getFunctionShard(ref);
      if (spec) throw new EmberError("no_shard", `${getFunctionName(ref!)} runs in "${spec.kind}" shards: pass { shard: "${spec.kind}:<key>" }`);
      throw new EmberError("no_shard", "no shard given and no defaultShard configured");
    }
    return shard;
  }

  private subKey(shard: string, fn: string, argsJson: string): string {
    return `${shard}\u0000${fn}\u0000${argsJson}`;
  }

  /**
   * False where the client cannot open a socket (`WebSocket: null`, or none available: a server rendering the app). Hooks then
   * read a query once over HTTP (`fetchForHydration` + `hydrate`) instead of subscribing to it.
   */
  get realtime(): boolean {
    return !!this.WS;
  }

  /**
   * @internal Bumped by every `setAuth`/`clearAuth`: a read started under one generation (a server render's
   * `fetchForHydration`) is not handed to `hydrate` under another.
   */
  get authEpoch(): number {
    return this.authGen;
  }

  /**
   * @internal Who a call of `ref` reads as now: the auth generation, the token's identity and, for a `fromAuth`
   * function called without `{ shard }`, the shard of its claim. Hooks key what they keep across renders (a pending
   * suspension) by it as well, so two users (or two orgs of one) never share one.
   */
  identityScope(ref: AnyFunctionReference, opts?: ShardOptions): string {
    let who: string;
    if (!this.authFetcher) who = "anon";
    else if (!this.tokenKnown) who = "?";
    else if (!this.token) who = "anon";
    else {
      const id = jwtIdentity(this.token);
      who = id ? identityCacheKey(id) : `opaque:${this.token}`;
    }
    return `${this.authGen}\u0000${who}\u0000${this.currentClaimShard(ref, opts) ?? ""}`;
  }

  /**
   * Low-level handle for `useSyncExternalStore`: `getSnapshot` is stable between changes, `subscribe` ref-counts a
   * deduplicated server subscription for `(shard, fn, args)`.
   */
  watchQuery<Q extends QueryReference>(
    ref: Q,
    args: Q["_args"],
    opts?: ShardOptions,
  ): { subscribe(listener: () => void): () => void; getSnapshot(): QuerySnapshot<Q["_returnType"]> } {
    const route = this.claimRoute(ref, opts);
    if (route) {
      // `fromAuth`: the shard of the token's claim, followed as the token changes (an org switch moves it).
      const store = new RoutedStore<QuerySnapshot<Q["_returnType"]>, ReturnType<EmberClient["watchQuery"]>>(
        route,
        (shard) => this.watchQuery(ref, args, { ...opts, shard }),
        LOADING as QuerySnapshot<Q["_returnType"]>,
        (error) => Object.freeze({ status: "error", value: undefined, error, optimistic: false }) as QuerySnapshot<Q["_returnType"]>,
      );
      return { subscribe: store.subscribe, getSnapshot: store.getSnapshot };
    }
    const a = toArgs(args);
    const shard = this.shardOf(opts, ref, a);
    const fn = getFunctionName(ref);
    const argsJson = stableStringify(a);
    try {
      this.checkArgs(fn, a);
    } catch (e) {
      const snap = Object.freeze({ status: "error", value: undefined, error: e as EmberError, optimistic: false }) as QuerySnapshot<Q["_returnType"]>;
      return { subscribe: () => () => {}, getSnapshot: () => snap };
    }
    const key = this.subKey(shard, fn, argsJson);
    return {
      subscribe: (listener) => this.addListener(key, shard, fn, a, argsJson, listener),
      getSnapshot: () => (this.subs.get(key)?.snapshot ?? this.hydrated.get(key)?.snapshot ?? LOADING) as QuerySnapshot<Q["_returnType"]>,
    };
  }

  /**
   * Subscribe to a query. `cb` runs on every change (and right away if a deduplicated subscription already has a
   * value). Returns the unsubscribe function.
   */
  subscribe<Q extends QueryReference>(
    ref: Q,
    args: Q["_args"],
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
  localQueryResult<Q extends QueryReference>(ref: Q, ...rest: ArgsAndOptions<Q, ShardOptions>): QuerySnapshot<Q["_returnType"]> {
    const [args, opts] = rest as unknown as [Q["_args"] | undefined, ShardOptions | undefined];
    return this.watchQuery(ref, args ?? {}, opts).getSnapshot();
  }

  /**
   * @internal The page subscriptions of `(ref, args)` for `watchPaginatedQuery` (paginate.ts, imported only by apps
   * that paginate): keys, ref-counted listeners that may start from another page's confirmed value, snapshots.
   */
  pageHost(ref: QueryReference, args: Record<string, unknown>, opts: ShardOptions & { initialNumItems: number }): PageHost | EmberError {
    const a = toArgs(args);
    const fn = getFunctionName(ref);
    const shard = this.shardOf(opts, ref, a);
    const withOpts = (paginationOpts: Record<string, unknown>) => ({ ...a, paginationOpts });
    try {
      this.checkArgs(fn, withOpts({ numItems: opts.initialNumItems, cursor: null }));
    } catch (e) {
      return e as EmberError;
    }
    return {
      key: (paginationOpts) => this.subKey(shard, fn, stableStringify(withOpts(paginationOpts))),
      listen: (paginationOpts, listener, seedFrom) => {
        const args = withOpts(paginationOpts);
        const argsJson = stableStringify(args);
        return this.addListener(this.subKey(shard, fn, argsJson), shard, fn, args, argsJson, listener, seedFrom === undefined ? undefined : this.seedOf(seedFrom));
      },
      snapshot: (key) => this.subs.get(key)?.snapshot ?? LOADING,
      confirmed: (key) => {
        const s = this.subs.get(key);
        return s?.confirmed && !s.error ? s.confirmed.value : undefined;
      },
    };
  }

  /** The confirmed value of a subscription with what `resume` needs, for another subscription to start from. */
  private seedOf(key: string): Seed | undefined {
    const s = this.subs.get(key);
    if (!s?.confirmed || s.error || s.authGen !== this.authGen) return undefined;
    return { value: s.confirmed.value, version: s.version, epoch: s.epoch, ik: s.ik, authGen: s.authGen, fromHttp: s.fromHttp === true, owner: s.owner };
  }

  private addListener(key: string, shard: string, fn: string, args: Record<string, unknown>, argsJson: string, listener: () => void, seed?: Seed): () => void {
    if (this.closed) return () => {};
    let sub = this.subs.get(key);
    if (sub && !sub.listeners.size && !this.reusable(sub)) {
      // Kept for another identity (defense in depth: identity changes end these already): never handed out.
      this.endLingering(sub);
      sub = undefined;
    }
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
      const hydrated = seed ? undefined : this.hydrated.get(key);
      if (hydrated) {
        // A value the server rendered (SSR): shown now, and the `sub` asks to resume from it (as after `httpFirst`).
        // Its snapshot is the one `getSnapshot` returned so far: the same object, so React sees no change.
        this.hydrated.delete(key);
        const h = hydrated.query;
        seed = { value: h.value, version: h.version, epoch: h.epoch || null, ik: h.ik || undefined, authGen: this.authGen, fromHttp: true, owner: undefined };
        sub.snapshot = hydrated.snapshot;
      }
      if (seed && seed.authGen === this.authGen) {
        // The server's value for these args too (a pinned page): shown now, and the `sub` asks to resume from it.
        sub.confirmed = { value: seed.value };
        sub.version = seed.version;
        sub.epoch = seed.epoch;
        sub.ik = seed.ik;
        sub.authGen = seed.authGen;
        sub.fromHttp = seed.fromHttp;
        sub.owner = seed.owner;
      }
      this.subs.set(key, sub);
      index(this.subsByShard, shard, sub);
      index(this.subsByFn, fn, sub);
      this.recompute([sub]);
      const conn = this.ensure(shard);
      // A cached value may let the `sub` resume (nothing downloaded): it waits for the cache, briefly.
      if (!sub.confirmed && (this.offline || this.snapshots)) this.startLocal(sub);
      if (!conn.ready && !sub.confirmed && !sub.local && !sub.localPending && !sub.httpFirst) this.maybeHttpFirst(conn, sub);
      if (this.subscribable(conn) && !sub.httpFirst && !sub.localPending && !conn.qids.has(sub.qid)) this.sendSub(conn, sub);
      if (sub.confirmed) this.persist([sub]);
    }
    else if (sub.graceTimer) {
      // Back within `unsubscribeGraceMs`: the live subscription (and its value) is reused.
      clearTimeout(sub.graceTimer);
      sub.graceTimer = undefined;
      this.lingering.delete(sub);
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
      // Whose value it holds now: a grace period started after the identity changed would keep it for the next one.
      const gen = this.identityGen;
      s.leftGen = gen;
      // Deferred so an unsubscribe + resubscribe in the same tick (React StrictMode, re-render) keeps the sub.
      queueMicrotask(() => {
        if (s.listeners.size || this.subs.get(s.key) !== s || s.graceTimer) return;
        const grace = this.options.unsubscribeGraceMs ?? 0;
        if (grace > 0 && !this.closed && gen === this.identityGen && this.reusable(s)) {
          s.graceTimer = setTimeout(() => {
            s.graceTimer = undefined;
            this.lingering.delete(s);
            this.dropSub(s);
          }, grace);
          this.lingering.add(s);
          if (this.lingering.size > UNSUBSCRIBE_GRACE_MAX) this.endLingering(this.lingering.values().next().value!);
          return;
        }
        this.dropSub(s);
      });
    };
  }

  /**
   * A subscription without listeners (waiting out its grace, or left this turn) may be reused only under the identity
   * its value was computed for: confirmed (`authGen`, owner), local or cached (`localGen`), or listened to (`leftGen`).
   */
  private reusable(s: Sub): boolean {
    if (s.leftGen !== undefined && s.leftGen !== this.identityGen) return false;
    if (s.local && s.localGen !== this.identityGen) return false;
    if (!s.confirmed && !s.error) return true;
    if (s.authGen !== this.authGen) return false;
    if (!s.owner || !this.tokenKnown) return true;
    return s.owner.key === (tokenOwner(this.token)?.key ?? s.owner.key);
  }

  private endLingering(s: Sub): void {
    clearTimeout(s.graceTimer);
    s.graceTimer = undefined;
    this.lingering.delete(s);
    this.dropSub(s);
  }

  /**
   * Whoever the client runs as may have changed: values produced before are someone else's. With `end`, every
   * subscription without listeners ends now (`unsub` sent, timers cleared): those waiting out `unsubscribeGraceMs`
   * and those whose last listener left this turn (their deferred cleanup has not run yet).
   */
  private identityChanged(end: boolean): void {
    this.identityGen++;
    if (!end) return;
    for (const s of [...this.lingering]) this.endLingering(s);
    for (const s of [...this.subs.values()]) if (!s.listeners.size) this.endLingering(s);
  }

  /** The last listener of `s` left (and its grace, if any, ran out): the subscription ends. */
  private dropSub(s: Sub): void {
    if (s.listeners.size || this.subs.get(s.key) !== s) return;
    this.subs.delete(s.key);
    unindex(this.subsByShard, s.shard, s);
    unindex(this.subsByFn, s.fn, s);
    // An optimistic update that read this query (`getQuery`, `updateQuery`) or listed its function's (`getAllQueries`)
    // runs again next time: what it read is gone now.
    if (this.overlayCache && (this.overlayCache.fns.has(s.fn) || this.overlayCache.keys.has(s.key))) this.overlayCache = null;
    this.optimisticSubs.delete(s);
    this.deferredSubs.delete(s);
    if (s.localTimer) clearTimeout(s.localTimer);
    s.localTimer = undefined;
    s.localPending = false;
    this.dropLocal(s);
    const conn = this.conns.get(s.shard);
    this.cancelHttpFirst(conn, s);
    if (conn && conn.qids.get(s.qid) === s) {
      conn.qids.delete(s.qid);
      if (this.subscribable(conn)) this.send(conn, { t: "unsub", qid: s.qid });
    }
    this.release(s.shard);
  }

  /**
   * `httpFirst`: the first value of `sub` over HTTP while its socket opens. The answer is used only if it still is
   * the first one (no snapshot yet) and the identity did not change meanwhile; it carries the shard's version, epoch
   * and identity tag, so the `sub` that follows asks to `resume` from it.
   */
  private maybeHttpFirst(conn: Conn, sub: Sub): void {
    if (this.options.httpFirst === false || !this.fetchImpl || this.closed || !this.online) return;
    if (this.authFetcher && !this.tokenKnown) {
      // Decided once the token is known: worth it only if the socket has not opened meanwhile (a token read from
      // local storage); a token fetched over the network took as long as the upgrade. Signed out (known, null) it
      // goes now, anonymously: no fetcher call per subscription.
      const gen = conn.gen;
      void this.fetchToken().then(
        () => {
          if (conn.gen === gen && conn.ws?.readyState !== OPEN && !conn.ready && this.subs.get(sub.key) === sub && !sub.confirmed && !sub.local && !sub.httpFirst && this.tokenKnown) this.startHttpFirst(conn, sub);
        },
        () => undefined,
      );
      return;
    }
    this.startHttpFirst(conn, sub);
  }

  private startHttpFirst(conn: Conn, sub: Sub): void {
    if ((conn.httpFirsts ?? 0) >= (this.options.httpFirstLimit ?? 8)) return;
    conn.httpFirsts = (conn.httpFirsts ?? 0) + 1;
    sub.httpFirst = true;
    const abort = typeof AbortController === "function" ? new AbortController() : undefined;
    sub.httpAbort = abort;
    (conn.httpFirstWaiting ??= new Set()).add(sub);
    const gen = this.authGen;
    // Fetched with the token of this identity: an answer that comes after it changed is someone else's.
    const idGen = this.identityGen;
    const done = () => {
      // Out of the waiting set whatever happened, so a cancel that could not reach this `conn` never blocks the flush.
      const waited = conn.httpFirstWaiting?.delete(sub) ?? false;
      // Cancelled (`ready` came first, unsubscribed, closed): whoever cancelled it took care of the `sub`.
      if (!sub.httpFirst || sub.httpAbort !== abort) {
        if (waited) this.flushHttpFirst(conn);
        return;
      }
      sub.httpFirst = false;
      sub.httpAbort = undefined;
      (conn.httpFirstDone ??= []).push(sub);
      this.flushHttpFirst(conn);
    };
    void this.httpFirstQuery(conn, sub, abort?.signal, gen, idGen).then(
      (r) => {
        if (abort?.signal.aborted) return;
        if (this.subs.get(sub.key) === sub && !sub.confirmed && !sub.error && gen === this.authGen && idGen === this.identityGen && r) {
          sub.confirmed = { value: r.value };
          sub.version = r.version;
          sub.epoch = r.epoch;
          sub.ik = r.ik;
          sub.authGen = gen;
          sub.fromHttp = true;
          sub.owner = tokenOwner(this.token);
          this.dropLocal(sub);
          this.persist([sub]);
          this.recompute([sub]);
        }
        done();
      },
      () => done(),
    );
  }

  /**
   * The pipelined `sub`s that waited for their HTTP answers (with one, the socket only confirms the value): together,
   * once none of this shard's is still in flight, so they share the turn's frame (feature "batch") instead of one
   * frame each as the answers trickle in. They resume from the version they got, so waiting for the others loses no
   * change; `ready` cancels the fetches still running and subscribes everything at once.
   */
  private flushHttpFirst(conn: Conn): void {
    if (conn.httpFirstWaiting?.size || !conn.httpFirstDone?.length) return;
    const subs = conn.httpFirstDone;
    conn.httpFirstDone = undefined;
    if (!this.subscribable(conn)) return; // the hello (or `ready`) subscribes them
    for (const sub of subs) if (this.subs.get(sub.key) === sub && !sub.httpFirst && !sub.localPending && !conn.qids.has(sub.qid)) this.sendSub(conn, sub);
  }

  /** Stops `sub`'s HTTP first fetch (its answer would be a second download of what the socket sends). */
  private cancelHttpFirst(conn: Conn | undefined, sub: Sub): void {
    if (!sub.httpFirst) return;
    sub.httpFirst = false;
    const abort = sub.httpAbort;
    sub.httpAbort = undefined;
    abort?.abort();
    if (!conn) return;
    conn.httpFirstWaiting?.delete(sub);
    this.flushHttpFirst(conn);
  }

  /**
   * A query over HTTP with the shard's version, epoch and identity tag (null when the server sends none). Only for a
   * subscription with nothing on screen yet (`httpFirst`): one with a cached value resumes over the socket instead.
   */
  private async httpQuery(fn: string, args: Record<string, unknown>, shard: string, signal?: AbortSignal): Promise<HttpFirstValue | null> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    // `warm`: the `sub` follows, and the shard keeps this run for it (a runtime before it ignores the field).
    const init: RequestInit = { method: "POST", headers, body: stringify({ fn, args, shard, warm: true }) };
    if (signal) init.signal = signal;
    const res = await this.fetchImpl!(`${this.httpBase}/api/query`, init);
    return httpFirstValue(parse(await res.text()));
  }

  /**
   * `sub`'s HTTP first value, fetched with the others of this turn for the same shard (`flushHttpBatch`). Settles
   * as a lone `httpQuery` would: rejects once `signal` aborts (the batch goes on for the others), null for an error.
   */
  private httpFirstQuery(conn: Conn, sub: Sub, signal: AbortSignal | undefined, authGen: number, identityGen: number): Promise<HttpFirstValue | null> {
    if (this.queryBatch === false) return this.httpQuery(sub.fn, sub.args, sub.shard, signal);
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      if (!conn.httpBatch) {
        conn.httpBatch = [];
        queueMicrotask(() => this.flushHttpBatch(conn));
      }
      conn.httpBatch.push({ sub, signal, authGen, identityGen, resolve, reject });
    });
  }

  /**
   * The turn's HTTP first fetches of `conn`'s shard: one `POST /api/query/batch` (one request, one shard call), or
   * `POST /api/query` for a lone one or a runtime without the batch. Only those still asked under the current
   * identity go, with its token (all of one batch share it); the others settle null now (their answer would be
   * dropped anyway). Each answer is still checked by `startHttpFirst` against the generations it was asked under.
   */
  private flushHttpBatch(conn: Conn): void {
    const items = conn.httpBatch ?? [];
    conn.httpBatch = undefined;
    const current = (i: HttpFirstItem) => !i.signal?.aborted && i.authGen === this.authGen && i.identityGen === this.identityGen && !this.closed;
    const live = items.filter(current);
    for (const i of items) if (!live.includes(i)) i.resolve(null);
    const alone = (list: HttpFirstItem[]) => {
      for (const i of list) {
        if (current(i)) this.httpQuery(i.sub.fn, i.sub.args, i.sub.shard, i.signal).then(i.resolve, i.reject);
        else i.resolve(null);
      }
    };
    if (live.length < 2 || this.queryBatch === false) return alone(live);
    for (let k = 0; k < live.length; k += MAX_QUERY_BATCH) {
      const chunk = live.slice(k, k + MAX_QUERY_BATCH);
      // The request outlives any one query: it is cancelled only once every query of it was.
      const ctl = typeof AbortController === "function" ? new AbortController() : undefined;
      let open = chunk.length;
      for (const i of chunk) i.signal?.addEventListener("abort", () => --open === 0 && ctl?.abort(), { once: true });
      this.httpQueryBatch(conn.shard, chunk, ctl?.signal).then(
        (out) => {
          if (out === "unsupported") {
            this.queryBatch = false;
            return alone(chunk);
          }
          chunk.forEach((i, n) => i.resolve(out?.[n] ?? null));
        },
        (e) => {
          for (const i of chunk) i.reject(e);
        },
      );
    }
  }

  /**
   * One `POST /api/query/batch` for `items` (one shard, the current token): an answer per query (null for an error),
   * null for all when the request failed as a whole (an invalid token, a server error), "unsupported" when the runtime
   * does not serve the batch (an older one answers it as a call of a function "batch": the shard in the query string
   * keeps that call on the shard the fetches go to anyway).
   */
  private async httpQueryBatch(shard: string, items: HttpFirstItem[], signal?: AbortSignal): Promise<Array<HttpFirstValue | null> | null | "unsupported"> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const queries = items.map((i) => ({ fn: i.sub.fn, args: i.sub.args, warm: true }));
    const init: RequestInit = { method: "POST", headers, body: stringify({ shard, queries }) };
    if (signal) init.signal = signal;
    const res = await this.fetchImpl!(`${this.httpBase}/api/query/batch?shard=${encodeURIComponent(shard)}`, init);
    let b: { ok?: unknown; results?: unknown } | null;
    try {
      b = parse(await res.text()) as { ok?: unknown; results?: unknown } | null;
    } catch {
      b = null;
    }
    if (b?.ok === true && Array.isArray(b.results) && b.results.length === items.length) return b.results.map(httpFirstValue);
    if (res.status === 401 || res.status === 429 || res.status >= 500) return null;
    return "unsupported";
  }

  /** Reads the offline adapter / snapshot cache for a new subscription; its `sub` waits for it (`LOCAL_WAIT_MS` at most). */
  private startLocal(sub: Sub): void {
    sub.localPending = true;
    sub.localTimer = setTimeout(() => this.localReady(sub), LOCAL_WAIT_MS);
    this.reloadLocal(sub);
  }

  private reloadLocal(sub: Sub): void {
    if (this.offline) void this.loadLocal(sub);
    else if (this.snapshots) this.loadCached(sub);
    else this.localReady(sub);
  }

  /**
   * The cache was read (or gave up): the `sub` goes now, resuming from a cached value when there is one; without one,
   * `httpFirst` may still fetch the first value while the socket opens.
   */
  private localReady(sub: Sub): void {
    if (!sub.localPending) return;
    sub.localPending = false;
    if (sub.localTimer) clearTimeout(sub.localTimer);
    sub.localTimer = undefined;
    if (this.subs.get(sub.key) !== sub || this.closed) return;
    const conn = this.conns.get(sub.shard);
    if (!conn) return;
    // A local or cached value is on screen already: the socket's `sub` (with `resume` from a cached one) confirms it,
    // no HTTP round trip on top. Without one, HTTP-first fetches the first value while the socket opens.
    if (!sub.confirmed && !sub.local && !conn.ready && !sub.httpFirst) this.maybeHttpFirst(conn, sub);
    if (this.subscribable(conn) && !conn.qids.has(sub.qid) && !sub.httpFirst) this.sendSub(conn, sub);
  }

  /**
   * The cache key of who the client runs as now, for the snapshot cache: `"anon"` signed out; null when unknown
   * (an opaque token) or the token has expired (a cached value is then not shown).
   */
  private cacheIdentity(): string | null | Promise<string | null> {
    if (!this.authFetcher) return "anon";
    const of = (token: string | null): string | null => {
      if (!token) return "anon";
      const exp = jwtExp(token);
      if (exp !== null && exp * 1000 <= Date.now()) return null;
      return tokenOwner(token)?.key ?? null;
    };
    if (this.token) return of(this.token);
    return this.fetchToken().then(of, () => null);
  }

  /** The snapshot cache's value for `sub` under the current identity (`snapshotCache`). */
  private loadCached(sub: Sub): void {
    const cache = this.snapshots!;
    const gen = this.authGen;
    const idGen = this.identityGen;
    const seq = (sub.localSeq = (sub.localSeq ?? 0) + 1);
    // Read for the identity of this generation: once it changed the entry is someone else's, never shown.
    const live = () => this.subs.get(sub.key) === sub && !sub.confirmed && gen === this.authGen && idGen === this.identityGen;
    const found = (e: CachedSnapshot | undefined) => {
      // A newer read took over (an identity change re-reads): it decides, this one is dropped.
      if (sub.localSeq !== seq) return;
      if (live() && e) {
        sub.local = { value: e.value, source: "cache", version: e.version, epoch: e.epoch, ik: e.ik };
        sub.localGen = idGen;
        this.recompute([sub]);
      }
      this.localReady(sub);
    };
    const read = (id: string | null) => {
      if (sub.localSeq !== seq) return;
      if (!id || !live()) return found(undefined);
      let e: CachedSnapshot | undefined | Promise<CachedSnapshot | undefined>;
      try {
        e = cache.get(id, sub.key);
      } catch {
        return found(undefined);
      }
      if (e && typeof (e as Promise<unknown>).then === "function") (e as Promise<CachedSnapshot | undefined>).then(found, () => found(undefined));
      else found(e as CachedSnapshot | undefined);
    };
    const id = this.cacheIdentity();
    if (id && typeof (id as Promise<unknown>).then === "function") (id as Promise<string | null>).then(read, () => read(null));
    else read(id as string | null);
  }

  /**
   * A query over HTTP with what `hydrate()` needs: for SSR and loaders. Serialize the result with `encodeJson` (values
   * may hold bigint/bytes) and hand it to the browser client's `hydrate()`; its first subscription of the same query
   * shows the value at once and resumes from it (the shard answers `unchanged` unless something changed since).
   */
  async fetchForHydration<Q extends QueryReference>(ref: Q, ...rest: ArgsAndOptions<Q, ShardOptions>): Promise<HydratedQuery<Q["_returnType"]>> {
    const [args, opts] = rest as unknown as [Q["_args"] | undefined, ShardOptions | undefined];
    const fn = getFunctionName(ref);
    const a = toArgs(args);
    this.checkArgs(fn, a);
    const routed = this.shardOrWait(opts, ref, a);
    const shard = typeof routed === "string" ? routed : await routed;
    const { status, body, owner, authGen } = await this.postQuery(fn, a, shard);
    const b = body as { ok?: boolean; value?: unknown; version?: unknown; epoch?: unknown; ik?: unknown; error?: WireErrorLike };
    if (!b || b.ok !== true) throw errorFromWire(b?.error ? { message: `HTTP ${status}`, ...b.error } : { message: `HTTP ${status}` }, `http_${status}`);
    // A runtime without them (older): the client then subscribes without `resume`.
    const version = typeof b.version === "number" ? b.version : 0;
    const epoch = typeof b.epoch === "string" ? b.epoch : "";
    const ik = typeof b.ik === "string" ? b.ik : "";
    const h: HydratedQuery<Q["_returnType"]> = { fn, args: a, shard, value: b.value as Q["_returnType"], version, epoch, ik };
    // Whose read it is: this client's `hydrate()` takes it only while the token is still theirs.
    this.hydrationOwners.set(h, { owner, authGen });
    return h;
  }

  /**
   * Values fetched on the server (`fetchForHydration`): the first subscription of each starts from it (shown at once,
   * `resume` instead of a download). Dropped on sign-in/out; ignored for a query this client already has.
   */
  hydrate(...entries: HydratedQuery[]): void {
    for (const h of entries) {
      if (!h || typeof h.fn !== "string" || typeof h.shard !== "string") continue;
      const key = this.subKey(h.shard, h.fn, stableStringify(toArgs(h.args)));
      // Read here (`fetchForHydration`) under a source `setAuth` replaced since (its new token may still be on its
      // way), or for someone the token no longer is: never shown to who it is now, loading subscription or not.
      // (A renewed JWT of the same source keeps its `authGen`; an entry from the server takes the first token's owner.)
      const local = this.hydrationOwners.get(h);
      if (local && local.authGen !== this.authGen) continue;
      const current = this.currentOwner();
      // A serialized entry: the first identity's (`serializedOwner`), never anyone's after a switch.
      if (!local && (this.serializedOwner === null || (this.serializedOwner !== undefined && current !== undefined && current !== this.serializedOwner))) continue;
      const owner = local?.owner ?? this.serializedOwner ?? current;
      if (owner !== undefined && current !== undefined && owner !== current) continue;
      if (!local && this.serializedOwner === undefined && current !== undefined) this.serializedOwner = current;
      const sub = this.subs.get(key);
      if (sub?.confirmed) continue;
      if (sub) {
        // Subscribed already, still loading: show the server's value now (its full value is on its way anyway).
        sub.confirmed = { value: h.value };
        sub.version = h.version;
        sub.epoch = h.epoch || null;
        sub.ik = h.ik || undefined;
        sub.authGen = this.authGen;
        sub.fromHttp = true;
        this.dropLocal(sub);
        this.recompute([sub]);
        continue;
      }
      // The same entry again (a `hydrate()` in render): its snapshot stays the same object.
      if (this.hydrated.get(key)?.query === h) continue;
      this.hydrated.set(key, { query: h, owner, snapshot: Object.freeze({ status: "success", value: h.value, error: undefined, optimistic: false }) });
    }
  }

  /**
   * The values handed to `hydrate()` that no subscription took yet. On a server that is what the render read
   * (`useSuspenseQuery` there reads with `fetchForHydration` + `hydrate`): serialize it with `encodeJson` for the
   * browser client's `hydrate()`.
   */
  dehydrate(): HydratedQuery[] {
    return [...this.hydrated.values()].map((h) => h.query);
  }

  /**
   * Until the server answers: the adapter's local result (registered offline query) or cached value — watched when
   * the adapter can (re-run as the replica changes), else computed once.
   */
  private async loadLocal(sub: Sub): Promise<void> {
    const failed = (e: unknown) => {
      this.report(new EmberError("local_query_failed", `${sub.fn}: ${(e as Error).message}`), { shard: sub.shard });
      this.localReady(sub);
    };
    const seq = (sub.localSeq = (sub.localSeq ?? 0) + 1);
    // Only the latest read of this `sub` decides (an identity change starts another): an older one is dropped.
    const latest = () => sub.localSeq === seq;
    try {
      await this.init;
      // A source that replaced another has not said who it is yet: wait for its token instead of running as the last.
      if (this.localQueryIdentity() === undefined && this.authFetcher && !this.tokenKnown) await this.fetchToken().catch(() => null);
      if (!latest()) return;
      const offline = this.offline;
      if (!offline || this.subs.get(sub.key) !== sub || sub.confirmed) return this.localReady(sub);
      const identity = this.localQueryIdentity();
      // Still unknown (the fetch failed, an opaque token): nothing local, never someone else's.
      if (identity === undefined) return this.localReady(sub);
      const request = { shard: sub.shard, fn: sub.fn, args: sub.args, argsJson: sub.argsJson, identity };
      const idGen = this.identityGen;
      // Computed for the identity of this generation: once it changed, the result is someone else's and is dropped.
      const live = () => latest() && this.subs.get(sub.key) === sub && !sub.confirmed && idGen === this.identityGen;
      if (offline.watchQueryLocally) {
        const off = offline.watchQueryLocally(
          request,
          (r) => {
            if (!latest()) return;
            if (!live()) return this.localReady(sub);
            // `undefined`: nothing local any more (cleared, evicted): the sub goes back to loading.
            const next = r ?? null;
            if (next !== sub.local) {
              sub.local = next;
              sub.localGen = idGen;
              this.recompute([sub]);
            }
            this.localReady(sub);
          },
          failed,
        );
        if (live()) sub.unwatchLocal = off;
        else off();
        return;
      }
      const r = await offline.runQueryLocally(request);
      if (!latest()) return;
      if (r && live()) {
        sub.local = r;
        sub.localGen = idGen;
        this.recompute([sub]);
      }
      this.localReady(sub);
    } catch (e) {
      failed(e);
    }
  }

  /** Drops the cached value shown for `sub` (and, from the snapshot cache, the entry itself). */
  private forgetCached(sub: Sub): void {
    const cached = sub.local?.source === "cache";
    this.dropLocal(sub);
    sub.resumeBase = undefined;
    if (cached && this.snapshots) {
      const id = this.cacheIdentity();
      const del = (k: string | null) => {
        try {
          if (k) this.snapshots!.delete(k, sub.key);
        } catch {
          /* best effort */
        }
      };
      if (id && typeof (id as Promise<unknown>).then === "function") void (id as Promise<string | null>).then(del, () => undefined);
      else del(id as string | null);
    }
    this.recompute([sub]);
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

  /** Hand confirmed values to the offline adapter (in server order), or to the snapshot cache. */
  private persist(subs: Iterable<Sub>): void {
    const offline = this.offline;
    const snaps = this.snapshots;
    if (!offline && !snaps) return;
    for (const sub of subs) {
      if (!sub.confirmed) continue;
      if (!offline) {
        // Only values whose owner is known, with what `resume` needs (never an error: `confirmed` is a value).
        if (sub.owner && sub.epoch && sub.ik !== undefined) {
          try {
            snaps!.set(sub.owner.key, sub.key, { value: sub.confirmed.value, version: sub.version, epoch: sub.epoch, ik: sub.ik, at: Date.now() });
          } catch {
            /* best effort */
          }
        }
        continue;
      }
      try {
        const r = offline.applyPatch({
          shard: sub.shard,
          fn: sub.fn,
          args: sub.args,
          argsJson: sub.argsJson,
          value: sub.confirmed.value,
          version: sub.version,
          ...(sub.epoch ? { epoch: sub.epoch } : {}),
          ...(sub.ik !== undefined ? { ik: sub.ik } : {}),
          ...(sub.owner ? { identity: sub.owner.identity } : { ownerUnknown: true as const }),
        });
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((e) => this.report(new EmberError("storage_error", `could not persist ${sub.fn}: ${(e as Error).message}`), { shard: sub.shard }));
        }
      } catch (e) {
        this.report(new EmberError("storage_error", `could not persist ${sub.fn}: ${(e as Error).message}`), { shard: sub.shard });
      }
    }
  }

  /** One-shot query on an existing socket with feature "query", otherwise HTTP. Never opens a socket. */
  async query<Q extends QueryReference>(ref: Q, ...rest: ArgsAndOptions<Q, QueryOptions>): Promise<Q["_returnType"]> {
    const [args, opts] = rest as unknown as [Q["_args"] | undefined, QueryOptions | undefined];
    const fn = getFunctionName(ref);
    const a = toArgs(args);
    this.checkArgs(fn, a);
    const routed = this.shardOrWait(opts, ref, a);
    const shard = typeof routed === "string" ? routed : await routed;
    const conn = this.conns.get(shard);
    // The socket answers as the identity it last authenticated: only while that is the client's current one.
    const gen = this.authGen;
    const current = conn?.authGen === gen;
    const ws = conn ? this.openWs(conn) : null;
    if (opts?.transport !== "http" && conn?.ready && current && ws && (conn.query || opts?.transport === "socket")) {
      const qid = `q${++this.qidCounter}`;
      const frame = stringify({ t: "q", qid, fn, args: a });
      this.clearTimer(conn, "idleTimer");
      return await new Promise<Q["_returnType"]>((resolve, reject) => {
        conn.queries.set(qid, {
          resolve,
          reject,
          retry: () => {
            // Over HTTP it would run with the token of whoever is signed in now: the caller asked as the identity of
            // `gen` (a sign-in/out since must never answer it with someone else's data).
            if (gen !== this.authGen) return reject(new EmberError("identity_changed", "the signed-in identity changed before the query was answered"));
            // Decode only on fallback, so a caller changing args while q is in flight cannot change the retry.
            const { args } = parse(frame) as Extract<ClientMessage, { t: "q" }>;
            void this.http("query", fn, args, shard).then(resolve, reject);
          },
        });
        // Feature "batch": in this turn's frame, with the subscriptions and mutations sent alongside.
        if (conn.batch) return this.sendEncoded(conn, frame);
        if (!this.sendFrame(conn, ws, frame)) {
          const pending = conn.queries.get(qid);
          conn.queries.delete(qid);
          pending?.retry();
          this.release(shard);
        }
      });
    }
    return (await this.http("query", fn, a, shard)) as Q["_returnType"];
  }

  private async http(kind: "query" | "mutation" | "action", fn: string, args: Record<string, unknown>, shard: string): Promise<unknown> {
    const { status, body } = kind === "query" ? await this.postQuery(fn, args, shard) : await this.post(kind, stringify({ fn, args, shard }));
    const b = body as { ok?: boolean; value?: unknown; error?: WireErrorLike };
    if (b && b.ok === true) return b.value;
    throw errorFromWire(b?.error ? { message: `HTTP ${status}`, ...b.error } : { message: `HTTP ${status}` }, `http_${status}`, kind === "mutation" ? "rejected" : undefined);
  }

  /**
   * `POST /api/<kind>` with the current token, renewed first when it expired or is inside its refresh window. A
   * `401 unauthenticated` (the token expired on the way, or was revoked) fetches a fresh token and sends the call again,
   * once, if the fetcher gave a different one for the same identity (the call ran nothing: the Worker refuses it before
   * the shard; as someone else it is not sent again). Returns the status, the parsed body, whose token it went with
   * (`ownerKey`) and the `authGen` it started under.
   */
  private async post(kind: "query" | "mutation" | "action", payload: string, path: string = kind): Promise<HttpAnswer> {
    if (!this.fetchImpl) throw new EmberError("no_fetch", "no fetch implementation available");
    const gen = this.authGen;
    let token = await this.httpToken();
    // Whoever the call runs as: a 401 is retried only for them (a renewed JWT), never as someone the fetcher now answers for.
    const idGen = this.identityGen;
    for (let retried = false; ; retried = true) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.httpBase}/api/${path}`, { method: "POST", headers, body: payload });
      } catch (e) {
        // A query sent twice is harmless: only writes have an outcome. An action is not one transaction: never "rejected".
        throw new EmberError("network_error", (e as Error).message ?? "network error", undefined, kind === "query" ? {} : { outcome: "unknown" });
      }
      let body: unknown;
      try {
        body = parse(await res.text());
      } catch {
        throw new EmberError("bad_response", `HTTP ${res.status}: response is not JSON`);
      }
      if (!retried && token && res.status === 401 && (body as { error?: { code?: unknown } } | null)?.error?.code === "unauthenticated" && gen === this.authGen) {
        // Single-flight: calls refused together share one renewal (`fetchToken` dedupes those in flight), and one refused
        // after another call renewed it already sends that token, without asking the fetcher again.
        const fresh = this.tokenKnown && this.token && this.token !== token ? this.token : await this.fetchToken().catch(() => null);
        if (fresh && fresh !== token && gen === this.authGen && idGen === this.identityGen && sameOwner(token, fresh)) {
          token = fresh;
          continue;
        }
      }
      return { status: res.status, body, owner: ownerKey(token), authGen: gen, identityGen: this.tokenKnown ? idGen : null };
    }
  }

  /** HTTP queries of `query()` and `fetchForHydration` waiting for the end of their turn, by shard (`flushQueries`). */
  private readonly queryQueue = new Map<string, QueuedQuery[]>();

  /**
   * `POST /api/query` for one query, as one entry of this turn's `POST /api/query/batch` of its shard when others go
   * with it (one request and one shard call, feature "qbatch"): the same answer either way. A lone query, or a runtime
   * without the batch, goes on its own.
   */
  private postQuery(fn: string, args: Record<string, unknown>, shard: string): Promise<HttpAnswer> {
    return new Promise((resolve, reject) => {
      // Encoded now, as the call was made (an argument that cannot be encoded, a cycle, rejects this query alone).
      const encoded = stringify(args);
      if (this.queryBatch === false) return void this.post("query", queryEntry(fn, encoded, shard)).then(resolve, reject);
      let q = this.queryQueue.get(shard);
      if (!q) {
        this.queryQueue.set(shard, (q = []));
        queueMicrotask(() => this.flushQueries(shard));
      }
      q.push({ fn, args: encoded, authGen: this.authGen, identityGen: this.tokenKnown ? this.identityGen : null, resolve, reject });
    });
  }

  /**
   * The turn's HTTP queries of one shard: one `POST /api/query/batch` per `MAX_QUERY_BATCH`, each query answered with
   * its own entry. A refusal of the whole request (an invalid token after the one renewal `post` tries, 429, a server
   * error) is every query's answer, as `{ok: false, error}` with the request's status, as it would have been one by
   * one; a batch too large (413) goes one by one; a runtime that does not serve the batch gets them one by one (and
   * no batch again). A query asked under an identity replaced since (a `setAuth`, a token for someone else) is never
   * sent: it fails with `identity_changed`, here and again before each one-by-one fallback.
   */
  private flushQueries(shard: string): void {
    const current = (i: QueuedQuery) => {
      if (i.authGen === this.authGen && (i.identityGen === null || i.identityGen === this.identityGen)) return true;
      i.reject(new EmberError("identity_changed", "the signed-in identity changed before the query was sent"));
      return false;
    };
    const items = (this.queryQueue.get(shard) ?? []).filter(current);
    this.queryQueue.delete(shard);
    const alone = (list: QueuedQuery[]) => {
      for (const i of list) if (current(i)) this.post("query", queryEntry(i.fn, i.args, shard)).then(i.resolve, i.reject);
    };
    if (items.length < 2 || this.queryBatch === false) return alone(items);
    for (let k = 0; k < items.length; k += MAX_QUERY_BATCH) {
      const chunk = items.slice(k, k + MAX_QUERY_BATCH);
      const payload = `{"shard":${JSON.stringify(shard)},"queries":[${chunk.map((i) => queryEntry(i.fn, i.args)).join(",")}]}`;
      this.post("query", payload, `query/batch?shard=${encodeURIComponent(shard)}`).then(
        (r) => {
          const b = r.body as { ok?: unknown; results?: unknown; error?: unknown } | null;
          if (b?.ok === true && Array.isArray(b.results) && b.results.length === chunk.length) {
            const results = b.results as unknown[];
            chunk.forEach((i, n) => i.resolve({ ...r, body: results[n] }));
            return;
          }
          if (r.status === 401 || r.status === 429 || r.status >= 500) {
            // Each query's own answer, shaped as `POST /api/query` refuses one (never the batch's other fields).
            const body = b && typeof b.error === "object" && b.error !== null ? { ok: false, error: b.error } : { ok: false };
            return chunk.forEach((i) => i.resolve({ ...r, body }));
          }
          // One by one as the identity the batch went as: a query asked before any token was known is bound to it now,
          // so an identity that changed while the batch was in flight is refused, not sent as the new one.
          for (const i of chunk) if (i.identityGen === null) i.identityGen = r.identityGen;
          if (r.status === 413) return alone(chunk);
          this.queryBatch = false;
          alone(chunk);
        },
        (e: unknown) => chunk.forEach((i) => i.reject(e)),
      );
    }
  }

  /** The token for an HTTP call: the current one, unless it expired or is about to (then a fresh one, if the fetcher has it). */
  private async httpToken(): Promise<string | null> {
    const t = this.token;
    if (t) {
      const exp = jwtExp(t);
      if (!this.refreshDue(t) && (exp === null || exp * 1000 > Date.now())) return t;
    }
    return await this.fetchToken().catch(() => t);
  }

  // ---------------------------------------------------------------------------------------------- mutations

  /**
   * Run a mutation over the shard's socket. The optimistic update (if any) is applied right away over confirmed
   * results and re-applied on every server change until the result arrives; a rejection rolls it back.
   */
  mutation<M extends MutationReference>(ref: M, ...rest: ArgsAndOptions<M, MutationOptions<M["_args"]>>): Promise<M["_returnType"]> {
    const [args, opts] = rest as unknown as [M["_args"] | undefined, MutationOptions<M["_args"]> | undefined];
    if (this.closed) return Promise.reject(new EmberError("closed", "client closed"));
    // `fromAuth` before the token is known: queued once it is, on the shard of its claim then (kept if it changes later).
    if (this.awaitsToken(ref, opts)) {
      return this.fetchToken()
        .catch(() => null)
        .then(() => this.enqueueMutation(ref, args, opts));
    }
    return this.enqueueMutation(ref, args, opts);
  }

  private enqueueMutation<M extends MutationReference>(ref: M, args: M["_args"] | undefined, opts: MutationOptions<M["_args"]> | undefined): Promise<M["_returnType"]> {
    if (this.closed) return Promise.reject(new EmberError("closed", "client closed"));
    let shard: string;
    let a: Record<string, unknown>;
    try {
      a = toArgs(args);
      this.checkArgs(getFunctionName(ref), a);
      shard = this.shardOf(opts, ref, a);
    } catch (e) {
      return Promise.reject(e);
    }
    const record: PendingMutationRecord = {
      mid: `${this.sessionId}-${++this.midCounter}`,
      shard,
      fn: getFunctionName(ref),
      args: a,
      createdAt: Date.now(),
      identity: this.localIdentity(),
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
  async action<A extends ActionReference>(ref: A, ...rest: ArgsAndOptions<A, ShardOptions>): Promise<A["_returnType"]> {
    const [args, opts] = rest as unknown as [A["_args"] | undefined, ShardOptions | undefined];
    const a = toArgs(args);
    this.checkArgs(getFunctionName(ref), a);
    const routed = this.shardOrWait(opts, ref, a);
    return (await this.http("action", getFunctionName(ref), a, typeof routed === "string" ? routed : await routed)) as A["_returnType"];
  }

  // ---------------------------------------------------------------------------------------------- optimistic view

  /**
   * Inside a batch frame (`onFrame`): the messages' recomputes wait for its end, where one recompute of what they
   * changed runs. Listeners see the frame's final state once, as after a frame of one message.
   */
  private frameDepth = 0;
  private recomputeDeferred = false;
  private readonly deferredSubs = new Set<Sub>();
  /** Subscriptions whose snapshot shows an optimistic value now. */
  private readonly optimisticSubs = new Set<Sub>();
  /**
   * The last run of the pending optimistic updates: the overlay they built, the pending mutations (and updates) it ran,
   * the token it ran under (`fromAuth` keys follow its claim) and what the updates read (query keys, and functions
   * listed with `getAllQueries`). While those are the same and nothing they read changed, it is reused as it is.
   */
  private overlayCache: { overlay: Map<string, unknown>; ran: Pending[]; updates: Array<OptimisticUpdate | undefined>; token: string | null; keys: Set<string>; fns: Set<string> } | null = null;

  /** Runs of the optimistic updates (each pending mutation's update, once per run): for tests. @internal */
  optimisticRuns = 0;

  /**
   * Rebuild the visible value of `only` (the subscriptions whose confirmed value, local value or error changed), and of
   * every subscription an optimistic layer covers now or covered before: confirmed state + pending updates in order.
   * The updates run again only when the pending mutations changed or a query they read did (an update may read any
   * query): a patch of a query no pending update reads costs only the walk of what it changed. Without `only`, the
   * pending mutations changed.
   */
  private recompute(only?: Sub[]): void {
    if (this.frameDepth > 0) {
      this.recomputeDeferred = true;
      if (only) for (const s of only) this.deferredSubs.add(s);
      return;
    }
    const withUpdates = this.pending.filter((p) => p.update);
    let overlay: Map<string, unknown>;
    const cache = this.overlayCache;
    if (!withUpdates.length) {
      overlay = new Map();
      this.overlayCache = null;
    } else if (
      cache &&
      cache.token === this.token &&
      cache.ran.length === withUpdates.length &&
      cache.ran.every((p, i) => p === withUpdates[i] && p.update === cache.updates[i]) &&
      !(only ?? []).some((s) => cache.keys.has(s.key) || cache.fns.has(s.fn))
    ) {
      overlay = cache.overlay;
    } else {
      overlay = this.runUpdates(withUpdates);
    }
    // What can show something else now: what changed, what an update covers, what one covered until now.
    const walk = new Set(only ?? []);
    for (const s of this.optimisticSubs) walk.add(s);
    for (const k of overlay.keys()) {
      const s = this.subs.get(k);
      if (s) walk.add(s);
    }
    const changed: Sub[] = [];
    for (const s of walk) {
      if (this.subs.get(s.key) !== s) {
        this.optimisticSubs.delete(s);
        continue;
      }
      const optimistic = overlay.has(s.key);
      const base = baseOf(s);
      const value = optimistic ? overlay.get(s.key) : base?.value;
      const hasValue = optimistic ? value !== undefined : base !== null;
      const status: QueryStatus = s.error && !optimistic ? "error" : hasValue ? "success" : "loading";
      const error = s.error ?? undefined;
      const source = !s.confirmed && s.local && status === "success" ? s.local.source : undefined;
      // Tracked before the shortcut below: an optimistic `undefined` shows LOADING (not marked optimistic), so the
      // snapshot may not change when the update goes, yet the subscription shows nothing optimistic any more.
      if (optimistic) this.optimisticSubs.add(s);
      else this.optimisticSubs.delete(s);
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

  /** Runs the pending optimistic updates in order: the overlay of values they set, and what they read (cached). */
  private runUpdates(withUpdates: Pending[]): Map<string, unknown> {
    const overlay = new Map<string, unknown>();
    const keys = new Set<string>();
    const fns = new Set<string>();
    for (const p of withUpdates) {
      this.optimisticRuns++;
      const defaultShard = p.record.shard;
      // A `fromAuth` query lives on the shard of the current token's claim, whatever shard the mutation was sent to.
      const keyOf = (ref: AnyFunctionReference, args: unknown, o?: ShardOptions) =>
        this.subKey(this.currentClaimShard(ref, o) ?? routeShard(ref, toArgs(args), o?.shard, defaultShard) ?? defaultShard, getFunctionName(ref), stableStringify(toArgs(args)));
      const current = (k: string): unknown => {
        keys.add(k);
        return overlay.has(k) ? overlay.get(k) : baseOf(this.subs.get(k))?.value;
      };
      const store: OptimisticLocalStore = {
        getQuery: (ref: AnyFunctionReference, ...rest: unknown[]) => current(keyOf(ref, rest[0], rest[1] as ShardOptions | undefined)),
        setQuery: (ref, args, value, o) => {
          overlay.set(keyOf(ref, args, o), value);
        },
        updateQuery: (ref, args, fn, o) => {
          const k = keyOf(ref, args, o);
          const v = current(k);
          if (v !== undefined) overlay.set(k, fn(v));
        },
        getAllQueries: (ref, o) => {
          const fn = getFunctionName(ref);
          const spec = getFunctionShard(ref);
          const claimed = spec?.fromClaim !== undefined && !o?.shard;
          const shard = o?.shard ?? (spec?.fromArg !== undefined ? undefined : claimed ? this.currentClaimShard(ref, o) : defaultShard);
          const out: Array<{ args: Record<string, unknown>; value: unknown }> = [];
          // A claim that cannot be read now (signed out, opaque token): no subscription of it is live.
          if (claimed && shard === undefined) return out;
          fns.add(fn);
          for (const s of this.subsByFn.get(fn) ?? []) {
            if (shard !== undefined && s.shard !== shard) continue;
            keys.add(s.key);
            out.push({ args: s.args, value: overlay.has(s.key) ? overlay.get(s.key) : baseOf(s)?.value });
          }
          return out;
        },
      };
      try {
        p.update!(store, p.record.args, p.record);
      } catch (e) {
        this.report(new EmberError("optimistic_update_failed", (e as Error).message), { shard: defaultShard });
      }
    }
    this.overlayCache = { overlay, ran: withUpdates, updates: withUpdates.map((p) => p.update), token: this.token, keys, fns };
    return overlay;
  }

  // ---------------------------------------------------------------------------------------------- connection state

  connectionState(): ConnectionState {
    return this.stateSnapshot;
  }

  onConnectionStateChange(cb: () => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /**
   * Called when whoever the client runs as changes: `setAuth` replaced or removed a token source in use (sign-out,
   * account switch), or the fetcher answered for someone else. Not on the first sign-in of a client built without one,
   * nor on a renewed token of the same user. For caches outside the client (`@freecorps/ember-react-query`): what they
   * hold was read for the previous identity.
   */
  onIdentityChange(cb: () => void): () => void {
    this.identityListeners.add(cb);
    return () => this.identityListeners.delete(cb);
  }

  private emitIdentityChange(): void {
    for (const cb of [...this.identityListeners]) {
      try {
        cb();
      } catch (e) {
        console.error("ember: an onIdentityChange listener threw", e);
      }
    }
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
        shard, ws: null, gen: 0, state: this.online ? "idle" : "offline", ready: false, helloSent: false, attempt: 0, epoch: null,
        qids: new Map(), queries: new Map(), retryTimer: null, idleTimer: null, pingTimer: null, deadlineTimer: null,
        authSeq: 0, reauth: null,
      };
      this.conns.set(shard, c);
    }
    return c;
  }

  /** The subscriptions of a shard, in the order they were made (a copy: sending may drop one). */
  private shardSubs(shard: string): Sub[] {
    return [...(this.subsByShard.get(shard) ?? [])];
  }

  private needed(conn: Conn): boolean {
    if (conn.queries.size) return true;
    if (this.subsByShard.get(conn.shard)?.size) return true;
    for (const p of this.pending) if (p.record.shard === conn.shard) return true;
    // Acks waiting for their timer do not keep the socket: they go out before it closes (`release`).
    return !!conn.acking;
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
      // Waiting acks (and whatever this turn queued) go out before the close.
      this.flushAcks(conn);
      this.flushOut(conn);
      this.dropSocket(conn);
      conn.state = this.online ? "idle" : "offline";
      this.forgetIdle(conn);
      this.emitState();
    }, this.options.idleTimeoutMs ?? 10_000);
  }

  /**
   * Nothing of `conn` is needed again (no subscription, query or mutation of its shard; acks went out): the entry goes
   * too, or an app with many shards (one per document, per org) keeps one per shard it ever opened. A later call of the
   * shard starts a new one; acks a failed send put back keep it until the next socket sends them. Offline it stays
   * (`connectionState()` shows the shard `offline`) and goes when the network is back.
   */
  private forgetIdle(conn: Conn): void {
    if (!this.online || conn.ws || this.needed(conn)) return;
    if (!conn.acks?.length && !conn.ackTimer && !conn.retryTimer && !conn.reauth && this.conns.get(conn.shard) === conn) this.conns.delete(conn.shard);
  }

  /** Subscriptions can go out on this socket: after `ready`, or right after `hello` when pipelining. */
  private subscribable(conn: Conn): boolean {
    return conn.ready || (conn.helloSent && this.options.pipelineConnect !== false);
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
    if (this.tabsLoading) {
      // The older `multiTab` option: the socket goes through the hub once its module is here.
      await this.tabsLoading;
      if (gen !== conn.gen || conn.ws) return;
    }
    const pipeline = this.options.pipelineConnect !== false;
    let tokenPromise: Promise<string | null>;
    if (pipeline) {
      // Pipelined: the socket opens (DNS, TLS, upgrade) while the client still loads its storage (offline adapter,
      // clientId, pending queue); `hello` waits for both the load (it carries the clientId) and the token.
      tokenPromise = this.init.then(() => this.fetchToken());
      // Handled below; never an unhandled rejection when this attempt is abandoned.
      tokenPromise.catch(() => undefined);
    } else {
      try {
        await this.init;
        tokenPromise = this.fetchToken();
        tokenPromise.catch(() => undefined);
        // Serial mode: the socket opens only once the token is known.
        await tokenPromise;
      } catch (e) {
        if (gen !== conn.gen) return;
        this.report(new EmberError("auth_failed", `auth token fetch failed: ${(e as Error).message}`), { shard: conn.shard });
        this.scheduleRetry(conn);
        return;
      }
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
    // Feature "zframe": binary frames as bytes, not a Blob to read first (a socket that has the property). Its frames
    // are handled in order: a binary one is decoded before what follows it.
    if ("binaryType" in ws) (ws as { binaryType: string }).binaryType = "arraybuffer";
    // Each frame tagged with the identity the socket had when it arrived: a compressed one decoded after an `auth` for
    // someone else (sent meanwhile) carries the previous identity's values. Its `snap`/`patch` are dropped (the shard
    // sends every subscription a fresh `snap` under the new identity, after that `auth`); the rest is handled.
    const inbox = new FrameQueue<string>(
      (text, arrivedAs) => {
        if (conn.ws !== ws) return;
        if (arrivedAs === this.connIdentityKey(conn)) return this.onFrame(conn, text);
        const kept = withoutDeliveries(text);
        if (kept !== null) this.onFrame(conn, kept);
      },
      (e) => {
        if (conn.ws === ws) this.report(new EmberError("bad_frame", `could not decode a compressed frame: ${(e as Error)?.message ?? String(e)}`), { shard: conn.shard });
      },
    );
    const authGen = this.authGen;
    let opened = false;
    let token: { value: string | null } | null = null;
    const hello = () => {
      if (conn.ws !== ws || !opened || !token || conn.helloSent) return;
      // The token may have changed while the socket was opening.
      const t = authGen === this.authGen ? token.value : this.token;
      conn.authGen = authGen === this.authGen || this.token ? this.authGen : -1;
      const m: ClientMessage = { t: "hello", clientId: this.clientIdValue!, protocol: PROTOCOL_VERSION };
      if (t) m.token = t;
      conn.lastToken = t;
      conn.identity = t ? jwtIdentity(t) : null;
      conn.opaque = !!t && !conn.identity;
      m.features = this.options.rowDiff !== false ? ["rowdiff", "vdiff", "ident", "query", "ack", "batch", "qbatch"] : ["ident", "query", "ack", "batch", "qbatch"];
      if (this.options.zframe && zframeSupported()) m.features.push("zframe");
      this.send(conn, m);
      conn.helloSent = true;
      // Pipelined: the first subscriptions ride with hello (one round trip less to the first snapshot); one whose
      // first value is coming over HTTP follows it, to resume from it.
      // Those whose answer already came wait in `httpFirstDone` for the rest of the shard's, to go out in one frame.
      if (pipeline) {
        const queued = new Set(conn.httpFirstDone ?? []);
        for (const sub of this.shardSubs(conn.shard)) if (!conn.qids.has(sub.qid) && !sub.httpFirst && !sub.localPending && !queued.has(sub)) this.sendSub(conn, sub);
        this.flushHttpFirst(conn);
      }
    };
    tokenPromise.then(
      (t) => {
        token = { value: t };
        hello();
      },
      (e: unknown) => {
        if (conn.ws !== ws) return;
        this.report(new EmberError("auth_failed", `auth token fetch failed: ${(e as Error).message}`), { shard: conn.shard });
        this.dropSocket(conn);
        this.scheduleRetry(conn);
      },
    );
    ws.onopen = () => {
      if (conn.ws !== ws) return;
      opened = true;
      hello();
    };
    ws.onmessage = (ev) => {
      if (conn.ws !== ws) return;
      inbox.push(ev.data, this.connIdentityKey(conn));
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
    let delay: number;
    if (conn.quickRetry) {
      // The attempt in flight when the network came back failed: retry soon (`onConnectivity`).
      conn.quickRetry = false;
      delay = this.spreadDelay();
    } else {
      const b = this.options.backoff ?? {};
      const initial = b.initialMs ?? 250;
      const max = b.maxMs ?? 30_000;
      const factor = b.factor ?? 2;
      const cap = Math.min(max, initial * factor ** Math.min(conn.attempt, 32));
      delay = Math.round(cap / 2 + (this.random() * cap) / 2);
      conn.attempt++;
    }
    conn.state = "waiting";
    this.clearTimer(conn, "retryTimer");
    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = null;
      void this.connect(conn);
    }, delay);
    this.emitState();
  }

  /**
   * Every client of an app sees the network (or the screen) come back at about the same time: a random delay (up to
   * `RECONNECT_SPREAD_MS`, or `backoff.initialMs` when smaller) spreads their reconnects instead of a thundering herd
   * on the shard. Not the backoff itself: the network is back, so the wait stays short.
   */
  private spreadDelay(): number {
    return Math.round(this.random() * Math.min(RECONNECT_SPREAD_MS, this.options.backoff?.initialMs ?? RECONNECT_SPREAD_MS));
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
    conn.helloSent = false;
    conn.ident = false;
    conn.query = false;
    conn.authGen = -1;
    conn.ack = false;
    conn.batch = false;
    // The turn's frame is never sent: the acks it carries wait again with the others (the rest goes out again from
    // the subscriptions and pending mutations on the next socket).
    if (conn.out) this.restoreAcks(conn, conn.out.acks, conn.out.ackVersion);
    conn.out = undefined;
    conn.failedWs = undefined;
    conn.authRefused = undefined; // the next socket subscribes everything again
    conn.batchPipelined = undefined;
    conn.lastToken = undefined;
    // Waiting acks stay: the next socket of the same identity sends them (`onReady`).
    if (conn.ackTimer) clearTimeout(conn.ackTimer);
    conn.ackTimer = null;
    conn.ikPipelined = undefined;
    conn.ikRefusals = 0;
    conn.httpFirsts = 0;
    conn.gen++;
    conn.qids.clear();
    const queries = [...conn.queries.values()];
    conn.queries.clear();
    for (const q of queries) {
      if (this.closed) q.reject(new EmberError("closed", "client closed"));
      else q.retry();
    }
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

  /**
   * Frames may be batched on this socket: feature "batch" confirmed, or (pipelined, before `ready`) not refused by
   * the last server of this shard. Before `ready` that is optimistic: `onReady` falls back when the server says no.
   */
  private batching(conn: Conn): boolean {
    return conn.batch === true || (!conn.ready && conn.helloSent && conn.serverBatch !== false);
  }

  /** The current socket, while frames can go out on it (open, and no `send` on it threw). */
  private openWs(conn: Conn): WebSocketLike | null {
    const ws = conn.ws;
    return ws && ws.readyState === OPEN && conn.failedWs !== ws ? ws : null;
  }

  private send(conn: Conn, m: ClientMessage | typeof PING): void {
    const ws = this.openWs(conn);
    if (!ws) return;
    if (m === PING) return void this.sendFrame(conn, ws, PING);
    this.sendEncoded(conn, stringify(m), m.t === "sub" ? String(m.qid) : undefined, m.t === "unsub" ? String(m.qid) : undefined, undefined, m.t === "mut" ? m.mid : undefined);
  }

  private sendEncoded(conn: Conn, frame: string, subQid?: string, unsubQid?: string, ack?: { mids: Id[]; version: number | undefined }, mid?: Id): void {
    const ws = this.openWs(conn);
    if (!ws) {
      if (ack) this.restoreAcks(conn, ack.mids, ack.version);
      return;
    }
    if (!this.batching(conn)) {
      if (conn.out) this.flushOut(conn); // never reorder
      if (!this.sendFrame(conn, ws, frame) && ack) this.restoreAcks(conn, ack.mids, ack.version);
      return;
    }
    // Feature "batch": one frame per turn (a burst of mutations is one Durable Object event, not one per mutation).
    let q = conn.out;
    // Before the size check: a `sub` that left no room for its `unsub` is still cancelled, not flushed alone.
    const at = q && unsubQid !== undefined ? q.subAt.get(unsubQid) : undefined;
    if (q && unsubQid !== undefined && at !== undefined) {
      // Its `sub` is in this same frame: neither goes out (the shard would build and drop that snapshot for nothing).
      q.subAt.delete(unsubQid);
      q.bytes -= (q.frames[at] ?? "").length + 1;
      q.frames[at] = "";
      q.subs.splice(q.subs.indexOf(unsubQid), 1);
      conn.ikPipelined?.delete(unsubQid);
      return;
    }
    if (q && q.bytes + frame.length > MAX_BATCH_BYTES) {
      this.flushOut(conn);
      q = undefined;
    }
    if (!q) {
      conn.out = q = { frames: [], bytes: 2, subs: [], unsubs: [], muts: new Map(), subAt: new Map(), acks: [] };
      const gen = conn.gen;
      // Two microtasks: an unsubscribe deferred by one (`addListener`'s) lands in the same frame as the `sub` that
      // replaces it (a pinned page, a `fromAuth` store moving shards), and the shard handles both in one event.
      queueMicrotask(() =>
        queueMicrotask(() => {
          if (conn.gen === gen && conn.out === q) this.flushOut(conn);
        }),
      );
    }
    if (mid !== undefined) q.muts.set(mid, q.frames.length);
    if (subQid !== undefined) q.subAt.set(subQid, q.frames.length);
    q.frames.push(frame);
    q.bytes += frame.length + 1;
    if (subQid !== undefined) q.subs.push(subQid);
    if (unsubQid !== undefined) q.unsubs.push(unsubQid);
    if (ack) {
      for (const mid of ack.mids) q.acks.push(mid);
      q.ackVersion = minVersion(q.ackVersion, ack.version);
    }
    if (q.frames.length >= MAX_BATCH_MESSAGES) this.flushOut(conn);
  }

  private flushOut(conn: Conn): void {
    const q = conn.out;
    conn.out = undefined;
    const ws = this.openWs(conn);
    if (!q) return;
    // Mutations dropped since they were queued (`drop`: discarded, another identity) and `sub`s cancelled by their
    // `unsub` left an empty slot.
    if (q.frames.includes("")) q.frames = q.frames.filter((f) => f !== "");
    if (!ws) {
      // Closed before its close event ran (`detachSocket` will find no frame): its acks wait again.
      this.restoreAcks(conn, q.acks, q.ackVersion);
      return;
    }
    // Acks waiting for their timer ride along (one frame, one Durable Object event, instead of one more later).
    let taken: Id[] = q.acks;
    let takenVersion: number | undefined = q.ackVersion;
    if (conn.batch && conn.acks?.length && this.ackable(conn)) {
      const version = conn.ackVersion;
      takenVersion = minVersion(takenVersion, version);
      const acks = this.takeAcks(conn);
      for (let i = 0; i < acks.length; i++) {
        const f = stringify(acks[i]);
        if (q.frames.length >= MAX_BATCH_MESSAGES || q.bytes + f.length + 1 > MAX_BATCH_BYTES) {
          // No room: the rest waits for the next frame or its timer (still flushed early on a busy shard: the
          // oldest version of the whole lot is a lower bound for the rest).
          conn.acks = acks.slice(i).flatMap((m) => m.mids);
          conn.ackVersion = version;
          this.armAckTimer(conn);
          break;
        }
        q.frames.push(f);
        q.bytes += f.length + 1;
        taken = taken.concat(acks[i]!.mids);
      }
    }
    if (!q.frames.length) return;
    if (q.frames.length > 1 && !conn.ready) {
      // Before `ready`: the server may not speak "batch" (see `onReady`).
      const bp = (conn.batchPipelined ??= { arrays: 0, qids: new Set(), unsubs: new Set() });
      bp.arrays++;
      for (const qid of q.subs) bp.qids.add(qid);
      for (const qid of q.unsubs) bp.unsubs.add(qid);
    }
    if (!this.sendFrame(conn, ws, q.frames.length === 1 ? q.frames[0]! : `[${q.frames.join(",")}]`) && taken.length) {
      // Not sent: the acks it carried (its own `ack` messages and the ones that rode along) wait again, for the next
      // socket of the same identity (`onReady`).
      this.restoreAcks(conn, taken, takenVersion);
    }
  }

  /** Acks a lost frame carried, waiting again (before the ones that came in meanwhile). */
  private restoreAcks(conn: Conn, mids: Id[], version: number | undefined): void {
    if (!mids.length) return;
    conn.acks = mids.concat(conn.acks ?? []);
    conn.ackVersion = minVersion(conn.ackVersion, version);
  }

  /**
   * A `send` that throws lost the frame. A close event usually follows, but not always (a socket the platform still
   * reports open): the socket is dropped right after this turn so the usual recovery runs anyway (one-shot queries
   * go over HTTP, subscriptions and pending mutations go out again on the next socket). Returns whether it went out.
   */
  private sendFrame(conn: Conn, ws: WebSocketLike, frame: string): boolean {
    if (conn.failedWs === ws) return false;
    try {
      ws.send(frame);
      return true;
    } catch {
      // Nothing else goes out on it, even later in this loop (`openWs`).
      conn.failedWs = ws;
      queueMicrotask(() => {
        if (conn.ws !== ws) return; // the close event came first
        this.dropSocket(conn);
        this.scheduleRetry(conn);
      });
      return false;
    }
  }

  private sendSub(conn: Conn, sub: Sub): void {
    conn.qids.set(sub.qid, sub);
    sub.sentAuthSeq = conn.authSeq;
    const m: ClientMessage = { t: "sub", qid: sub.qid, fn: sub.fn, args: sub.args };
    // A value fetched over HTTP for this connection (`httpFirst`) carries the epoch the server checks.
    const epochOk = sub.epoch === conn.epoch || (sub.fromHttp === true && !conn.ready);
    sub.resumeBase = undefined;
    sub.resumeOffered = undefined;
    sub.awaitingReply = true;
    const l = sub.local;
    if (sub.confirmed && sub.epoch && epochOk && sub.authGen === this.authGen && !sub.error) {
      m.resume = { version: sub.version, epoch: sub.epoch };
      sub.resumeOffered = { value: sub.confirmed.value, authSeq: conn.authSeq };
      // Feature "ident": the server keeps no identity row per snapshot; without the tag it sends a full snap.
      // Before `ready` (pipelined) the tag goes optimistically: only an "ident" server of this epoch gave it.
      if (sub.ik !== undefined && (conn.ident || !conn.ready)) {
        m.resume.ik = sub.ik;
        if (!conn.ready) (conn.ikPipelined ??= new Set()).add(sub.qid);
      }
    } else if (!sub.confirmed && !sub.error && l && typeof l.version === "number" && l.epoch && l.ik && (l.epoch === conn.epoch || !conn.ready) && (conn.ident || !conn.ready)) {
      // A value stored for this identity (offline adapter, snapshot cache), or a local run the adapter found equal to
      // it (`source: "local"` with `version`): `unchanged` makes it the confirmed value; under another identity (its
      // tag differs), another epoch or after changes, the shard sends the full value.
      m.resume = { version: l.version, epoch: l.epoch, ik: l.ik };
      if (!conn.ready) (conn.ikPipelined ??= new Set()).add(sub.qid);
      sub.resumeBase = { value: l.value, ik: l.ik };
      sub.resumeOffered = { value: l.value, authSeq: conn.authSeq };
    }
    this.send(conn, m);
  }

  private sendMut(conn: Conn, p: Pending): void {
    // Only ever as the identity that issued it: signed out (or not known yet) it waits; another identity drops it.
    // What counts is the identity this socket runs as (its last hello/auth), never the stored one nor a token that
    // has not reached the socket yet.
    const owner = p.record.identity;
    if (owner) {
      const now = conn.identity ?? null;
      if (!now) {
        p.held = true;
        return;
      }
      if (!sameIdentity(owner, now)) return this.drop(p, new EmberError("identity_changed", "queued by another identity"));
    }
    p.held = false;
    p.sentAuthSeq = conn.authSeq;
    this.send(conn, { t: "mut", mid: p.record.mid, fn: p.record.fn, args: p.record.args });
  }

  /** Takes a pending mutation out for good (never sent): out of storage, its optimistic effect rolled back. */
  private drop(p: Pending, error: EmberError): void {
    if (this.pendingByMid.get(p.record.mid) !== p) return;
    this.pendingByMid.delete(p.record.mid);
    // Still in this turn's frame (not on the socket yet): it never goes out.
    const q = this.conns.get(p.record.shard)?.out;
    const at = q?.muts.get(p.record.mid);
    if (q && at !== undefined) {
      q.muts.delete(p.record.mid);
      q.bytes -= q.frames[at]!.length + 1;
      q.frames[at] = "";
    }
    const i = this.pending.indexOf(p);
    if (i >= 0) this.pending.splice(i, 1);
    void Promise.resolve()
      .then(() => this.storage.remove(p.record.mid))
      .catch(() => undefined);
    if (p.update) this.recompute();
    p.reject(error);
    this.emitState();
    // Nothing left for this shard: its socket may go, as after a settled mutation.
    this.release(p.record.shard);
  }

  /**
   * Drops every queued mutation (sign-out on a shared device, "discard offline changes"): none of them is sent, each
   * caller's promise rejects with `discarded`, optimistic effects roll back. Returns how many were dropped.
   */
  async discardPending(): Promise<number> {
    await this.init.catch(() => undefined);
    const all = [...this.pending];
    for (const p of all) this.drop(p, new EmberError("discarded", "pending mutation discarded"));
    return all.length;
  }

  /** Another identity signed in: what an earlier one queued is dropped (it would otherwise run as the new one). */
  private dropForeign(id: LocalIdentity): void {
    for (const p of [...this.pending]) {
      const owner = p.record.identity;
      // One already on a socket ran (or runs) as its own identity: its answer settles it. Should it need resending
      // (a reconnect), `sendMut` drops it then, since that socket runs as someone else.
      if (owner && !sameIdentity(owner, id) && p.sentAuthSeq < 0) this.drop(p, new EmberError("identity_changed", "queued by another identity"));
    }
  }

  // ---------------------------------------------------------------------------------------------- heartbeat

  private armPing(conn: Conn): void {
    const hb = this.options.heartbeat;
    if (hb === false || !conn.ready) return;
    this.clearTimer(conn, "pingTimer");
    const interval = hb?.intervalMs ?? 25_000;
    this.pingAfter(conn, Math.round(interval * (1 - this.random() / 5)));
  }

  /**
   * Pings after `quiet` ms with no frame from the server. Any frame counts as liveness (`heard` only stamps the
   * time, no timer per frame): one heard meanwhile pushes the ping to `quiet` ms after it.
   */
  private pingAfter(conn: Conn, quiet: number, ms = quiet): void {
    const armedAt = Date.now();
    conn.pingTimer = setTimeout(() => {
      conn.pingTimer = null;
      const heardAt = conn.heardAt ?? 0;
      const since = Date.now() - heardAt;
      if (heardAt > armedAt && since < quiet) return this.pingAfter(conn, quiet, quiet - since);
      this.ping(conn);
    }, ms);
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
    conn.heardAt = Date.now();
    if (!conn.deadlineTimer) return;
    this.clearTimer(conn, "deadlineTimer");
    this.armPing(conn);
  }

  // ---------------------------------------------------------------------------------------------- connectivity

  private onConnectivity(e: ConnectivityEvent): void {
    if (this.closed) return;
    // Hidden / backgrounded (the OS may kill the socket any time now): acks waiting for their timer go now, and the
    // snapshot cache is written with the current versions (the page may not come back).
    if (e === "background") {
      this.flushSnapshots();
      return this.flushAllAcks();
    }
    if (e === "offline") {
      this.online = false;
      for (const conn of this.conns.values()) {
        this.dropSocket(conn);
        this.clearTimer(conn, "retryTimer");
        conn.quickRetry = false;
        conn.state = "offline";
      }
      this.emitState();
      return;
    }
    if (e === "online" || e === "foreground") {
      this.online = true;
      for (const conn of this.conns.values()) {
        if (!this.needed(conn)) {
          if (conn.state === "offline") conn.state = "idle";
          // Went idle while offline: nothing of it left, so it leaves the list now.
          if (!conn.ws && !conn.idleTimer) this.forgetIdle(conn);
          continue;
        }
        if (conn.ws && conn.ready) {
          // Back from background: a quick ping finds a socket the OS killed silently.
          if (e === "foreground") this.ping(conn);
          continue;
        }
        conn.attempt = 0;
        if (conn.ws || conn.state === "connecting") {
          // An attempt is in flight (socket opening, or the token still loading): it goes on, and if it fails its
          // retry is the short spread below, not the backoff (the network is back).
          conn.quickRetry = true;
          continue;
        }
        this.clearTimer(conn, "retryTimer");
        conn.state = "waiting";
        conn.retryTimer = setTimeout(() => {
          conn.retryTimer = null;
          void this.connect(conn);
        }, this.spreadDelay());
      }
      this.emitState();
    }
  }

  // ---------------------------------------------------------------------------------------------- frames

  private onFrame(conn: Conn, data: unknown): void {
    this.heard(conn);
    if (typeof data !== "string") return;
    if (data === PONG) return;
    let parsed: ServerMessage | ServerMessage[];
    try {
      parsed = parse(data) as ServerMessage | ServerMessage[];
    } catch {
      this.report(new EmberError("bad_frame", "server sent invalid JSON"), { shard: conn.shard });
      return;
    }
    if (!Array.isArray(parsed)) return this.onMessage(conn, parsed);
    // Feature "batch": the messages of one server turn, in order. A handler may replace the socket (restart).
    // One recompute for the whole frame (every `snap`/`patch` would otherwise re-run every optimistic update and walk
    // every subscription): it runs before any Promise settled by these messages resumes its caller.
    const gen = conn.gen;
    this.frameDepth++;
    try {
      for (const m of parsed) {
        if (conn.gen !== gen) break;
        this.onMessage(conn, m);
      }
    } finally {
      this.frameDepth--;
      if (this.frameDepth === 0 && this.recomputeDeferred) {
        this.recomputeDeferred = false;
        const subs = [...this.deferredSubs];
        this.deferredSubs.clear();
        this.recompute(subs);
      }
    }
  }

  private onMessage(conn: Conn, m: ServerMessage): void {
    switch (m.t) {
      case "ready":
        return this.onReady(conn, m);
      case "snap": {
        const sub = conn.qids.get(String(m.qid));
        if (!sub) return;
        let promoted = false;
        if (m.unchanged) {
          // `unchanged` is about the value that `sub` offered, nothing else: a value shown since (`hydrate()` while
          // loading) is not what the shard checked.
          // Nor is it about the identity the socket runs as now if an `auth` frame went after that `sub`: the shard
          // checked the offer under the identity before it (an account switch), so it says nothing for this one.
          const offered = conn.authSeq === sub.resumeOffered?.authSeq ? sub.resumeOffered : undefined;
          const base = sub.resumeBase;
          if (sub.confirmed && offered && Object.is(sub.confirmed.value, offered.value)) {
            // still the value it resumed from
          } else if (base && offered && Object.is(base.value, offered.value)) {
            // The cached value it resumed from is current: it is the confirmed value now.
            sub.confirmed = { value: base.value };
            sub.ik = base.ik;
            promoted = true;
            this.dropLocal(sub);
          } else {
            // Nothing to keep (the cached value was dropped meanwhile, another one is shown, or the identity changed):
            // ask again, for the full value.
            this.send(conn, { t: "unsub", qid: sub.qid });
            this.sendSub(conn, sub);
            return;
          }
        } else {
          // A new full value keeps the identity of what did not change in the one shown (rows re-render less).
          const prev = sub.confirmed ?? sub.local;
          sub.confirmed = { value: prev ? reuseUnchanged(prev.value, m.value) : m.value };
          sub.ik = m.ik;
          this.dropLocal(sub);
        }
        sub.resumeBase = undefined;
        sub.resumeOffered = undefined;
        sub.awaitingReply = false;
        // `unchanged` over the value already confirmed (not promoted), with no error to clear: the snapshot is the same.
        const same = m.unchanged && !promoted && sub.error === null;
        // The shard answered for the socket's identity (`ik`, or its identity rows): the value is that identity's.
        sub.owner = conn.opaque ? undefined : { key: identityCacheKey(conn.identity ?? null), identity: conn.identity ?? null };
        sub.version = m.version;
        sub.epoch = conn.epoch;
        sub.authGen = this.authGen;
        sub.error = null;
        sub.fromHttp = false;
        if (!m.unchanged || promoted) this.persist([sub]);
        if (same) return;
        return this.recompute([sub]);
      }
      case "patch": {
        const changed: Sub[] = [];
        for (const c of m.changes) {
          const sub = conn.qids.get(String(c.qid));
          if (!sub) continue;
          if (c.diff || c.vdiff) {
            // Applied to the confirmed value (optimistic layers are re-applied on top by recompute).
            let next: unknown;
            try {
              next = c.diff ? applyRowDiff(sub.confirmed?.value, c.diff) : applyValueDiff(sub.confirmed?.value, c.vdiff!);
            } catch (e) {
              // Our base is not the server's: resubscribe without resume for a full snapshot.
              this.report(new EmberError("rowdiff_mismatch", (e as Error).message), { shard: conn.shard });
              sub.epoch = null;
              this.send(conn, { t: "unsub", qid: sub.qid });
              this.sendSub(conn, sub);
              continue;
            }
            sub.confirmed = { value: next };
          } else sub.confirmed = { value: sub.confirmed ? reuseUnchanged(sub.confirmed.value, c.value) : c.value };
          this.dropLocal(sub);
          sub.error = null;
          sub.awaitingReply = false;
          changed.push(sub);
        }
        // Every confirmed value on this socket is current as of this version — except one whose `sub` the shard has
        // not answered yet (it may hold changes this patch does not carry).
        for (const sub of conn.qids.values()) if (sub.confirmed && !sub.awaitingReply && sub.version < m.version) sub.version = m.version;
        // A busy shard: waiting acks go before their outcomes could leave its ring unacknowledged (a dedup row each).
        if (conn.ackVersion !== undefined && m.version - conn.ackVersion >= ACK_VERSION_SPAN) this.flushAcks(conn);
        this.persist(changed);
        // The confirmed values now include these mutations: drop their optimistic layers in the same recompute, so
        // the confirmed row and the optimistic row of one mutation are never shown together. Their mres follows.
        for (const mid of m.mids ?? []) {
          const p = this.pendingByMid.get(String(mid));
          if (p && p.record.shard === conn.shard) p.update = undefined;
        }
        return this.recompute(changed);
      }
      case "qres": {
        const q = conn.queries.get(String(m.qid));
        if (!q) return;
        conn.queries.delete(String(m.qid));
        if (m.ok) q.resolve(m.value);
        else q.reject(errorFromWire(m.error, "Error"));
        this.release(conn.shard);
        return;
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
        const err = errorFromWire(m, "Error");
        const q = m.qid !== undefined ? conn.queries.get(String(m.qid)) : undefined;
        if (q) {
          // A one-shot query the server refused before running it (e.g. auth_expired): ask over HTTP instead.
          conn.queries.delete(String(m.qid));
          q.retry();
          this.release(conn.shard);
          return;
        }
        if (m.qid === undefined && m.code === "bad_frame" && !conn.query && conn.queries.size) {
          // A server without feature "query" refused a forced `q` (qid-less bad_frame): those go over HTTP.
          const queries = [...conn.queries.values()];
          conn.queries.clear();
          for (const x of queries) x.retry();
          this.release(conn.shard);
          return;
        }
        if (m.qid !== undefined) {
          const sub = conn.qids.get(String(m.qid));
          if (!sub) return;
          // A cached value is not shown next to a refusal (expired or revoked access, a failing query).
          if (!sub.confirmed && sub.local) this.forgetCached(sub);
          if (m.code === "auth_expired") {
            // The server dropped this `sub`: subscribe again once a fresh token is sent.
            conn.qids.delete(sub.qid);
            if (sub.sentAuthSeq !== undefined && conn.authSeq > sub.sentAuthSeq) {
              // An `auth` already went after it (a renewal sent before this refusal came back): the frames run in
              // order, so the `sub` sent again now runs under that token (as a refused `mut` is resent).
              this.sendSub(conn, sub);
              return;
            }
            void this.reauth(conn).then((r) => {
              if (this.subs.get(sub.key) !== sub || conn.qids.has(sub.qid) || !conn.ready) return;
              if (r === "sent") this.sendSub(conn, sub);
              else if (r === "failed") {
                sub.error = err;
                // A later fresh token (refresh, sign-in) sends it again (`sendAuth`).
                (conn.authRefused ??= new Set()).add(sub);
                this.recompute([sub]);
              }
            });
            return;
          }
          // The server keeps a failing subscription registered and sends a `patch` once it succeeds again.
          sub.error = err;
          return this.recompute([sub]);
        }
        if (m.code === "unauthenticated" && !conn.ready) {
          // The shard refused the hello's token: this socket runs signed out. Values cached for that identity are not
          // shown (its access may have been revoked) and are forgotten.
          const refused = conn.identity;
          conn.identity = null;
          conn.opaque = false;
          if (refused && this.snapshots) {
            try {
              this.snapshots.clear(identityCacheKey(refused));
            } catch {
              /* best effort */
            }
          }
          for (const sub of this.shardSubs(conn.shard)) if (!sub.confirmed && sub.local?.source === "cache") this.forgetCached(sub);
        }
        if (m.code === "bad_frame" && conn.ikRefusals) {
          conn.ikRefusals--; // a pipelined `resume.ik` refused by a server without "ident"; already resent
          return;
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
    // What was queued before `ready` goes out as pipelined (so the fallback below accounts for it).
    if (conn.out) this.flushOut(conn);
    conn.ready = true;
    conn.attempt = 0;
    conn.quickRetry = false;
    conn.epoch = m.epoch;
    conn.ident = m.features?.includes("ident") === true;
    conn.query = m.features?.includes("query") === true;
    conn.ack = m.features?.includes("ack") === true;
    conn.batch = m.features?.includes("batch") === true;
    conn.serverBatch = conn.batch;
    // The deployment's runtime (every shard's): whether `httpFirst` batches its fetches from now on.
    this.queryBatch = m.features?.includes("qbatch") === true;
    const piped = conn.batchPipelined;
    conn.batchPipelined = undefined;
    let refused = 0;
    // Unsubs of refused arrays whose sub the server did take (it went alone): they go again, before anything else.
    const unsubs: string[] = [];
    if (!conn.batch && piped) {
      // Array frames sent before `ready` to a server without "batch": each was refused whole (one qid-less
      // `bad_frame`). Their subs go again below, one frame each.
      for (const qid of piped.qids) conn.qids.delete(qid);
      for (const qid of piped.unsubs) if (!piped.qids.has(qid) && !conn.qids.has(qid)) unsubs.push(qid);
      refused += piped.arrays;
    }
    if (!conn.ident && conn.ikPipelined) {
      // Refused by a server without "ident" (unknown field): resend those below, without the tag. One that rode in a
      // refused array frame was counted with it.
      for (const qid of conn.ikPipelined) {
        if (!conn.batch && piped?.qids.has(qid)) continue;
        conn.qids.delete(qid);
        refused++;
      }
    }
    conn.ikRefusals = (conn.ikRefusals ?? 0) + refused;
    conn.ikPipelined = undefined;
    // Acks a previous socket could not send: this one takes them if it runs as the same identity (the shard finds
    // outcomes by identity and clientId); they ride with what goes out next. Others can never be sent.
    if (conn.acks?.length && conn.ackGen !== conn.gen) {
      if (conn.ack && conn.ackAuth !== undefined && conn.ackAuth !== -1 && conn.ackAuth === conn.authGen) {
        conn.ackGen = conn.gen;
        this.armAckTimer(conn);
      } else this.dropAcks(conn);
    }
    conn.state = "open";
    for (const qid of unsubs) this.send(conn, { t: "unsub", qid });
    // The socket is ready before their HTTP answers: it sends the snapshots (below), the fetches stop.
    if (conn.httpFirstWaiting?.size) for (const sub of [...conn.httpFirstWaiting]) this.cancelHttpFirst(undefined, sub);
    conn.httpFirstWaiting = undefined;
    conn.httpFirstDone = undefined;
    // Pipelined subscriptions already went out with hello.
    for (const sub of this.shardSubs(conn.shard)) if (!conn.qids.has(sub.qid) && !sub.localPending && !sub.httpFirst) this.sendSub(conn, sub);
    // Over a copy: sending can drop a mutation (another identity's), which would skip the next one in a live walk.
    for (const p of [...this.pending]) if (p.record.shard === conn.shard) this.sendMut(conn, p);
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
    // Feature "ack": once the mutation is out of pending storage (it will never be resent), tell the shard.
    const ackGen = conn.ack ? conn.gen : undefined;
    const ackAuth = conn.authGen ?? -1;
    if (ackGen !== undefined) conn.acking = (conn.acking ?? 0) + 1;
    void Promise.resolve()
      .then(() => this.storage.remove(p.record.mid))
      .then(
        () => ackGen !== undefined && this.queueAck(conn, ackGen, ackAuth, m.mid, m.ok ? m.version : undefined),
        () => undefined,
      )
      .finally(() => {
        if (ackGen === undefined) return;
        conn.acking = Math.max(0, (conn.acking ?? 1) - 1);
        if (!conn.acking) this.release(conn.shard);
      });
    // Usually already dropped by the patch listing this mid; a rejected (or patch-less) mutation drops it here.
    if (p.update) this.recompute();
    if (m.ok) p.resolve(m.value);
    else p.reject(errorFromWire(m.error, "Error", "rejected"));
    this.emitState();
    this.release(conn.shard);
  }

  /**
   * Acks are coalesced per shard: they go out together `ACK_DELAY_MS` after the first, with any other frame (feature
   * "batch", `flushOut`), at `ACK_MAX` waiting, once the shard's version moved `ACK_VERSION_SPAN` past them, and
   * before the socket closes (idle, `close()`, page hide). `gen`/`auth`: the socket that received the `mres` and the
   * identity it ran as. One that dropped meanwhile leaves them for the next socket of that identity (`onReady`).
   */
  private queueAck(conn: Conn, gen: number, auth: number, mid: Id, version?: number): void {
    if (this.closed) return;
    // The socket changed since the `mres`, but the current one runs as the same identity: it can send this ack.
    const g = gen !== conn.gen && auth !== -1 && auth === conn.authGen && conn.ready ? conn.gen : gen;
    // Waiting acks of the same known identity (another socket that dropped before sending them): one lot, carried
    // together to the next socket of that identity (`onReady`).
    const sameIdentity = !!conn.acks?.length && auth !== -1 && conn.ackAuth === auth;
    if (conn.acks?.length && !sameIdentity && (conn.ackGen !== g || conn.ackAuth !== auth)) {
      // Waiting acks of another socket or identity: they go now if they can, else never.
      this.flushAcks(conn);
      this.dropAcks(conn);
    }
    if (!sameIdentity || g === conn.gen) conn.ackGen = g;
    conn.ackAuth = auth;
    (conn.acks ??= []).push(mid);
    if (conn.acks.length > ACK_KEEP_MAX) conn.acks.splice(0, conn.acks.length - ACK_KEEP_MAX);
    if (version !== undefined && (conn.ackVersion === undefined || version < conn.ackVersion)) conn.ackVersion = version;
    // No socket that can take them now: they wait for the next one (`onReady`).
    if (!this.ackable(conn)) return;
    if (conn.acks.length >= ACK_MAX) return this.flushAcks(conn);
    this.armAckTimer(conn);
  }

  /**
   * The waiting acks can go out on the current socket: ready with "ack", theirs (or carried to it), and still running
   * as the identity their mutations ran as (unknown, -1: sent anyway; under another identity the shard ignores them).
   */
  private ackable(conn: Conn): boolean {
    return conn.ready && conn.ack === true && conn.ackGen === conn.gen && (conn.ackAuth === conn.authGen || conn.ackAuth === -1);
  }

  private dropAcks(conn: Conn): void {
    conn.acks = [];
    conn.ackVersion = undefined;
    if (conn.ackTimer) clearTimeout(conn.ackTimer);
    conn.ackTimer = null;
  }

  private armAckTimer(conn: Conn): void {
    if (conn.ackTimer || !conn.acks?.length) return;
    const gen = conn.gen;
    conn.ackTimer = setTimeout(() => {
      conn.ackTimer = null;
      if (conn.gen === gen) this.flushAcks(conn);
    }, ACK_DELAY_MS);
  }

  /** The waiting acks as `ack` messages (256 mids each), taken off the socket. */
  private takeAcks(conn: Conn): Array<Extract<ClientMessage, { t: "ack" }>> {
    const mids = conn.acks ?? [];
    this.dropAcks(conn);
    const out: Array<Extract<ClientMessage, { t: "ack" }>> = [];
    for (let i = 0; i < mids.length; i += 256) out.push({ t: "ack", mids: mids.slice(i, i + 256) });
    return out;
  }

  /**
   * Send the waiting acks now (in this turn's frame when batching). With no socket that can take them they stay for
   * the next one (`onReady`); a ready socket that cannot (another identity, no "ack") means they never will.
   */
  private flushAcks(conn: Conn): void {
    if (!conn.acks?.length) return;
    if (!this.ackable(conn)) {
      if (conn.ready || conn.ackAuth !== this.authGen || conn.ackAuth === -1) this.dropAcks(conn);
      return;
    }
    const version = conn.ackVersion;
    for (const m of this.takeAcks(conn)) this.sendEncoded(conn, stringify(m), undefined, undefined, { mids: m.mids, version });
  }

  /** The app is going away (page hide, background): what is waiting goes out now. */
  private flushAllAcks(): void {
    for (const conn of this.conns.values()) {
      this.flushAcks(conn);
      if (conn.out) this.flushOut(conn);
    }
  }

  private report(e: EmberError, info: { shard?: string }): void {
    if (this.options.onError) this.options.onError(e, info);
  }
}

/** Mutation ids are strings; the server echoes them back as given. */
export type MutationId = Id;

function index<K>(map: Map<K, Set<Sub>>, k: K, s: Sub): void {
  const set = map.get(k);
  if (set) set.add(s);
  else map.set(k, new Set([s]));
}

function unindex<K>(map: Map<K, Set<Sub>>, k: K, s: Sub): void {
  const set = map.get(k);
  if (!set?.delete(s)) return;
  if (!set.size) map.delete(k);
}

function sameIdentity(a: LocalIdentity, b: LocalIdentity): boolean {
  return a.subject === b.subject && (a.issuer ?? null) === (b.issuer ?? null);
}

function minVersion(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}
