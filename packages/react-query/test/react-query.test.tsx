import { QueryClient, QueryClientProvider, dehydrate, hydrate, useMutation, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmberClient, anyApi, unsafeRef, type FunctionReference } from "@freecorps/ember-client";
import { FakeEmberServer, FakeFunctionError } from "@freecorps/ember-client/testing";
import { MemoryBackend, memoryStorage } from "@freecorps/ember-offline";
import { defineSchema, defineTable, v } from "@freecorps/ember-server";
import { EmberQueryClient, emberMutation, emberMutationFn, emberQuery, prefetchEmberQuery } from "../src/index.ts";

const SHARD = "org:acme";
const api = anyApi as unknown as {
  messages: {
    list: FunctionReference<"query", "public", { channel: string }, string[]>;
    send: FunctionReference<"mutation", "public", { channel: string; body: string }, string>;
  };
};

function setup(gcTime = 5 * 60_000, opts: { ident?: boolean } = {}) {
  const server = new FakeEmberServer({
    ...opts,
    queries: {
      "messages:list": (db, { channel }) => db.where<{ body: string }>("messages", "channel", channel).map((m) => m.body),
      "messages:docs": (db, { channel }) => db.where("messages", "channel", channel),
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
  const eqc = new EmberQueryClient(ember).connect(queryClient);
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
    expect(emberQuery(api.messages.list, { channel: "a" }).queryKey[1]).toBeNull();
    expect(o.queryKeyHashFn!(["ember", "s", "f", { b: 1, a: 2n }] as never)).toBe(o.queryKeyHashFn!(["ember", "s", "f", { a: 2n, b: 1 }] as never));
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
