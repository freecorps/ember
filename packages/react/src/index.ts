// React bindings for @freecorps/ember-client. No DOM APIs: works in React DOM and React Native.
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
  toResult,
  watchPaginatedQuery,
  type ArgsAndOptions,
  type ArgsOrSkipAndOptions,
  type ConnectionState,
  type EmberClient,
  type EmberErrorOf,
  type FunctionReference,
  type MutationReference,
  type ActionReference,
  type AnyFunctionReference,
  type NamedShardKind,
  type OptionsFor,
  type OptimisticUpdate,
  type PaginatedSnapshot,
  type PaginationStatus,
  type OptionalRestArgs,
  type PaginationOptions,
  type PaginationResult,
  type QueryReference,
  type QuerySnapshot,
  type Result,
  type ShardOptions,
} from "@freecorps/ember-client";

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

type ArgsOf<F extends AnyFunctionReference> = F["_args"];
type ReturnOf<F extends AnyFunctionReference> = F["_returnType"];
type Rest<F> = ArgsOrSkipAndOptions<F, ShardOptions>;
const splitRest = (rest: readonly unknown[]) => ({ args: rest[0] as Record<string, unknown> | "skip" | undefined, opts: rest[1] as ShardOptions | undefined });

/**
 * The live query's snapshot and the key its args were compared by (null: skipped): serialized once per render, and
 * reused by the hooks built on it (`useSuspenseQuery` keys its promise by it).
 */
function useWatched<Q extends QueryReference>(ref: Q, rest: readonly unknown[]): { snap: QuerySnapshot<ReturnOf<Q>>; argsKey: string | null; args: Record<string, unknown> | undefined; opts: ShardOptions | undefined } {
  const client = useEmberClient();
  const { args, opts } = splitRest(rest);
  const name = getFunctionName(ref);
  const skip = args === "skip";
  const argsKey = skip ? null : stableStringify(args ?? {});
  const shard = opts?.shard;
  const handle = useMemo(
    () => (skip ? null : client.watchQuery(ref, (args ?? {}) as ArgsOf<Q>, shard === undefined ? undefined : { shard })),
    // args are read through argsKey; ref through its name
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, name, argsKey, shard],
  );
  const snap = useSyncExternalStore(
    handle?.subscribe ?? noopSubscribe,
    handle?.getSnapshot ?? getLoading,
    handle?.getSnapshot ?? getLoading,
  ) as QuerySnapshot<ReturnOf<Q>>;
  return { snap, argsKey, args: skip ? undefined : args, opts };
}

/**
 * The full snapshot of a live query (`status`, `value`, `error`, `optimistic`, and `source` — `"local"` or `"cache"`
 * while the value comes from offline storage, before the server answers). Args are compared by value, so an
 * inline object is fine. `"skip"` subscribes to nothing.
 *
 * Offline-first: give the client a `StorageAdapter` (`new EmberClient({ url, storage: indexedDbStorage({ name,
 * schema, queries }) })`, from `@freecorps/ember-offline/indexeddb`); `useQuery` then renders stored / locally
 * computed results on a cold start without network.
 */
export function useQuerySnapshot<Q extends QueryReference>(ref: Q, ...rest: Rest<Q>): QuerySnapshot<ReturnOf<Q>> {
  return useWatched(ref, rest).snap;
}

/**
 * Live query value: `undefined` while loading (or skipped). Errors are thrown to the nearest error boundary,
 * like `convex/react`. Use `useQueryState` to handle them inline.
 */
export function useQuery<Q extends QueryReference>(ref: Q, ...rest: Rest<Q>): ReturnOf<Q> | undefined {
  const s = useQuerySnapshot(ref, ...rest);
  if (s.status === "error") throw s.error;
  return s.value;
}

/** `useQueryState`: a discriminated union, with the query's typed errors. */
export type QueryState<Q extends QueryReference> =
  | { readonly status: "loading"; readonly data: undefined; readonly error: undefined }
  | { readonly status: "success"; readonly data: ReturnOf<Q>; readonly error: undefined; readonly optimistic: boolean; readonly source?: "local" | "cache" }
  | { readonly status: "error"; readonly data: undefined; readonly error: EmberErrorOf<Q> };

/** The live query as a state you can `switch` on (never throws): `{ status: "loading" | "success" | "error" }`. */
export function useQueryState<Q extends QueryReference>(ref: Q, ...rest: Rest<Q>): QueryState<Q> {
  const s = useQuerySnapshot(ref, ...rest);
  return useMemo((): QueryState<Q> => {
    if (s.status === "error") return { status: "error", data: undefined, error: s.error as unknown as EmberErrorOf<Q> };
    if (s.status === "success") return { status: "success", data: s.value as ReturnOf<Q>, error: undefined, optimistic: s.optimistic, ...(s.source ? { source: s.source } : {}) };
    return { status: "loading", data: undefined, error: undefined };
  }, [s]);
}

// Suspense: a loading query throws a promise that settles on its first value. The subscription it opens is kept a
// few seconds after that, so the remounted component finds the value (and the server subscription) still there.
const SUSPENSE_GRACE_MS = 10_000;
const suspended = new WeakMap<EmberClient, Map<string, Promise<void>>>();

/**
 * Like `useQuery`, but suspends while loading (wrap it in `<Suspense>`): the value is never `undefined`.
 *
 * The promise thrown is shared per (shard, function, args) and settles on the first value (or error); the
 * subscription behind it is released `SUSPENSE_GRACE_MS` after that, once: later snapshots do not start more timers,
 * and the release never removes a newer suspension of the same key. The timer does not keep a server process alive.
 */
export function useSuspenseQuery<Q extends QueryReference>(ref: Q, ...rest: ArgsAndOptions<Q, ShardOptions>): ReturnOf<Q> {
  const client = useEmberClient();
  const { snap: s, argsKey, args, opts } = useWatched(ref, rest);
  if (s.status === "error") throw s.error;
  if (s.status === "success") return s.value as ReturnOf<Q>;
  const key = `${opts?.shard ?? ""}\u0000${getFunctionName(ref)}\u0000${argsKey ?? "{}"}`;
  let byKey = suspended.get(client);
  if (!byKey) suspended.set(client, (byKey = new Map()));
  const map = byKey;
  let p = map.get(key);
  if (!p) {
    let settled = false;
    let off: (() => void) | undefined;
    const mine: Promise<void> = new Promise<void>((resolve) => {
      off = client.subscribe(ref, (args ?? {}) as ArgsOf<Q>, opts, (snap) => {
        if (snap.status === "loading" || settled) return;
        settled = true;
        resolve();
        const t = setTimeout(() => {
          off?.();
          if (map.get(key) === mine) map.delete(key);
        }, SUSPENSE_GRACE_MS);
        (t as { unref?: () => void }).unref?.();
      });
    });
    p = mine;
    map.set(key, p);
  }
  throw p;
}

/** `[options?]`, or `[options]` with a typed `shard` when the function's shard must be named (`shard: "org"`). */
type HookOptions<F> = [NamedShardKind<F>] extends [never] ? [options?: OptionsFor<F, ShardOptions>] : [options: OptionsFor<F, ShardOptions>];

export interface ReactMutation<M extends MutationReference> {
  (...args: OptionalRestArgs<M>): Promise<ReturnOf<M>>;
  /** Runs the mutation and returns `{ ok, value } | { ok: false, error }` (typed errors) instead of throwing. */
  safe(...args: OptionalRestArgs<M>): Promise<Result<ReturnOf<M>, EmberErrorOf<M>>>;
  /** A new mutation function that applies `update` optimistically on every call. */
  withOptimisticUpdate(update: OptimisticUpdate<ArgsOf<M>>): ReactMutation<M>;
}

function makeMutation<M extends MutationReference>(client: EmberClient, ref: M, opts: ShardOptions | undefined, update?: OptimisticUpdate<ArgsOf<M>>): ReactMutation<M> {
  const run = (args?: ArgsOf<M>) => {
    const o: { shard?: string; optimisticUpdate?: OptimisticUpdate<ArgsOf<M>> } = {};
    if (opts?.shard !== undefined) o.shard = opts.shard;
    if (update) o.optimisticUpdate = update;
    return (client.mutation as (r: M, a: unknown, o: unknown) => Promise<ReturnOf<M>>)(ref, args, o);
  };
  const f = ((...a: unknown[]) => run(a[0] as ArgsOf<M> | undefined)) as unknown as ReactMutation<M>;
  f.safe = (...a: unknown[]) => toResult<ReturnOf<M>, EmberErrorOf<M>>(run(a[0] as ArgsOf<M> | undefined));
  f.withOptimisticUpdate = (u) => makeMutation<M>(client, ref, opts, u);
  return f;
}

/** A stable function that runs the mutation. `.withOptimisticUpdate(fn)` adds an optimistic update; `.safe()` returns a Result. */
export function useMutation<M extends MutationReference>(ref: M, ...options: HookOptions<M>): ReactMutation<M> {
  const opts = options[0] as ShardOptions | undefined;
  const client = useEmberClient();
  const name = getFunctionName(ref);
  const shard = opts?.shard;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => makeMutation<M>(client, ref, shard === undefined ? undefined : { shard }), [client, name, shard]);
}

/** `useMutationState`: the mutation plus its last call's state, for forms and buttons. */
export interface MutationState<M extends MutationReference> {
  /** Runs it; resolves to a Result (never throws). */
  mutate(...args: OptionalRestArgs<M>): Promise<Result<ReturnOf<M>, EmberErrorOf<M>>>;
  readonly isPending: boolean;
  readonly data: ReturnOf<M> | undefined;
  readonly error: EmberErrorOf<M> | undefined;
  reset(): void;
}

export function useMutationState<M extends MutationReference>(ref: M, ...options: HookOptions<M>): MutationState<M> {
  const m = useMutation(ref, ...options);
  const [st, setSt] = useState<{ isPending: boolean; data: ReturnOf<M> | undefined; error: EmberErrorOf<M> | undefined }>({ isPending: false, data: undefined, error: undefined });
  const seq = useRef(0);
  const mutate = useCallback(
    async (...args: OptionalRestArgs<M>) => {
      const mine = ++seq.current;
      setSt((p) => ({ ...p, isPending: true }));
      const r = await m.safe(...args);
      if (mine === seq.current) setSt(r.ok ? { isPending: false, data: r.value, error: undefined } : { isPending: false, data: undefined, error: r.error });
      return r;
    },
    [m],
  );
  const reset = useCallback(() => {
    seq.current++;
    setSt({ isPending: false, data: undefined, error: undefined });
  }, []);
  return { mutate, reset, ...st };
}

export interface ReactAction<A extends ActionReference> {
  (...args: OptionalRestArgs<A>): Promise<ReturnOf<A>>;
  safe(...args: OptionalRestArgs<A>): Promise<Result<ReturnOf<A>, EmberErrorOf<A>>>;
}

/** Calls the action over HTTP (`POST /api/action`); the shard defaults to the client's default shard. */
export function useAction<A extends ActionReference>(ref: A, ...options: HookOptions<A>): ReactAction<A> {
  const opts = options[0] as ShardOptions | undefined;
  const client = useEmberClient();
  const name = getFunctionName(ref);
  const shard = opts?.shard;
  return useMemo(() => {
    const run = (args?: ArgsOf<A>) => (client.action as (r: A, a: unknown, o: unknown) => Promise<ReturnOf<A>>)(ref, args, shard === undefined ? undefined : { shard });
    const f = ((...a: unknown[]) => run(a[0] as ArgsOf<A> | undefined)) as unknown as ReactAction<A>;
    f.safe = (...a: unknown[]) => toResult<ReturnOf<A>, EmberErrorOf<A>>(run(a[0] as ArgsOf<A> | undefined));
    return f;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, name, shard]);
}

/** Online flag, per-shard socket state and the number of unconfirmed mutations. */
export function useConnectionState(): ConnectionState {
  const client = useEmberClient();
  const subscribe = useCallback((l: () => void) => client.onConnectionStateChange(l), [client]);
  const get = useCallback(() => client.connectionState(), [client]);
  return useSyncExternalStore(subscribe, get, get);
}

// ------------------------------------------------------------------------------------------------ pagination

export type { PaginationOptions, PaginationResult };

export type { PaginationStatus };

export interface UsePaginatedQueryResult<T> {
  results: T[];
  status: PaginationStatus;
  isLoading: boolean;
  loadMore(numItems: number): void;
}

/** A query usable with `usePaginatedQuery`: it takes `paginationOpts` and returns a `PaginationResult`. */
export type PaginatedQueryReference = FunctionReference<"query", any, { paginationOpts: PaginationOptions }, PaginationResult<any>, any, any>;
type PageItem<Q extends PaginatedQueryReference> = ReturnOf<Q> extends PaginationResult<infer T> ? T : never;
type PaginatedArgs<Q extends PaginatedQueryReference> = Omit<ArgsOf<Q>, "paginationOpts">;

const NO_PAGES: PaginatedSnapshot<never> = Object.freeze({ results: [], status: "LoadingFirstPage", isLoading: true });
const getNoPages = () => NO_PAGES;

/**
 * Live cursor pagination (`watchPaginatedQuery` of `@freecorps/ember-client`): page `i` is its own live query with `paginationOpts`; once
 * loaded, its key range is fixed (`endCursor`), so a new item changes one page and the others keep their
 * subscriptions. Pages split when they grow past twice their size and merge when they empty; the list never shrinks
 * while a page's subscription is replaced. Page items keep their identity across changes.
 */
export function usePaginatedQuery<Q extends PaginatedQueryReference>(
  ref: Q,
  args: PaginatedArgs<Q> | "skip",
  opts: ShardOptions & { initialNumItems: number },
): UsePaginatedQueryResult<PageItem<Q>> {
  const client = useEmberClient();
  const name = getFunctionName(ref);
  const skip = args === "skip";
  const argsKey = skip ? null : stableStringify(args ?? {});
  const shard = opts.shard;
  const initial = useRef(opts.initialNumItems);
  // One paginator per (function, args, shard): new args start from the first page again.
  const handle = useMemo(
    () => (skip ? null : watchPaginatedQuery<PageItem<Q>>(client, ref, (args ?? {}) as Record<string, unknown>, { initialNumItems: initial.current, ...(shard === undefined ? {} : { shard }) })),
    // args are read through argsKey; ref through its name
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, name, argsKey, shard],
  );
  const snap = useSyncExternalStore(handle?.subscribe ?? noopSubscribe, handle?.getSnapshot ?? getNoPages, handle?.getSnapshot ?? getNoPages) as PaginatedSnapshot<PageItem<Q>>;
  if (snap.error) throw snap.error;
  const loadMore = useCallback((n: number) => handle?.loadMore(n), [handle]);
  return useMemo(() => ({ results: snap.results, status: snap.status, isLoading: snap.isLoading, loadMore }), [snap, loadMore]);
}

export type { QuerySnapshot, ConnectionState } from "@freecorps/ember-client";
