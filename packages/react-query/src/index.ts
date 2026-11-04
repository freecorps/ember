// TanStack Query adapter for @ember/client (in the spirit of @convex-dev/react-query).
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
import { hashKey, queryOptions, skipToken, type QueryCacheNotifyEvent, type QueryClient, type QueryKey, type Query } from "@tanstack/react-query";
import {
  EmberError,
  getFunctionName,
  stableStringify,
  type EmberClient,
  type FunctionReference,
  type MutationOptions,
  type QuerySnapshot,
  type ShardOptions,
} from "@ember/client";

type QueryRef = FunctionReference<"query"> | string;
type MutationRef = FunctionReference<"mutation"> | string;
type ArgsOf<F> = F extends FunctionReference<any, infer A, any> ? A : Record<string, unknown>;
type ReturnOf<F> = F extends FunctionReference<any, any, infer R> ? R : unknown;

/** `["ember", shard | null, "module:export", args]`; a null shard means the client's `defaultShard`. */
export type EmberQueryKey = readonly ["ember", string | null, string, Record<string, unknown> | "skip"];

export const isEmberQueryKey = (key: QueryKey): key is EmberQueryKey => key[0] === "ember" && key.length === 4 && typeof key[2] === "string";

/** Hash for TanStack: ember keys via the tagged stable JSON (bigint/bytes safe), others via `hashKey`. */
export function emberQueryKeyHashFn(key: QueryKey): string {
  return isEmberQueryKey(key) ? `ember:${stableStringify(key)}` : hashKey(key);
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
export function emberQuery<Q extends QueryRef>(ref: Q, args: ArgsOf<Q> | "skip" = {} as ArgsOf<Q>, opts?: ShardOptions) {
  const key = ["ember", opts?.shard ?? null, getFunctionName(ref), args === "skip" ? "skip" : ((args ?? {}) as Record<string, unknown>)] as const;
  return queryOptions<ReturnOf<Q>, EmberError, ReturnOf<Q>, EmberQueryKey>({
    queryKey: key,
    queryFn: args === "skip" ? skipToken : (ctx) => connected(ctx.client).fetch(ctx.queryKey) as Promise<ReturnOf<Q>>,
    queryKeyHashFn: emberQueryKeyHashFn,
    staleTime: Infinity,
  });
}

/**
 * Same key as `emberQuery`, fetched once over HTTP (`POST /api/query`) with the given client. For SSR / loaders:
 * `await queryClient.prefetchQuery(emberQueryOneShot(ember, api.x.y, args))`, dehydrate, hydrate in the browser;
 * the live subscription starts when a component observes the query.
 */
export function emberQueryOneShot<Q extends QueryRef>(client: EmberClient, ref: Q, args: ArgsOf<Q> = {} as ArgsOf<Q>, opts?: ShardOptions) {
  const base = emberQuery(ref, args, opts);
  return queryOptions<ReturnOf<Q>, EmberError, ReturnOf<Q>, EmberQueryKey>({
    ...base,
    queryFn: () => client.query(ref as string, args as Record<string, unknown>, opts) as Promise<ReturnOf<Q>>,
  });
}

/** `prefetchQuery` over HTTP (no socket): the SSR helper. */
export function prefetchEmberQuery<Q extends QueryRef>(queryClient: QueryClient, client: EmberClient, ref: Q, args?: ArgsOf<Q>, opts?: ShardOptions): Promise<void> {
  return queryClient.prefetchQuery(emberQueryOneShot(client, ref, args, opts));
}

/**
 * `mutationFn` for `useMutation`. Runs over the EmberQueryClient connected to the mutation's QueryClient; the
 * optimistic update (if any) flows into the TanStack cache through the live queries.
 */
export function emberMutationFn<M extends MutationRef>(ref: M, opts?: MutationOptions<ArgsOf<M>>) {
  return (variables: ArgsOf<M>, context: { client: QueryClient }): Promise<ReturnOf<M>> =>
    connected(context.client).client.mutation(ref as string, variables as Record<string, unknown>, opts) as Promise<ReturnOf<M>>;
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
    if (this.ssr) return this.client.query(fn, args, opts);
    const now = this.client.localQueryResult(fn, args, opts);
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
      off = this.client.subscribe(fn, args, opts, done);
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
    const off = this.client.subscribe(fn, args, opts, (s) => this.push(hash, s));
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
