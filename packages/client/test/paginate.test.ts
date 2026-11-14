// Live pagination with fixed page boundaries (paginate.ts): pinning without a second download, one page per change,
// splits, merges, args, loadMore during updates, and the order/uniqueness of the rows in every case (with a fuzz).
import { describe, expect, it } from "vitest";
import { unsafeRef, type PaginatedQueryHandle, type PaginatedSnapshot } from "../src/index.ts";
import type { FakeDb, FakeSocket } from "../src/testing.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

type Item = { _id: string; n: number; list: string };
const END = "e";

/** `.paginate()` over items of a list in desc `n` order, with the runtime's cursor semantics (`endCursor` included). */
function paginate(db: FakeDb, { list, paginationOpts: o }: { list: string; paginationOpts: { numItems: number; cursor: string | null; endCursor?: string | null } }) {
  // Index key (n, _id), desc; a cursor is the key of a row.
  const cmp = (a: [number, string], b: [number, string]) => (a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const keyOf = (d: Item): [number, string] => [d.n, d._id];
  const decode = (c: string): [number, string] => {
    const [n, id] = c.slice(1).split("|");
    return [Number(n), id!];
  };
  const all = db.where<Item>("items", "list", list).sort((a, b) => cmp(keyOf(b), keyOf(a)));
  if (o.cursor === END) return { page: [], isDone: true, continueCursor: END };
  const rest = o.cursor ? all.filter((d) => cmp(keyOf(d), decode(o.cursor!)) < 0) : all;
  if (o.endCursor) {
    const page = o.endCursor === END ? rest : rest.filter((d) => cmp(keyOf(d), decode(o.endCursor!)) >= 0);
    return { page, isDone: o.endCursor === END, continueCursor: o.endCursor };
  }
  if (rest.length > o.numItems) {
    const last = rest[o.numItems - 1]!;
    return { page: rest.slice(0, o.numItems), isDone: false, continueCursor: `c${last.n}|${last._id}` };
  }
  return { page: rest, isDone: true, continueCursor: END };
}

function setup(opts: { ident?: boolean } = {}) {
  const server = messagesServer({
    ident: opts.ident ?? true,
    batch: true,
    queries: { "items:page": paginate as never },
    mutations: {
      "items:add": (db, { list, n }) => db.insert("items", { list, n }),
      "items:remove": (db, { id }) => db.delete("items", id),
    },
  });
  const client = makeClient(server);
  const ref = unsafeRef<"query">("items:page");
  const truth = new Map<string, Item>();
  const add = (n: number, list = "a") => {
    const id = server.mutateDirect(SHARD, "items:add", { list, n }) as unknown as { ok: boolean; value: string };
    truth.set(id.value, { _id: id.value, n, list });
    return id.value;
  };
  const remove = (id: string) => {
    server.mutateDirect(SHARD, "items:remove", { id });
    truth.delete(id);
  };
  const ordered = (list = "a") =>
    [...truth.values()]
      .filter((d) => d.list === list)
      .sort((a, b) => (a.n !== b.n ? b.n - a.n : a._id < b._id ? 1 : a._id > b._id ? -1 : 0))
      .map((d) => d.n);
  return { server, client, ref, add, remove, ordered, truth };
}

/** A paginated handle with one listener that records every snapshot it sees. */
function watch(h: PaginatedQueryHandle<Item>) {
  const seen: Array<PaginatedSnapshot<Item>> = [];
  const off = h.subscribe(() => seen.push(h.getSnapshot()));
  const ns = () => h.getSnapshot().results.map((d) => d.n);
  return { seen, off, ns, snap: () => h.getSnapshot() };
}

const frames = (ws: FakeSocket, t: string) => ws.sent.filter((m) => m !== "ping" && m.t === t).length;
const fullSnaps = (ws: FakeSocket) => ws.received.filter((m) => m !== "pong" && m.t === "snap" && !(m as { unchanged?: boolean }).unchanged).length;

/** Rows are the newest rows of the list, in order, without duplicates or gaps. */
function expectPrefix(ns: number[], truth: number[]) {
  expect(ns).toEqual(truth.slice(0, ns.length));
}

async function loadPages(h: PaginatedQueryHandle<Item>, w: ReturnType<typeof watch>, k: number, n: number) {
  for (let i = 1; i <= k; i++) {
    await until(() => w.snap().status === "CanLoadMore" && w.snap().results.length >= i * n);
    if (i < k) h.loadMore(n);
  }
  await tick(5);
}

describe("watchPaginatedQuery: fixed page boundaries", () => {
  it("pins each page after its first value without downloading it again", async () => {
    const { server, client, ref, add } = setup();
    for (let i = 0; i < 30; i++) add(i);
    const h = client.watchPaginatedQuery<Item>(ref, { list: "a" }, { initialNumItems: 5 });
    const w = watch(h);
    await loadPages(h, w, 3, 5);
    const ws = server.open(SHARD)[0]!;
    // 3 unpinned loads (full) + 3 pins answered `unchanged`.
    expect(fullSnaps(ws)).toBe(3);
    expect(ws.received.filter((m) => m !== "pong" && m.t === "snap" && (m as { unchanged?: boolean }).unchanged).length).toBe(3);
    expect(server.subscriptionCount(SHARD)).toBe(3);
    expect(w.ns()).toEqual(Array.from({ length: 15 }, (_, i) => 29 - i));
    w.off();
    client.close();
  });

  it("a new item on top changes the first page only: no subscription, no snapshot, the list never shrinks", async () => {
    const { server, client, ref, add, ordered } = setup();
    for (let i = 0; i < 40; i++) add(i);
    const h = client.watchPaginatedQuery<Item>(ref, { list: "a" }, { initialNumItems: 5 });
    const w = watch(h);
    await loadPages(h, w, 4, 5);
    const ws = server.open(SHARD)[0]!;
    const subs0 = frames(ws, "sub");
    const unsubs0 = frames(ws, "unsub");
    const snaps0 = fullSnaps(ws);
    w.seen.length = 0;
    for (let k = 0; k < 3; k++) add(100 + k);
    await until(() => w.ns()[0] === 102);
    await tick(5);
    expect(frames(ws, "sub") - subs0).toBe(0);
    expect(frames(ws, "unsub") - unsubs0).toBe(0);
    expect(fullSnaps(ws) - snaps0).toBe(0);
    expect(Math.min(...w.seen.map((s) => s.results.length))).toBeGreaterThanOrEqual(20);
    expect(w.ns().length).toBe(23);
    expectPrefix(w.ns(), ordered());
    w.off();
    client.close();
  });

  it("inserts and removals in the middle land in their page, in order", async () => {
    const { server, client, ref, add, remove, ordered, truth } = setup();
    for (let i = 0; i < 40; i++) add(i * 10);
    const h = client.watchPaginatedQuery<Item>(ref, { list: "a" }, { initialNumItems: 5 });
    const w = watch(h);
    await loadPages(h, w, 3, 5);
    const ws = server.open(SHARD)[0]!;
    const subs0 = frames(ws, "sub");
    add(325); // page 2 (330..290)
    await until(() => w.ns().includes(325));
    const victim = [...truth.values()].find((d) => d.n === 360)!;
    remove(victim._id); // page 1
    await until(() => !w.ns().includes(360));
    await tick(5);
    expect(frames(ws, "sub") - subs0).toBe(0);
    expect(w.ns().length).toBe(15);
    expectPrefix(w.ns(), ordered());
    w.off();
    client.close();
  });

  it("splits a page past twice its size, keeping it shown until both halves arrive", async () => {
    const { server, client, ref, add, ordered } = setup();
    for (let i = 0; i < 20; i++) add(i);
    const h = client.watchPaginatedQuery<Item>(ref, { list: "a" }, { initialNumItems: 4 });
    const w = watch(h);
    await loadPages(h, w, 2, 4);
    w.seen.length = 0;
    for (let k = 0; k < 6; k++) add(100 + k);
    await until(() => w.ns().length === 14);
    await tick(10);
    // The first page (4 + 6 = 10 rows > 8) became two pinned pages: 3 subscriptions in all.
    expect(server.subscriptionCount(SHARD)).toBe(3);
    expectPrefix(w.ns(), ordered());
    // Never shorter than before, never a duplicate.
    for (const s of w.seen) {
      expect(s.results.length).toBeGreaterThanOrEqual(8);
      expect(new Set(s.results.map((d) => d._id)).size).toBe(s.results.length);
    }
    // Later changes still land in one page each.
    const ws = server.open(SHARD)[0]!;
    const subs0 = frames(ws, "sub");
    add(200);
    await until(() => w.ns()[0] === 200);
    await tick(5);
    expect(frames(ws, "sub") - subs0).toBe(0);
    expectPrefix(w.ns(), ordered());
    w.off();
    client.close();
  });

  it("merges a page that became empty into its neighbour", async () => {
    const { server, client, ref, add, remove, ordered, truth } = setup();
    for (let i = 0; i < 16; i++) add(i);
    const h = client.watchPaginatedQuery<Item>(ref, { list: "a" }, { initialNumItems: 5 });
    const w = watch(h);
    await loadPages(h, w, 3, 5);
    expect(server.subscriptionCount(SHARD)).toBe(3);
    // Empty the middle page (10..6).
    for (const d of [...truth.values()].filter((d) => d.n >= 6 && d.n <= 10)) remove(d._id);
    await until(() => server.subscriptionCount(SHARD) === 2);
    await tick(5);
    expect(w.ns()).toEqual(ordered().slice(0, 10));
    // A new row in the merged range shows up.
    add(8);
    await until(() => w.ns().includes(8));
    expectPrefix(w.ns(), ordered());
    w.off();
    client.close();
  });

  it("loadMore while the list is changing", async () => {
    const { client, ref, add, ordered } = setup();
    for (let i = 0; i < 30; i++) add(i);
    const h = client.watchPaginatedQuery<Item>(ref, { list: "a" }, { initialNumItems: 5 });
    const w = watch(h);
    await loadPages(h, w, 1, 5);
    h.loadMore(5);
    add(100);
    add(2.5);
    h.loadMore(5); // ignored: the second page is still loading
    await until(() => w.snap().status === "CanLoadMore" && w.ns().length === 11);
    expectPrefix(w.ns(), ordered());
    h.loadMore(5);
    add(200);
    await until(() => w.snap().status === "CanLoadMore" && w.ns().length === 17);
    expectPrefix(w.ns(), ordered());
    w.off();
    client.close();
  });

  it("other args are another paginator; the last page reports Exhausted and grows at the end", async () => {
    const { client, ref, add, ordered } = setup();
    for (let i = 0; i < 6; i++) add(i, "a");
    for (let i = 0; i < 3; i++) add(i, "b");
    const ha = client.watchPaginatedQuery<Item>(ref, { list: "a" }, { initialNumItems: 4 });
    const hb = client.watchPaginatedQuery<Item>(ref, { list: "b" }, { initialNumItems: 4 });
    const wa = watch(ha);
    const wb = watch(hb);
    await until(() => wa.snap().status === "CanLoadMore" && wb.snap().status === "Exhausted");
    expect(wb.ns()).toEqual([2, 1, 0]);
    ha.loadMore(4);
    await until(() => wa.snap().status === "Exhausted");
    expect(wa.ns()).toEqual(ordered("a"));
    add(-1, "a");
    await until(() => wa.ns().includes(-1));
    expect(wa.snap().status).toBe("Exhausted");
    expect(wa.ns()).toEqual(ordered("a"));
    wa.off();
    wb.off();
    client.close();
  });

  it("without feature ident the pins still work (full snapshots instead of unchanged)", async () => {
    const { server, client, ref, add, ordered } = setup({ ident: false });
    for (let i = 0; i < 12; i++) add(i);
    const h = client.watchPaginatedQuery<Item>(ref, { list: "a" }, { initialNumItems: 4 });
    const w = watch(h);
    await loadPages(h, w, 2, 4);
    add(50);
    await until(() => w.ns()[0] === 50);
    expect(server.subscriptionCount(SHARD)).toBe(2);
    expectPrefix(w.ns(), ordered());
    w.off();
    client.close();
  });

  it("fuzz: random inserts, removals and loadMore keep the rows a gap-free, duplicate-free prefix", async () => {
    for (const seed of [1, 2, 3, 4]) {
      let x = seed * 7919;
      const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const { client, ref, add, remove, ordered, truth } = setup();
      for (let i = 0; i < 25; i++) add(Math.floor(rnd() * 1000));
      const h = client.watchPaginatedQuery<Item>(ref, { list: "a" }, { initialNumItems: 3 });
      const w = watch(h);
      await until(() => w.snap().status !== "LoadingFirstPage");
      for (let step = 0; step < 60; step++) {
        const r = rnd();
        if (r < 0.45) add(Math.floor(rnd() * 1200));
        else if (r < 0.75 && truth.size) {
          const ids = [...truth.keys()];
          remove(ids[Math.floor(rnd() * ids.length)]!);
        } else h.loadMore(1 + Math.floor(rnd() * 4));
        if (rnd() < 0.5) await tick();
        for (const s of w.seen) expect(new Set(s.results.map((d) => d._id)).size).toBe(s.results.length);
        w.seen.length = 0;
      }
      // Settled: what is shown is exactly the newest rows of the list, down to where the loaded pages end.
      await tick(20);
      await until(() => !w.snap().isLoading);
      await tick(20);
      expectPrefix(w.ns(), ordered());
      if (w.snap().status === "Exhausted") expect(w.ns()).toEqual(ordered());
      w.off();
      client.close();
    }
  });
});
