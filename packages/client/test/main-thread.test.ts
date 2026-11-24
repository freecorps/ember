// Main-thread work in the client (PR 3B-2): the socket opens while the client still loads its storage, a server
// value rebuilds only its own subscription when nothing optimistic is pending (all of them otherwise), and the JWT is
// decoded once per token.
import { describe, expect, it, vi } from "vitest";
import { MemoryPendingStorage, unsafeRef, type EmberError, type PendingStorage, type QuerySnapshot } from "../src/index.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

const list = unsafeRef<"query">("messages:list");
const count = unsafeRef<"query">("messages:count");
const send = unsafeRef<"mutation">("messages:send");

describe("socket open in parallel with the client's load", () => {
  it("the upgrade starts before the storage has loaded; hello (with the clientId) waits for it", async () => {
    const server = messagesServer();
    let release!: () => void;
    const loaded = new Promise<void>((r) => (release = r));
    const inner = new MemoryPendingStorage();
    const slow: PendingStorage = {
      getClientId: async () => (await loaded, inner.getClientId()),
      setClientId: (id) => inner.setClientId(id),
      load: () => inner.load(),
      put: (r) => inner.put(r),
      remove: (m) => inner.remove(m),
    };
    const client = makeClient(server, { storage: slow });
    const seen: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "c" }, {}, (s) => seen.push(s));
    // The socket is there (and open) while the storage is still loading; nothing was said on it yet.
    await until(() => server.history[0]?.readyState === 1);
    expect(server.history.length).toBe(1);
    expect(server.history[0]!.sent.filter((m) => m !== "ping")).toEqual([]);
    release();
    await until(() => seen.some((s) => s.status === "success"));
    const hello = server.history[0]!.sent.find((m) => m !== "ping" && m.t === "hello") as { clientId: string };
    expect(hello.clientId).toBe(client.clientId);
    client.close();
  });
});

/** Pending storage whose clientId waits for `release()`: the client's load (`init`) is slow. */
function slowStorage() {
  let release!: () => void;
  const loaded = new Promise<void>((r) => (release = r));
  const inner = new MemoryPendingStorage();
  const storage: PendingStorage = {
    getClientId: async () => (await loaded, inner.getClientId()),
    setClientId: (id) => inner.setClientId(id),
    load: () => inner.load(),
    put: (r) => inner.put(r),
    remove: (m) => inner.remove(m),
  };
  return { storage, release };
}

describe("pipelined connect: a failed load or token fetch closes the socket and retries", () => {
  const helloOf = (ws: { sent: unknown[] }) => ws.sent.find((m) => m !== "ping" && (m as { t: string }).t === "hello");

  it("the client's load rejects: the socket opened meanwhile is closed (no hello), the retry recovers", async () => {
    const server = messagesServer();
    const errors: EmberError[] = [];
    const client = makeClient(server, { onError: (e) => errors.push(e) });
    const internals = client as unknown as { init: Promise<void> };
    const real = internals.init;
    const failed = Promise.reject(new Error("disk gone"));
    failed.catch(() => undefined);
    internals.init = failed;
    const seen: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "c" }, {}, (s) => seen.push(s));
    await until(() => errors.length > 0);
    expect(errors[0]!.code).toBe("auth_failed");
    expect(errors[0]!.message).toContain("disk gone");
    const first = server.history[0]!;
    await until(() => first.readyState === 3);
    expect(first.closedByClient).toBe(true);
    expect(helloOf(first)).toBeUndefined();
    // The load works again: the retry (after the backoff) connects and the value arrives.
    internals.init = real;
    await until(() => seen.some((x) => x.status === "success"));
    expect(server.history.length).toBeGreaterThan(1);
    expect(helloOf(server.history.at(-1)!)).toBeDefined();
    client.close();
  });

  it("the token fetch rejects: the socket is closed without hello and the next attempt sends the token", async () => {
    const server = messagesServer();
    const errors: EmberError[] = [];
    let calls = 0;
    const client = makeClient(server, {
      auth: async () => {
        if (calls++ === 0) throw new Error("idp down");
        return "user:amy";
      },
      onError: (e) => errors.push(e),
    });
    const seen: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "c" }, {}, (s) => seen.push(s));
    await until(() => seen.some((x) => x.status === "success"));
    expect(errors.map((e) => e.code)).toEqual(["auth_failed"]);
    const [first, ...rest] = server.history;
    expect(first!.closedByClient).toBe(true);
    expect(helloOf(first!)).toBeUndefined();
    expect(helloOf(rest.at(-1)!)).toMatchObject({ token: "user:amy" });
    client.close();
  });

  it("a slow upgrade after a fast load: hello waits for the open, then goes out once", async () => {
    const server = messagesServer({ openDelayMs: 30 });
    const client = makeClient(server);
    await client.ready();
    const seen: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "c" }, {}, (s) => seen.push(s));
    await until(() => seen.some((x) => x.status === "success"));
    expect(server.history).toHaveLength(1);
    expect(server.history[0]!.sent.filter((m) => m !== "ping" && m.t === "hello")).toHaveLength(1);
    client.close();
  });

  it("closed while still loading: the socket goes, no hello is sent when the load ends, nothing reconnects", async () => {
    const server = messagesServer();
    const { storage, release } = slowStorage();
    const errors: EmberError[] = [];
    const client = makeClient(server, { storage, onError: (e) => errors.push(e) });
    client.subscribe(list, { channel: "c" }, {}, () => {});
    await until(() => server.history[0]?.readyState === 1);
    client.close();
    release();
    await client.ready();
    await tick(30);
    expect(server.history).toHaveLength(1);
    expect(server.history[0]!.closedByClient).toBe(true);
    expect(helloOf(server.history[0]!)).toBeUndefined();
    expect(errors).toEqual([]);
  });
});

describe("recompute after a server value", () => {
  it("a resume answered `unchanged` over the value shown rebuilds nothing", async () => {
    const server = messagesServer({ ident: true });
    const client = makeClient(server);
    const seen: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "u" }, {}, (s) => seen.push(s));
    client.subscribe(count, {}, {}, () => {});
    await until(() => seen.at(-1)?.status === "success" && server.subscriptionCount() === 2);
    const recompute = vi.spyOn(client as unknown as { recompute: (only?: unknown[]) => void }, "recompute");
    const shown = seen.length;
    server.dropAll();
    await until(() => server.history.length === 2 && server.history[1]!.received.filter((m) => m !== "pong" && m.t === "snap").length === 2);
    await tick(5);
    expect(server.history[1]!.received.filter((m) => m !== "pong" && m.t === "snap").every((m) => (m as { unchanged?: boolean }).unchanged)).toBe(true);
    expect(recompute).not.toHaveBeenCalled();
    expect(seen.length).toBe(shown);
    client.close();
  });


  it("an optimistic update that reads another query is re-applied when that query changes", async () => {
    const server = messagesServer();
    const client = makeClient(server);
    const lists: QuerySnapshot<string[]>[] = [];
    const counts: QuerySnapshot<number>[] = [];
    client.subscribe(list, { channel: "o" }, {}, (s) => lists.push(s as QuerySnapshot<string[]>));
    client.subscribe(count, {}, {}, (s) => counts.push(s as QuerySnapshot<number>));
    await until(() => lists.at(-1)?.status === "success" && counts.at(-1)?.status === "success");
    const sock = server.open()[0]!;
    sock.holdIncoming();
    // The count shown optimistically is derived from the *list* query's current value.
    const p = client.mutation(send, { channel: "o", body: "mine" }, {
      optimisticUpdate: (store) => store.setQuery(count, {}, ((store.getQuery(list, { channel: "o" }) as string[] | undefined)?.length ?? 0) + 100),
    });
    expect(counts.at(-1)!).toMatchObject({ value: 100, optimistic: true });
    // Another writer adds to the list: only the list changes on the server, yet the count's optimistic value moves.
    server.mutateDirect(SHARD, "messages:send", { channel: "o", body: "theirs" });
    await until(() => counts.at(-1)!.value === 101);
    expect(counts.at(-1)!.optimistic).toBe(true);
    sock.releaseIncoming();
    await p;
    await until(() => counts.at(-1)!.optimistic === false);
    expect(counts.at(-1)!.value).toBe(2);
    client.close();
  });

  it("with nothing optimistic, a value for one of many subscriptions touches that one only", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server);
    const N = 200;
    const calls = new Array<number>(N).fill(0);
    for (let i = 0; i < N; i++) client.subscribe(list, { channel: `c${i}` }, {}, () => calls[i]!++);
    await until(() => calls.every((n) => n > 0));
    calls.fill(0);
    server.mutateDirect(SHARD, "messages:send", { channel: "c7", body: "x" });
    await until(() => calls[7]! > 0);
    await tick(5);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(1);
    client.close();
  });
});
