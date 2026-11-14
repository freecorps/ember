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
// subscribed over the socket while it has observers and until TanStack garbage-collects it (gcTime); every server
// patch (and optimistic update) is pushed with setQueryData.
import { hashKey, mutationOptions, queryOptions, skipToken, type QueryCacheNotifyEvent, type QueryClient, type QueryKey, type Query } from "@tanstack/react-query";
import {
  EmberError,
  encodeJson,
  getFunctionName,
  stableStringify,
  unsafeRef,
  type ArgsAndOptions,
  type ArgsOrSkipAndOptions,
  type EmberClient,
  type EmberErrorOf,
  type HydratedQuery,
  type MutationOptions,
  type MutationReference,
  type QueryReference,
  type QuerySnapshot,
  type ShardOptions,
} from "@freecorps/ember-client";

type QueryRef = QueryReference;
type MutationRef = MutationReference;
type ArgsOf<F extends QueryRef | MutationRef> = F["_args"];
type ReturnOf<F extends QueryRef | MutationRef> = F["_returnType"];

/** `["ember", shard | null, "module:export", args]`; a null shard means the client's `defaultShard`. */
export type EmberQueryKey = readonly ["ember", string | null, string, Record<string, unknown> | "skip"];

export const isEmberQueryKey = (key: QueryKey): key is EmberQueryKey => key[0] === "ember" && key.length === 4 && typeof key[2] === "string";

/** Hash for TanStack: ember keys via the tagged stable JSON (bigint/bytes safe), others via `hashKey`. */
export function emberQueryKeyHashFn(key: QueryKey): string {
  return isEmberQueryKey(key) || key[0] === "ember:hydration" ? `ember:${stableStringify(key)}` : hashKey(key);
}

const registry = new WeakMap<QueryClient, EmberQueryClient>();

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
  const key = ["ember", opts?.shard ?? null, getFunctionName(ref), args === "skip" ? "skip" : ((args ?? {}) as Record<string, unknown>)] as const;
  return queryOptions<ReturnOf<Q>, EmberErrorOf<Q>, ReturnOf<Q>, EmberQueryKey>({
    queryKey: key,
    queryFn: args === "skip" ? skipToken : (ctx) => connected(ctx.client).fetch(ctx.queryKey) as Promise<ReturnOf<Q>>,
    queryKeyHashFn: emberQueryKeyHashFn,
    staleTime: Infinity,
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

export interface EmberQueryClientOptions {
  /** Fetch with HTTP one-shots and never subscribe (SSR). Default: true when there is no `window`. */
  ssr?: boolean;
}

interface Live {
  off: () => void;
  query: Query<any, any, any, any>;
}

export class EmberQueryClient {
  readonly client: EmberClient;
  private queryClient: QueryClient | null = null;
  private stopCache: (() => void) | null = null;
  private readonly live = new Map<string, Live>();
  private readonly ssr: boolean;

  constructor(client: EmberClient, options: EmberQueryClientOptions = {}) {
    this.client = client;
    this.ssr = options.ssr ?? typeof (globalThis as { window?: unknown }).window === "undefined";
  }

  /** Attach to a QueryClient: sets the ember-aware key hash and starts following its cache. */
  connect(queryClient: QueryClient): this {
    if (this.queryClient) throw new Error("EmberQueryClient is already connected");
    this.queryClient = queryClient;
    registry.set(queryClient, this);
    const defaults = queryClient.getDefaultOptions();
    queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, queryKeyHashFn: emberQueryKeyHashFn } });
    this.stopCache = queryClient.getQueryCache().subscribe((e) => this.onCacheEvent(e));
    for (const q of queryClient.getQueryCache().getAll()) if (q.getObserversCount() > 0) this.watch(q);
    return this;
  }

  disconnect(): void {
    this.stopCache?.();
    this.stopCache = null;
    for (const l of this.live.values()) l.off();
    this.live.clear();
    if (this.queryClient) registry.delete(this.queryClient);
    this.queryClient = null;
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
    const { fn, args, opts } = this.target(key);
    const ref = unsafeRef<"query">(fn);
    if (this.ssr) {
      const qc = this.queryClient;
      return this.client.fetchForHydration(ref, args, opts).then((h) => (qc ? keepMeta(qc, key, h) : h.value));
    }
    const now = this.client.localQueryResult(ref, args, opts);
    if (now.status === "success") return Promise.resolve(now.value);
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
    if (e.type === "observerAdded") this.watch(e.query);
    else if (e.type === "removed") this.unwatch(e.query.queryHash);
  }

  private watch(query: Query<any, any, any, any>): void {
    if (this.ssr || this.live.has(query.queryHash)) return;
    const key = query.queryKey as EmberQueryKey;
    if (key[3] === "skip") return;
    const { fn, args, opts } = this.target(key);
    const hash = query.queryHash;
    // A value rendered on the server: the subscription starts from it (resume) instead of downloading it again.
    const qc = this.queryClient;
    const meta = qc?.getQueryData<EmberHydrationMeta>(emberHydrationKey(key));
    if (qc && meta) {
      qc.removeQueries({ queryKey: emberHydrationKey(key), exact: true });
      // Only the very value the server fetched: data changed since (or mangled on its way) downloads the real one.
      if (query.state.data !== undefined && typeof meta.fp === "string" && fingerprint(query.state.data) === meta.fp) {
        this.client.hydrate({ fn, args, shard: meta.shard, value: query.state.data, version: meta.version, epoch: meta.epoch, ik: meta.ik });
      }
    }
    const off = this.client.subscribe(unsafeRef<"query">(fn), args, opts, (s) => this.push(hash, s));
    this.live.set(hash, { off, query });
  }

  private unwatch(hash: string): void {
    const l = this.live.get(hash);
    if (!l) return;
    this.live.delete(hash);
    l.off();
  }

  private push(hash: string, s: QuerySnapshot): void {
    const l = this.live.get(hash);
    const qc = this.queryClient;
    if (!l || !qc) return;
    if (s.status === "success") {
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
