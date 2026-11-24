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
