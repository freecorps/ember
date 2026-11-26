import { QueryClient, QueryClientProvider, QueryObserver, dehydrate, hydrate, useMutation, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmberClient, FUNCTION_SHARD, anyApi, makeFunctionReference, memorySnapshotCache, unsafeRef, type FunctionReference } from "@freecorps/ember-client";
import { FakeEmberServer, FakeFunctionError } from "@freecorps/ember-client/testing";
import { MemoryBackend, memoryStorage } from "@freecorps/ember-offline";
import { defineSchema, defineTable, v } from "@freecorps/ember-server";
import { EmberQueryClient, emberHydrationKey, emberMutation, emberMutationFn, emberQuery, emberQueryKeyHashFn, prefetchEmberQuery } from "../src/index.ts";

const SHARD = "org:acme";
const api = anyApi as unknown as {
  messages: {
    list: FunctionReference<"query", "public", { channel: string }, string[]>;
    send: FunctionReference<"mutation", "public", { channel: string; body: string }, string>;
  };
};

function setup(gcTime = 5 * 60_000, opts: { ident?: boolean; unsubscribeGraceMs?: number } = {}) {
  const { unsubscribeGraceMs, ...serverOpts } = opts;
  const server = new FakeEmberServer({
    ...serverOpts,
    queries: {
      "messages:list": (db, { channel }) => db.where<{ body: string }>("messages", "channel", channel).map((m) => m.body),
      "messages:docs": (db, { channel }) => db.where("messages", "channel", channel),
      "messages:blob": () => ({ n: 7n, bytes: new Uint8Array([1, 2, 3]) }),
      "boom:q": () => {
        throw new FakeFunctionError("nope", "exploded");
      },
    },
    mutations: { "messages:send": (db, { channel, body }) => db.insert("messages", { channel, body }) },
  });
  const ember = new EmberClient({
    url: "https://ember.test",
    WebSocket: server.WebSocket,
    fetch: server.fetch,
    connectivity: null,
    heartbeat: false,
    defaultShard: SHARD,
    backoff: { initialMs: 5, maxMs: 10 },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime, retry: false } } });
  const eqc = new EmberQueryClient(ember, unsubscribeGraceMs === undefined ? {} : { unsubscribeGraceMs }).connect(queryClient);
  const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { server, ember, queryClient, eqc, wrap };
}

afterEach(() => cleanup());

function List({ channel }: { channel: string }) {
  const { data, status } = useQuery(emberQuery(api.messages.list, { channel }));
  return <div data-testid="list">{status === "success" ? data.join(",") || "empty" : status}</div>;
}

describe("emberQuery", () => {
  it("builds a stable key with staleTime Infinity", () => {
    const o = emberQuery(api.messages.list, { channel: "a" }, { shard: "org:x" });
    expect(o.queryKey).toEqual(["ember", "org:x", "messages:list", { channel: "a" }]);
    expect(o.staleTime).toBe(Infinity);
    // The client keeps unchanged rows' identity itself.
    expect(o.structuralSharing).toBe(false);
    expect(emberQuery(api.messages.list, { channel: "a" }).queryKey[1]).toBeNull();
    expect(o.queryKeyHashFn!(["ember", "s", "f", { b: 1, a: 2n }] as never)).toBe(o.queryKeyHashFn!(["ember", "s", "f", { a: 2n, b: 1 }] as never));
  });

  it("a hydration entry's hash is the query's own with the other tag (what `watch` looks it up by, without encoding the args)", () => {
    for (const key of [["ember", null, "m:f", { b: 1, a: 2n }], ["ember", "org:x", "m:f", { s: 'q"\\' }]] as const) {
      const h = emberQueryKeyHashFn(key as never);
      expect(h.startsWith('ember:["ember",')).toBe(true);
      expect(emberQueryKeyHashFn(emberHydrationKey(key as never) as never)).toBe(`ember:["ember:hydration",${h.slice('ember:["ember",'.length)}`);
    }
  });

  it("loads, then receives server patches through setQueryData", async () => {
    const { server, ember, queryClient, wrap } = setup();
    wrap(<List channel="a" />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    act(() => void server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "hi" }));
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("hi"));
    expect(queryClient.getQueryData(emberQuery(api.messages.list, { channel: "a" }).queryKey)).toEqual(["hi"]);
    expect(server.subscriptionCount()).toBe(1);
    ember.close();
  });

  it("a cold load is one client subscription and one render with the value (the fetch waits for the live one)", async () => {
    const { server, ember, queryClient, wrap } = setup();
    server.mutateDirect(SHARD, "messages:send", { channel: "c", body: "v" });
    let subscribes = 0;
    const orig = ember.subscribe.bind(ember) as (...a: unknown[]) => () => void;
    (ember as unknown as { subscribe: (...a: unknown[]) => () => void }).subscribe = (...a) => (subscribes++, orig(...a));
    const renders: string[] = [];
    function Counted() {
      const { data, status, fetchStatus } = useQuery(emberQuery(api.messages.list, { channel: "c" }));
      renders.push(`${status}/${fetchStatus}/${data?.join(",") ?? ""}`);
      return <div data-testid="c">{status === "success" ? data.join(",") : status}</div>;
    }
    let updates = 0;
    const off = queryClient.getQueryCache().subscribe((e) => e.type === "updated" && e.action.type === "success" && updates++);
    wrap(<Counted />);
    await waitFor(() => expect(screen.getByTestId("c").textContent).toBe("v"));
    await new Promise((r) => setTimeout(r, 20));
    expect(subscribes).toBe(1);
    expect(updates).toBe(1);
    expect(renders.filter((r) => r.startsWith("success"))).toEqual(["success/idle/v"]);
    // Still live afterwards (patches through setQueryData).
    act(() => void server.mutateDirect(SHARD, "messages:send", { channel: "c", body: "w" }));
    await waitFor(() => expect(screen.getByTestId("c").textContent).toBe("v,w"));
    off();
    ember.close();
  });

  /** The client's socket open (another query), with the server's frames held from now on. */
  async function heldSocket(server: FakeEmberServer, ember: EmberClient) {
    const warm = ember.subscribe(api.messages.list, { channel: "warm" }, undefined, () => {});
    await waitFor(() => expect(server.open(SHARD).length).toBe(1));
    await waitFor(() => expect(server.subscriptionCount(SHARD)).toBe(1));
    const ws = server.open(SHARD)[0]!;
    ws.hold();
    return { ws, warm };
  }

  /** Counts `client.subscribe` calls. */
  function countSubscribes(ember: EmberClient) {
    const n = { subscribes: 0 };
    const orig = ember.subscribe.bind(ember) as (...a: unknown[]) => () => void;
    (ember as unknown as { subscribe: (...a: unknown[]) => () => void }).subscribe = (...a) => (n.subscribes++, orig(...a));
    return n;
  }

  it("a fetch whose observer goes before the value comes still settles (over a subscription of its own)", async () => {
    const { server, ember, queryClient, eqc } = setup(5 * 60_000, { unsubscribeGraceMs: 0 });
    const { ws } = await heldSocket(server, ember);
    const n = countSubscribes(ember);
    const opts = emberQuery(api.messages.list, { channel: "gone" });
    const obs = new QueryObserver(queryClient, opts);
    const off = obs.subscribe(() => {});
    expect(eqc.subscriptionCount).toBe(1);
    const p = queryClient.fetchQuery(opts);
    off();
    // The live subscription ends with no value yet; the fetch subscribes on its own (and settles once the value comes).
    await waitFor(() => expect(eqc.subscriptionCount).toBe(0));
    await waitFor(() => expect(n.subscribes).toBe(2));
    ws.release();
    await expect(p).resolves.toEqual([]);
    ember.close();
  });

  it("a fetch started while an earlier one still waits (cancelled, then refetched) shares the live subscription", async () => {
    const { server, ember, queryClient } = setup();
    const { ws } = await heldSocket(server, ember);
    server.mutateDirect(SHARD, "messages:send", { channel: "r", body: "v" });
    const n = countSubscribes(ember);
    const opts = emberQuery(api.messages.list, { channel: "r" });
    const obs = new QueryObserver(queryClient, opts);
    const off = obs.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    // The first queryFn still waits on the live subscription when the second one runs.
    await queryClient.cancelQueries({ queryKey: opts.queryKey });
    const again = obs.refetch();
    await new Promise((r) => setTimeout(r, 10));
    ws.release();
    await expect(again).resolves.toMatchObject({ status: "success", data: ["v"] });
    expect(n.subscribes).toBe(1);
    expect(queryClient.getQueryData(opts.queryKey)).toEqual(["v"]);
    off();
    ember.close();
  });

  it("a fetch cancelled while its observer stays: the value still reaches the cache", async () => {
    const { server, ember, queryClient } = setup();
    const { ws } = await heldSocket(server, ember);
    server.mutateDirect(SHARD, "messages:send", { channel: "k", body: "v" });
    const opts = emberQuery(api.messages.list, { channel: "k" });
    const obs = new QueryObserver(queryClient, opts);
    const off = obs.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    await queryClient.cancelQueries({ queryKey: opts.queryKey });
    expect(queryClient.getQueryState(opts.queryKey)?.fetchStatus).toBe("idle");
    ws.release();
    await waitFor(() => expect(queryClient.getQueryData(opts.queryKey)).toEqual(["v"]));
    // And live afterwards.
    server.mutateDirect(SHARD, "messages:send", { channel: "k", body: "w" });
    await waitFor(() => expect(queryClient.getQueryData(opts.queryKey)).toEqual(["v", "w"]));
    off();
    ember.close();
  });

  it("a cold fetch cancelled silently (no fetch after it): the first value still reaches the cache", async () => {
    const { server, ember, queryClient } = setup();
    const { ws } = await heldSocket(server, ember);
    server.mutateDirect(SHARD, "messages:send", { channel: "s", body: "v" });
    const opts = emberQuery(api.messages.list, { channel: "s" });
    const obs = new QueryObserver(queryClient, opts);
    const off = obs.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    // Without `revert` (cancelQueries defaults it to true) TanStack keeps the stale "fetching" status: no fetch is
    // left to write the value.
    await queryClient.cancelQueries({ queryKey: opts.queryKey }, { silent: true, revert: false });
    expect(queryClient.getQueryState(opts.queryKey)?.fetchStatus).toBe("fetching");
    ws.release();
    await waitFor(() => expect(queryClient.getQueryData(opts.queryKey)).toEqual(["v"]));
    expect(obs.getCurrentResult()).toMatchObject({ status: "success", data: ["v"] });
    off();
    ember.close();
  });

  it("a refetch of a query already in error rejects at once (the error is not sent again)", async () => {
    const { ember, queryClient } = setup();
    const opts = emberQuery(unsafeRef<"query">("boom:q") as unknown as typeof api.messages.list, { channel: "x" });
    const obs = new QueryObserver(queryClient, opts);
    const off = obs.subscribe(() => {});
    await waitFor(() => expect(obs.getCurrentResult().status).toBe("error"));
    const r = await Promise.race([obs.refetch(), new Promise((res) => setTimeout(() => res("hung"), 500))]);
    expect(r).toMatchObject({ status: "error" });
    off();
    ember.close();
  });

  it("rowdiff patches reach setQueryData as the reconstructed array", async () => {
    const { server, ember, queryClient, wrap } = setup();
    const docs = anyApi.messages!.docs as unknown as FunctionReference<"query", "public", { channel: string }, Array<{ _id: string; body: string }>>;
    function Docs() {
      const { data, status } = useQuery(emberQuery(docs, { channel: "d" }));
      return <div data-testid="docs">{status === "success" ? data.map((d) => d.body).join(",") || "empty" : status}</div>;
    }
    for (let i = 0; i < 30; i++) server.mutateDirect(SHARD, "messages:send", { channel: "d", body: `m${i}` });
    wrap(<Docs />);
    await waitFor(() => expect(screen.getByTestId("docs").textContent).toMatch(/^m0,/));
    act(() => void server.mutateDirect(SHARD, "messages:send", { channel: "d", body: "new" }));
    await waitFor(() => expect(screen.getByTestId("docs").textContent).toMatch(/,new$/));
    const data = queryClient.getQueryData(emberQuery(docs, { channel: "d" }).queryKey) as Array<{ body: string }>;
    expect(data).toHaveLength(31);
    const patch = server.open()[0]!.received.find((f): f is any => f !== "pong" && f.t === "patch");
    expect(patch.changes[0].diff).toBeDefined();
    ember.close();
  });

  it("keeps the subscription during gcTime and unsubscribes when the query is garbage-collected", async () => {
    const { server, ember, eqc, queryClient, wrap } = setup(300);
    const view = wrap(<List channel="g" />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    expect(eqc.subscriptionCount).toBe(1);
    view.unmount();
    await new Promise((r) => setTimeout(r, 20));
    // still live inside gcTime: the cache keeps getting patches
    expect(server.subscriptionCount()).toBe(1);
    server.mutateDirect(SHARD, "messages:send", { channel: "g", body: "late" });
    await waitFor(() => expect(queryClient.getQueryData(emberQuery(api.messages.list, { channel: "g" }).queryKey)).toEqual(["late"]), { interval: 5 });
    await waitFor(() => expect(eqc.subscriptionCount).toBe(0), { timeout: 1000 });
    await waitFor(() => expect(server.subscriptionCount()).toBe(0));
    ember.close();
  });

  it("unsubscribes after the grace period without observers (data kept), and subscribes again when one comes back", async () => {
    const { server, ember, eqc, queryClient, wrap } = setup(5 * 60_000, { unsubscribeGraceMs: 50 });
    const key = emberQuery(api.messages.list, { channel: "u" }).queryKey;
    const view = wrap(<List channel="u" />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    view.unmount();
    await waitFor(() => expect(eqc.subscriptionCount).toBe(0), { timeout: 1000 });
    await waitFor(() => expect(server.subscriptionCount()).toBe(0));
    // Still in the TanStack cache (gcTime), no longer live.
    expect(queryClient.getQueryData(key)).toEqual([]);
    server.mutateDirect(SHARD, "messages:send", { channel: "u", body: "while away" });
    await new Promise((r) => setTimeout(r, 20));
    expect(queryClient.getQueryData(key)).toEqual([]);
    // A new observer: subscribed again, and the value catches up.
    wrap(<List channel="u" />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("while away"));
    expect(eqc.subscriptionCount).toBe(1);
    expect(server.subscriptionCount()).toBe(1);
    ember.close();
  });

  it("a grace of -Infinity (or below 0) unsubscribes at once; only +Infinity keeps the subscription", async () => {
    const { server, ember, eqc, wrap } = setup(5 * 60_000, { unsubscribeGraceMs: -Infinity });
    const view = wrap(<List channel="n" />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    view.unmount();
    await waitFor(() => expect(eqc.subscriptionCount).toBe(0), { timeout: 1000 });
    await waitFor(() => expect(server.subscriptionCount()).toBe(0));
    ember.close();
  });

  it("a remount after the grace period shows the value another Ember subscriber kept current meanwhile", async () => {
    const { server, ember, eqc, queryClient, wrap } = setup(5 * 60_000, { unsubscribeGraceMs: 30 });
    const key = emberQuery(api.messages.list, { channel: "o" }).queryKey;
    let direct: unknown;
    const offDirect = ember.subscribe(api.messages.list, { channel: "o" }, {}, (s) => s.status === "success" && (direct = s.value));
    const view = wrap(<List channel="o" />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    view.unmount();
    await waitFor(() => expect(eqc.subscriptionCount).toBe(0), { timeout: 1000 });
    // The Ember subscription lives on (the other subscriber) and moves ahead; TanStack keeps the old value.
    server.mutateDirect(SHARD, "messages:send", { channel: "o", body: "moved" });
    await waitFor(() => expect(direct).toEqual(["moved"]));
    expect(queryClient.getQueryData(key)).toEqual([]);
    wrap(<List channel="o" />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("moved"));
    offDirect();
    ember.close();
  });

  it("a query removed by a cache listener while subscribe() delivers the current value does not leak the subscription", async () => {
    const { server, ember, eqc, queryClient } = setup(5 * 60_000, { unsubscribeGraceMs: 30 });
    const options = emberQuery(api.messages.list, { channel: "r" });
    let direct: unknown;
    const offDirect = ember.subscribe(api.messages.list, { channel: "r" }, {}, (s) => s.status === "success" && (direct = s.value));
    const first = new QueryObserver(queryClient, options);
    const offFirst = first.subscribe(() => {});
    await waitFor(() => expect(queryClient.getQueryData(options.queryKey)).toEqual([]));
    offFirst();
    await waitFor(() => expect(eqc.subscriptionCount).toBe(0), { timeout: 1000 });
    server.mutateDirect(SHARD, "messages:send", { channel: "r", body: "newer" });
    await waitFor(() => expect(direct).toEqual(["newer"]));
    // The value Ember already holds reaches TanStack inside subscribe(); this listener drops the query right then.
    const offListener = queryClient.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.query.queryHash === queryClient.getQueryCache().find({ queryKey: options.queryKey })?.queryHash) {
        if (JSON.stringify(e.query.state.data) === JSON.stringify(["newer"])) queryClient.removeQueries({ queryKey: options.queryKey, exact: true });
      }
    });
    const second = new QueryObserver(queryClient, options);
    const offSecond = second.subscribe(() => {});
    expect(queryClient.getQueryCache().find({ queryKey: options.queryKey })).toBeUndefined();
    expect(eqc.subscriptionCount).toBe(0);
    offListener();
    // Only the direct subscriber is left: once it goes, nothing keeps the server subscription.
    offDirect();
    await waitFor(() => expect(server.subscriptionCount()).toBe(0), { timeout: 1000 });
    offSecond();
    ember.close();
  });

  it("an observer coming back within the grace period keeps the same subscription", async () => {
    const { server, ember, eqc, wrap } = setup(5 * 60_000, { unsubscribeGraceMs: 200 });
    const view = wrap(<List channel="k" />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    const subs = () => server.open().flatMap((ws) => ws.sent.filter((m) => m !== "ping" && m.t === "sub"));
    expect(subs()).toHaveLength(1);
    view.unmount();
    await new Promise((r) => setTimeout(r, 50));
    wrap(<List channel="k" />);
    await new Promise((r) => setTimeout(r, 300));
    expect(eqc.subscriptionCount).toBe(1);
    expect(server.subscriptionCount()).toBe(1);
    expect(subs()).toHaveLength(1);
    expect(server.open().flatMap((ws) => ws.sent.filter((m) => m !== "ping" && m.t === "unsub"))).toHaveLength(0);
    ember.close();
  });

  it("a snapshot whose value TanStack already holds (a cached value confirmed unchanged) does not call setQueryData", async () => {
    const { server } = setup(5 * 60_000, { ident: true });
    server.mutateDirect(SHARD, "messages:send", { channel: "s", body: "kept" });
    const cache = memorySnapshotCache();
    const make = () =>
      new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, heartbeat: false, defaultShard: SHARD, snapshotCache: cache, httpFirst: false });
    const first = make();
    await new Promise<void>((resolve) => {
      const off = first.subscribe(unsafeRef("messages:list"), { channel: "s" }, {}, (x) => {
        if (x.status === "success" && !x.source) {
          off();
          resolve();
        }
      });
    });
    first.close();
    const ember = make();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    new EmberQueryClient(ember).connect(queryClient);
    let updates = 0;
    queryClient.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.action.type === "success") updates++;
    });
    render(<QueryClientProvider client={queryClient}><List channel="s" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("kept"));
    // The socket confirms the cached value (`unchanged`): a new snapshot, the same value object.
    await waitFor(() => expect(server.open().at(-1)!.received.some((m) => m !== "pong" && m.t === "snap" && m.unchanged)).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(updates).toBe(1);
    ember.close();
  });

  it("'skip' does not subscribe; errors land in the query state", async () => {
    const { server, ember, wrap } = setup();
    function Skip() {
      const q = useQuery(emberQuery(api.messages.list, "skip"));
      return <div data-testid="skip">{q.fetchStatus}</div>;
    }
    function Boom() {
      const q = useQuery(emberQuery(unsafeRef<"query">("boom:q"), {}));
      return <div data-testid="boom">{q.status === "error" ? (q.error as { code: string }).code : q.status}</div>;
    }
    wrap(
      <>
        <Skip />
        <Boom />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("boom").textContent).toBe("nope"));
    expect(screen.getByTestId("skip").textContent).toBe("idle");
    expect(server.open()[0]!.sent.filter((m) => m !== "ping" && m.t === "sub").length).toBe(1);
    ember.close();
  });
});

describe("emberMutation", () => {
  it("is full useMutation options (TanStack passes the QueryClient in the mutation context)", async () => {
    const { wrap } = setup();
    let mutate!: (v: { channel: string; body: string }) => Promise<string>;
    function App() {
      const m = useMutation(emberMutation(api.messages.send));
      mutate = m.mutateAsync;
      return <List channel="em" />;
    }
    wrap(<App />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    await act(async () => {
      await mutate({ channel: "em", body: "via options" });
    });
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("via options"));
  });
});

describe("emberMutationFn", () => {
  it("runs the mutation and the live query updates", async () => {
    const { ember, wrap } = setup();
    let mutate!: (v: { channel: string; body: string }) => Promise<string>;
    function App() {
      const m = useMutation({ mutationFn: emberMutationFn(api.messages.send) });
      mutate = m.mutateAsync;
      return <List channel="m" />;
    }
    wrap(<App />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    let id = "";
    await act(async () => {
      id = await mutate({ channel: "m", body: "yo" });
    });
    expect(id).toMatch(/^messages_/);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("yo"));
    ember.close();
  });

  it("optimistic updates show in the TanStack cache", async () => {
    const { server, ember, wrap } = setup();
    let mutate!: (v: { channel: string; body: string }) => Promise<string>;
    function App() {
      const m = useMutation({
        mutationFn: emberMutationFn(api.messages.send, {
          optimisticUpdate: (store, args) => store.setQuery(api.messages.list, { channel: args.channel }, [...(store.getQuery(api.messages.list, { channel: args.channel }) ?? []), "…"]),
        }),
      });
      mutate = m.mutateAsync;
      return <List channel="o" />;
    }
    wrap(<App />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    server.open()[0]!.holdIncoming();
    let p!: Promise<string>;
    act(() => {
      p = mutate({ channel: "o", body: "real" });
    });
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("…"));
    server.open()[0]!.releaseIncoming();
    await act(async () => void (await p));
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("real"));
    ember.close();
  });
});

describe("SSR", () => {
  it("prefetches over HTTP, hydrates, then goes live", async () => {
    // "server side": HTTP only
    const { server, ember } = setup();
    server.mutateDirect(SHARD, "messages:send", { channel: "s", body: "ssr" });
    const serverQc = new QueryClient();
    await prefetchEmberQuery(serverQc, ember, api.messages.list, { channel: "s" });
    expect(server.httpRequests.map((r) => r.path)).toEqual(["/api/query"]);
    expect(server.history.length).toBe(0);
    const state = JSON.parse(JSON.stringify(dehydrate(serverQc)));

    // "browser": hydrate, render immediately with data, then subscribe
    const browserQc = new QueryClient();
    new EmberQueryClient(ember).connect(browserQc);
    hydrate(browserQc, state);
    render(
      <QueryClientProvider client={browserQc}>
        <List channel="s" />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("list").textContent).toBe("ssr");
    await waitFor(() => expect(server.subscriptionCount()).toBe(1));
    act(() => void server.mutateDirect(SHARD, "messages:send", { channel: "s", body: "live" }));
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("ssr,live"));
    ember.close();
  });

  it("the hydrated value is resumed: the browser's subscription downloads nothing (unchanged)", async () => {
    const { server, ember } = setup(undefined, { ident: true });
    server.mutateDirect(SHARD, "messages:send", { channel: "h", body: "ssr" });
    const serverQc = new QueryClient();
    await prefetchEmberQuery(serverQc, ember, api.messages.list, { channel: "h" });
    const state = JSON.parse(JSON.stringify(dehydrate(serverQc)));
    const browserQc = new QueryClient();
    new EmberQueryClient(ember).connect(browserQc);
    hydrate(browserQc, state);
    render(
      <QueryClientProvider client={browserQc}>
        <List channel="h" />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("list").textContent).toBe("ssr");
    await waitFor(() => expect(server.subscriptionCount()).toBe(1));
    const ws = server.open(SHARD).at(-1)!;
    await waitFor(() => expect(ws.received.some((m) => m !== "pong" && m.t === "snap")).toBe(true));
    const snaps = ws.received.filter((m) => m !== "pong" && m.t === "snap") as Array<{ unchanged?: boolean }>;
    expect(snaps.map((m) => m.unchanged)).toEqual([true]);
    act(() => void server.mutateDirect(SHARD, "messages:send", { channel: "h", body: "live" }));
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("ssr,live"));
    ember.close();
  });

  it("hydrated data that is not the server's value any more (lossy JSON, setQueryData) is not resumed: the real value comes", async () => {
    const { server, ember } = setup(undefined, { ident: true });
    const blob = makeFunctionReference<"query", Record<string, never>, { n: bigint; bytes: Uint8Array }>("messages:blob");
    const serverQc = new QueryClient();
    new EmberQueryClient(ember, { ssr: true }).connect(serverQc);
    await serverQc.prefetchQuery(emberQuery(blob, {}));
    // A plain JSON round trip loses the bigint and the bytes (an app should use encodeJson/decodeJson).
    const state = dehydrate(serverQc);
    const lossy = JSON.parse(JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
    const browserQc = new QueryClient();
    new EmberQueryClient(ember).connect(browserQc);
    hydrate(browserQc, lossy);
    function Blob() {
      const { data } = useQuery(emberQuery(blob, {}));
      return <div data-testid="blob">{data && typeof data.n === "bigint" && data.bytes instanceof Uint8Array ? `ok ${data.bytes.length}` : "lossy"}</div>;
    }
    render(
      <QueryClientProvider client={browserQc}>
        <Blob />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("blob").textContent).toBe("ok 3"));
    // Not resumed from the mangled data: the browser fetched the value again (HTTP-first, then the socket).
    expect(server.httpRequests.filter((r) => (r.body as { fn?: string }).fn === "messages:blob")).toHaveLength(2);
    ember.close();
  });

  it("an EmberQueryClient in ssr mode fetches with HTTP and never opens a socket", async () => {
    const { server, ember } = setup();
    const qc = new QueryClient();
    new EmberQueryClient(ember, { ssr: true }).connect(qc);
    expect(await qc.fetchQuery(emberQuery(api.messages.list, { channel: "z" }))).toEqual([]);
    expect(server.history.length).toBe(0);
    ember.close();
  });
});

describe("offline storage", () => {
  it("resolves queries from offline storage on a cold start without network, then follows the server", async () => {
    const { server } = setup();
    server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "stored" });
    const schema = defineSchema({ tables: { messages: defineTable({ channel: v.string(), body: v.string() }) } });
    const backend = new MemoryBackend();
    let online = true;
    let emit: (e: "online") => void = () => {};
    const make = () => {
      const ember = new EmberClient({
        url: "https://ember.test",
        WebSocket: server.WebSocket,
        fetch: server.fetch,
        connectivity: { isOnline: () => online, subscribe: (e) => ((emit = e), () => {}) },
        heartbeat: false,
        defaultShard: SHARD,
        backoff: { initialMs: 5, maxMs: 10 },
        storage: memoryStorage({ schema, backend }),
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      new EmberQueryClient(ember, { ssr: false }).connect(queryClient);
      return { ember, queryClient };
    };
    const a = make();
    render(<QueryClientProvider client={a.queryClient}><List channel="a" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("stored"));
    await a.ember.flushStorage();
    cleanup();
    a.ember.close();

    online = false;
    const b = make();
    render(<QueryClientProvider client={b.queryClient}><List channel="a" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("stored"));
    server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "fresh" });
    online = true;
    act(() => emit("online"));
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("stored,fresh"));
    b.ember.close();
  });
});

describe("functions routed by their own shard spec", () => {
  const routed = <F,>(name: string, spec: { kind: string; fromArg?: string; fromClaim?: string }): F => {
    const ref = makeFunctionReference(name) as unknown as Record<symbol, unknown>;
    ref[FUNCTION_SHARD] = spec;
    return ref as unknown as F;
  };
  const byArg = routed<FunctionReference<"query", "public", { orgId: string }, string>>("notes:byArg", { kind: "org", fromArg: "orgId" });
  const byClaim = routed<FunctionReference<"query", "public", Record<string, never>, string>>("notes:byClaim", { kind: "org", fromClaim: "org" });
  const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

  function routedSetup(ssr = false) {
    const server = new FakeEmberServer({
      verify: (token) => {
        const p = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { sub: string; org?: string };
        return { subject: p.sub, claims: { org: p.org } };
      },
      queries: {
        "notes:byArg": (_db, _args, ctx) => `from ${ctx.shard}`,
        "notes:byClaim": (_db, _args, ctx) => `from ${ctx.shard} as ${ctx.identity?.subject}`,
      },
    });
    // No defaultShard: without the spec, a call without `{ shard }` has nowhere to go.
    const ember = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, heartbeat: false, auth: () => jwt({ sub: "ana", org: "beta" }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    new EmberQueryClient(ember, { ssr }).connect(queryClient);
    const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
    return { server, ember, queryClient, wrap };
  }
  function ByArg() {
    const { data, status, error } = useQuery(emberQuery(byArg, { orgId: "acme" }));
    return <div data-testid="arg">{status === "success" ? data : status === "error" ? `error:${error.code}` : status}</div>;
  }
  function ByClaim() {
    const { data, status, error } = useQuery(emberQuery(byClaim, {}));
    return <div data-testid="claim">{status === "success" ? data : status === "error" ? `error:${error.code}` : status}</div>;
  }

  it("shard: { org: 'orgId' } (fromArg) and fromAuth subscribe on the shard the reference names", async () => {
    const { server, ember, wrap } = routedSetup();
    wrap(
      <>
        <ByArg />
        <ByClaim />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("arg").textContent).toBe("from org:acme"));
    await waitFor(() => expect(screen.getByTestId("claim").textContent).toBe("from org:beta as ana"));
    expect(server.subscriptionCount()).toBe(2);
    ember.close();
  });

  it("the same over HTTP (SSR prefetch and an ssr EmberQueryClient)", async () => {
    const { server, ember, queryClient } = routedSetup(true);
    await prefetchEmberQuery(queryClient, ember, byArg, { orgId: "acme" });
    expect(queryClient.getQueryData(emberQuery(byArg, { orgId: "acme" }).queryKey)).toBe("from org:acme");
    expect(await queryClient.fetchQuery(emberQuery(byClaim, {}))).toBe("from org:beta as ana");
    expect(server.httpRequests.map((r) => (r.body as { shard: string }).shard)).toEqual(["org:acme", "org:beta"]);
    ember.close();
  });
  it("each query keeps the reference it was built with: a later emberQuery of the same name does not reroute it", async () => {
    const { server, ember, queryClient } = routedSetup(true);
    const first = emberQuery(byArg, { orgId: "acme" });
    expect(await queryClient.fetchQuery(first)).toBe("from org:acme");
    // The same name through a plain reference with an explicit shard (as a hand-written key would).
    expect(await queryClient.fetchQuery(emberQuery(unsafeRef<"query">("notes:byArg"), { orgId: "x" }, { shard: "org:explicit" }))).toBe("from org:explicit");
    // The first query routes as before (its reference: fromArg), not through the plain one (nowhere to go).
    await queryClient.refetchQueries({ queryKey: first.queryKey, exact: true });
    expect(queryClient.getQueryState(first.queryKey)?.status).toBe("success");
    expect(server.httpRequests.map((r) => (r.body as { shard: string }).shard)).toEqual(["org:acme", "org:explicit", "org:acme"]);

    // A key restored from a persisted cache (serialized: a new array no emberQuery built, and in SSR not live either):
    // the cached query's observer, through its own key, routes it.
    const restored = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    hydrate(restored, JSON.parse(JSON.stringify(dehydrate(queryClient))));
    const e2 = new EmberQueryClient(ember, { ssr: true }).connect(restored);
    const obs = new QueryObserver(restored, emberQuery(byArg, { orgId: "acme" }));
    const off = obs.subscribe(() => {});
    // The plain reference is now the one by name: only the observer's key can route the restored one.
    emberQuery(unsafeRef<"query">("notes:byArg"), { orgId: "x" });
    await restored.refetchQueries({ queryKey: first.queryKey, exact: true });
    expect(restored.getQueryState(first.queryKey)?.status).toBe("success");
    expect((server.httpRequests.at(-1)!.body as { shard: string }).shard).toBe("org:acme");
    off();
    e2.disconnect();
    ember.close();
  });
});

describe("identity change (CWE-524): observed queries keep nothing of the previous identity", () => {
  const secret = unsafeRef<"query">("me:secret");
  const jwt = (sub: string) => `x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;
  function identitySetup() {
    const server = new FakeEmberServer({
      verify: (token) => ({ subject: (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { sub: string }).sub }),
      queries: {
        "me:secret": (_db, _args, ctx) => {
          if (!ctx.identity) throw new FakeFunctionError("Unauthenticated", "sign in");
          return `secret of ${ctx.identity.subject}`;
        },
      },
    });
    let failHttp = false;
    const fetch: typeof globalThis.fetch = (input, init) => (failHttp ? Promise.reject(new TypeError("offline")) : server.fetch(input, init));
    const ember = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch, connectivity: null, heartbeat: false, defaultShard: SHARD, auth: () => jwt("ana") });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    new EmberQueryClient(ember).connect(queryClient);
    const shown: string[] = [];
    function Secret() {
      const { data, status, error } = useQuery(emberQuery(secret, {}));
      const text = status === "success" ? String(data) : status === "error" ? `error:${(error as { code?: string }).code}${data ? `+${String(data)}` : ""}` : status;
      shown.push(text);
      return <div data-testid="secret">{text}</div>;
    }
    const wrap = () => render(<QueryClientProvider client={queryClient}>{<Secret />}</QueryClientProvider>);
    const key = emberQuery(secret, {}).queryKey;
    return { server, ember, queryClient, wrap, shown, key, offline: () => (failHttp = true) };
  }

  it("sign-out whose anonymous refresh fails: the previous identity's value is gone, not kept next to the error", async () => {
    const { ember, queryClient, wrap, shown, key } = identitySetup();
    wrap();
    await waitFor(() => expect(screen.getByTestId("secret").textContent).toBe("secret of ana"));
    shown.length = 0;
    act(() => ember.clearAuth());
    expect(queryClient.getQueryData(key)).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId("secret").textContent).toBe("error:Unauthenticated"));
    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(shown.filter((t) => t.includes("ana"))).toEqual([]);
    // A refetch does not bring the previous identity's snapshot back either.
    await act(async () => void (await queryClient.refetchQueries({ queryKey: key }).catch(() => undefined)));
    expect(queryClient.getQueryData(key)).toBeUndefined();
    ember.close();
  });

  it("an account switch with no refresh arriving (offline): nothing of the previous identity, then the new one's value", async () => {
    const { server, ember, queryClient, wrap, shown, key, offline } = identitySetup();
    wrap();
    await waitFor(() => expect(screen.getByTestId("secret").textContent).toBe("secret of ana"));
    shown.length = 0;
    // The socket's answers wait, and HTTP fails: no value for Bob arrives.
    for (const s of server.sockets) s.hold();
    offline();
    await act(async () => ember.setAuth(() => jwt("bob")));
    await act(async () => void (await queryClient.refetchQueries({ queryKey: key }).catch(() => undefined)));
    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(shown.filter((t) => t.includes("ana"))).toEqual([]);
    // Bob's snapshot reaches the cache through the subscription that stayed.
    for (const s of server.sockets) s.release();
    await waitFor(() => expect(screen.getByTestId("secret").textContent).toBe("secret of bob"));
    expect(shown.filter((t) => t.includes("ana"))).toEqual([]);
    ember.close();
  });

  it("a new source for the same user (no new snapshot: the shard sees a renewal): the value comes back over HTTP", async () => {
    const { server, ember, queryClient, wrap, key } = identitySetup();
    wrap();
    await waitFor(() => expect(screen.getByTestId("secret").textContent).toBe("secret of ana"));
    const before = server.httpRequests.length;
    act(() => ember.setAuth(() => jwt("ana")));
    expect(queryClient.getQueryData(key)).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId("secret").textContent).toBe("secret of ana"));
    expect(server.httpRequests.slice(before).map((r) => r.authorization)).toContain(`Bearer ${jwt("ana")}`);
    ember.close();
  });
});
