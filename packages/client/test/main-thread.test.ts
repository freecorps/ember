// Main-thread work in the client (PR 3B-2): the socket opens while the client still loads its storage, a server
// value rebuilds only its own subscription when nothing optimistic is pending (all of them otherwise), and the JWT is
// decoded once per token.
import { describe, expect, it } from "vitest";
import { MemoryPendingStorage, unsafeRef, type PendingStorage, type QuerySnapshot } from "../src/index.ts";
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
    await tick(5);
    // The socket is there (and open) while the storage is still loading; nothing was said on it yet.
    expect(server.history.length).toBe(1);
    expect(server.history[0]!.sent.filter((m) => m !== "ping")).toEqual([]);
    release();
    await until(() => seen.some((s) => s.status === "success"));
    const hello = server.history[0]!.sent.find((m) => m !== "ping" && m.t === "hello") as { clientId: string };
    expect(hello.clientId).toBe(client.clientId);
    client.close();
  });
});

describe("recompute after a server value", () => {
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
