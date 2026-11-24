// Optimistic updates from the mutations themselves (Brigade RFC 0016 gap G5), through EmberClient with the real
// engine behind a fake socket server: no hand-written update per query.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmberClient, type QuerySnapshot, unsafeRef, makeFunctionReference } from "@freecorps/ember-client";
import { localOptimisticUpdates } from "../src/index.ts";
import { mutation, v } from "@freecorps/ember-server";
import { engineServer, messages, schema } from "./app.ts";

const SHARD = "org:acme";
type Msg = { _id: string; body: string; channel: string };

const until = (cond: () => unknown, timeout = 3000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout, interval: 2 },
  );

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** Changes a document it read in place, then throws: only a copy may be touched. */
const scribble = mutation({
  args: { id: v.id("messages") },
  handler: (ctx: any, { id }: { id: any }) => {
    const doc = ctx.db.get(id);
    doc.body = "scribbled";
    throw new Error("changed my mind");
  },
});

function setup() {
  const srv = engineServer();
  srv.m("messages:send", { channel: "a", body: "first" });
  srv.m("messages:send", { channel: "a", body: "second" });
  srv.m("messages:send", { channel: "b", body: "elsewhere" });
  const errors: string[] = [];
  const c = new EmberClient({
    url: "https://ember.test",
    WebSocket: srv.fake.WebSocket,
    fetch: srv.fake.fetch,
    defaultShard: SHARD,
    heartbeat: false,
    optimisticUpdates: localOptimisticUpdates({
      schema,
      mutations: { messages: { send: messages.send, edit: messages.edit, remove: messages.remove, scribble } },
      // `count` is a derived number: the replica cannot reproduce it, so it keeps its confirmed value.
      queries: { messages: { list: messages.list, latest: messages.latest, count: messages.count } },
      onError: (fn, e) => errors.push(`${fn}: ${e.message}`),
    }),
  });
  cleanups.push(() => c.close());
  const watch = <T>(fn: string, args: Record<string, unknown>) => {
    const seen: QuerySnapshot<T>[] = [];
    const off = c.subscribe(makeFunctionReference<"query", Record<string, unknown>, T>(fn), args, {}, (s: QuerySnapshot<T>) => seen.push(s));
    cleanups.push(off);
    return { last: () => seen.at(-1)! };
  };
  return { srv, c, watch, errors };
}

describe("localOptimisticUpdates", () => {
  it("the mutation's own code updates every query the replica reproduces, until the server answers", async () => {
    const { srv, c, watch } = setup();
    const list = watch<Msg[]>("messages:list", { channel: "a" });
    const latest = watch<Msg[]>("messages:latest", { channel: "a", n: 2 });
    // Channel "c" has no messages; channel "b" is not on screen, so the replica lacks its row and cannot reproduce `count`.
    const other = watch<Msg[]>("messages:list", { channel: "c" });
    const count = watch<number>("messages:count", {});
    await until(() => [list, latest, other, count].every((w) => w.last()?.status === "success"));
    expect(count.last().value).toBe(3);

    // The server holds the mutation: what the screen shows now is the client's own run of `messages:send`.
    for (const ws of srv.fake.open(SHARD)) ws.holdIncoming();
    const sent = c.mutation(unsafeRef("messages:send"), { channel: "a", body: "third" });
    await until(() => list.last().optimistic);
    expect(list.last().value!.map((m) => m.body)).toEqual(["first", "second", "third"]);
    expect(latest.last()).toMatchObject({ optimistic: true });
    expect(latest.last().value!.map((m) => m.body)).toEqual(["third", "second"]);
    expect(other.last()).toMatchObject({ optimistic: false });
    expect(count.last()).toMatchObject({ optimistic: false, value: 3 });

    // The server answers: its own value (its own id) replaces the optimistic one.
    for (const ws of srv.fake.open(SHARD)) ws.releaseIncoming();
    const id = await sent;
    await until(() => !list.last().optimistic && list.last().value!.length === 3);
    expect(list.last().value!.at(-1)).toMatchObject({ _id: id, body: "third" });
    await until(() => count.last().value === 4);
  });

  it("a derived value gets an optimistic value too when the replica holds every row it reads", async () => {
    const { srv, c, watch } = setup();
    const a = watch<Msg[]>("messages:list", { channel: "a" });
    const b = watch<Msg[]>("messages:list", { channel: "b" });
    const count = watch<number>("messages:count", {});
    await until(() => [a, b, count].every((w) => w.last()?.status === "success"));
    for (const ws of srv.fake.open(SHARD)) ws.holdIncoming();
    const p = c.mutation(unsafeRef("messages:send"), { channel: "b", body: "more" });
    await until(() => count.last().optimistic);
    expect(count.last().value).toBe(4);
    for (const ws of srv.fake.open(SHARD)) ws.releaseIncoming();
    await p;
  });

  it("edits and deletes show at once; pending mutations stack in order", async () => {
    const { srv, c, watch } = setup();
    const list = watch<Msg[]>("messages:list", { channel: "a" });
    await until(() => list.last()?.status === "success");
    const [first, second] = list.last().value!;
    for (const ws of srv.fake.open(SHARD)) ws.holdIncoming();
    const p1 = c.mutation(unsafeRef("messages:edit"), { id: first!._id, body: "first, edited" });
    const p2 = c.mutation(unsafeRef("messages:remove"), { id: second!._id });
    const p3 = c.mutation(unsafeRef("messages:send"), { channel: "a", body: "new" });
    await until(() => list.last().value?.length === 2 && list.last().value?.[1]?.body === "new");
    expect(list.last().value!.map((m) => m.body)).toEqual(["first, edited", "new"]);
    for (const ws of srv.fake.open(SHARD)) ws.releaseIncoming();
    await Promise.all([p1, p2, p3]);
    await until(() => !list.last().optimistic);
    expect(list.last().value!.map((m) => m.body)).toEqual(["first, edited", "new"]);
  });

  it("pending inserts keep their local ids across recomputes and never collide, even in the same millisecond", async () => {
    const { srv, c, watch } = setup();
    const list = watch<Msg[]>("messages:list", { channel: "a" });
    await until(() => list.last()?.status === "success");
    for (const ws of srv.fake.open(SHARD)) ws.holdIncoming();
    // Sent in the same tick: same clock, distinct seeds.
    const p1 = c.mutation(unsafeRef("messages:send"), { channel: "a", body: "x" });
    const p2 = c.mutation(unsafeRef("messages:send"), { channel: "a", body: "y" });
    await until(() => list.last().value?.length === 4);
    const ids = list.last().value!.slice(2).map((m) => m._id);
    expect(new Set(ids).size).toBe(2);
    // Another mutation recomputes every pending update from scratch: the same ids come back.
    const first = list.last().value![0]!;
    const p3 = c.mutation(unsafeRef("messages:edit"), { id: first._id, body: "first, again" });
    await until(() => list.last().value?.[0]?.body === "first, again");
    expect(list.last().value!.slice(2).map((m) => m._id)).toEqual(ids);
    for (const ws of srv.fake.open(SHARD)) ws.releaseIncoming();
    await Promise.all([p1, p2, p3]);
  });

  it("the same args object sent twice gets two distinct local rows", async () => {
    const { srv, c, watch } = setup();
    const list = watch<Msg[]>("messages:list", { channel: "a" });
    await until(() => list.last()?.status === "success");
    for (const ws of srv.fake.open(SHARD)) ws.holdIncoming();
    const form = { channel: "a", body: "again" };
    const p1 = c.mutation(unsafeRef("messages:send"), form);
    const p2 = c.mutation(unsafeRef("messages:send"), form);
    await until(() => list.last().value?.length === 4);
    expect(new Set(list.last().value!.slice(2).map((m) => m._id)).size).toBe(2);
    for (const ws of srv.fake.open(SHARD)) ws.releaseIncoming();
    await Promise.all([p1, p2]);
  });

  it("a mutation that changes a document it read, then throws, leaves the screen's data as it was", async () => {
    const { srv, c, watch } = setup();
    const list = watch<Msg[]>("messages:list", { channel: "a" });
    await until(() => list.last()?.status === "success");
    const first = list.last().value![0]!;
    for (const ws of srv.fake.open(SHARD)) ws.holdIncoming();
    const p = c.mutation(unsafeRef("messages:scribble"), { id: first._id }).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 20));
    expect(list.last().value![0]!.body).toBe("first");
    expect(first.body).toBe("first");
    for (const ws of srv.fake.open(SHARD)) ws.releaseIncoming();
    await p;
  });

  it("a mutation that fails locally changes nothing on screen; the server's answer stands", async () => {
    const { srv, c, watch, errors } = setup();
    const list = watch<Msg[]>("messages:list", { channel: "a" });
    await until(() => list.last()?.status === "success");
    const before = list.last().value;
    for (const ws of srv.fake.open(SHARD)) ws.holdIncoming();
    // An id the replica does not have: the local run throws NotFound.
    const p = c.mutation(unsafeRef("messages:edit"), { id: "messages_01J00000000000000000000000", body: "x" }).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 20));
    expect(list.last().value).toBe(before);
    expect(errors.some((e) => e.startsWith("messages:edit"))).toBe(true);
    for (const ws of srv.fake.open(SHARD)) ws.releaseIncoming();
    await p;
  });
});

describe("localOptimisticUpdates: work per recompute", () => {
  it("a query runs only when the mutation's rows meet its read set; the screen's documents are never copied whole", async () => {
    const { query } = await import("@freecorps/ember-server");
    const srv = engineServer();
    const CH = 20;
    for (let i = 0; i < CH * 5; i++) srv.m("messages:send", { channel: `c${i % CH}`, body: `m${i}` });
    let runs = 0;
    const list = query({
      args: { channel: v.string() },
      handler: (ctx: any, a: { channel: string }) => (runs++, (messages.list as any).handler(ctx, a)),
    });
    const loaded = Array.from({ length: CH }, (_, i) => ({ args: { channel: `c${i}` }, value: srv.q("messages:list", { channel: `c${i}` }) as Msg[] }));
    const set: Array<{ args: unknown; value: Msg[] }> = [];
    const store = {
      getQuery: () => undefined,
      setQuery: (_r: unknown, args: unknown, value: unknown) => void set.push({ args, value: value as Msg[] }),
      updateQuery: () => {},
      getAllQueries: () => loaded,
    } as any;
    const updates = localOptimisticUpdates({ schema, mutations: { messages: { edit: messages.edit } }, queries: { messages: { list } } });
    const target = loaded[3]!.value[0]!;
    const record = { mid: "m1", shard: SHARD, fn: "messages:edit", args: { id: target._id, body: "edited" }, createdAt: 1 };
    updates["messages:edit"]!(store, record.args, record);
    // First call: every loaded query is checked once (before), the one the edit touches runs again (after).
    expect(runs).toBe(CH + 1);
    expect(set.map((s) => s.args)).toEqual([{ channel: "c3" }]);
    expect(set[0]!.value.map((m) => m.body)[0]).toBe("edited");
    // Unchanged rows keep their identity: the optimistic value reuses the screen's documents.
    expect(set[0]!.value[1]).toBe(loaded[3]!.value[1]);
    expect(loaded[3]!.value[0]!.body).not.toBe("edited");
    // The next recompute (same values on screen): only the affected query runs.
    runs = 0;
    updates["messages:edit"]!(store, record.args, record);
    expect(runs).toBe(2);
    expect(set).toHaveLength(2);
  });
});

describe("localOptimisticUpdates: the screen's documents are never written", () => {
  const deepFreeze = <T>(x: T): T => {
    if (typeof x === "object" && x !== null && !Object.isFrozen(x)) {
      Object.freeze(x);
      for (const v of Object.values(x)) deepFreeze(v);
    }
    return x;
  };

  it("writes without a prior read (patch, delete, insert) leave the loaded values as they were", async () => {
    const srv = engineServer();
    for (let i = 0; i < 4; i++) srv.m("messages:send", { channel: "a", body: `m${i}` });
    const value = deepFreeze(srv.q("messages:list", { channel: "a" }) as Msg[]);
    const before = structuredClone(value);
    const loaded = [{ args: { channel: "a" }, value }];
    const set: Msg[][] = [];
    const store = {
      getQuery: () => undefined,
      setQuery: (_r: unknown, _args: unknown, v: unknown) => void set.push(v as Msg[]),
      updateQuery: () => {},
      getAllQueries: () => loaded,
    } as any;
    const errors: string[] = [];
    const updates = localOptimisticUpdates({
      schema,
      mutations: { messages: { edit: messages.edit, remove: messages.remove, send: messages.send } },
      queries: { messages: { list: messages.list } },
      onError: (fn, e) => errors.push(`${fn}: ${e.message}`),
    });
    const run = (fn: string, args: Record<string, unknown>) => updates[fn]!(store, args, { mid: fn, shard: SHARD, fn, args, createdAt: 1 });
    // `edit` is `db.patch(id, …)` and `remove` is `db.delete(id)`: neither reads the document first.
    run("messages:edit", { id: value[1]!._id, body: "edited" });
    run("messages:remove", { id: value[2]!._id });
    run("messages:send", { channel: "a", body: "new" });
    // A write in place on a frozen document would throw (and land in onError).
    expect(errors).toEqual([]);
    expect(value).toEqual(before);
    // (A local id orders the inserted row anywhere among the others: the server's value places it.)
    expect(set.map((v) => v.map((m) => m.body).sort())).toEqual([
      ["edited", "m0", "m2", "m3"],
      ["m0", "m1", "m3"],
      ["m0", "m1", "m2", "m3", "new"],
    ]);
  });

  it("one value object on screen for two queries: each keeps its own remembered read set", async () => {
    const { query } = await import("@freecorps/ember-server");
    const srv = engineServer();
    for (let i = 0; i < 6; i++) srv.m("messages:send", { channel: i % 2 ? "x" : "y", body: `m${i}` });
    const runs = new Map<string, number>();
    const counted = (name: string) =>
      query({ args: { channel: v.string() }, handler: (ctx: any, a: { channel: string }) => (runs.set(name, (runs.get(name) ?? 0) + 1), (messages.list as any).handler(ctx, a)) });
    const shared = srv.q("messages:list", { channel: "x" }) as Msg[];
    const other = srv.q("messages:list", { channel: "y" }) as Msg[];
    // Two queries show the very same array (a value handed from one subscription to another).
    const loaded = [
      { name: "messages:list", args: { channel: "x" }, value: shared },
      { name: "messages:list2", args: { channel: "x" }, value: shared },
      { name: "messages:list", args: { channel: "y" }, value: other },
    ];
    const { getFunctionName } = await import("@freecorps/ember-server");
    const store = { getQuery: () => undefined, setQuery: () => {}, updateQuery: () => {}, getAllQueries: (ref: any) => loaded.filter((l) => l.name === getFunctionName(ref)) } as any;
    const updates = localOptimisticUpdates({ schema, mutations: { messages: { edit: messages.edit } }, queries: { messages: { list: counted("list"), list2: counted("list2") } } });
    const args = { id: other[0]!._id, body: "edited" };
    const record = { mid: "m1", shard: SHARD, fn: "messages:edit", args, createdAt: 1 };
    updates["messages:edit"]!(store, args, record);
    runs.clear();
    // Next recompute: the edit misses channel "x", whose two queries remembered their read sets; only "y" runs.
    updates["messages:edit"]!(store, args, record);
    expect(Object.fromEntries(runs)).toEqual({ list: 2 });
  });
});

describe("localOptimisticUpdates: handlers that change documents in place", () => {
  const storeOf = async (loaded: Array<{ name: string; args: Record<string, unknown>; value: unknown }>) => {
    const { getFunctionName } = await import("@freecorps/ember-server");
    const set: Array<{ name: string; args: unknown; value: Msg[] }> = [];
    const store = {
      getQuery: () => undefined,
      setQuery: (r: any, args: unknown, value: unknown) => void set.push({ name: getFunctionName(r), args, value: value as Msg[] }),
      updateQuery: () => {},
      getAllQueries: (ref: any) => loaded.filter((l) => l.name === getFunctionName(ref)),
    } as any;
    return { store, set };
  };

  it("a query handler that changes the documents it read never changes the screen's", async () => {
    const { query } = await import("@freecorps/ember-server");
    const srv = engineServer();
    for (let i = 0; i < 3; i++) srv.m("messages:send", { channel: "a", body: `m${i}` });
    // Changes the documents it returns, in place (not idempotent: a second run over the same objects adds another "!").
    const shout = query({
      args: { channel: v.string() },
      handler: (ctx: any, a: { channel: string }) => {
        const rows = (messages.list as any).handler(ctx, a) as Msg[];
        for (const r of rows) r.body += "!";
        return rows;
      },
    });
    // What the server answered for it.
    const value = (srv.q("messages:list", { channel: "a" }) as Msg[]).map((m) => ({ ...m, body: `${m.body}!` }));
    const shown = structuredClone(value);
    const { store } = await storeOf([{ name: "messages:shout", args: { channel: "a" }, value }]);
    const updates = localOptimisticUpdates({ schema, mutations: { messages: { edit: messages.edit } }, queries: { messages: { shout } } });
    const args = { id: value[0]!._id, body: "edited" };
    updates["messages:edit"]!(store, args, { mid: "m1", shard: SHARD, fn: "messages:edit", args, createdAt: 1 });
    expect(value).toEqual(shown);
  });

  it("a mutation that changes a document in place before writing it: the query it left is updated too", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "moving" });
    srv.m("messages:send", { channel: "a", body: "staying" });
    srv.m("messages:send", { channel: "b", body: "there" });
    const move = mutation({
      args: { id: v.id("messages"), to: v.string() },
      handler: (ctx: any, { id, to }: { id: any; to: string }) => {
        const doc = ctx.db.get(id);
        doc.channel = to;
        ctx.db.patch(id, { channel: doc.channel });
      },
    });
    const a = srv.q("messages:list", { channel: "a" }) as Msg[];
    const b = srv.q("messages:list", { channel: "b" }) as Msg[];
    const { store, set } = await storeOf([
      { name: "messages:list", args: { channel: "a" }, value: a },
      { name: "messages:list", args: { channel: "b" }, value: b },
    ]);
    const updates = localOptimisticUpdates({ schema, mutations: { messages: { move } }, queries: { messages: { list: messages.list } } });
    const args = { id: a[0]!._id, to: "b" };
    updates["messages:move"]!(store, args, { mid: "m1", shard: SHARD, fn: "messages:move", args, createdAt: 1 });
    const shownFor = (channel: string) => set.find((s) => (s.args as { channel: string }).channel === channel)?.value.map((m) => m.body).sort();
    expect(shownFor("a")).toEqual(["staying"]);
    expect(shownFor("b")).toEqual(["moving", "there"]);
    expect(a.map((m) => m.channel)).toEqual(["a", "a"]);
  });
});
