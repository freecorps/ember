import { describe, expect, it } from "vitest";
import {
  MemoryPendingStorage,
  type ConnectivityEvent,
  type LocalIdentity,
  type LocalQueryRequest,
  type QuerySnapshot,
  type QueryUpdate,
  type StorageAdapter,
} from "../src/index.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

/** A StorageAdapter over plain maps (the real ones live in @freecorps/ember-offline). Shared across "reloads". */
class FakeStore {
  pending = new MemoryPendingStorage();
  results = new Map<string, QueryUpdate>();
  identity: LocalIdentity | null = null;
  requests: LocalQueryRequest[] = [];
  /** fn → local implementation over the cached results (stands in for runLocalQuery). */
  local: Record<string, (req: LocalQueryRequest, store: FakeStore) => unknown> = {};
  closed = 0;
  adapter(sync: StorageAdapter["sync"] = []): StorageAdapter {
    return {
      load: async () => ({ identity: this.identity }),
      persistPending: this.pending,
      applyPatch: (u) => void this.results.set(`${u.shard}|${u.fn}|${u.argsJson}`, u),
      runQueryLocally: async (req) => {
        this.requests.push(req);
        const f = this.local[req.fn];
        if (f) return { value: f(req, this), source: "local" };
        const hit = this.results.get(`${req.shard}|${req.fn}|${req.argsJson}`);
        return hit ? { value: hit.value, source: "cache" } : undefined;
      },
      setIdentity: (id) => void (this.identity = id),
      sync,
      flush: async () => {},
      close: () => void this.closed++,
    };
  }
}

function connectivity(online: boolean) {
  let emit: (e: ConnectivityEvent) => void = () => {};
  return { source: { isOnline: () => online, subscribe: (e: (x: ConnectivityEvent) => void) => ((emit = e), () => {}) }, emit: (e: ConnectivityEvent) => emit(e) };
}

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

const appendBody = {
  "messages:send": (store: any, args: any) => {
    const cur = store.getQuery("messages:list", { channel: args.channel });
    if (cur) store.setQuery("messages:list", { channel: args.channel }, [...cur, args.body]);
  },
};

describe("offline StorageAdapter", () => {
  it("persists confirmed values and shows them on a cold start, offline", async () => {
    const server = messagesServer();
    server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "one" });
    const store = new FakeStore();
    const c1 = makeClient(server, { storage: store.adapter() });
    const seen: QuerySnapshot<string[]>[] = [];
    c1.subscribe("messages:list", { channel: "a" }, {}, (s: QuerySnapshot<string[]>) => seen.push(s));
    await until(() => seen.at(-1)?.status === "success");
    expect(seen.at(-1)).toEqual({ status: "success", value: ["one"], error: undefined, optimistic: false });
    server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "two" });
    await until(() => store.results.get(`${SHARD}|messages:list|{"channel":"a"}`)?.value?.toString() === "one,two");
    // Versions are only comparable within a shard epoch: the store gets both.
    expect(store.results.get(`${SHARD}|messages:list|{"channel":"a"}`)).toMatchObject({ version: expect.any(Number), epoch: expect.any(String) });
    c1.close();
    await tick();
    expect(store.closed).toBe(1);

    // reload with no network: the cached value is shown, marked as such
    const net = connectivity(false);
    const c2 = makeClient(server, { storage: store.adapter(), connectivity: net.source });
    const s2: QuerySnapshot<string[]>[] = [];
    c2.subscribe("messages:list", { channel: "a" }, {}, (s: QuerySnapshot<string[]>) => s2.push(s));
    await until(() => s2.at(-1)?.status === "success");
    expect(s2.at(-1)).toMatchObject({ value: ["one", "two"], source: "cache", optimistic: false });
    expect(c2.localQueryResult("messages:list", { channel: "a" }).source).toBe("cache");

    // back online: the server's snapshot replaces it (no `source` any more)
    server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "three" });
    net.emit("online");
    await until(() => s2.at(-1)?.value?.length === 3);
    expect(s2.at(-1)!.source).toBeUndefined();
    c2.close();
  });

  it("keeps offline mutations (and their registered optimistic updates) across a restart, then converges", async () => {
    const server = messagesServer();
    const store = new FakeStore();
    store.local["messages:list"] = (req, st) => [...((st.results.get(`${req.shard}|messages:list|${req.argsJson}`)?.value as string[]) ?? [])];

    const net1 = connectivity(false);
    const c1 = makeClient(server, { storage: store.adapter(), connectivity: net1.source, optimisticUpdates: appendBody });
    const s1: QuerySnapshot<string[]>[] = [];
    c1.subscribe("messages:list", { channel: "a" }, {}, (s: QuerySnapshot<string[]>) => s1.push(s));
    await until(() => s1.at(-1)?.status === "success");
    expect(s1.at(-1)).toMatchObject({ value: [], source: "local" });
    // offline mutation, optimistic through the registered update
    const lost = c1.mutation("messages:send", { channel: "a", body: "offline 1" });
    lost.catch(() => undefined);
    await until(() => s1.at(-1)?.value?.length === 1);
    expect(s1.at(-1)).toMatchObject({ value: ["offline 1"], optimistic: true, source: "local" });
    await tick(5);
    expect(store.pending.load().map((r) => r.args.body)).toEqual(["offline 1"]);
    c1.close();

    // restart, still offline: the restored mutation is still applied on top of the local value
    const net2 = connectivity(false);
    const restored: unknown[] = [];
    const c2 = makeClient(server, {
      storage: store.adapter(),
      connectivity: net2.source,
      optimisticUpdates: appendBody,
      onRestoredMutationResult: (rec, r) => restored.push([rec.args.body, r.ok]),
    });
    const s2: QuerySnapshot<string[]>[] = [];
    c2.subscribe("messages:list", { channel: "a" }, {}, (s: QuerySnapshot<string[]>) => s2.push(s));
    await until(() => s2.at(-1)?.value?.length === 1);
    expect(s2.at(-1)).toMatchObject({ value: ["offline 1"], optimistic: true });
    expect(c2.connectionState().pendingMutations).toBe(1);

    // reconnect: replayed once, confirmed by the server, queue cleared
    net2.emit("online");
    await until(() => restored.length === 1 && s2.at(-1)?.optimistic === false);
    expect(restored).toEqual([["offline 1", true]]);
    expect(s2.at(-1)).toEqual({ status: "success", value: ["offline 1"], error: undefined, optimistic: false });
    await until(() => store.pending.load().length === 0);
    expect(server.rows(SHARD, "messages").map((r) => r.body)).toEqual(["offline 1"]);
    expect(c2.connectionState().pendingMutations).toBe(0);
    c2.close();
  });

  it("a queued mutation only goes out as the identity that issued it: another one signing in drops it", async () => {
    const server = messagesServer();
    const store = new FakeStore();
    const net1 = connectivity(true);
    const c1 = makeClient(server, { storage: store.adapter(), connectivity: net1.source, auth: () => jwt({ sub: "ada", iss: "me" }) });
    c1.subscribe("messages:list", { channel: "a" }, {}, () => {});
    await until(() => store.identity?.subject === "ada");
    net1.emit("offline");
    await tick(5);
    c1.mutation("messages:send", { channel: "a", body: "ada's" }).catch(() => undefined);
    await tick(5);
    expect(store.pending.load().map((r) => [r.args.body, r.identity?.subject])).toEqual([["ada's", "ada"]]);
    c1.close();

    // Bob signs in on the same device: Ada's queued mutation is dropped, never sent as Bob.
    const restored: unknown[] = [];
    const net2 = connectivity(true);
    const c2 = makeClient(server, {
      storage: store.adapter(),
      connectivity: net2.source,
      auth: () => jwt({ sub: "bob", iss: "me" }),
      onRestoredMutationResult: (rec, r) => restored.push([rec.args.body, r.ok, r.ok ? null : r.error.code]),
    });
    c2.subscribe("messages:list", { channel: "a" }, {}, () => {});
    await until(() => restored.length === 1);
    expect(restored).toEqual([["ada's", false, "identity_changed"]]);
    await until(() => store.pending.load().length === 0);
    await tick(20);
    expect(server.rows(SHARD, "messages")).toEqual([]);
    c2.close();
  });

  it("signed out, a queued mutation waits; the same identity signing back in sends it; discardPending drops the rest", async () => {
    const server = messagesServer();
    const store = new FakeStore();
    const net = connectivity(true);
    const ada = () => jwt({ sub: "ada", iss: "me" });
    const c = makeClient(server, { storage: store.adapter(), connectivity: net.source, auth: ada });
    c.subscribe("messages:list", { channel: "a" }, {}, () => {});
    await until(() => store.identity?.subject === "ada");
    // Queued as Ada while offline, then she signs out: it waits (it never goes out signed out).
    net.emit("offline");
    await tick(5);
    const p = c.mutation("messages:send", { channel: "a", body: "later" });
    c.clearAuth();
    net.emit("online");
    await tick(30);
    expect(server.rows(SHARD, "messages")).toEqual([]);
    expect(c.connectionState().pendingMutations).toBe(1);
    // Ada again: it goes out.
    c.setAuth(ada);
    await p;
    expect(server.rows(SHARD, "messages").map((r) => r.body)).toEqual(["later"]);

    // Queued again, then discarded: never sent, the caller is told.
    net.emit("offline");
    await tick(5);
    const q = c.mutation("messages:send", { channel: "a", body: "dropped" });
    await tick(5);
    expect(await c.discardPending()).toBe(1);
    await expect(q).rejects.toMatchObject({ code: "discarded" });
    await until(() => store.pending.load().length === 0);
    net.emit("online");
    await tick(30);
    expect(server.rows(SHARD, "messages").map((r) => r.body)).toEqual(["later"]);
    c.close();
  });

  it("subscribes to sync queries for its whole life and passes the local identity", async () => {
    const server = messagesServer();
    server.mutateDirect(SHARD, "messages:send", { channel: "s", body: "synced" });
    const store = new FakeStore();
    const c = makeClient(server, { storage: store.adapter([{ query: "messages:list", args: { channel: "s" } }]), auth: () => jwt({ sub: "ada", iss: "me" }) });
    await until(() => store.results.has(`${SHARD}|messages:list|{"channel":"s"}`));
    expect(server.subscriptionCount(SHARD)).toBe(1);
    await until(() => store.identity?.subject === "ada");
    expect(store.identity).toEqual({ subject: "ada", issuer: "me" });
    c.subscribe("messages:count", {}, {}, () => {});
    await until(() => store.requests.some((r) => r.fn === "messages:count"));
    expect(store.requests.find((r) => r.fn === "messages:count")!.identity).toEqual({ subject: "ada", issuer: "me" });
    c.clearAuth();
    await until(() => store.identity === null);
    c.close();
  });

  it("a watched local value that goes away (cleared, evicted) takes the sub back to loading", async () => {
    const server = messagesServer();
    let push: (r: { value: unknown; source: "local" | "cache" } | undefined) => void = () => {};
    const store = new FakeStore();
    const adapter: StorageAdapter = {
      ...store.adapter(),
      watchQueryLocally: (_req, onResult) => {
        push = onResult;
        onResult({ value: ["cached"], source: "cache" });
        return () => {};
      },
    };
    const c = makeClient(server, { storage: adapter, connectivity: connectivity(false).source });
    const seen: QuerySnapshot<string[]>[] = [];
    c.subscribe("messages:list", { channel: "w" }, {}, (s: QuerySnapshot<string[]>) => seen.push(s));
    await until(() => seen.at(-1)?.status === "success");
    expect(seen.at(-1)).toMatchObject({ value: ["cached"], source: "cache" });
    push(undefined);
    await until(() => seen.at(-1)?.status === "loading");
    expect(c.localQueryResult("messages:list", { channel: "w" })).toMatchObject({ status: "loading", value: undefined });
    c.close();
  });

  it("falls back to memory when the adapter cannot load", async () => {
    const server = messagesServer();
    const errors: string[] = [];
    const broken: StorageAdapter = {
      load: async () => {
        throw new Error("disk full");
      },
      persistPending: new MemoryPendingStorage(),
      applyPatch: () => {
        throw new Error("never");
      },
      runQueryLocally: () => {
        throw new Error("never");
      },
    };
    const c = makeClient(server, { storage: broken, onError: (e) => errors.push(e.code) });
    const seen: QuerySnapshot[] = [];
    c.subscribe("messages:list", { channel: "z" }, {}, (s) => seen.push(s));
    await until(() => seen.at(-1)?.status === "success");
    expect(errors).toEqual(["storage_error"]);
    c.close();
  });
});
