// The whole offline story through EmberClient, with the real engine behind a fake socket server:
// subscribe → offline → reload a fresh client on the same storage → local queries (search too) → offline
// mutation with an optimistic update → another reload → reconnect → server state converges, pending cleared.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmberClient, type ConnectivityEvent, type OptimisticUpdate, type QuerySnapshot, type StorageAdapter } from "@freecorps/ember-client";
import { engineServer, offlineQueries, schema, type Server } from "./app.ts";
import { backend, type BackendKind } from "./backends.ts";

const SHARD = "org:acme";

const until = (cond: () => unknown, timeout = 3000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout, interval: 2 },
  );

type Msg = { _id: string; body: string; channel: string };

/** Registered by name, so it also applies to mutations restored after a restart. */
const optimisticUpdates: Record<string, OptimisticUpdate> = {
  "messages:send": (store, args: { channel: string; body: string }) => {
    const cur = store.getQuery("messages:list", { channel: args.channel }) as Msg[] | undefined;
    if (cur) store.setQuery("messages:list", { channel: args.channel }, [...cur, { _id: "optimistic", ...args }]);
  },
};

function client(srv: Server, storage: StorageAdapter, online: boolean) {
  let emit: (e: ConnectivityEvent) => void = () => {};
  const c = new EmberClient({
    url: "https://ember.test",
    WebSocket: srv.fake.WebSocket,
    fetch: srv.fake.fetch,
    connectivity: { isOnline: () => online, subscribe: (e) => ((emit = e), () => {}) },
    defaultShard: SHARD,
    backoff: { initialMs: 5, maxMs: 20 },
    heartbeat: false,
    storage,
    optimisticUpdates,
  });
  return { c, goOnline: () => emit("online") };
}

function watch<T>(c: EmberClient, fn: string, args: Record<string, unknown>) {
  const seen: QuerySnapshot<T>[] = [];
  const off = c.subscribe(fn, args, {}, (s: QuerySnapshot<T>) => seen.push(s));
  return { seen, last: () => seen.at(-1), off };
}

describe.each(["sqlite", "expo-sqlite", "indexeddb", "memory", "sqlite-wasm", "tinybase"] as BackendKind[])("offline client scenario: %s", (kind) => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it("works offline from a cold start and converges on reconnect", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "Olá, ação!" });
    srv.m("messages:send", { channel: "a", body: "segunda" });
    srv.m("messages:send", { channel: "b", body: "elsewhere" });
    const b = backend(kind);
    cleanups.push(b.cleanup);
    const storage = () => b.make({ schema, queries: offlineQueries });

    // 1. online: subscribe; the result is persisted and its rows replicated
    const s1 = client(srv, storage(), true);
    const list1 = watch<Msg[]>(s1.c, "messages:list", { channel: "a" });
    await until(() => list1.last()?.status === "success" && !list1.last()!.source);
    expect(list1.last()!.value!.map((m) => m.body)).toEqual(["Olá, ação!", "segunda"]);
    await s1.c.flushStorage();
    s1.c.close();

    // 2. reload a fresh client with no network: the query runs locally, search too (accent-insensitive)
    const s2 = client(srv, storage(), false);
    const list2 = watch<Msg[]>(s2.c, "messages:list", { channel: "a" });
    const search2 = watch<string[]>(s2.c, "messages:search", { q: "acao" });
    await until(() => list2.last()?.status === "success" && search2.last()?.status === "success");
    expect(list2.last()).toMatchObject({ source: "local", optimistic: false });
    expect(list2.last()!.value!.map((m) => m.body)).toEqual(["Olá, ação!", "segunda"]);
    expect(search2.last()).toMatchObject({ value: ["Olá, ação!"], source: "local" });

    // 3. mutate offline: optimistic on top of the local value, queued in storage
    const sent = s2.c.mutation("messages:send", { channel: "a", body: "escrita offline" });
    sent.catch(() => undefined);
    await until(() => list2.last()?.value?.length === 3);
    expect(list2.last()).toMatchObject({ optimistic: true, source: "local" });
    await s2.c.flushStorage();
    s2.c.close();

    // 4. reload again, still offline: the restored mutation is re-applied through the registered update
    const s3 = client(srv, storage(), false);
    const list3 = watch<Msg[]>(s3.c, "messages:list", { channel: "a" });
    await until(() => list3.last()?.value?.length === 3);
    expect(list3.last()!.value!.map((m) => m._id)).toContain("optimistic");
    expect(s3.c.connectionState().pendingMutations).toBe(1);
    expect(srv.q("messages:list", { channel: "a" }).length).toBe(2);

    // 5. reconnect: replayed once, confirmed, the optimistic row replaced by the server's
    s3.goOnline();
    await until(() => s3.c.connectionState().pendingMutations === 0 && list3.last()?.optimistic === false && !list3.last()?.source);
    const server = srv.q("messages:list", { channel: "a" }) as Msg[];
    expect(server.map((m) => m.body)).toEqual(["Olá, ação!", "segunda", "escrita offline"]);
    expect(list3.last()!.value).toEqual(server);
    await s3.c.flushStorage();
    s3.c.close();

    // 6. the replica converged and the queue is empty: a last offline reload shows the server's state
    const s4 = client(srv, storage(), false);
    await s4.c.ready();
    expect(s4.c.connectionState().pendingMutations).toBe(0);
    const list4 = watch<Msg[]>(s4.c, "messages:list", { channel: "a" });
    const search4 = watch<string[]>(s4.c, "messages:search", { q: "offline" });
    await until(() => list4.last()?.status === "success" && search4.last()?.status === "success");
    expect(list4.last()!.value).toEqual(server);
    expect(search4.last()!.value).toEqual(["escrita offline"]);
    s4.c.close();
  });
});
