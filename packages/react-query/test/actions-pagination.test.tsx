// emberAction (useMutation over an action) and emberPaginatedQuery (useInfiniteQuery over Ember's cursors), with the
// shard routing of the reference (fromArg / fromAuth) preserved.
import { QueryClient, QueryClientProvider, useInfiniteQuery, useMutation, type InfiniteData, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { EmberClient, FUNCTION_SHARD, anyApi, makeFunctionReference, type EmberErrorOf, type FunctionReference } from "@freecorps/ember-client";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { EmberQueryClient, emberAction, emberPaginatedQuery, emberQueryKeyHashFn } from "../src/index.ts";

type Note = { _id: string; n: number };
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type TooLong = { readonly code: "TooLong"; readonly data: { max: number } };
const api = anyApi as unknown as {
  notes: { feed: FunctionReference<"query", "public", { tag: string; paginationOpts: { numItems: number; cursor: string | null } }, Page<Note>> };
  ai: { shout: FunctionReference<"action", "public", { text: string }, string, TooLong> };
};
const routed = <F,>(name: string, spec: { kind: string; fromArg?: string; fromClaim?: string }): F => {
  const ref = makeFunctionReference(name) as unknown as Record<symbol, unknown>;
  ref[FUNCTION_SHARD] = spec;
  return ref as unknown as F;
};
const feedByOrg = routed<FunctionReference<"query", "public", { orgId: string; paginationOpts: { numItems: number; cursor: string | null } }, Page<Note>>>("notes:feedByOrg", { kind: "org", fromArg: "orgId" });
const feedByClaim = routed<FunctionReference<"query", "public", { paginationOpts: { numItems: number; cursor: string | null } }, Page<Note>>>("notes:feedByClaim", { kind: "org", fromClaim: "org" });
const shoutByOrg = routed<FunctionReference<"action", "public", { orgId: string; text: string }, string>>("ai:shoutByOrg", { kind: "org", fromArg: "orgId" });
const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

function setup(opts: { defaultShard?: string } = {}) {
  // Newest first, `cursor` = the last `n` of the previous page.
  const feed = (db: { where<T>(t: string, f: string, v: unknown): T[] }, tag: string, o: { numItems: number; cursor: string | null }) => {
    const all = db.where<Note>("notes", "tag", tag).sort((a, b) => b.n - a.n);
    const rest = o.cursor ? all.filter((d) => d.n < Number(o.cursor)) : all;
    const page = rest.slice(0, o.numItems);
    return { page, isDone: rest.length <= o.numItems, continueCursor: page.length ? String(page.at(-1)!.n) : (o.cursor ?? "") };
  };
  const server = new FakeEmberServer({
    verify: (token) => {
      const p = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { sub: string; org?: string };
      return { subject: p.sub, claims: { org: p.org } };
    },
    queries: {
      "notes:feed": (db, { tag, paginationOpts }) => feed(db, tag, paginationOpts),
      "notes:feedByOrg": (db, { paginationOpts }, ctx) => feed(db, ctx.shard, paginationOpts),
      "notes:feedByClaim": (db, { paginationOpts }, ctx) => feed(db, ctx.shard, paginationOpts),
    },
    mutations: { "notes:add": (db, { tag, n }) => db.insert("notes", { tag, n }) },
  });
  const actions: Array<{ fn: string; args: Record<string, unknown>; shard: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname !== "/api/action") return server.fetch(input, init);
    const body = JSON.parse(String(init?.body)) as { fn: string; args: Record<string, unknown>; shard: string };
    actions.push(body);
    const text = String(body.args.text);
    const json = text.length > 5 ? { ok: false, error: { code: "TooLong", message: "too long", data: { max: 5 }, kind: "app" } } : { ok: true, value: `${text.toUpperCase()}@${body.shard}` };
    return new Response(JSON.stringify(json), { status: json.ok ? 200 : 400, headers: { "content-type": "application/json" } });
  };
  const ember = new EmberClient({
    url: "https://ember.test",
    WebSocket: server.WebSocket,
    fetch,
    connectivity: null,
    heartbeat: false,
    ...(opts.defaultShard ? { defaultShard: opts.defaultShard } : { auth: () => jwt({ sub: "ana", org: "beta" }) }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  new EmberQueryClient(ember).connect(queryClient);
  const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { server, ember, queryClient, wrap, actions };
}

afterEach(() => cleanup());

describe("emberAction", () => {
  it("useMutation over an action: typed data and errors; the shard of { shard }, else the reference's routing", async () => {
    const { ember, wrap, actions } = setup({ defaultShard: "org:acme" });
    let m!: ReturnType<typeof useMutation<string, EmberErrorOf<typeof api.ai.shout>, { text: string }>>;
    function App() {
      m = useMutation(emberAction(api.ai.shout));
      expectTypeOf(m.data).toEqualTypeOf<string | undefined>();
      return <div data-testid="m">{m.isPending ? "pending" : m.isError ? `error:${m.error.code}` : (m.data ?? "idle")}</div>;
    }
    wrap(<App />);
    await act(async () => void (await m.mutateAsync({ text: "hi" })));
    await waitFor(() => expect(screen.getByTestId("m").textContent).toBe("HI@org:acme"));
    await act(async () => void (await m.mutateAsync({ text: "toolong" }).catch(() => {})));
    await waitFor(() => expect(screen.getByTestId("m").textContent).toBe("error:TooLong"));
    const o = emberAction(api.ai.shout, { shard: "org:x" });
    expect(o.mutationKey).toEqual(["ember:action", "org:x", "ai:shout"]);
    let routedM!: ReturnType<typeof useMutation<string, unknown, { orgId: string; text: string }>>;
    function Routed() {
      routedM = useMutation(emberAction(shoutByOrg));
      return null;
    }
    wrap(<Routed />);
    await act(async () => void (await routedM.mutateAsync({ orgId: "zeta", text: "yo" })));
    expect(actions.map((a) => a.shard)).toEqual(["org:acme", "org:acme", "org:zeta"]);
    ember.close();
  });
});

describe("emberPaginatedQuery", () => {
  it("useInfiniteQuery: first page, fetchNextPage by continueCursor, hasNextPage from isDone; refetch sees new rows", async () => {
    const { server, ember, queryClient, wrap } = setup({ defaultShard: "org:acme" });
    for (let n = 1; n <= 5; n++) server.mutateDirect("org:acme", "notes:add", { tag: "t", n });
    let q!: UseInfiniteQueryResult<InfiniteData<Page<Note>, string | null>, unknown>;
    function Feed() {
      q = useInfiniteQuery(emberPaginatedQuery(api.notes.feed, { tag: "t" }, { numItems: 2 }));
      const items = q.data?.pages.flatMap((p) => p.page.map((d) => d.n)) ?? [];
      return <div data-testid="f">{q.status === "success" ? `${items.join(",")}${q.hasNextPage ? "+" : ""}` : q.status}</div>;
    }
    wrap(<Feed />);
    await waitFor(() => expect(screen.getByTestId("f").textContent).toBe("5,4+"));
    await act(async () => void (await q.fetchNextPage()));
    await waitFor(() => expect(screen.getByTestId("f").textContent).toBe("5,4,3,2+"));
    await act(async () => void (await q.fetchNextPage()));
    await waitFor(() => expect(screen.getByTestId("f").textContent).toBe("5,4,3,2,1"));
    expect(q.data!.pageParams).toEqual([null, "4", "2"]);
    server.mutateDirect("org:acme", "notes:add", { tag: "t", n: 6 });
    await act(async () => void (await q.refetch()));
    // Every loaded page is read again from its cursor: the new row is on page 1.
    await waitFor(() => expect(screen.getByTestId("f").textContent).toBe("6,5,4,3,2,1"));
    const key = emberPaginatedQuery(api.notes.feed, { tag: "t" }, { numItems: 2 }).queryKey;
    expect(key).toEqual(["ember:paginated", null, "notes:feed", { tag: "t" }, 2]);
    expect(queryClient.getQueryData(key)).toBeDefined();
    expect(emberQueryKeyHashFn(["ember:paginated", null, "f", { b: 1n, a: 1 }, 2])).toBe(emberQueryKeyHashFn(["ember:paginated", null, "f", { a: 1, b: 1n }, 2]));
    ember.close();
  });

  it("keeps the reference's routing: fromArg and fromAuth pages come from the shard they name", async () => {
    const { server, ember, wrap } = setup();
    for (let n = 1; n <= 3; n++) server.mutateDirect("org:zeta", "notes:add", { tag: "org:zeta", n });
    for (let n = 1; n <= 3; n++) server.mutateDirect("org:beta", "notes:add", { tag: "org:beta", n: n * 10 });
    function Both() {
      const a = useInfiniteQuery(emberPaginatedQuery(feedByOrg, { orgId: "zeta" }, { numItems: 2 }));
      const b = useInfiniteQuery(emberPaginatedQuery(feedByClaim, {}, { numItems: 2 }));
      const show = (x: typeof a) => (x.status === "success" ? x.data.pages.flatMap((p) => p.page.map((d) => d.n)).join(",") : x.status);
      return <div data-testid="b">{`${show(a)}|${show(b)}`}</div>;
    }
    wrap(<Both />);
    await waitFor(() => expect(screen.getByTestId("b").textContent).toBe("3,2|30,20"));
    ember.close();
  });

  it("'skip' disables it", async () => {
    const { ember, wrap } = setup({ defaultShard: "org:acme" });
    function Skipped() {
      const q = useInfiniteQuery(emberPaginatedQuery(api.notes.feed, "skip", { numItems: 2 }));
      return <div data-testid="s">{q.fetchStatus}</div>;
    }
    wrap(<Skipped />);
    expect(screen.getByTestId("s").textContent).toBe("idle");
    ember.close();
  });
});
