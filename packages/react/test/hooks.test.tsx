import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Component, StrictMode, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { EmberClient, anyApi, unsafeRef, type FunctionReference } from "@freecorps/ember-client";
import { FakeEmberServer, FakeFunctionError } from "@freecorps/ember-client/testing";
import { MemoryBackend, memoryStorage } from "@freecorps/ember-offline";
import { defineSchema, defineTable, v } from "@freecorps/ember-server";
import { EmberProvider, useConnectionState, useMutation, usePaginatedQuery, useQuery, useQuerySnapshot, type PaginationResult } from "../src/index.ts";

const SHARD = "org:acme";

const api = anyApi as unknown as {
  messages: {
    list: FunctionReference<"query", "public", { channel: string }, string[]>;
    paged: FunctionReference<"query", "public", { channel: string; paginationOpts: { numItems: number; cursor: string | null } }, PaginationResult<string>>;
    feed: FunctionReference<"query", "public", { channel: string; paginationOpts: { numItems: number; cursor: string | null; endCursor?: string | null } }, PaginationResult<{ _id: string; n: number }>>;
    send: FunctionReference<"mutation", "public", { channel: string; body: string }, string>;
  };
};

function setup() {
  const server = new FakeEmberServer({
    queries: {
      "messages:list": (db, { channel }) => db.where<{ body: string }>("messages", "channel", channel).map((m) => m.body),
      "messages:paged": (db, { channel, paginationOpts }) => {
        const all = db.where<{ body: string }>("messages", "channel", channel).map((m) => m.body);
        const start = paginationOpts.cursor ? Number(paginationOpts.cursor) : 0;
        const end = start + paginationOpts.numItems;
        return { page: all.slice(start, end), isDone: end >= all.length, continueCursor: end >= all.length ? null : String(end) };
      },
      // Cursor pagination as `.paginate()` does it (cursor = the key of a row, `endCursor` pins a page), newest first.
      "messages:feed": (db, { channel, paginationOpts: o }) => {
        const all = db.where<{ _id: string; n: number }>("messages", "channel", channel).sort((a, b) => b.n - a.n);
        const rest = o.cursor === "e" ? [] : o.cursor ? all.filter((d) => d.n < Number(o.cursor)) : all;
        if (o.endCursor) return { page: o.endCursor === "e" ? rest : rest.filter((d) => d.n >= Number(o.endCursor)), isDone: o.endCursor === "e", continueCursor: o.endCursor };
        if (rest.length > o.numItems) return { page: rest.slice(0, o.numItems), isDone: false, continueCursor: String(rest[o.numItems - 1]!.n) };
        return { page: rest, isDone: true, continueCursor: "e" };
      },
      "boom:q": () => {
        throw new FakeFunctionError("nope", "exploded");
      },
    },
    mutations: {
      "messages:post": (db, { channel, n }) => db.insert("messages", { channel, n }),
      "messages:send": (db, { channel, body }) => {
        if (body === "fail") throw new FakeFunctionError("invalid", "no");
        return db.insert("messages", { channel, body });
      },
    },
  });
  const client = new EmberClient({
    url: "https://ember.test",
    WebSocket: server.WebSocket,
    fetch: server.fetch,
    connectivity: null,
    heartbeat: false,
    defaultShard: SHARD,
    backoff: { initialMs: 5, maxMs: 10 },
  });
  const wrap = (ui: ReactNode) => render(<EmberProvider client={client}>{ui}</EmberProvider>);
  return { server, client, wrap };
}

afterEach(() => cleanup());

function List({ channel }: { channel: string }) {
  const msgs = useQuery(api.messages.list, { channel });
  return <div data-testid="list">{msgs === undefined ? "loading" : msgs.join(",") || "empty"}</div>;
}

describe("useQuery", () => {
  it("renders loading, then the value, then live updates", async () => {
    const { server, client, wrap } = setup();
    wrap(<List channel="a" />);
    expect(screen.getByTestId("list").textContent).toBe("loading");
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    act(() => void server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "hi" }));
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("hi"));
    client.close();
  });

  it("dedups the subscription across components and survives StrictMode", async () => {
    const { server, client, wrap } = setup();
    wrap(
      <StrictMode>
        <List channel="d" />
        <List channel="d" />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getAllByTestId("list").map((e) => e.textContent)).toEqual(["empty", "empty"]));
    expect(server.subscriptionCount()).toBe(1);
    const subs = server.open()[0]!.sent.filter((m) => m !== "ping" && m.t === "sub");
    expect(subs.length).toBe(1);
    client.close();
  });

  it("'skip' subscribes to nothing; changing args switches subscription", async () => {
    const { server, client, wrap } = setup();
    function Maybe() {
      const [ch, setCh] = useState<string | null>(null);
      const v = useQuery(api.messages.list, ch === null ? "skip" : { channel: ch });
      return (
        <button data-testid="b" onClick={() => setCh(ch === null ? "x" : "y")}>
          {v === undefined ? "none" : `${ch}:${v.length}`}
        </button>
      );
    }
    wrap(<Maybe />);
    await new Promise((r) => setTimeout(r, 10));
    expect(server.history.length).toBe(0);
    act(() => screen.getByTestId("b").click());
    await waitFor(() => expect(screen.getByTestId("b").textContent).toBe("x:0"));
    act(() => screen.getByTestId("b").click());
    await waitFor(() => expect(screen.getByTestId("b").textContent).toBe("y:0"));
    await waitFor(() => expect(server.subscriptionCount()).toBe(1));
    client.close();
  });

  it("throws query errors to the error boundary", async () => {
    const { client, wrap } = setup();
    class Boundary extends Component<{ children: ReactNode }, { e: Error | null }> {
      override state = { e: null as Error | null };
      static getDerivedStateFromError(e: Error) {
        return { e };
      }
      override render() {
        return this.state.e ? <div data-testid="err">{(this.state.e as { code?: string }).code}</div> : this.props.children;
      }
    }
    function Boom() {
      useQuery(unsafeRef<"query">("boom:q"), {});
      return null;
    }
    const orig = console.error;
    console.error = () => {};
    try {
      wrap(
        <Boundary>
          <Boom />
        </Boundary>,
      );
      await waitFor(() => expect(screen.getByTestId("err").textContent).toBe("nope"));
    } finally {
      console.error = orig;
    }
    client.close();
  });
});

describe("useMutation", () => {
  it("withOptimisticUpdate shows the change at once, then the confirmed value; rejection rolls back", async () => {
    const { server, client, wrap } = setup();
    let send!: ReturnType<typeof useMutation<typeof api.messages.send>>;
    function App() {
      send = useMutation(api.messages.send).withOptimisticUpdate((store, args) => {
        const cur = store.getQuery(api.messages.list, { channel: args.channel });
        if (cur) store.setQuery(api.messages.list, { channel: args.channel }, [...cur, `${args.body}*`]);
      });
      return <List channel="m" />;
    }
    wrap(<App />);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("empty"));
    server.open()[0]!.holdIncoming();
    let p!: Promise<string>;
    act(() => {
      p = send({ channel: "m", body: "yo" });
    });
    expect(screen.getByTestId("list").textContent).toBe("yo*");
    server.open()[0]!.releaseIncoming();
    await act(async () => void (await p));
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("yo"));

    let failed: unknown;
    await act(async () => {
      failed = await send({ channel: "m", body: "fail" }).catch((e) => e);
    });
    expect(failed).toMatchObject({ code: "invalid" });
    expect(screen.getByTestId("list").textContent).toBe("yo");
    client.close();
  });
});

describe("useConnectionState", () => {
  it("tracks the shard socket and pending mutations", async () => {
    const { server, client, wrap } = setup();
    function Status() {
      const s = useConnectionState();
      return <div data-testid="s">{`${s.shards[SHARD] ?? "none"}/${s.pendingMutations}`}</div>;
    }
    wrap(
      <>
        <Status />
        <List channel="c" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("open/0"));
    act(() => server.dropAll());
    await waitFor(() => expect(screen.getByTestId("s").textContent).not.toBe("open/0"));
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("open/0"));
    client.close();
  });
});

describe("usePaginatedQuery", () => {
  it("loads pages by cursor and reports status", async () => {
    const { server, client, wrap } = setup();
    for (let i = 1; i <= 5; i++) server.mutateDirect(SHARD, "messages:send", { channel: "p", body: `m${i}` });
    let more!: (n: number) => void;
    function Paged() {
      const { results, status, loadMore } = usePaginatedQuery(api.messages.paged, { channel: "p" }, { initialNumItems: 2 });
      more = loadMore;
      return <div data-testid="p">{`${status}:${results.join(",")}`}</div>;
    }
    wrap(<Paged />);
    await waitFor(() => expect(screen.getByTestId("p").textContent).toBe("CanLoadMore:m1,m2"));
    act(() => more(2));
    await waitFor(() => expect(screen.getByTestId("p").textContent).toBe("CanLoadMore:m1,m2,m3,m4"));
    act(() => more(5));
    await waitFor(() => expect(screen.getByTestId("p").textContent).toBe("Exhausted:m1,m2,m3,m4,m5"));
    act(() => void server.mutateDirect(SHARD, "messages:send", { channel: "p", body: "m6" }));
    await waitFor(() => expect(screen.getByTestId("p").textContent).toBe("Exhausted:m1,m2,m3,m4,m5,m6"));
    client.close();
  });
});

describe("usePaginatedQuery with fixed page boundaries", () => {
  it("a new row on top: no new subscription, rows keep their identity, the list never shrinks; new args start over", async () => {
    const { server, client, wrap } = setup();
    for (let i = 0; i < 12; i++) server.mutateDirect(SHARD, "messages:post", { channel: "f", n: i });
    for (let i = 0; i < 3; i++) server.mutateDirect(SHARD, "messages:post", { channel: "g", n: i });
    let more!: (n: number) => void;
    const renders: Array<Array<{ _id: string; n: number }>> = [];
    function Feed({ channel }: { channel: string }) {
      const { results, status, loadMore } = usePaginatedQuery(api.messages.feed, { channel }, { initialNumItems: 4 });
      more = loadMore;
      renders.push(results);
      return <div data-testid="f">{`${status}:${results.map((r) => r.n).join(",")}`}</div>;
    }
    const view = wrap(<Feed channel="f" />);
    await waitFor(() => expect(screen.getByTestId("f").textContent).toBe("CanLoadMore:11,10,9,8"));
    act(() => more(4));
    await waitFor(() => expect(screen.getByTestId("f").textContent).toBe("CanLoadMore:11,10,9,8,7,6,5,4"));
    const ws = server.open(SHARD)[0]!;
    const subs = ws.sent.filter((m) => m !== "ping" && m.t === "sub").length;
    const before = renders.at(-1)!;
    renders.length = 0;
    act(() => void server.mutateDirect(SHARD, "messages:post", { channel: "f", n: 100 }));
    await waitFor(() => expect(screen.getByTestId("f").textContent).toBe("CanLoadMore:100,11,10,9,8,7,6,5,4"));
    expect(ws.sent.filter((m) => m !== "ping" && m.t === "sub").length).toBe(subs);
    expect(Math.min(...renders.map((r) => r.length))).toBeGreaterThanOrEqual(8);
    // Rows of the second page are the same objects as before (its subscription did not change).
    const after = renders.at(-1)!;
    expect(after.slice(5)).toEqual(before.slice(4));
    for (let i = 4; i < 8; i++) expect(after[i + 1]).toBe(before[i]);
    view.rerender(
      <EmberProvider client={client}>
        <Feed channel="g" />
      </EmberProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("f").textContent).toBe("Exhausted:2,1,0"));
    client.close();
  });
});

// ------------------------------------------------------------------------------------------------ offline storage


const offlineSchema = defineSchema({ tables: { messages: defineTable({ channel: v.string(), body: v.string() }) } });

function Snap({ channel }: { channel: string }) {
  const s = useQuerySnapshot(api.messages.list, { channel });
  return <div data-testid="snap">{s.status === "success" ? `${s.value!.join(",") || "empty"}|${s.source ?? "server"}` : s.status}</div>;
}

describe("offline storage", () => {
  it("renders the stored value on a cold start without network, then the server's", async () => {
    const { server } = setup();
    server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "hi" });
    const backend = new MemoryBackend();
    let online = true;
    let emit: (e: "online" | "offline") => void = () => {};
    const make = () =>
      new EmberClient({
        url: "https://ember.test",
        WebSocket: server.WebSocket,
        fetch: server.fetch,
        connectivity: { isOnline: () => online, subscribe: (e) => ((emit = e), () => {}) },
        heartbeat: false,
        defaultShard: SHARD,
        backoff: { initialMs: 5, maxMs: 10 },
        storage: memoryStorage({ schema: offlineSchema, backend }),
      });
    const c1 = make();
    render(<EmberProvider client={c1}><Snap channel="a" /></EmberProvider>);
    await waitFor(() => expect(screen.getByTestId("snap").textContent).toBe("hi|server"));
    await c1.flushStorage();
    cleanup();
    c1.close();

    online = false;
    const c2 = make();
    render(<EmberProvider client={c2}><Snap channel="a" /></EmberProvider>);
    await waitFor(() => expect(screen.getByTestId("snap").textContent).toBe("hi|cache"));
    server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "more" });
    online = true;
    act(() => emit("online"));
    await waitFor(() => expect(screen.getByTestId("snap").textContent).toBe("hi,more|server"));
    c2.close();
  });
});
