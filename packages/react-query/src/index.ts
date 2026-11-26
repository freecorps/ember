// TanStack Query adapter for @freecorps/ember-client (in the spirit of @convex-dev/react-query).
//
//   const ember = new EmberClient({ url, defaultShard: "org:acme" });
//   const queryClient = new QueryClient();
//   new EmberQueryClient(ember).connect(queryClient);
//
//   const { data } = useQuery(emberQuery(api.messages.list, { channel }));
//   const send = useMutation({ mutationFn: emberMutationFn(api.messages.send) });
//
// Queries live in the TanStack cache under ["ember", shard, fn, args] with staleTime Infinity. A query is
// subscribed over the socket while it has observers, and for `unsubscribeGraceMs` (default 5 s) after the last one
// goes (or until TanStack garbage-collects it, if sooner): a remount within the grace keeps the subscription, a later
// one subscribes again (resuming from the client's cached value when it has one). Every server patch (and optimistic
// update) is pushed with setQueryData; the client already keeps unchanged rows' identity, so no structural sharing.
import {
  hashKey,
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  skipToken,
  type InfiniteData,
  type QueryCacheNotifyEvent,
  type QueryClient,
  type QueryKey,
  type Query,
} from "@tanstack/react-query";
import {
  EmberError,
  encodeJson,
  getFunctionName,
  stableStringify,
  unsafeRef,
  type ActionReference,
  type ArgsAndOptions,
  type ArgsOrSkipAndOptions,
  type EmberClient,
  type EmberErrorOf,
  type FunctionReference,
  type HydratedQuery,
  type MutationOptions,
  type MutationReference,
  type OptionsFor,
  type PaginationOptions,
  type PaginationResult,
  type QueryReference,
  type QuerySnapshot,
  type ShardOptions,
  type Visibility,
} from "@freecorps/ember-client";

type QueryRef = QueryReference;
type MutationRef = MutationReference;
type ArgsOf<F extends QueryRef | MutationRef | ActionReference> = F["_args"];
type ReturnOf<F extends QueryRef | MutationRef | ActionReference> = F["_returnType"];

/** `["ember", shard | null, "module:export", args]`; a null shard means the client's `defaultShard`. */
export type EmberQueryKey = readonly ["ember", string | null, string, Record<string, unknown> | "skip"];

export const isEmberQueryKey = (key: QueryKey): key is EmberQueryKey => key[0] === "ember" && key.length === 4 && typeof key[2] === "string";

/** Hash for TanStack: ember keys via the tagged stable JSON (bigint/bytes safe), others via `hashKey`. */
export function emberQueryKeyHashFn(key: QueryKey): string {
  return isEmberQueryKey(key) || key[0] === "ember:hydration" || key[0] === "ember:paginated" ? `ember:${stableStringify(key)}` : hashKey(key);
}

const registry = new WeakMap<QueryClient, EmberQueryClient>();

/**
 * The reference each query key came from (`emberQuery` binds it to the key array it builds, which TanStack keeps as
 * the query's `queryKey` and hands to its `queryFn`): a key only holds the name, and the reference carries the
 * function's shard routing (`shard: { org: "orgId" }`, `fromAuth`), which the client needs to route a call without
 * `{ shard }`. Held weakly: it goes with the key (no growth with queries), and a later `emberQuery` of the same name
 * with another reference never changes how an existing query routes.
 */
const keyRefs = new WeakMap<QueryKey, QueryRef>();
/**
 * Fallback for a key no `emberQuery` built (restored from a persisted cache, or written by hand): the last reference
 * `emberQuery` saw for the name. One entry per function name of the app (a fixed set: references come from `api`), else
 * a reference by name: the key's shard, else the client's `defaultShard`.
 */
const namedRefs = new Map<string, QueryRef>();

/** The reference that routes `key` (and, for a query, the key arrays its observers were built with). */
function refFor(key: EmberQueryKey, query?: Live["query"]): QueryRef {
  const bound = keyRefs.get(key);
  if (bound) return bound;
  // A query restored from a persisted cache keeps its restored key array: an observer's `emberQuery` built its own.
  for (const o of query?.observers ?? []) {
    const r = keyRefs.get(o.options.queryKey as QueryKey);
    if (r) return r;
  }
  return namedRefs.get(key[2]) ?? unsafeRef<"query">(key[2]);
}

function connected(qc: QueryClient): EmberQueryClient {
  const e = registry.get(qc);
  if (!e) throw new Error("Ember: this QueryClient is not connected (new EmberQueryClient(client).connect(queryClient))");
  return e;
}

/**
 * Query options for `useQuery`, `useSuspenseQuery`, `prefetchQuery`, ... `"skip"` disables the query.
 */
export function emberQuery<Q extends QueryRef>(ref: Q, ...rest: ArgsOrSkipAndOptions<Q, ShardOptions>) {
  const [args, opts] = rest as unknown as [ArgsOf<Q> | "skip" | undefined, ShardOptions | undefined];
  const name = getFunctionName(ref);
  const key = ["ember", opts?.shard ?? null, name, args === "skip" ? "skip" : ((args ?? {}) as Record<string, unknown>)] as const;
  keyRefs.set(key, ref);
  if (namedRefs.get(name) !== ref) namedRefs.set(name, ref);
  return queryOptions<ReturnOf<Q>, EmberErrorOf<Q>, ReturnOf<Q>, EmberQueryKey>({
    queryKey: key,
    queryFn: args === "skip" ? skipToken : (ctx) => connected(ctx.client).fetch(ctx.queryKey) as Promise<ReturnOf<Q>>,
    queryKeyHashFn: emberQueryKeyHashFn,
    staleTime: Infinity,
    // The client already reuses what did not change (rows matched by `_id`): a deep compare here would only cost.
    structuralSharing: false,
  });
}

/**
 * What the shard said about a value fetched on the server (`version`, `epoch`, `ik`), stored next to its query, with a
 * fingerprint of the value (`fp`): the browser resumes only if the query's data is still exactly that value (not
 * changed by `setQueryData`, nor by a lossy serialization of the dehydrated state).
 */
export type EmberHydrationMeta = Pick<HydratedQuery, "shard" | "version" | "epoch" | "ik"> & { fp: string };

/** A 53-bit hash of a value's tagged JSON; null when it cannot be encoded. */
function fingerprint(value: unknown): string | null {
  let json: string;
  try {
    json = encodeJson(value);
  } catch {
    return null;
  }
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${json.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/**
 * The key under which a server-fetched value's `EmberHydrationMeta` rides next to the query (it is dehydrated and
 * hydrated with it): the browser's first subscription resumes from the value instead of downloading it again.
 */
export const emberHydrationKey = (key: EmberQueryKey) => ["ember:hydration", key[1], key[2], key[3]] as const;

/** Stores what `fetchForHydration` returned: the value is the query's data, the rest its hydration entry. */
function keepMeta(qc: QueryClient, key: EmberQueryKey, h: HydratedQuery): unknown {
  const fp = h.epoch && h.ik ? fingerprint(h.value) : null;
  if (fp) qc.setQueryData<EmberHydrationMeta>(emberHydrationKey(key), { shard: h.shard, version: h.version, epoch: h.epoch, ik: h.ik, fp });
  return h.value;
}

/**
 * Same key as `emberQuery`, fetched once over HTTP (`POST /api/query`) with the given client. For SSR / loaders:
 * `await queryClient.prefetchQuery(emberQueryOneShot(ember, api.x.y, args))`, dehydrate, hydrate in the browser;
 * the live subscription starts when a component observes the query, resuming from the hydrated value (the shard
 * answers `unchanged` when nothing changed: no second download).
 */
export function emberQueryOneShot<Q extends QueryRef>(client: EmberClient, ref: Q, ...rest: ArgsAndOptions<Q, ShardOptions>) {
  const [args, opts] = rest as unknown as [ArgsOf<Q> | undefined, ShardOptions | undefined];
  const base = (emberQuery as (r: Q, a: unknown, o: unknown) => ReturnType<typeof emberQuery<Q>>)(ref, args ?? {}, opts);
  return queryOptions<ReturnOf<Q>, EmberErrorOf<Q>, ReturnOf<Q>, EmberQueryKey>({
    ...base,
    queryFn: async (ctx) => {
      const h = await (client.fetchForHydration as (r: Q, a: unknown, o: unknown) => Promise<HydratedQuery<ReturnOf<Q>>>)(ref, args ?? {}, opts);
      return keepMeta(ctx.client, ctx.queryKey, h) as ReturnOf<Q>;
    },
  });
}

/** `prefetchQuery` over HTTP (no socket): the SSR helper. */
export function prefetchEmberQuery<Q extends QueryRef>(queryClient: QueryClient, client: EmberClient, ref: Q, ...rest: ArgsAndOptions<Q, ShardOptions>): Promise<void> {
  return queryClient.prefetchQuery((emberQueryOneShot as (c: EmberClient, r: Q, ...x: unknown[]) => ReturnType<typeof emberQueryOneShot<Q>>)(client, ref, ...rest));
}

/**
 * `mutationFn` for `useMutation`. Runs over the EmberQueryClient connected to the mutation's QueryClient; the
 * optimistic update (if any) flows into the TanStack cache through the live queries.
 */
export function emberMutationFn<M extends MutationRef>(ref: M, opts?: MutationOptions<ArgsOf<M>>) {
  return (variables: ArgsOf<M>, context: { client: QueryClient }): Promise<ReturnOf<M>> =>
    (connected(context.client).client.mutation as (r: M, a: unknown, o: unknown) => Promise<ReturnOf<M>>)(ref, variables, opts);
}

/**
 * Full `useMutation` options with typed variables and errors:
 * `const send = useMutation(emberMutation(api.messages.send))` → `send.error` is `EmberErrorOf<typeof api.messages.send>`.
 */
export function emberMutation<M extends MutationRef>(ref: M, opts?: MutationOptions<ArgsOf<M>>) {
  return mutationOptions<ReturnOf<M>, EmberErrorOf<M>, ArgsOf<M>>({
    mutationKey: ["ember", opts?.shard ?? null, getFunctionName(ref)],
    mutationFn: emberMutationFn(ref, opts) as (variables: ArgsOf<M>) => Promise<ReturnOf<M>>,
  });
}

/**
 * `useMutation` options for an action (`POST /api/action`), with typed variables and errors:
 * `const run = useMutation(emberAction(api.ai.summarize))` → `run.data` is the action's result, `run.error` its
 * `EmberErrorOf`. Routed like any call: `{ shard }`, else the function's own routing (`fromArg`, `fromAuth`), else the
 * client's `defaultShard`.
 */
export function emberAction<A extends ActionReference>(ref: A, opts?: ShardOptions) {
  return mutationOptions<ReturnOf<A>, EmberErrorOf<A>, ArgsOf<A>>({
    mutationKey: ["ember:action", opts?.shard ?? null, getFunctionName(ref)],
    mutationFn: emberActionFn(ref, opts) as (variables: ArgsOf<A>) => Promise<ReturnOf<A>>,
  });
}

/** `mutationFn` of `emberAction`: runs the action with the client connected to the mutation's QueryClient. */
export function emberActionFn<A extends ActionReference>(ref: A, opts?: ShardOptions) {
  return (variables: ArgsOf<A>, context: { client: QueryClient }): Promise<ReturnOf<A>> =>
    (connected(context.client).client.action as (r: A, a: unknown, o: unknown) => Promise<ReturnOf<A>>)(ref, variables, opts);
}

/** A query usable with `emberPaginatedQuery`: it takes `paginationOpts` and returns a `PaginationResult`. */
export type PaginatedQueryReference = FunctionReference<"query", Visibility, { paginationOpts: PaginationOptions }, PaginationResult<unknown>>;
type PageItem<Q extends PaginatedQueryReference> = ReturnOf<Q> extends PaginationResult<infer T> ? T : never;
/** `["ember:paginated", shard | null, "module:export", args (without paginationOpts), numItems]`. */
export type EmberPaginatedKey = readonly ["ember:paginated", string | null, string, Record<string, unknown> | "skip", number];

/**
 * `infiniteQueryOptions` over Ember's cursor pagination, for `useInfiniteQuery` / `useSuspenseInfiniteQuery`:
 * page 1 is `paginationOpts: { numItems, cursor: null }`, the next one starts at the page's `continueCursor`
 * (`hasNextPage` is `!isDone`). Each page is one read (`client.query`: the socket when it is open, else HTTP), routed
 * by the reference (`fromArg` / `fromAuth`) unless `{ shard }` names one. Pages are not live: refetch or invalidate
 * the key to see new rows (TanStack refetches every loaded page from its cursor); for live pages use
 * `usePaginatedQuery` of `@freecorps/ember-react`. `"skip"` disables it.
 */
export function emberPaginatedQuery<Q extends PaginatedQueryReference>(ref: Q, args: Omit<ArgsOf<Q>, "paginationOpts"> | "skip", opts: OptionsFor<Q, ShardOptions> & { numItems: number }) {
  const o = opts as ShardOptions & { numItems: number };
  const shard = o.shard;
  const key: EmberPaginatedKey = ["ember:paginated", shard ?? null, getFunctionName(ref), args === "skip" ? "skip" : (args as Record<string, unknown>), o.numItems];
  type Page = PaginationResult<PageItem<Q>>;
  return infiniteQueryOptions<Page, EmberErrorOf<Q>, InfiniteData<Page, string | null>, EmberPaginatedKey, string | null>({
    queryKey: key,
    queryFn:
      args === "skip"
        ? skipToken
        : (ctx) =>
            connected(ctx.client).fetchPage(
              ctx.queryKey,
              ref,
              { ...(args as Record<string, unknown>), paginationOpts: { numItems: o.numItems, cursor: ctx.pageParam } },
              shard,
            ) as Promise<Page>,
    initialPageParam: null,
    getNextPageParam: (last) => (last.isDone ? undefined : last.continueCursor),
    queryKeyHashFn: emberQueryKeyHashFn,
  });
}

export interface EmberQueryClientOptions {
  /** Fetch with HTTP one-shots and never subscribe (SSR). Default: true when there is no `window`. */
  ssr?: boolean;
  /**
   * How long a query stays subscribed after its last observer goes (unmount, navigation). An observer coming back
   * within it keeps the subscription; after it, the server subscription is dropped (the cached data stays, and a new
   * observer subscribes again). Default 5000 ms; `Infinity` keeps it until TanStack garbage-collects the query (a
   * negative value is 0, NaN the default).
   */
  unsubscribeGraceMs?: number;
}

const DEFAULT_UNSUBSCRIBE_GRACE_MS = 5_000;

interface Live {
  off: () => void;
  query: Query<any, any, any, any>;
  /**
   * The query's `queryFn`s waiting for its first value (an observer's fetch, a `refetch`/`fetchQuery` racing it): the
   * observer's subscription answers them all (one subscription, and one cache update, the fetch's, instead of
   * `setQueryData` and then the fetch's: one render on a cold load).
   */
  fetching?: Array<{ key: EmberQueryKey; resolve: (v: unknown) => void; reject: (e: unknown) => void }> | undefined;
  /** The last snapshot the subscription handed over. */
  last?: QuerySnapshot | undefined;
  /**
   * The snapshot it held when the identity changed (the previous identity's value or error): never written to the
   * cache nor answered to a `queryFn` again. Cleared by the next one the subscription hands over (a value read for the
   * new identity); until then a `queryFn` reads over HTTP, as whoever is signed in now.
   */
  stale?: QuerySnapshot | undefined;
}

/** Where a `fromAuth` paginated query's pages were read: the shard of the token's claim then. */
interface PageRoute {
  route: ClaimRoute;
  shard: string;
}
type ClaimRoute = NonNullable<ReturnType<EmberClient["claimRoute"]>>;

/** `emberQueryKeyHashFn` of an ember key's hydration entry, from the key's own hash: no second encoding of the args. */
const HASH_PREFIX = 'ember:["ember",';
const HYDRATION_HASH_PREFIX = 'ember:["ember:hydration",';

export class EmberQueryClient {
  readonly client: EmberClient;
  private queryClient: QueryClient | null = null;
  private stopCache: (() => void) | null = null;
  private stopIdentity: (() => void) | null = null;
  /** Following the token's claims (`fromAuth` paginated queries): started by the first such query read. */
  private stopClaims: (() => void) | null = null;
  /** By the query's key array (what its `queryFn` gets): the shard its pages were read from. */
  private readonly pageRoutes = new WeakMap<QueryKey, PageRoute>();
  private readonly live = new Map<string, Live>();
  /** The same, by the query's key array (the very one its `queryFn` gets): found without hashing it again. */
  private readonly liveByKey = new WeakMap<QueryKey, Live>();
  /** Queries without observers, by hash: their subscription ends when the timer fires. */
  private readonly idle = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ssr: boolean;
  private readonly graceMs: number;

  constructor(client: EmberClient, options: EmberQueryClientOptions = {}) {
    this.client = client;
    this.ssr = options.ssr ?? typeof (globalThis as { window?: unknown }).window === "undefined";
    // Only `Infinity` means "until gcTime": NaN (a bad env value) falls back to the default, below 0 to 0.
    const grace = options.unsubscribeGraceMs ?? DEFAULT_UNSUBSCRIBE_GRACE_MS;
    this.graceMs = grace === Infinity ? grace : Number.isNaN(grace) ? DEFAULT_UNSUBSCRIBE_GRACE_MS : Math.max(0, grace);
  }

  /** Attach to a QueryClient: sets the ember-aware key hash and starts following its cache. */
  connect(queryClient: QueryClient): this {
    if (this.queryClient) throw new Error("EmberQueryClient is already connected");
    this.queryClient = queryClient;
    registry.set(queryClient, this);
    const defaults = queryClient.getDefaultOptions();
    queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, queryKeyHashFn: emberQueryKeyHashFn } });
    this.stopCache = queryClient.getQueryCache().subscribe((e) => this.onCacheEvent(e));
    this.stopIdentity = this.client.onIdentityChange(() => this.identityChanged());
    for (const q of queryClient.getQueryCache().getAll()) if (q.getObserversCount() > 0) this.watch(q);
    return this;
  }

  disconnect(): void {
    this.stopCache?.();
    this.stopCache = null;
    this.stopIdentity?.();
    this.stopIdentity = null;
    this.stopClaims?.();
    this.stopClaims = null;
    for (const t of this.idle.values()) clearTimeout(t);
    this.idle.clear();
    const live = [...this.live.values()];
    this.live.clear();
    for (const l of live) {
      l.off();
      this.refetchAlone(l);
    }
    if (this.queryClient) registry.delete(this.queryClient);
    this.queryClient = null;
  }

  /**
   * Sign-out or account switch (`client.onIdentityChange`): what the TanStack cache holds was read for the previous
   * identity, and none of it stays. Ember queries nobody observes are removed, with the hydration entries of a server
   * render. Observed ones are reset (no data, no error): their subscription stays, but what it holds now is the
   * previous identity's (`Live.stale`), so they read again over HTTP as the new one, and take the subscription's values
   * again from the first new one. Paginated queries (not live) are reset too: no page of theirs is shown, nor extended
   * with its cursor (observed ones refetch from page 1).
   */
  private identityChanged(): void {
    const qc = this.queryClient;
    if (!qc) return;
    const ours = (q: Query) => {
      const k = q.queryKey[0];
      return k === "ember" || k === "ember:paginated" || k === "ember:hydration";
    };
    qc.removeQueries({ predicate: (q) => ours(q) && q.getObserversCount() === 0 });
    for (const l of this.live.values()) {
      const held = l.last;
      if (held && held.status !== "loading") l.stale = held;
    }
    qc.resetQueries({ predicate: (q) => q.queryKey[0] === "ember:paginated" || (isEmberQueryKey(q.queryKey) && this.live.has(q.queryHash)) }).catch(() => {});
  }

  /**
   * @internal One page of an `emberPaginatedQuery` (`client.query`). A `fromAuth` one remembers the shard of the
   * token's claim its first page was read from: when the claim moves to another shard (an org switch), its pages are
   * another shard's and its cursor means nothing there (`claimsChanged`).
   */
  fetchPage(key: QueryKey, ref: QueryReference, args: Record<string, unknown>, shard: string | undefined): Promise<unknown> {
    const opts = shard === undefined ? undefined : { shard };
    const read = (r: QueryReference, a: unknown, o: unknown) => (this.client.query as (r: QueryReference, a: unknown, o: unknown) => Promise<unknown>)(r, a, o);
    const route = this.client.claimRoute(ref, opts);
    if (!route) return read(ref, args, opts);
    this.stopClaims ??= route.onChange(() => this.claimsChanged());
    const first = (args.paginationOpts as { cursor?: unknown } | undefined)?.cursor === null;
    // Where the pages are: the claim's shard when page 1 is asked for (or, with the token not known yet, once read).
    const keep = () => {
      const now = route.current();
      if (typeof now === "string" && (first || !this.pageRoutes.has(key))) this.pageRoutes.set(key, { route, shard: now });
    };
    keep();
    return read(ref, args, opts).then((page) => {
      if (!this.pageRoutes.has(key)) keep();
      return page;
    });
  }

  /** The token changed: paginated `fromAuth` queries whose claim now points to another shard start over. */
  private claimsChanged(): void {
    const qc = this.queryClient;
    if (!qc) return;
    const moved = new Set<Query>();
    for (const q of qc.getQueryCache().getAll()) {
      if (q.queryKey[0] !== "ember:paginated") continue;
      const r = this.pageRoutes.get(q.queryKey);
      if (!r) continue;
      const now = r.route.current();
      // Not known yet (the token is being fetched): decided when it is.
      if (now === undefined || now === r.shard) continue;
      this.pageRoutes.delete(q.queryKey);
      moved.add(q);
    }
    if (!moved.size) return;
    qc.removeQueries({ predicate: (q) => moved.has(q) && q.getObserversCount() === 0 });
    qc.resetQueries({ predicate: (q) => moved.has(q) }).catch(() => {});
  }

  /** Number of live subscriptions held for the TanStack cache. */
  get subscriptionCount(): number {
    return this.live.size;
  }

  private target(key: EmberQueryKey): { fn: string; args: Record<string, unknown>; opts: ShardOptions | undefined } {
    const [, shard, fn, args] = key;
    return { fn, args: args === "skip" ? {} : args, opts: shard === null ? undefined : { shard } };
  }

  /** queryFn for ember keys: the live value if there is one, else the first snapshot (or HTTP in SSR). */
  fetch(key: QueryKey): Promise<unknown> {
    if (!isEmberQueryKey(key) || key[3] === "skip") return Promise.reject(new Error("Ember: not an ember query key"));
    const { args, opts } = this.target(key);
    const byKey = this.liveByKey.get(key);
    let hash: string | undefined;
    const hashOf = () => (hash ??= emberQueryKeyHashFn(key));
    // A key nobody's `emberQuery` built (restored from a persisted cache) and not live (always so in SSR): its query,
    // whose observers' own keys route it, comes from the cache.
    const query = byKey?.query ?? (keyRefs.has(key) ? undefined : this.queryClient?.getQueryCache().get(hashOf()));
    const ref = refFor(key, query);
    if (this.ssr) {
      const qc = this.queryClient;
      return this.client.fetchForHydration(ref, args, opts).then((h) => (qc ? keepMeta(qc, key, h) : h.value));
    }
    const now = this.client.localQueryResult(ref, args, opts);
    const l = byKey && this.live.get(byKey.query.queryHash) === byKey ? byKey : this.live.get(hashOf());
    // After an identity change, until the subscription hands over a new snapshot: what it holds (or is about to show
    // again, while the token is fetched) is the previous identity's. Read over HTTP, as whoever is signed in now.
    if (l?.stale && (now === l.stale || now.status === "loading")) {
      return (this.client.query as (r: QueryReference, a: unknown, o: unknown) => Promise<unknown>)(ref, args, { ...opts, transport: "http" });
    }
    if (now.status === "success") return Promise.resolve(now.value);
    // An error already there is not sent again: waiting for the next snapshot would never settle.
    if (now.status === "error") return Promise.reject(now.error);
    // Observed: its live subscription (`watch`) brings the value.
    if (l) return new Promise((resolve, reject) => (l.fetching ??= []).push({ key, resolve, reject }));
    return this.fetchOnce(ref, args, opts);
  }

  /** The first snapshot of a query nobody observes (prefetch), over a subscription of its own. */
  private fetchOnce(ref: QueryReference, args: Record<string, unknown>, opts: ShardOptions | undefined): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let off: (() => void) | null = null;
      let settled = false;
      const done = (s: QuerySnapshot) => {
        if (settled || s.status === "loading") return;
        settled = true;
        // unsubscribe after the current dispatch; the observer's live subscription (if any) keeps the server sub
        queueMicrotask(() => off?.());
        if (s.status === "success") resolve(s.value);
        else reject(s.error);
      };
      off = this.client.subscribe(ref, args, opts, done);
      if (settled) off();
    });
  }

  private onCacheEvent(e: QueryCacheNotifyEvent): void {
    if (!isEmberQueryKey(e.query.queryKey)) return;
    if (e.type === "observerAdded") {
      this.cancelIdle(e.query.queryHash);
      this.watch(e.query);
    } else if (e.type === "observerRemoved") {
      if (e.query.getObserversCount() === 0) this.startIdle(e.query);
    } else if (e.type === "removed") this.unwatch(e.query.queryHash);
  }

  /** The last observer went: unsubscribe after the grace period, unless one comes back first. */
  private startIdle(query: Live["query"]): void {
    const hash = query.queryHash;
    if (!this.live.has(hash) || this.idle.has(hash) || this.graceMs === Infinity) return;
    this.idle.set(
      hash,
      setTimeout(() => {
        this.idle.delete(hash);
        if (query.getObserversCount() === 0) this.unwatch(hash);
      }, this.graceMs),
    );
  }

  private cancelIdle(hash: string): void {
    const t = this.idle.get(hash);
    if (t === undefined) return;
    clearTimeout(t);
    this.idle.delete(hash);
  }

  private watch(query: Query<any, any, any, any>): void {
    if (this.ssr || this.live.has(query.queryHash)) return;
    const key = query.queryKey as EmberQueryKey;
    if (key[3] === "skip") return;
    const { fn, args, opts } = this.target(key);
    const hash = query.queryHash;
    // A value rendered on the server: the subscription starts from it (resume) instead of downloading it again.
    const qc = this.queryClient;
    const entry = qc ? this.hydrationEntry(qc, query) : undefined;
    const meta = entry?.state.data as EmberHydrationMeta | undefined;
    if (qc && entry) qc.getQueryCache().remove(entry);
    if (qc && meta) {
      // Only the very value the server fetched: data changed since (or mangled on its way) downloads the real one.
      if (query.state.data !== undefined && typeof meta.fp === "string" && fingerprint(query.state.data) === meta.fp) {
        this.client.hydrate({ fn, args, shard: meta.shard, value: query.state.data, version: meta.version, epoch: meta.epoch, ik: meta.ik });
      }
    }
    // Live before subscribing: a subscription another Ember subscriber kept (past this one's grace period) calls back
    // right away with its current value, which TanStack may not have (it kept the value of the unsubscribe).
    const live: Live = { off: () => {}, query };
    this.live.set(hash, live);
    this.liveByKey.set(query.queryKey, live);
    const off = this.client.subscribe(refFor(key, query), args, opts, (s) => this.push(hash, s));
    // That value may have made a cache listener remove the query (`unwatch` ran the placeholder): let go at once.
    if (this.live.get(hash) === live) live.off = off;
    else off();
  }

  /** The query's `emberHydrationKey` entry, found by hash (the args are not encoded again). */
  private hydrationEntry(qc: QueryClient, query: Live["query"]): Query | undefined {
    const cache = qc.getQueryCache();
    const hash = query.queryHash;
    if (hash.startsWith(HASH_PREFIX)) return cache.get(HYDRATION_HASH_PREFIX + hash.slice(HASH_PREFIX.length));
    return cache.find({ queryKey: emberHydrationKey(query.queryKey as EmberQueryKey), exact: true });
  }

  private unwatch(hash: string): void {
    this.cancelIdle(hash);
    const l = this.live.get(hash);
    if (!l) return;
    this.live.delete(hash);
    l.off();
    this.refetchAlone(l);
  }

  /** The subscription waiting `queryFn`s relied on ended first: they get their value from one of their own. */
  private refetchAlone(l: Live): void {
    const waiting = l.fetching;
    if (!waiting) return;
    l.fetching = undefined;
    const key = waiting[0]!.key;
    const { args, opts } = this.target(key);
    const p = this.fetchOnce(refFor(key, l.query), args, opts);
    for (const f of waiting) p.then(f.resolve, f.reject);
  }

  private push(hash: string, s: QuerySnapshot): void {
    const l = this.live.get(hash);
    const qc = this.queryClient;
    if (!l || !qc) return;
    l.last = s;
    if (l.stale) {
      // The previous identity's snapshot is never written again; the first new one is the new identity's.
      if (s === l.stale) return;
      if (s.status !== "loading") l.stale = undefined;
    }
    const waiting = l.fetching;
    if (waiting && s.status !== "loading") {
      l.fetching = undefined;
      for (const f of waiting) {
        if (s.status === "success") f.resolve(s.value);
        else f.reject(s.error);
      }
      // The fetch's own result is the cache update (and the one render), while TanStack still runs it: a cancelled
      // one (`cancelQueries`, its observer kept) has its late result dropped, so the value is written here as usual.
      // A silent cancel leaves `fetchStatus` at "fetching" with no fetch left (`promise` is undefined): written too.
      if (l.query.state.fetchStatus === "fetching" && l.query.promise !== undefined) return;
    }
    if (s.status === "success") {
      // The very value TanStack already holds (a recompute that changed nothing here): no update, no re-render.
      const st = l.query.state;
      if (st.status === "success" && st.data === s.value) return;
      qc.setQueryData(l.query.queryKey, s.value);
    } else if (s.status === "error" && s.error) {
      const st = l.query.state;
      l.query.setState({
        status: "error",
        fetchStatus: "idle",
        error: s.error,
        errorUpdateCount: st.errorUpdateCount + 1,
        errorUpdatedAt: Date.now(),
        fetchFailureCount: st.fetchFailureCount + 1,
        fetchFailureReason: s.error,
      });
    }
  }
}

export { EmberError };
