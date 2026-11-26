// React bindings for @freecorps/ember-client. No DOM APIs: works in React DOM and React Native.
import {
  Fragment,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  decodeJson,
  getFunctionName,
  stableStringify,
  toResult,
  unsafeRef,
  watchPaginatedQuery,
  type ArgsAndOptions,
  type ArgsOrSkipAndOptions,
  type ConnectionState,
  type EmberClient,
  type EmberErrorOf,
  type FunctionReference,
  type HydratedQuery,
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
  const w = useWatchHandle(ref, rest);
  const { handle } = w;
  const snap = useSyncExternalStore(
    handle?.subscribe ?? noopSubscribe,
    handle?.getSnapshot ?? getLoading,
    handle?.getSnapshot ?? getLoading,
  ) as QuerySnapshot<ReturnOf<Q>>;
  return { snap, argsKey: w.argsKey, args: w.args, opts: w.opts };
}

/** The live query handle of (ref, args, shard): one per distinct value of them (args compared by value). */
function useWatchHandle<Q extends QueryReference>(ref: Q, rest: readonly unknown[]) {
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
  return { handle, argsKey, args: skip ? undefined : args, opts };
}

// ------------------------------------------------------------------------------------------------ selectors

/**
 * `Object.is`, or, for two arrays / plain objects, the same length / keys with `Object.is` values (one level): a
 * selector that builds a new array or object from rows the client kept (unchanged rows keep their identity) compares
 * equal when nothing it picked changed.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const pa = Object.getPrototypeOf(a);
  if (pa !== Object.prototype && pa !== null) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/**
 * `useSyncExternalStore` of `select(getSnapshot())`: re-renders only when the selection changes by `equals` (the
 * previous selection is returned, same object, when it is equal). An inline `select` is fine: it runs again on a new
 * snapshot or when it changes, and the comparison keeps the rendered value stable.
 */
function useSelected<T, S>(subscribe: (l: () => void) => () => void, getSnapshot: () => T, select: (t: T) => S, equals: (a: S, b: S) => boolean): S {
  const last = useRef<{ value: S } | null>(null);
  const getSelection = useMemo(() => {
    let memo: { snap: T; sel: S } | null = null;
    return () => {
      const snap = getSnapshot();
      if (memo && Object.is(memo.snap, snap)) return memo.sel;
      const next = select(snap);
      const prev = last.current;
      const sel = prev && equals(prev.value, next) ? prev.value : next;
      memo = { snap, sel };
      return sel;
    };
  }, [getSnapshot, select, equals]);
  const value = useSyncExternalStore(subscribe, getSelection, getSelection);
  useEffect(() => {
    last.current = { value };
  }, [value]);
  return value;
}

/** `select` / `equals` of `useQuery`. */
export interface SelectOptions<T, S> {
  /** Picks what the component renders from the value: it re-renders only when the pick changes (by `equals`). */
  select?: (value: T) => S;
  /** How two picks compare. Default `shallowEqual`. */
  equals?: (a: S, b: S) => boolean;
}

/** `useQuery` options: the shard, and an optional selector. */
export type QueryHookOptions<T, S> = ShardOptions & SelectOptions<T, S>;

type Picked<S> = { readonly status: QuerySnapshot["status"]; readonly value: S | undefined; readonly error: unknown };

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
 *
 * `{ select }` renders a part of the value: `useQuery(api.todos.list, { list }, { select: (t) => t.filter((x) =>
 * x.done).length })` re-renders only when the count changes, not on every change of the list (`equals`, default
 * `shallowEqual`, compares two selections; the client keeps unchanged rows' identity, so a filtered array of rows
 * compares equal when none of its rows changed).
 */
export function useQuery<Q extends QueryReference, S = ReturnOf<Q>>(ref: Q, ...rest: ArgsOrSkipAndOptions<Q, QueryHookOptions<ReturnOf<Q>, S>>): S | undefined {
  const { handle, opts } = useWatchHandle(ref, rest);
  const o = opts as QueryHookOptions<ReturnOf<Q>, S> | undefined;
  const pick = o?.select;
  const eq = o?.equals ?? shallowEqual;
  const select = useCallback(
    (s: QuerySnapshot<ReturnOf<Q>>): Picked<S> => (pick && s.status === "success" ? { status: s.status, value: pick(s.value as ReturnOf<Q>), error: undefined } : (s as Picked<S>)),
    [pick],
  );
  const equals = useCallback(
    (a: Picked<S>, b: Picked<S>) => (pick ? a.status === b.status && (a.status === "success" ? eq(a.value as S, b.value as S) : a.error === b.error) : Object.is(a, b)),
    [pick, eq],
  );
  const s = useSelected((handle?.subscribe ?? noopSubscribe) as (l: () => void) => () => void, (handle?.getSnapshot ?? getLoading) as () => QuerySnapshot<ReturnOf<Q>>, select, equals);
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
/**
 * A suspension whose query never answers (offline, a closed client) or whose component went away while suspended (a
 * boundary unmounted, a navigation: no effect ever runs for it) settles after this long, and is released a grace later: a
 * component still waiting renders again and suspends anew on a fresh subscription.
 */
const SUSPENSE_ABANDON_MS = 60_000;
interface Suspension {
  readonly promise: Promise<void>;
  settled: boolean;
  /** Server render: the fetch failed. The render after the promise throws it to the error boundary. */
  failed?: { error: unknown };
  /** Lets go of what keeps the query (the subscription opened to suspend), once; later calls do nothing. */
  release(): void;
}
const suspended = new WeakMap<EmberClient, Map<string, Suspension>>();

/** The suspension of `key`: settles once the query answers (or `SUSPENSE_ABANDON_MS` pass). */
function suspendOn<Q extends QueryReference>(client: EmberClient, map: Map<string, Suspension>, key: string, ref: Q, args: ArgsOf<Q>, opts: ShardOptions | undefined): Suspension {
  let off: (() => void) | undefined;
  let released = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let resolveIt: () => void = () => {};
  const mine: Suspension = {
    promise: new Promise<void>((resolve) => (resolveIt = resolve)),
    settled: false,
    release: () => {
      if (released) return;
      released = true;
      clearTimeout(abandon);
      if (grace !== undefined) clearTimeout(grace);
      off?.();
      if (map.get(key) === mine) map.delete(key);
    },
  };
  const settle = (): boolean => {
    if (mine.settled) return false;
    mine.settled = true;
    resolveIt();
    return true;
  };
  // Settled first, released after the grace: a component still mounted suspends again on a new subscription of
  // the same query before this one lets go, so the client keeps the one it has (and its in-flight HTTP-first fetch).
  const graceThenRelease = () => {
    if (released) return;
    grace = setTimeout(mine.release, SUSPENSE_GRACE_MS);
    (grace as { unref?: () => void }).unref?.();
  };
  const abandon = setTimeout(() => {
    if (settle()) graceThenRelease();
  }, SUSPENSE_ABANDON_MS);
  (abandon as { unref?: () => void }).unref?.();
  map.set(key, mine);
  if (!client.realtime) {
    // A server render (no WebSocket): one HTTP read, handed to `hydrate`; the render that retries reads it from the
    // client's snapshot, and `client.dehydrate()` hands it to the browser's `hydrate()`. Nothing is subscribed, so
    // there is nothing to release but the entry (a failure is kept a grace, for the retry to throw it).
    const epoch = client.authEpoch;
    void (client.fetchForHydration as (r: Q, a: unknown, o: unknown) => ReturnType<EmberClient["fetchForHydration"]>)(ref, args, opts).then(
      (h) => {
        // Read for whoever was signed in when it started: never shown to the identity that replaced them.
        if (client.authEpoch === epoch) client.hydrate(h);
        clearTimeout(abandon);
        // Read from the client's snapshot from now on: the entry has nothing more to keep.
        if (settle()) mine.release();
      },
      (error: unknown) => {
        clearTimeout(abandon);
        // Failed for whoever was signed in when it started: the new identity's render reads again, never throws it.
        if (client.authEpoch !== epoch) {
          if (settle()) mine.release();
          return;
        }
        mine.failed = { error };
        if (settle()) graceThenRelease();
      },
    );
    return mine;
  }
  try {
    off = client.subscribe(ref, args, opts, (snap) => {
      if (snap.status === "loading" || !settle()) return;
      clearTimeout(abandon);
      graceThenRelease();
    });
  } catch (e) {
    mine.release();
    throw e;
  }
  return mine;
}

/**
 * Like `useQuery`, but suspends while loading (wrap it in `<Suspense>`): the value is never `undefined`.
 *
 * The promise thrown is shared per (identity, shard, function, args) — never across users, nor across the orgs of a
 * `fromAuth` function — and settles on the first value (or error). The subscription behind it is released once the
 * component mounts with the value (its own subscription holds the query then), or `SUSPENSE_GRACE_MS` after the value
 * if it never mounts, once: later snapshots do not start more timers, and the release never removes a newer suspension
 * of the same key. One that never settles is released after `SUSPENSE_ABANDON_MS` (settled then, released after the
 * same grace: no subscription outlives a component that suspended and was unmounted, and one still mounted keeps the
 * query's fetch across the boundary). A query loading again after its promise settled (a sign-out) suspends on a new
 * promise, never on the settled one. The timers do not keep a server process alive.
 *
 * Server rendering (a client without WebSocket, `client.realtime === false`): no subscription; the query is read once
 * with `fetchForHydration` and handed to `client.hydrate`, so a streaming render (`renderToPipeableStream`,
 * `prerender`) waits for it and renders the value. A failed read goes to the error boundary.
 */
export function useSuspenseQuery<Q extends QueryReference>(ref: Q, ...rest: ArgsAndOptions<Q, ShardOptions>): ReturnOf<Q> {
  const client = useEmberClient();
  const { snap: s, argsKey, args, opts } = useWatched(ref, rest);
  const key = `${client.identityScope(ref, opts)}\u0000${opts?.shard ?? ""}\u0000${getFunctionName(ref)}\u0000${argsKey ?? "{}"}`;
  // Mounted with the value: this component's own subscription holds the query now, so the one opened to suspend
  // goes at once (not a grace later). Only with the value: one settled without it (abandoned) keeps the query until
  // the component's own subscription has it. Never runs on a server.
  const has = s.status === "success";
  useEffect(() => {
    if (!has) return;
    const cur = suspended.get(client)?.get(key);
    if (cur?.settled && !cur.failed) cur.release();
  }, [client, key, has]);
  if (s.status === "error") throw s.error;
  if (s.status === "success") return s.value as ReturnOf<Q>;
  let byKey = suspended.get(client);
  if (!byKey) suspended.set(client, (byKey = new Map()));
  let cur = byKey.get(key);
  if (cur?.settled && cur.failed) throw cur.failed.error;
  if (!cur || cur.settled) cur = suspendOn(client, byKey, key, ref, (args ?? {}) as ArgsOf<Q>, opts);
  throw cur.promise;
}

/** `[options?]`, or `[options]` with a typed `shard` when the function's shard must be named (`shard: "org"`). */
type HookOptions<F, O = ShardOptions> = [NamedShardKind<F>] extends [never] ? [options?: OptionsFor<F, O>] : [options: OptionsFor<F, O>];

/** `useMutation` / `useMutationState` options: the shard, and an optimistic update applied on every call. */
export type MutationHookOptions<M extends MutationReference> = ShardOptions & {
  /**
   * Applied on every call (as `.withOptimisticUpdate`). An inline function is fine: the latest one runs, and the
   * mutation function stays the same object across renders.
   */
  optimisticUpdate?: OptimisticUpdate<ArgsOf<M>>;
};

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

/**
 * A stable function that runs the mutation. `.withOptimisticUpdate(fn)` adds an optimistic update (or pass
 * `{ optimisticUpdate }`); `.safe()` returns a Result.
 */
export function useMutation<M extends MutationReference>(ref: M, ...options: HookOptions<M, MutationHookOptions<M>>): ReactMutation<M> {
  const opts = options[0] as MutationHookOptions<M> | undefined;
  const client = useEmberClient();
  const name = getFunctionName(ref);
  const shard = opts?.shard;
  // The latest optimistic update, read at call time: an inline one does not make a new mutation function per render.
  const update = useRef(opts?.optimisticUpdate);
  update.current = opts?.optimisticUpdate;
  const optimistic = opts?.optimisticUpdate !== undefined;
  return useMemo(
    () => makeMutation<M>(client, ref, shard === undefined ? undefined : { shard }, optimistic ? (store, args, m) => update.current?.(store, args, m) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, name, shard, optimistic],
  );
}

/** `useMutationState`: the mutation plus its last call's state, for forms and buttons. */
export interface MutationState<M extends MutationReference> {
  /** Runs it; resolves to a Result (never throws). */
  mutate(...args: OptionalRestArgs<M>): Promise<Result<ReturnOf<M>, EmberErrorOf<M>>>;
  readonly isPending: boolean;
  readonly data: ReturnOf<M> | undefined;
  readonly error: EmberErrorOf<M> | undefined;
  /** The last call's Result (undefined before the first one, or after `reset`). */
  readonly result: Result<ReturnOf<M>, EmberErrorOf<M>> | undefined;
  reset(): void;
}

/**
 * The mutation and its last call's state (`isPending`, `data`, `error`), for forms and buttons. `{ optimisticUpdate }`
 * applies an optimistic update on every call. The returned object is memoized: it changes only when the state does,
 * and `mutate` / `reset` keep their identity.
 */
export function useMutationState<M extends MutationReference>(ref: M, ...options: HookOptions<M, MutationHookOptions<M>>): MutationState<M> {
  const m = useMutation(ref, ...options);
  const { run, reset, st } = useCallState<OptionalRestArgs<M>, ReturnOf<M>, EmberErrorOf<M>>(m.safe);
  return useMemo(() => ({ mutate: run, reset, ...st }), [run, reset, st]);
}

type CallState<R, E> = { readonly isPending: boolean; readonly data: R | undefined; readonly error: E | undefined; readonly result: Result<R, E> | undefined };
const IDLE: CallState<never, never> = Object.freeze({ isPending: false, data: undefined, error: undefined, result: undefined });

/** The state of the last call of `safe` (a newer call wins over an older one still running). */
function useCallState<A extends unknown[], R, E>(safe: (...args: A) => Promise<Result<R, E>>) {
  const [st, setSt] = useState<CallState<R, E>>(IDLE);
  const seq = useRef(0);
  const run = useCallback(
    async (...args: A) => {
      const mine = ++seq.current;
      setSt((p) => (p.isPending ? p : { ...p, isPending: true }));
      const r = await safe(...args);
      if (mine === seq.current) setSt(r.ok ? { isPending: false, data: r.value, error: undefined, result: r } : { isPending: false, data: undefined, error: r.error, result: r });
      return r;
    },
    [safe],
  );
  const reset = useCallback(() => {
    seq.current++;
    setSt(IDLE);
  }, []);
  return { run, reset, st };
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

/** `useActionState`: an action and its last call's state. */
export interface ActionState<A extends ActionReference> {
  /** Runs the action; resolves to a Result (never throws). A newer call's state replaces an older one's. */
  run(...args: OptionalRestArgs<A>): Promise<Result<ReturnOf<A>, EmberErrorOf<A>>>;
  readonly isPending: boolean;
  readonly data: ReturnOf<A> | undefined;
  readonly error: EmberErrorOf<A> | undefined;
  /** The last call's Result (undefined before the first one, or after `reset`). */
  readonly result: Result<ReturnOf<A>, EmberErrorOf<A>> | undefined;
  reset(): void;
  /**
   * The action in React 19's `useActionState` shape, `(previous, args) => Promise<Result>`: `const [result, dispatch,
   * pending] = React.useActionState(state.reducer, null)` for `<form action>` and transitions. It does not update
   * this hook's own state (that hook keeps it).
   */
  reducer(previous: Result<ReturnOf<A>, EmberErrorOf<A>> | null | undefined, args: ArgsOf<A>): Promise<Result<ReturnOf<A>, EmberErrorOf<A>>>;
}

/**
 * An action (`useAction`) with the state of its last call: `isPending`, `data`, `error`, `result`. Works on React 18
 * and 19; with React 19's `useActionState` use `.reducer`. Memoized like `useMutationState`.
 */
export function useActionState<A extends ActionReference>(ref: A, ...options: HookOptions<A>): ActionState<A> {
  const a = useAction(ref, ...options);
  const { run, reset, st } = useCallState<OptionalRestArgs<A>, ReturnOf<A>, EmberErrorOf<A>>(a.safe);
  const reducer = useCallback((_prev: unknown, args: ArgsOf<A>) => (a.safe as (x: unknown) => Promise<Result<ReturnOf<A>, EmberErrorOf<A>>>)(args), [a]);
  return useMemo(() => ({ run, reset, reducer, ...st }), [run, reset, reducer, st]);
}

/**
 * Online flag, per-shard socket state and the number of unconfirmed mutations. With `select`, only that part:
 * `useConnectionState((s) => s.pendingMutations > 0)` re-renders when it flips, not on every socket change.
 */
export function useConnectionState(): ConnectionState;
export function useConnectionState<S>(select: (state: ConnectionState) => S, equals?: (a: S, b: S) => boolean): S;
export function useConnectionState<S>(select?: (state: ConnectionState) => S, equals?: (a: S, b: S) => boolean): ConnectionState | S {
  const client = useEmberClient();
  const subscribe = useCallback((l: () => void) => client.onConnectionStateChange(l), [client]);
  const get = useCallback(() => client.connectionState(), [client]);
  const pick = useCallback((s: ConnectionState) => (select ? select(s) : s), [select]);
  return useSelected<ConnectionState, ConnectionState | S>(subscribe, get, pick, (equals ?? (select ? shallowEqual : Object.is)) as (a: ConnectionState | S, b: ConnectionState | S) => boolean);
}

// ------------------------------------------------------------------------------------------------ hydration

/** A query read on the server (`client.fetchForHydration` / `preloadQuery`), for `usePreloadedQuery`. */
export type Preloaded<Q extends QueryReference> = HydratedQuery<ReturnOf<Q>>;

/** `client.fetchForHydration`, typed for `usePreloadedQuery` (a server component, a loader). */
export function preloadQuery<Q extends QueryReference>(client: EmberClient, ref: Q, ...rest: ArgsAndOptions<Q, ShardOptions>): Promise<Preloaded<Q>> {
  return (client.fetchForHydration as (r: Q, ...x: unknown[]) => Promise<Preloaded<Q>>)(ref, ...rest);
}

export interface EmberHydrateProps {
  /** What the server's client read: `client.dehydrate()`, as is or encoded (`encodeJson`). Null: nothing. */
  state: readonly HydratedQuery[] | string | null | undefined;
  children?: ReactNode;
}

/**
 * Hands server-read values to the client before its children render (`client.hydrate`), so every hook below shows
 * them from the first render (no loading flash) and subscribes with `resume`. A new `state` hydrates again (entries
 * the client already has are ignored), the same one does nothing.
 */
export function EmberHydrate({ state, children }: EmberHydrateProps) {
  const client = useEmberClient();
  const done = useRef<{ client: EmberClient; state: EmberHydrateProps["state"] } | null>(null);
  if (state && (done.current?.client !== client || done.current.state !== state)) {
    client.hydrate(...(typeof state === "string" ? (decodeJson(state) as HydratedQuery[]) : state));
    done.current = { client, state };
  }
  return createElement(Fragment, null, children);
}

/**
 * The live value of a query preloaded on the server (`preloadQuery` / `fetchForHydration`): shown at once from the
 * preloaded value, then live (the subscription resumes from it). Same shard as the preload (its routing included).
 * A preload the client refuses (read for another identity than the one signed in now) is not shown: the hook
 * suspends until the live value comes (wrap it in `<Suspense>`). Errors go to the error boundary.
 */
export function usePreloadedQuery<T>(preloaded: HydratedQuery<T>): T {
  const client = useEmberClient();
  const done = useRef<{ client: EmberClient; preloaded: HydratedQuery<T> } | null>(null);
  if (done.current?.client !== client || done.current.preloaded !== preloaded) {
    client.hydrate(preloaded);
    done.current = { client, preloaded };
  }
  const ref = useMemo(() => unsafeRef<"query">(preloaded.fn), [preloaded.fn]);
  return useSuspenseQuery(ref, preloaded.args, { shard: preloaded.shard }) as T;
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
