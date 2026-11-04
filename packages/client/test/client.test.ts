import { describe, expect, it, vi } from "vitest";
import {
  anyApi,
  EmberError,
  encodeJson,
  getFunctionName,
  KeyValuePendingStorage,
  makeFunctionReference,
  MemoryPendingStorage,
  type ConnectivityEvent,
  type FunctionReference,
  type QuerySnapshot,
} from "../src/index.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

const api = anyApi as unknown as {
  messages: {
    list: FunctionReference<"query", { channel: string }, string[]>;
    send: FunctionReference<"mutation", { channel: string; body: string }, string>;
  };
};

function collect<T>() {
  const seen: QuerySnapshot<T>[] = [];
  return { seen, cb: (s: QuerySnapshot<T>) => seen.push(s), last: () => seen[seen.length - 1] };
}

describe("function references", () => {
  it("anyApi turns property paths into module:export names", () => {
    expect(getFunctionName(anyApi.messages!.list!)).toBe("messages:list");
    expect(getFunctionName((anyApi as any).chat.messages.list)).toBe("chat/messages:list");
    expect(getFunctionName("a:b")).toBe("a:b");
    expect(getFunctionName(makeFunctionReference<"query">("x:y"))).toBe("x:y");
    expect(() => getFunctionName((anyApi as any).messages)).toThrow(/module and an export/);
  });
});

describe("subscriptions", () => {
  it("receives the snapshot and patches", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const c = collect<string[]>();
    client.subscribe(api.messages.list, { channel: "a" }, { shard: SHARD }, c.cb);
    await until(() => c.last()?.status === "success");
    expect(c.last()!.value).toEqual([]);
    server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "hi" });
    await until(() => c.last()?.value?.length === 1);
    expect(c.last()!.value).toEqual(["hi"]);
    // a write that does not change the result sends no patch
    const n = c.seen.length;
    server.mutateDirect(SHARD, "messages:send", { channel: "b", body: "other" });
    await tick(5);
    expect(c.seen.length).toBe(n);
    client.close();
  });

  it("dedups identical subscriptions and ref-counts them", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const a = collect<string[]>();
    const b = collect<string[]>();
    const offA = client.subscribe(api.messages.list, { channel: "x" }, {}, a.cb);
    await until(() => a.last()?.status === "success");
    // same args, different key order / object identity
    const offB = client.subscribe("messages:list", { channel: "x" }, { shard: SHARD }, b.cb);
    expect(b.seen.length).toBe(1); // got the cached value right away
    await tick(5);
    expect(server.subscriptionCount()).toBe(1);
    const subs = server.open()[0]!.sent.filter((m) => m !== "ping" && m.t === "sub");
    expect(subs.length).toBe(1);

    offA();
    await tick(5);
    expect(server.subscriptionCount()).toBe(1);
    server.mutateDirect(SHARD, "messages:send", { channel: "x", body: "1" });
    await until(() => b.last()?.value?.length === 1);
    expect(a.seen.length).toBe(1);

    offB();
    await until(() => server.subscriptionCount() === 0);
    expect(server.open()[0]!.sent.some((m) => m !== "ping" && m.t === "unsub")).toBe(true);
    client.close();
  });

  it("keeps the subscription across an unsubscribe + resubscribe in the same tick", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const off = client.subscribe(api.messages.list, { channel: "s" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    off();
    const off2 = client.subscribe(api.messages.list, { channel: "s" }, {}, () => {});
    await tick(5);
    const sent = server.open()[0]!.sent.filter((m) => m !== "ping" && (m.t === "sub" || m.t === "unsub"));
    expect(sent.length).toBe(1);
    off2();
    client.close();
  });

  it("surfaces query errors as typed EmberError", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const c = collect();
    client.subscribe("boom:query", {}, {}, c.cb);
    await until(() => c.last()?.status === "error");
    expect(c.last()!.error).toBeInstanceOf(EmberError);
    expect(c.last()!.error!.code).toBe("nope");
    client.close();
  });

  it("reconnects with backoff and resumes: unchanged keeps the value, changed gets a fresh snapshot", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const x = collect<string[]>();
    const y = collect<string[]>();
    client.subscribe(api.messages.list, { channel: "x" }, {}, x.cb);
    client.subscribe(api.messages.list, { channel: "y" }, {}, y.cb);
    await until(() => x.last()?.status === "success" && y.last()?.status === "success");
    server.mutateDirect(SHARD, "messages:send", { channel: "x", body: "1" });
    await until(() => x.last()?.value?.length === 1);
    const xValue = x.last()!.value;
    const yValue = y.last()!.value;

    server.refuseConnections = 2; // two failed attempts before the server accepts again
    server.dropAll();
    await until(() => client.connectionState().shards[SHARD] === "waiting");
    // changes while offline: only y is affected
    server.mutateDirect(SHARD, "messages:send", { channel: "y", body: "while-away" });
    await until(() => client.connectionState().shards[SHARD] === "open", 3000);
    await until(() => y.last()?.value?.length === 1);
    expect(server.history.length).toBe(4); // first, two refused, the good one

    const sock = server.open()[0]!;
    const subs = sock.sent.filter((m): m is Extract<typeof m, { t: "sub" }> => m !== "ping" && m.t === "sub");
    expect(subs.length).toBe(2);
    for (const s of subs) expect(s.resume).toEqual({ version: expect.any(Number), epoch: server.shard(SHARD).epoch });
    const snaps = sock.received.filter((m) => m !== "pong" && m.t === "snap") as Array<{ unchanged?: boolean }>;
    expect(snaps.filter((s) => s.unchanged).length).toBe(1);
    expect(x.last()!.value).toBe(xValue); // same reference: no re-render needed
    expect(y.last()!.value).not.toBe(yValue);
    expect(y.last()!.value).toEqual(["while-away"]);
    client.close();
  });

  it("does not resume across an epoch change", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    client.subscribe(api.messages.list, { channel: "x" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    server.resetEpoch(SHARD);
    server.dropAll();
    await until(() => server.subscriptionCount() === 1);
    const sub = server.open()[0]!.sent.find((m) => m !== "ping" && m.t === "sub") as { resume?: unknown };
    expect(sub.resume).toBeUndefined();
    client.close();
  });
});

describe("mutations", () => {
  it("resolves with the server value after the patch is applied", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const c = collect<string[]>();
    client.subscribe(api.messages.list, { channel: "m" }, {}, c.cb);
    const id = await client.mutation(api.messages.send, { channel: "m", body: "hello" });
    expect(id).toMatch(/^messages_/);
    expect(c.last()!.value).toEqual(["hello"]);
    client.close();
  });

  it("applies optimistic updates, rebases them over other writers' patches, and drops them on confirm", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const c = collect<string[]>();
    client.subscribe(api.messages.list, { channel: "o" }, {}, c.cb);
    await until(() => c.last()?.status === "success");
    const sock = server.open()[0]!;
    sock.holdIncoming(); // our mut frame waits on the wire

    const p = client.mutation(api.messages.send, { channel: "o", body: "mine" }, {
      optimisticUpdate: (store, args) => {
        const cur = store.getQuery(api.messages.list, { channel: args.channel });
        if (cur) store.setQuery(api.messages.list, { channel: args.channel }, [...cur, `${args.body}*`]);
      },
    });
    expect(c.last()!.value).toEqual(["mine*"]);
    expect(c.last()!.optimistic).toBe(true);
    expect(client.connectionState().pendingMutations).toBe(1);

    // Another writer commits first: its patch arrives, the optimistic change is re-applied on top.
    server.mutateDirect(SHARD, "messages:send", { channel: "o", body: "theirs" });
    await until(() => c.last()!.value!.includes("theirs"));
    expect(c.last()!.value).toEqual(["theirs", "mine*"]);
    expect(c.last()!.optimistic).toBe(true);

    const from = c.seen.length;
    sock.releaseIncoming();
    await p;
    await tick(5);
    expect(c.last()!.value).toEqual(["theirs", "mine"]);
    expect(c.last()!.optimistic).toBe(false);
    // patch(v) then mres(v): the confirmed row and the optimistic row are never shown together
    for (const s of c.seen.slice(from)) expect(s.value!.filter((b) => b.startsWith("mine")).length).toBe(1);
    expect(client.connectionState().pendingMutations).toBe(0);
    client.close();
  });

  it("optimistic updates of several pending mutations stack in order", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const c = collect<number>();
    client.subscribe("messages:count", {}, {}, c.cb);
    await until(() => c.last()?.status === "success");
    server.open()[0]!.holdIncoming();
    const inc = { optimisticUpdate: (store: any) => store.setQuery("messages:count", {}, (store.getQuery("messages:count", {}) ?? 0) + 1) };
    const ps = [1, 2, 3].map((i) => client.mutation(api.messages.send, { channel: "c", body: `${i}` }, inc));
    expect(c.last()!.value).toBe(3);
    server.open()[0]!.releaseIncoming();
    await Promise.all(ps);
    await tick(5);
    expect(c.last()).toMatchObject({ value: 3, optimistic: false });
    client.close();
  });

  it("rolls back and rejects with a typed EmberError on mres ok:false", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const c = collect<string[]>();
    client.subscribe(api.messages.list, { channel: "f" }, {}, c.cb);
    await until(() => c.last()?.status === "success");
    const seen: string[][] = [];
    client.subscribe(api.messages.list, { channel: "f" }, {}, (s) => seen.push(s.value!));
    const p = client.mutation(api.messages.send, { channel: "f", body: "fail" }, {
      optimisticUpdate: (store) => store.setQuery(api.messages.list, { channel: "f" }, ["fail*"]),
    });
    expect(c.last()!.value).toEqual(["fail*"]);
    await expect(p).rejects.toMatchObject({ name: "EmberError", code: "invalid_body", message: "body may not be fail" });
    expect(c.last()!.value).toEqual([]);
    expect(c.last()!.optimistic).toBe(false);
    expect(client.connectionState().pendingMutations).toBe(0);
    client.close();
  });

  it("retries pending mutations after reconnect; server dedup runs them once", async () => {
    const server = messagesServer();
    const storage = new MemoryPendingStorage();
    const client = makeClient(server, { storage });
    await client.ready();
    client.subscribe(api.messages.list, { channel: "q" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    const sock = server.open()[0]!;
    sock.hold(); // the server runs the mutation but the answer is lost with the socket
    const p = client.mutation(api.messages.send, { channel: "q", body: "once" });
    await until(() => server.executions === 1);
    expect((await storage.load()).length).toBe(1);
    sock.drop();
    expect(await p).toMatch(/^messages_/);
    expect(server.executions).toBe(1);
    expect(server.rows(SHARD, "messages").length).toBe(1);
    await tick();
    expect((await storage.load()).length).toBe(0);
    const resent = server.open()[0]!.sent.filter((m) => m !== "ping" && m.t === "mut");
    expect(resent.length).toBe(1);
    client.close();
  });

  it("queues mutations while disconnected and sends them in order when connected", async () => {
    const server = messagesServer();
    server.refuseConnections = 3;
    const client = makeClient(server);
    const a = client.mutation(api.messages.send, { channel: "z", body: "1" });
    const b = client.mutation(api.messages.send, { channel: "z", body: "2" });
    await Promise.all([a, b]);
    expect(server.rows(SHARD, "messages").map((r) => r.body)).toEqual(["1", "2"]);
    client.close();
  });

  it("persists the queue and the clientId: a new client restores and sends it", async () => {
    const server = messagesServer();
    const kv = new Map<string, string>();
    const store = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v) };
    const offline = makeClient(server, { storage: new KeyValuePendingStorage(store), connectivity: { isOnline: () => false, subscribe: () => () => {} } });
    const lost = offline.mutation(api.messages.send, { channel: "p", body: "persisted" });
    lost.catch(() => {});
    await offline.ready();
    await tick(5);
    expect(JSON.parse(kv.get("ember:pending")!)).toHaveLength(1);
    const clientId = offline.clientId;
    offline.close();
    expect(server.history.length).toBe(0);

    const results: unknown[] = [];
    const client = makeClient(server, {
      storage: new KeyValuePendingStorage(store),
      onRestoredMutationResult: (rec, r) => results.push([rec.fn, r.ok]),
    });
    await client.ready();
    expect(client.clientId).toBe(clientId);
    await until(() => results.length === 1);
    expect(results[0]).toEqual(["messages:send", true]);
    expect(server.rows(SHARD, "messages").map((r) => r.body)).toEqual(["persisted"]);
    await tick(5);
    expect(JSON.parse(kv.get("ember:pending")!)).toHaveLength(0);
    client.close();
  });
});

describe("protocol v1 semantics", () => {
  it("patch.mids drops the optimistic layer atomically, before the mres arrives", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const pendingAt: Array<{ value: string[] | undefined; optimistic: boolean; pending: number }> = [];
    client.subscribe(api.messages.list, { channel: "a" }, {}, (s) =>
      pendingAt.push({ value: s.value, optimistic: s.optimistic, pending: client.connectionState().pendingMutations }),
    );
    await until(() => pendingAt.at(-1)?.value !== undefined);
    const p = client.mutation(api.messages.send, { channel: "a", body: "mine" }, {
      optimisticUpdate: (store, args) => store.setQuery(api.messages.list, { channel: "a" }, [`${args.body}*`]),
    });
    await p;
    const patch = server.open()[0]!.received.find((m) => m !== "pong" && m.t === "patch") as { mids: unknown[] };
    const mut = server.open()[0]!.sent.find((m) => m !== "ping" && m.t === "mut") as { mid: string };
    expect(patch.mids).toEqual([mut.mid]);
    // The confirmed view replaced the optimistic one while the mutation was still pending (mres not yet seen).
    const confirmed = pendingAt.find((s) => s.value?.[0] === "mine")!;
    expect(confirmed).toEqual({ value: ["mine"], optimistic: false, pending: 1 });
    expect(pendingAt.map((s) => s.value)).toEqual([[], ["mine*"], ["mine"]]);
    client.close();
  });

  it("auth_expired mres: refreshes the token, re-sends auth, retries the mutation once with the same mid", async () => {
    const server = messagesServer();
    let n = 0;
    const auth = vi.fn(() => `user:u${++n}`);
    const client = makeClient(server, { auth });
    const c = collect<string | null>();
    client.subscribe("users:me", {}, {}, c.cb);
    await until(() => c.last()?.value === "u1");
    server.expireAuth(SHARD, false); // no proactive authExpired: the mut itself bounces
    const id = await client.mutation(api.messages.send, { channel: "e", body: "after-expiry" });
    expect(id).toMatch(/^messages_/);
    const sent = server.open()[0]!.sent.filter((m) => m !== "ping" && (m.t === "mut" || m.t === "auth")) as Array<{ t: string; mid?: string }>;
    expect(sent.map((m) => m.t)).toEqual(["mut", "auth", "mut"]);
    expect(sent[0]!.mid).toBe(sent[2]!.mid);
    expect(server.executions).toBe(1);
    expect(auth).toHaveBeenCalledTimes(2);
    await until(() => c.last()?.value === "u2");
    client.close();
  });

  it("auth_expired mres with no new token rejects the mutation", async () => {
    const server = messagesServer();
    let first = true;
    const client = makeClient(server, { auth: () => (first ? ((first = false), "user:a") : null), onError: () => {} });
    client.subscribe("users:me", {}, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    server.expireAuth(SHARD, false);
    await expect(client.mutation(api.messages.send, { channel: "e", body: "x" })).rejects.toMatchObject({ code: "auth_expired" });
    expect(server.executions).toBe(0);
    expect(client.connectionState().pendingMutations).toBe(0);
    client.close();
  });

  it("auth_expired on sub: re-auths and subscribes again", async () => {
    const server = messagesServer();
    let n = 0;
    const client = makeClient(server, { auth: () => `user:u${++n}` });
    client.subscribe("users:me", {}, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    server.expireAuth(SHARD, false);
    const c = collect<number>();
    client.subscribe("messages:count", {}, {}, c.cb);
    await until(() => c.last()?.status === "success");
    expect(c.seen.every((s) => s.status !== "error")).toBe(true);
    expect(server.subscriptionCount()).toBe(2);
    client.close();
  });

  it("a failing subscription stays registered with its error and recovers through a later patch", async () => {
    const server = messagesServer({
      queries: {
        "messages:latest": (db, { channel }) => {
          const rows = db.where<{ body: string }>("messages", "channel", channel);
          if (!rows.length) throw new Error(`channel ${channel} is empty`);
          return rows[rows.length - 1]!.body;
        },
      },
    });
    const client = makeClient(server);
    const c = collect<string>();
    client.subscribe("messages:latest", { channel: "r" }, {}, c.cb);
    await until(() => c.last()?.status === "error");
    expect(c.last()!.error).toMatchObject({ code: "Error", message: "channel r is empty" });
    expect(server.subscriptionCount()).toBe(1);
    await client.mutation(api.messages.send, { channel: "r", body: "first" });
    await until(() => c.last()?.status === "success");
    expect(c.last()).toMatchObject({ value: "first", error: undefined });
    const subs = server.open()[0]!.sent.filter((m) => m !== "ping" && m.t === "sub");
    expect(subs.length).toBe(1); // recovered via patch, not by re-subscribing
    client.close();
  });
});

describe("auth", () => {
  it("sends the token in hello and refreshes it on authExpired", async () => {
    const server = messagesServer();
    let n = 0;
    const auth = vi.fn(async () => `user:u${++n}`);
    const client = makeClient(server, { auth });
    const c = collect<string>();
    client.subscribe("users:me", {}, {}, c.cb);
    await until(() => c.last()?.value === "u1");
    const hello = server.open()[0]!.sent[0] as { t: string; token?: string };
    expect(hello).toMatchObject({ t: "hello", token: "user:u1", protocol: 1 });

    server.expireAuth();
    await until(() => c.last()?.value === "u2");
    expect(auth).toHaveBeenCalledTimes(2);
    expect(server.open()[0]!.sent.some((m) => m !== "ping" && m.t === "auth")).toBe(true);
    client.close();
  });

  it("setAuth re-auths open sockets; clearAuth signs out in place with auth token:null", async () => {
    const server = messagesServer();
    const client = makeClient(server, { auth: () => "user:alice" });
    const c = collect<string | null>();
    client.subscribe("users:me", {}, {}, c.cb);
    await until(() => c.last()?.value === "alice");
    client.setAuth(() => "user:bob");
    await until(() => c.last()?.value === "bob");
    expect(server.history.length).toBe(1);

    client.clearAuth();
    await until(() => c.last()?.value === null && c.last()?.status === "success");
    expect(server.history.length).toBe(1);
    const auths = server.open()[0]!.sent.filter((m) => m !== "ping" && m.t === "auth");
    expect(auths).toEqual([{ t: "auth", token: "user:bob" }, { t: "auth", token: null }]);
    client.close();
  });

  it("refreshes a JWT before it expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const server = messagesServer({ verify: (t) => ({ subject: t.slice(-6) }) });
      const now = Math.floor(Date.now() / 1000);
      const jwt = (exp: number, sub: string) =>
        `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.${sub}`;
      let calls = 0;
      const client = makeClient(server, { auth: () => jwt(now + 120, ++calls === 1 ? "first1" : "second") });
      const c = collect<string>();
      client.subscribe("users:me", {}, {}, c.cb);
      await vi.advanceTimersByTimeAsync(10);
      expect(c.last()?.value).toBe("first1");
      await vi.advanceTimersByTimeAsync(91_000); // 120 s - 30 s
      expect(c.last()?.value).toBe("second");
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("connection", () => {
  it("reports state, opens lazily and closes idle sockets", async () => {
    const server = messagesServer();
    const client = makeClient(server, { idleTimeoutMs: 10 });
    const states: string[] = [];
    client.onConnectionStateChange(() => states.push(client.connectionState().shards[SHARD] ?? "-"));
    expect(server.history.length).toBe(0);
    const off = client.subscribe(api.messages.list, { channel: "l" }, {}, () => {});
    await until(() => client.connectionState().connected && client.connectionState().shards[SHARD] === "open");
    off();
    await until(() => client.connectionState().shards[SHARD] === "idle");
    expect(server.open().length).toBe(0);
    expect(states).toEqual(["connecting", "open", "idle"]);
    client.close();
  });

  it("one socket per shard", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    client.subscribe(api.messages.list, { channel: "a" }, { shard: "org:a" }, () => {});
    client.subscribe(api.messages.list, { channel: "a" }, { shard: "org:b" }, () => {});
    client.subscribe(api.messages.list, { channel: "b" }, { shard: "org:b" }, () => {});
    await until(() => server.subscriptionCount() === 3);
    expect(server.open().map((s) => s.shard).sort()).toEqual(["org:a", "org:b"]);
    expect(server.history[0]!.url).toBe("wss://ember.test/ws?shard=org%3Aa");
    client.close();
  });

  it("heartbeat detects a half-open socket and reconnects", async () => {
    const server = messagesServer();
    const client = makeClient(server, { heartbeat: { intervalMs: 10, timeoutMs: 15 } });
    client.subscribe(api.messages.list, { channel: "h" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    const first = server.open()[0]!;
    await until(() => first.sent.includes("ping") && first.received.includes("pong"));
    first.silent = true;
    await until(() => server.history.length === 2 && server.open().length === 1 && server.subscriptionCount() === 1);
    client.close();
  });

  it("goes offline on the offline event and reconnects at once when back online", async () => {
    const server = messagesServer();
    let emit: (e: ConnectivityEvent) => void = () => {};
    const client = makeClient(server, { connectivity: { subscribe: (e) => ((emit = e), () => {}) }, backoff: { initialMs: 60_000 } });
    client.subscribe(api.messages.list, { channel: "n" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    emit("offline");
    expect(client.connectionState()).toMatchObject({ online: false, connected: false });
    await tick(5);
    expect(server.open().length).toBe(0);
    emit("online");
    await until(() => server.subscriptionCount() === 1); // no 60 s backoff wait
    expect(client.connectionState().online).toBe(true);
    client.close();
  });
});

describe("one-shots", () => {
  it("query goes over HTTP with the bearer token", async () => {
    const server = messagesServer();
    server.mutateDirect(SHARD, "messages:send", { channel: "h", body: "x" });
    const client = makeClient(server, { auth: () => "user:carol" });
    expect(await client.query(api.messages.list, { channel: "h" })).toEqual(["x"]);
    expect(server.httpRequests[0]).toMatchObject({ path: "/api/query", authorization: "Bearer user:carol", body: { fn: "messages:list", shard: SHARD } });
    await expect(client.query("boom:query", {})).rejects.toMatchObject({ code: "nope" });
    expect(server.history.length).toBe(0);
    client.close();
  });

  it("bigint and bytes round-trip through the tagged codec", async () => {
    expect(encodeJson({ n: 1n, b: new Uint8Array([255]), f: NaN })).toBe('{"n":{"$int64":"1"},"b":{"$bytes":"/w=="},"f":{"$float":"NaN"}}');
    const server = messagesServer({ queries: { "echo:q": (_db, args) => args } });
    const client = makeClient(server);
    const args = { n: 9007199254740993n, b: new Uint8Array([1, 2, 255]) };
    expect(await client.query("echo:q", args)).toEqual(args);
    const c = collect<typeof args>();
    client.subscribe("echo:q", args, {}, c.cb);
    await until(() => c.last()?.status === "success");
    expect(c.last()!.value).toEqual(args);
    client.close();
  });

  it("action goes over HTTP (POST /api/action) with the bearer token and shard; errors are typed", async () => {
    const server = messagesServer();
    const calls: Array<{ url: string; auth: string | null; body: any }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
      const out = body.fn === "a:ok" ? { ok: true, value: { n: 1n } } : { ok: false, error: { code: "Boom", message: "nope" } };
      return new Response(encodeJson(out), { status: out.ok ? 200 : 400 });
    }) as typeof fetch;
    const client = makeClient(server, { auth: () => "user:dan", fetch: fetchImpl });
    expect(await client.action("a:ok", { x: 1 })).toEqual({ n: 1n });
    expect(calls[0]).toMatchObject({ auth: "Bearer user:dan", body: { fn: "a:ok", args: { x: 1 }, shard: SHARD } });
    expect(calls[0]!.url).toMatch(/\/api\/action$/);
    await expect(client.action("a:bad", {}, { shard: "org:z" })).rejects.toMatchObject({ code: "Boom", message: "nope" });
    expect(calls[1]!.body.shard).toBe("org:z");
    client.close();
  });
});
