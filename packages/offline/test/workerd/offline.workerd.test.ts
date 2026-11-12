/**
 * PLAN §17 phase 5 "exemplo offline com busca local", end to end: EmberClient with IndexedDB offline storage
 * (fake-indexeddb) against the real runtime (Shard DO, hibernating WebSockets, engine) in workerd.
 *
 * subscribe → go offline → reload a fresh client on the same storage → the query and a search run locally →
 * mutate offline with an optimistic update → reload → reconnect → the server ran it once, the client converged,
 * the pending queue is empty.
 */
import { SELF } from "cloudflare:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { EmberClient, type ConnectivityEvent, type OptimisticUpdate, type QuerySnapshot, type WebSocketLike, unsafeRef } from "@freecorps/ember-client";
import { functionsV1, schemaV1 } from "../../../runtime/test/app.ts";
import { indexedDbStorage } from "../../src/indexeddb.ts";

/** WHATWG-style socket over `SELF.fetch` + `Upgrade: websocket` (same as the client's workerd test). */
class SelfWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  private ws: WebSocket | null = null;

  constructor(url: string) {
    SELF.fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } }).then(
      (res) => {
        const ws = res.webSocket;
        if (!ws || this.readyState !== 0) return this.closed(1006);
        ws.accept();
        this.ws = ws;
        this.readyState = 1;
        ws.addEventListener("message", (e) => this.onmessage?.({ data: e.data }));
        ws.addEventListener("close", (e) => this.closed(e.code));
        ws.addEventListener("error", (e) => this.onerror?.(e));
        this.onopen?.({});
      },
      () => this.closed(1006),
    );
  }
  private closed(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  send(data: string): void {
    this.ws!.send(data);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    try {
      this.ws?.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}

type Msg = { _id: string; body: string; channel: string };

const optimisticUpdates: Record<string, OptimisticUpdate> = {
  "messages:send": (store, args: { channel: string; body: string }) => {
    const cur = store.getQuery(unsafeRef("messages:list"), { channel: args.channel }) as Msg[] | undefined;
    if (cur) store.setQuery(unsafeRef("messages:list"), { channel: args.channel }, [...cur, { _id: "optimistic", ...args }]);
  },
};

const offlineQueries = { messages: { list: functionsV1.messages.list, search: functionsV1.messages.search } };

describe("offline end to end (workerd runtime + IndexedDB)", () => {
  it("serves queries and search locally while offline, replays the queue and converges", async () => {
    const shard = `org:offline-${crypto.randomUUID()}`;
    const idb = new IDBFactory();
    const storage = () => indexedDbStorage({ name: "e2e", schema: schemaV1, queries: offlineQueries, indexedDB: idb, IDBKeyRange });
    const errors: string[] = [];
    const client = (online: boolean) => {
      let emit: (e: ConnectivityEvent) => void = () => {};
      const c = new EmberClient({
        url: "http://ember",
        WebSocket: SelfWebSocket,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as any, init as any)) as typeof fetch,
        connectivity: { isOnline: () => online, subscribe: (e) => ((emit = e), () => {}) },
        defaultShard: shard,
        heartbeat: false,
        auth: () => "good:alice",
        storage: storage(),
        optimisticUpdates,
        onError: (e) => errors.push(`${e.code}: ${e.message}`),
      });
      return { c, online: () => emit("online") };
    };
    const watch = <T>(c: EmberClient, fn: string, args: Record<string, unknown>) => {
      const seen: QuerySnapshot<T>[] = [];
      c.subscribe(fn, args, {}, (s: QuerySnapshot<T>) => seen.push(s));
      return () => seen.at(-1);
    };

    // 1. online: subscribe and write through the real shard; results and rows are persisted
    const a = client(true);
    const listA = watch<Msg[]>(a.c, "messages:list", { channel: "c" });
    await expect.poll(() => listA()?.status).toBe("success");
    await a.c.mutation(unsafeRef("messages:send"), { channel: "c", body: "Olá, ação!" });
    await a.c.mutation(unsafeRef("messages:send"), { channel: "c", body: "segunda mensagem" });
    await expect.poll(() => listA()?.value?.length).toBe(2);
    await a.c.flushStorage();
    a.c.close();

    // 2. reload with no network: the list and a never-subscribed search run locally from IndexedDB
    const b = client(false);
    const listB = watch<Msg[]>(b.c, "messages:list", { channel: "c" });
    const searchB = watch<string[]>(b.c, "messages:search", { q: "acao" });
    await expect.poll(() => listB()?.status).toBe("success");
    await expect.poll(() => searchB()?.status).toBe("success");
    expect(listB()).toMatchObject({ source: "local", optimistic: false });
    expect(listB()!.value!.map((m) => m.body)).toEqual(["Olá, ação!", "segunda mensagem"]);
    expect(listB()!.value![0]).toMatchObject({ author: "alice", channel: "c" });
    expect(searchB()).toMatchObject({ value: ["Olá, ação!"], source: "local" });

    // 3. offline mutation: optimistic over the local value, queued in IndexedDB
    b.c.mutation(unsafeRef("messages:send"), { channel: "c", body: "escrita sem rede" }).catch(() => undefined);
    await expect.poll(() => listB()?.value?.length).toBe(3);
    expect(listB()).toMatchObject({ optimistic: true, source: "local" });
    await b.c.flushStorage();
    b.c.close();

    // 4. reload again offline: the queued mutation is still shown (registered optimistic update)
    const c = client(false);
    const listC = watch<Msg[]>(c.c, "messages:list", { channel: "c" });
    await expect.poll(() => listC()?.value?.length).toBe(3);
    expect(listC()!.value!.at(-1)).toMatchObject({ _id: "optimistic", body: "escrita sem rede" });
    expect(c.c.connectionState().pendingMutations).toBe(1);

    // 5. reconnect: replayed on the real shard, confirmed, optimistic layer dropped, queue cleared
    c.online();
    await expect.poll(() => c.c.connectionState().pendingMutations, { timeout: 10_000 }).toBe(0);
    await expect.poll(() => listC()?.optimistic === false && !listC()?.source && listC()?.value?.length === 3).toBe(true);
    const server = (await c.c.query(unsafeRef("messages:list"), { channel: "c" })) as Msg[];
    expect(server.map((m) => m.body)).toEqual(["Olá, ação!", "segunda mensagem", "escrita sem rede"]);
    expect(listC()!.value).toEqual(server);
    await c.c.flushStorage();
    c.c.close();

    // 6. the replica converged: a last offline reload shows the server state, no pending left
    const d = client(false);
    await d.c.ready();
    expect(d.c.connectionState().pendingMutations).toBe(0);
    const listD = watch<Msg[]>(d.c, "messages:list", { channel: "c" });
    const searchD = watch<string[]>(d.c, "messages:search", { q: "sem rede" });
    await expect.poll(() => listD()?.status === "success" && searchD()?.status === "success").toBe(true);
    expect(listD()!.value).toEqual(server);
    expect(searchD()!.value).toEqual(["escrita sem rede"]);
    d.c.close();
    expect(errors).toEqual([]);
  });
});
