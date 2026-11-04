// React bindings for @ember/client. No DOM APIs: works in React DOM and React Native.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  getFunctionName,
  stableStringify,
  type ConnectionState,
  type EmberClient,
  type FunctionReference,
  type OptimisticUpdate,
  type QuerySnapshot,
  type ShardOptions,
} from "@ember/client";

const EmberContext = createContext<EmberClient | null>(null);

export interface EmberProviderProps {
  client: EmberClient;
  children?: ReactNode;
}

export function EmberProvider({ client, children }: EmberProviderProps) {
  return createElement(EmberContext.Provider, { value: client }, children);
}

export function useEmberClient(): EmberClient {
  const c = useContext(EmberContext);
  if (!c) throw new Error("Ember hooks need an <EmberProvider client={...}> above them");
  return c;
}

const LOADING: QuerySnapshot = Object.freeze({ status: "loading", value: undefined, error: undefined, optimistic: false });
const noopSubscribe = () => () => {};
const getLoading = () => LOADING;

type QueryRef = FunctionReference<"query"> | string;
type ArgsOf<Q> = Q extends FunctionReference<any, infer A, any> ? A : Record<string, unknown>;
type ReturnOf<Q> = Q extends FunctionReference<any, any, infer R> ? R : unknown;

/**
 * The full snapshot of a live query (`status`, `value`, `error`, `optimistic`). Args are compared by value, so an
 * inline object is fine. `"skip"` subscribes to nothing.
 */
export function useQuerySnapshot<Q extends QueryRef>(ref: Q, args: ArgsOf<Q> | "skip", opts?: ShardOptions): QuerySnapshot<ReturnOf<Q>> {
  const client = useEmberClient();
  const name = getFunctionName(ref);
  const skip = args === "skip";
  const argsKey = skip ? null : stableStringify(args ?? {});
  const shard = opts?.shard;
  const handle = useMemo(
    () => (skip ? null : client.watchQuery(name, args as Record<string, unknown>, shard === undefined ? undefined : { shard })),
    // args are read through argsKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, name, argsKey, shard],
  );
  return useSyncExternalStore(
    handle?.subscribe ?? noopSubscribe,
    handle?.getSnapshot ?? getLoading,
    handle?.getSnapshot ?? getLoading,
  ) as QuerySnapshot<ReturnOf<Q>>;
}

/**
 * Live query value: `undefined` while loading (or skipped). Errors are thrown to the nearest error boundary,
 * like `convex/react`. Use `useQuerySnapshot` to handle them inline.
 */
export function useQuery<Q extends QueryRef>(ref: Q, args: ArgsOf<Q> | "skip" = {} as ArgsOf<Q>, opts?: ShardOptions): ReturnOf<Q> | undefined {
  const s = useQuerySnapshot(ref, args, opts);
  if (s.status === "error") throw s.error;
  return s.value;
}

type MutationRef = FunctionReference<"mutation"> | string;

export interface ReactMutation<M extends MutationRef> {
  (args?: ArgsOf<M>): Promise<ReturnOf<M>>;
  /** A new mutation function that applies `update` optimistically on every call. */
  withOptimisticUpdate(update: OptimisticUpdate<ArgsOf<M>>): ReactMutation<M>;
}

function makeMutation<M extends MutationRef>(client: EmberClient, name: string, opts: ShardOptions | undefined, update?: OptimisticUpdate): ReactMutation<M> {
  const f = ((args?: ArgsOf<M>) => {
    const o: { shard?: string; optimisticUpdate?: OptimisticUpdate } = {};
    if (opts?.shard !== undefined) o.shard = opts.shard;
    if (update) o.optimisticUpdate = update;
    return client.mutation(name, args as Record<string, unknown> | undefined, o);
  }) as ReactMutation<M>;
  f.withOptimisticUpdate = (u) => makeMutation<M>(client, name, opts, u as OptimisticUpdate);
  return f;
}

/** A stable function that runs the mutation. `.withOptimisticUpdate(fn)` adds an optimistic update. */
export function useMutation<M extends MutationRef>(ref: M, opts?: ShardOptions): ReactMutation<M> {
  const client = useEmberClient();
  const name = getFunctionName(ref);
  const shard = opts?.shard;
  return useMemo(() => makeMutation<M>(client, name, shard === undefined ? undefined : { shard }), [client, name, shard]);
}

type ActionRef = FunctionReference<"action"> | string;

/** Actions are not wired in the client yet: calling the function rejects with `not_implemented`. */
export function useAction<A extends ActionRef>(ref: A, opts?: ShardOptions): (args?: ArgsOf<A>) => Promise<ReturnOf<A>> {
  const client = useEmberClient();
  const name = getFunctionName(ref);
  const shard = opts?.shard;
  return useCallback(
    (args?: ArgsOf<A>) => client.action(name, args as Record<string, unknown> | undefined, shard === undefined ? undefined : { shard }),
    [client, name, shard],
  );
}

/** Online flag, per-shard socket state and the number of unconfirmed mutations. */
export function useConnectionState(): ConnectionState {
  const client = useEmberClient();
  const subscribe = useCallback((l: () => void) => client.onConnectionStateChange(l), [client]);
  const get = useCallback(() => client.connectionState(), [client]);
  return useSyncExternalStore(subscribe, get, get);
}

// ------------------------------------------------------------------------------------------------ pagination

/** What a paginated query receives in `args.paginationOpts`. */
export interface PaginationOptions {
  numItems: number;
  cursor: string | null;
}

/** What a paginated query must return. */
export interface PaginationResult<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string | null;
}

export type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

export interface UsePaginatedQueryResult<T> {
  results: T[];
  status: PaginationStatus;
  isLoading: boolean;
  loadMore(numItems: number): void;
}

type PageItem<Q> = ReturnOf<Q> extends PaginationResult<infer T> ? T : unknown;
type PaginatedArgs<Q> = Omit<ArgsOf<Q>, "paginationOpts">;

/**
 * Basic cursor pagination: page `i` is its own live query with `paginationOpts: {numItems, cursor}`, where the
 * cursor is page `i-1`'s `continueCursor`. Pages are concatenated. Page boundaries do not split/merge yet (Phase 4).
 */
export function usePaginatedQuery<Q extends QueryRef>(
  ref: Q,
  args: PaginatedArgs<Q> | "skip",
  opts: ShardOptions & { initialNumItems: number },
): UsePaginatedQueryResult<PageItem<Q>> {
  const client = useEmberClient();
  const name = getFunctionName(ref);
  const skip = args === "skip";
  const argsKey = skip ? null : stableStringify(args ?? {});
  const shard = opts.shard;
  const [state, setState] = useState<{ key: string | null; sizes: number[] }>({ key: argsKey, sizes: [opts.initialNumItems] });
  const sizes = state.key === argsKey ? state.sizes : [opts.initialNumItems];
  if (state.key !== argsKey) setState({ key: argsKey, sizes });

  // Each page's cursor depends on the previous page's result, so handles are derived from the snapshots.
  const cache = useRef<{ snaps: QuerySnapshot[]; result: UsePaginatedQueryResult<PageItem<Q>> & { error?: unknown } } | null>(null);
  const sizesKey = sizes.join(",");

  const handles = useCallback(() => {
    if (skip) return [];
    const out: Array<ReturnType<EmberClient["watchQuery"]>> = [];
    let cursor: string | null = null;
    for (const numItems of sizes) {
      const h = client.watchQuery(name, { ...(args as object), paginationOpts: { numItems, cursor } }, shard === undefined ? undefined : { shard });
      out.push(h);
      const s = h.getSnapshot();
      const v = s.value as PaginationResult<unknown> | undefined;
      if (!v || v.isDone || v.continueCursor === null) break;
      cursor = v.continueCursor;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, name, argsKey, shard, sizesKey, skip]);

  const subscribe = useCallback(
    (listener: () => void) => {
      // Re-derive the handle list whenever a page changes (a new continueCursor adds the next page).
      let offs: Array<() => void> = [];
      const resubscribe = () => {
        const next = handles().map((h) => h.subscribe(onChange));
        for (const off of offs) off();
        offs = next;
      };
      const onChange = () => {
        resubscribe();
        listener();
      };
      resubscribe();
      return () => {
        for (const off of offs) off();
        offs = [];
      };
    },
    [handles],
  );

  const getSnapshot = useCallback((): UsePaginatedQueryResult<PageItem<Q>> & { error?: unknown } => {
    const snaps = handles().map((h) => h.getSnapshot());
    const prev = cache.current;
    if (prev && prev.snaps.length === snaps.length && prev.snaps.every((s, i) => s === snaps[i])) return prev.result;
    const results: PageItem<Q>[] = [];
    let status: PaginationStatus = skip ? "LoadingFirstPage" : "CanLoadMore";
    let error: unknown;
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i]!;
      if (s.status === "error") {
        error = s.error;
        break;
      }
      const v = s.value as PaginationResult<PageItem<Q>> | undefined;
      if (!v) {
        status = i === 0 ? "LoadingFirstPage" : "LoadingMore";
        break;
      }
      results.push(...v.page);
      if (v.isDone) status = "Exhausted";
    }
    if (status === "CanLoadMore" && snaps.length < sizes.length) status = "LoadingMore";
    const loadMore = (n: number) => {
      if (status !== "CanLoadMore") return;
      setState((st) => ({ key: st.key, sizes: [...st.sizes, n] }));
    };
    const result = { results, status, isLoading: status === "LoadingFirstPage" || status === "LoadingMore", loadMore, error };
    cache.current = { snaps, result };
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handles, skip, sizesKey]);

  const { error, ...result } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (error) throw error;
  return result;
}

export type { QuerySnapshot, ConnectionState } from "@ember/client";
