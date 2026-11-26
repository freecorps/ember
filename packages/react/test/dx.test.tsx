// Selectors, useActionState, useMutationState with optimisticUpdate, EmberHydrate / usePreloadedQuery.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Suspense, useActionState as useReactActionState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { EmberClient, anyApi, encodeJson, type FunctionReference } from "@freecorps/ember-client";
import { FakeEmberServer, FakeFunctionError } from "@freecorps/ember-client/testing";
import {
  EmberHydrate,
  EmberProvider,
  preloadQuery,
  shallowEqual,
  useActionState,
  useConnectionState,
  useMutationState,
  usePreloadedQuery,
  useQuery,
  type Preloaded,
} from "../src/index.ts";

const SHARD = "org:acme";
type Todo = { _id: string; list: string; title: string; done: boolean };
const api = anyApi as unknown as {
  todos: {
    list: FunctionReference<"query", "public", { list: string }, Todo[]>;
    add: FunctionReference<"mutation", "public", { list: string; title: string }, string>;
    toggle: FunctionReference<"mutation", "public", { id: string; done: boolean }, null>;
  };
  ai: { summarize: FunctionReference<"action", "public", { text: string }, string> };
};

function setup() {
  const server = new FakeEmberServer({
    queries: { "todos:list": (db, { list }) => db.where<Todo>("todos", "list", list) },
    mutations: {
      "todos:add": (db, { list, title }) => {
        if (title === "fail") throw new FakeFunctionError("invalid", "no");
        return db.insert("todos", { list, title, done: false });
      },
      "todos:toggle": (db, { id, done }) => (db.patch("todos", id, { done }), null),
    },
  });
  const actionCalls: unknown[] = [];
  const release: Array<() => void> = [];
  // `POST /api/action` (the fake server serves queries and mutations): held until `release` when the text says so.
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname !== "/api/action") return server.fetch(input, init);
    const body = JSON.parse(String(init?.body)) as { fn: string; args: { text: string }; shard: string };
    actionCalls.push(body);
    if (body.args.text === "hold") await new Promise<void>((r) => release.push(r));
    const json =
      body.args.text === "boom"
        ? { ok: false, error: { code: "TooLong", message: "too long", data: { max: 3 }, kind: "app" } }
        : { ok: true, value: body.args.text.toUpperCase() };
    return new Response(JSON.stringify(json), { status: json.ok ? 200 : 400, headers: { "content-type": "application/json" } });
  };
  const client = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch, connectivity: null, heartbeat: false, defaultShard: SHARD, backoff: { initialMs: 5, maxMs: 10 } });
  const wrap = (ui: ReactNode) => render(<EmberProvider client={client}>{ui}</EmberProvider>);
  return { server, client, wrap, actionCalls, release };
}

afterEach(() => cleanup());

/** Adds a todo on the server directly; its id. */
const add = (server: FakeEmberServer, list: string, title: string) => (server.mutateDirect(SHARD, "todos:add", { list, title }) as { value: string }).value;

describe("useQuery({ select })", () => {
  it("re-renders only when the selection changes", async () => {
    const { server, client, wrap } = setup();
    const ids = [add(server, "l", "a"), add(server, "l", "b")];
    let renders = 0;
    let full = 0;
    function Done() {
      renders++;
      // Inline selector: a new function each render.
      const n = useQuery(api.todos.list, { list: "l" }, { select: (t) => t.filter((x) => x.done).length });
      return <div data-testid="done">{n === undefined ? "loading" : String(n)}</div>;
    }
    function All() {
      full++;
      useQuery(api.todos.list, { list: "l" });
      return null;
    }
    wrap(
      <>
        <Done />
        <All />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("done").textContent).toBe("0"));
    const r0 = renders;
    const f0 = full;
    // A title edit / a new undone todo: the list changes, the count does not.
    await act(async () => void server.mutateDirect(SHARD, "todos:add", { list: "l", title: "c" }));
    await waitFor(() => expect(full).toBeGreaterThan(f0));
    expect(renders).toBe(r0);
    await act(async () => void server.mutateDirect(SHARD, "todos:toggle", { id: ids[0], done: true }));
    await waitFor(() => expect(screen.getByTestId("done").textContent).toBe("1"));
    expect(renders).toBe(r0 + 1);
    client.close();
  });

  it("an array selection compares shallowly: unchanged rows keep the rendered array", async () => {
    const { server, client, wrap } = setup();
    server.mutateDirect(SHARD, "todos:add", { list: "l", title: "a" });
    const seen: unknown[] = [];
    function Open() {
      const open = useQuery(api.todos.list, { list: "l" }, { select: (t) => t.filter((x) => !x.done) });
      if (open) seen.push(open);
      return <div data-testid="open">{open?.map((t) => t.title).join(",") ?? "loading"}</div>;
    }
    wrap(<Open />);
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("a"));
    const id = add(server, "l", "b");
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("a,b"));
    const before = seen.length;
    // Done: it leaves the selection; then another list's write: nothing.
    await act(async () => void server.mutateDirect(SHARD, "todos:toggle", { id, done: true }));
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("a"));
    expect(seen.length).toBe(before + 1);
    expect(shallowEqual([1, { a: 1 }], [1, { a: 1 }])).toBe(false);
    expect(shallowEqual({ a: 1, b: "x" }, { b: "x", a: 1 })).toBe(true);
    client.close();
  });
});

describe("useConnectionState(select)", () => {
  it("re-renders only when the selected part changes", async () => {
    const { server, client, wrap } = setup();
    let renders = 0;
    function Saving() {
      renders++;
      const saving = useConnectionState((s) => s.pendingMutations > 0);
      return <div data-testid="saving">{String(saving)}</div>;
    }
    function Status() {
      const s = useConnectionState();
      return <div data-testid="s">{s.shards[SHARD] ?? "none"}</div>;
    }
    wrap(
      <>
        <Saving />
        <Status />
        <Todos />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("open"));
    const r0 = renders;
    act(() => server.dropAll());
    await waitFor(() => expect(screen.getByTestId("s").textContent).not.toBe("open"));
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("open"));
    expect(renders).toBe(r0); // the socket went down and up: `saving` stayed false
    server.open()[0]!.holdIncoming();
    let p!: Promise<unknown>;
    act(() => {
      p = client.mutation(api.todos.add, { list: "z", title: "x" });
    });
    await waitFor(() => expect(screen.getByTestId("saving").textContent).toBe("true"));
    server.open()[0]!.releaseIncoming();
    await act(async () => void (await p));
    await waitFor(() => expect(screen.getByTestId("saving").textContent).toBe("false"));
    expect(renders).toBe(r0 + 2);
    client.close();
  });
});

function Todos({ list = "z" }: { list?: string }) {
  const t = useQuery(api.todos.list, { list });
  return <div data-testid="todos">{t === undefined ? "loading" : t.map((x) => x.title).join(",") || "empty"}</div>;
}

describe("useActionState", () => {
  it("pending, then data; a typed error; reset; a newer call wins", async () => {
    const { client, wrap, actionCalls, release } = setup();
    let st!: ReturnType<typeof useActionState<typeof api.ai.summarize>>;
    function App() {
      st = useActionState(api.ai.summarize);
      return <div data-testid="a">{st.isPending ? "pending" : st.error ? `error:${st.error.code}` : (st.data ?? "idle")}</div>;
    }
    wrap(<App />);
    expect(screen.getByTestId("a").textContent).toBe("idle");
    let p!: Promise<unknown>;
    act(() => void (p = st.run({ text: "hold" })));
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("pending"));
    await waitFor(() => expect(release.length).toBe(1));
    await act(async () => {
      release[0]!();
      await p;
    });
    expect(screen.getByTestId("a").textContent).toBe("HOLD");
    expect(st.result).toEqual({ ok: true, value: "HOLD" });
    await act(async () => void (await st.run({ text: "boom" })));
    expect(screen.getByTestId("a").textContent).toBe("error:TooLong");
    act(() => st.reset());
    expect(screen.getByTestId("a").textContent).toBe("idle");
    // An older call still running does not overwrite a newer one's result.
    let slow!: Promise<unknown>;
    act(() => void (slow = st.run({ text: "hold" })));
    await act(async () => void (await st.run({ text: "fast" })));
    await waitFor(() => expect(release.length).toBe(2));
    await act(async () => {
      release[1]!();
      await slow;
    });
    expect(screen.getByTestId("a").textContent).toBe("FAST");
    expect(actionCalls).toHaveLength(4);
    expect(actionCalls[0]).toMatchObject({ fn: "ai:summarize", shard: SHARD });
    client.close();
  });

  it("reducer plugs into React 19's useActionState", async () => {
    const { client, wrap } = setup();
    let dispatch!: (args: { text: string }) => void;
    function App() {
      const st = useActionState(api.ai.summarize);
      const [result, run, pending] = useReactActionState(st.reducer, null);
      dispatch = run;
      return <div data-testid="r">{pending ? "pending" : result ? (result.ok ? result.value : result.error.code) : "idle"}</div>;
    }
    wrap(<App />);
    await act(async () => dispatch({ text: "hi" }));
    await waitFor(() => expect(screen.getByTestId("r").textContent).toBe("HI"));
    client.close();
  });
});

describe("useMutationState({ optimisticUpdate })", () => {
  it("applies the (latest, inline) update on every call; mutate and the state object stay stable", async () => {
    const { server, client, wrap } = setup();
    const seen = new Set<unknown>();
    const states = new Set<unknown>();
    let st!: ReturnType<typeof useMutationState<typeof api.todos.add>>;
    function App() {
      st = useMutationState(api.todos.add, {
        optimisticUpdate: (store, args) => {
          const cur = store.getQuery(api.todos.list, { list: args.list });
          if (cur) store.setQuery(api.todos.list, { list: args.list }, [...cur, { _id: "tmp", list: args.list, title: `${args.title}*`, done: false }]);
        },
      });
      seen.add(st.mutate);
      states.add(st);
      return <Todos list="o" />;
    }
    const view = wrap(<App />);
    await waitFor(() => expect(screen.getByTestId("todos").textContent).toBe("empty"));
    const statesBefore = states.size;
    view.rerender(<EmberProvider client={client}><App /></EmberProvider>);
    expect(states.size).toBe(statesBefore); // same state: same object
    server.open()[0]!.holdIncoming();
    let p!: Promise<unknown>;
    act(() => void (p = st.mutate({ list: "o", title: "milk" })));
    expect(screen.getByTestId("todos").textContent).toBe("milk*");
    expect(st.isPending).toBe(true);
    server.open()[0]!.releaseIncoming();
    await act(async () => void (await p));
    await waitFor(() => expect(screen.getByTestId("todos").textContent).toBe("milk"));
    expect(st.data).toEqual(expect.any(String));
    await act(async () => void (await st.mutate({ list: "o", title: "fail" })));
    expect(st.error).toMatchObject({ code: "invalid" });
    expect(screen.getByTestId("todos").textContent).toBe("milk");
    expect(seen.size).toBe(1);
    client.close();
  });
});

describe("EmberHydrate / usePreloadedQuery", () => {
  it("EmberHydrate hands the server's values over before the children render (encoded or not)", async () => {
    const { server, client, wrap } = setup();
    server.mutateDirect(SHARD, "todos:add", { list: "h", title: "from server" });
    const ssr = new EmberClient({ url: "https://ember.test", WebSocket: null, fetch: server.fetch, connectivity: null, heartbeat: false, defaultShard: SHARD });
    client.hydrate(); // nothing
    const entry = await ssr.fetchForHydration(api.todos.list, { list: "h" });
    ssr.hydrate(entry);
    const state = encodeJson(ssr.dehydrate());
    const firsts: string[] = [];
    function First() {
      const t = useQuery(api.todos.list, { list: "h" });
      firsts.push(t === undefined ? "loading" : t.map((x) => x.title).join(","));
      return null;
    }
    wrap(
      <EmberHydrate state={state}>
        <First />
        <Todos list="h" />
      </EmberHydrate>,
    );
    expect(firsts[0]).toBe("from server"); // no loading render
    expect(screen.getByTestId("todos").textContent).toBe("from server");
    act(() => void server.mutateDirect(SHARD, "todos:add", { list: "h", title: "live" }));
    await waitFor(() => expect(screen.getByTestId("todos").textContent).toBe("from server,live"));
    ssr.close();
    client.close();
  });

  it("usePreloadedQuery shows the preloaded value at once, then live; its shard is the preload's", async () => {
    const { server, client, wrap } = setup();
    server.mutateDirect("org:other", "todos:add", { list: "p", title: "other org" });
    const ssr = new EmberClient({ url: "https://ember.test", WebSocket: null, fetch: server.fetch, connectivity: null, heartbeat: false, defaultShard: SHARD });
    const preloaded: Preloaded<typeof api.todos.list> = await preloadQuery(ssr, api.todos.list, { list: "p" }, { shard: "org:other" });
    const firsts: string[] = [];
    function View({ p }: { p: Preloaded<typeof api.todos.list> }) {
      const t = usePreloadedQuery(p);
      firsts.push(t.map((x) => x.title).join(","));
      return <div data-testid="p">{t.map((x) => x.title).join(",")}</div>;
    }
    wrap(
      <Suspense fallback={<div data-testid="p">fallback</div>}>
        <View p={JSON.parse(encodeJson(preloaded))} />
      </Suspense>,
    );
    expect(screen.getByTestId("p").textContent).toBe("other org");
    expect(firsts[0]).toBe("other org");
    act(() => void server.mutateDirect("org:other", "todos:add", { list: "p", title: "new" }));
    await waitFor(() => expect(screen.getByTestId("p").textContent).toBe("other org,new"));
    ssr.close();
    client.close();
  });

  it("a preload the app still holds is not shown after an account switch: a remount suspends until the live value", async () => {
    const { server } = setup();
    const jwt = (sub: string) => `x.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
    const client = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, heartbeat: false, defaultShard: SHARD, auth: () => jwt("ana") });
    // What the server rendered for Ana (serialized: no record of whose read it is in this client).
    const anas: Preloaded<typeof api.todos.list> = { fn: "todos:list", args: { list: "s" }, shard: SHARD, value: [{ _id: "x", list: "s", title: "ana's secret", done: false }], version: 1, epoch: "e", ik: "k" };
    const seen: string[] = [];
    function View({ p }: { p: Preloaded<typeof api.todos.list> }) {
      const t = usePreloadedQuery(p);
      seen.push(t.map((x) => x.title).join(","));
      return <div data-testid="s">{t.map((x) => x.title).join(",") || "empty"}</div>;
    }
    const ui = (
      <EmberProvider client={client}>
        <Suspense fallback={<div data-testid="s">fallback</div>}>
          <View p={anas} />
        </Suspense>
      </EmberProvider>
    );
    const first = render(ui);
    expect(screen.getByTestId("s").textContent).toBe("ana's secret");
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("empty")); // live, as Ana
    first.unmount();
    act(() => client.setAuth(() => jwt("bob")));
    seen.length = 0;
    render(ui); // the same preload object handed over again
    expect(screen.getByTestId("s").textContent).toBe("fallback");
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("empty"));
    expect(seen).not.toContain("ana's secret");
    client.close();
  });
});
