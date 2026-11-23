// Frames per operation (each client frame is one Durable Object event): pipelined subscriptions in one array frame
// (optimistically before `ready`, with a fallback for servers without "batch"), coalesced and piggybacked acks, a
// `sub` and the `unsub` it replaces in one frame, one-shot queries in the turn's frame, and no `auth` frame (nor a
// refresh every second) for a token that did not change.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmberError, unsafeRef, type QuerySnapshot } from "../src/index.ts";
import type { ClientMessage } from "../src/protocol.ts";
import type { FakeSocket } from "../src/testing.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

const list = unsafeRef<"query">("messages:list");
const send = unsafeRef<"mutation">("messages:send");
const msgs = (ws: FakeSocket, t: ClientMessage["t"]) => ws.sent.filter((m): m is ClientMessage => m !== "ping" && typeof m === "object" && m.t === t);

afterEach(() => {
  vi.useRealTimers();
});

describe("pipelined subscriptions", () => {
  it("go in one array frame right after hello, on the first connection and on reconnects", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server);
    const seen = new Map<string, unknown>();
    for (let i = 0; i < 10; i++) client.subscribe(list, { channel: `c${i}` }, {}, (s) => s.value && seen.set(`c${i}`, s.value));
    await until(() => seen.size === 10);
    const ws = server.open()[0]!;
    // hello + one frame with the 10 subs.
    expect(ws.framesIn).toBe(2);
    expect(ws.batchesIn).toBe(1);
    expect(msgs(ws, "sub")).toHaveLength(10);
    ws.drop();
    await until(() => server.open().length === 1 && server.subscriptionCount() === 10);
    const again = server.open()[0]!;
    expect(again.framesIn).toBe(2);
    client.close();
  });

  it("a server without \"batch\" refuses the array: the subs go again one by one, nothing is reported", async () => {
    const server = messagesServer({ batch: false });
    const errors: EmberError[] = [];
    const client = makeClient(server, { onError: (e) => errors.push(e) });
    const seen = new Map<string, unknown>();
    for (let i = 0; i < 5; i++) client.subscribe(list, { channel: `o${i}` }, {}, (s) => s.status === "success" && seen.set(`o${i}`, s.value));
    await until(() => seen.size === 5);
    const ws = server.open()[0]!;
    // hello, the refused array, then 5 single subs.
    expect(ws.framesIn).toBe(7);
    expect(server.subscriptionCount()).toBe(5);
    await tick(5);
    expect(errors).toEqual([]);
    // The next socket of this shard knows: no array before `ready` any more.
    ws.drop();
    await until(() => server.open().length === 1 && server.subscriptionCount() === 5);
    const again = server.open()[0]!;
    expect(again.framesIn).toBe(6);
    expect(again.sent.some((m) => typeof m === "string" && m.startsWith("["))).toBe(false);
    expect(errors).toEqual([]);
    client.close();
  });

  it("a server without \"batch\" refuses an array holding an unsub whose sub went alone: the unsub goes again", async () => {
    const server = messagesServer({ batch: false });
    const Base = server.WebSocket;
    let first: FakeSocket | undefined;
    // The first socket's `ready` is held: what the client sends meanwhile is pipelined.
    const WS = class extends Base {
      constructor(url: string) {
        super(url);
        if (!first) {
          first = this;
          this.hold();
        }
      }
    };
    const errors: EmberError[] = [];
    const client = makeClient(server, { WebSocket: WS, onError: (e) => errors.push(e) });
    const offA = client.subscribe(list, { channel: "a" }, {}, () => {});
    await until(() => first && msgs(first, "sub").length === 1);
    const ws = first!;
    expect(ws.subs.size).toBe(1);
    // Next turn, still before `ready`: the unsub of a and the sub of b go together, as an array the server refuses.
    offA();
    client.subscribe(list, { channel: "b" }, {}, () => {});
    await until(() => ws.sent.some((m) => typeof m === "string" && m.startsWith("[")));
    ws.release();
    await until(() => msgs(ws, "unsub").length === 1 && msgs(ws, "sub").length === 2);
    await tick(5);
    // Only b is left on the server.
    expect(ws.subs.size).toBe(1);
    expect(msgs(ws, "sub").at(-1)).toMatchObject({ args: { channel: "b" } });
    expect(errors).toEqual([]);
    client.close();
  });

  it("a rollback to a runtime without \"batch\" nor \"ident\": the array with tagged resumes is refused once, subs resent", async () => {
    const server = messagesServer({ batch: true, ident: true });
    const errors: EmberError[] = [];
    const client = makeClient(server, { onError: (e) => errors.push(e), auth: () => "user:amy" });
    const a: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "a" }, {}, (s) => a.push(s));
    client.subscribe(list, { channel: "b" }, {}, () => {});
    await until(() => a.at(-1)?.status === "success" && server.subscriptionCount() === 2);
    // Same epoch, older runtime: it refuses array frames and `resume.ik` alike (one qid-less bad_frame each).
    const opts = (server as unknown as { opts: { batch?: boolean; ident?: boolean } }).opts;
    opts.batch = false;
    opts.ident = false;
    server.open()[0]!.drop();
    await until(() => server.open().length === 1 && server.subscriptionCount() === 2);
    const ws = server.open()[0]!;
    expect(ws.sent.filter((m) => typeof m === "string" && m.startsWith("["))).toHaveLength(1);
    expect(msgs(ws, "sub").every((m) => !(m as Extract<ClientMessage, { t: "sub" }>).resume?.ik)).toBe(true);
    await tick(5);
    expect(errors).toEqual([]);
    expect(a.at(-1)).toMatchObject({ status: "success", value: [] });
    client.close();
  });
});

describe("one frame per turn", () => {
  it("a sub and the unsub it replaces (same tick) share one frame", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server);
    let done = false;
    const off = client.subscribe(list, { channel: "a" }, {}, (s) => {
      if (s.status === "success") done = true;
    });
    await until(() => done);
    const ws = server.open()[0]!;
    const before = ws.framesIn;
    off();
    client.subscribe(list, { channel: "b" }, {}, () => {});
    await until(() => msgs(ws, "unsub").length === 1);
    expect(ws.framesIn - before).toBe(1);
    expect(ws.sent.slice(-2)).toMatchObject([{ t: "sub", args: { channel: "b" } }, { t: "unsub" }]);
    client.close();
  });

  it("a one-shot query goes in the frame of the mutations sent in the same turn", async () => {
    const server = messagesServer({ batch: true, query: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    const ws = server.open()[0]!;
    await tick();
    const before = ws.framesIn;
    await Promise.all([client.mutation(send, { channel: "x", body: "a" }), client.mutation(send, { channel: "x", body: "b" }), client.query(unsafeRef("messages:count"), {})]);
    expect(ws.framesIn - before).toBe(1);
    expect(msgs(ws, "q")).toHaveLength(1);
    client.close();
  });
});

describe("a send that throws without closing the socket", () => {
  it("the one-shot query in that frame falls back to HTTP, its acks wait again and the socket is replaced", async () => {
    const server = messagesServer({ batch: true, ack: true, query: true });
    const client = makeClient(server);
    const seen: unknown[] = [];
    client.subscribe(list, { channel: "x" }, {}, (s) => s.value && seen.push(s.value));
    await until(() => client.connectionState().shards[SHARD] === "open");
    await client.mutation(send, { channel: "x", body: "one" });
    await tick(10);
    const ws = server.open()[0]!;
    expect(msgs(ws, "ack")).toHaveLength(0); // waiting for its timer or the next frame
    // The frame with the query (and the ack riding along) is lost; the platform still reports the socket open.
    vi.spyOn(ws, "send").mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    expect(await client.query(unsafeRef("messages:count"), {}, { transport: "socket" })).toBe(1);
    expect(server.httpRequests).toHaveLength(1);
    expect(msgs(ws, "q")).toHaveLength(0);
    // No query left behind on the dropped socket (it would keep the shard's socket needed forever).
    expect((client as unknown as { conns: Map<string, { queries: Map<string, unknown> }> }).conns.get(SHARD)!.queries.size).toBe(0);
    expect(ws.readyState).toBe(3);
    // The next socket resubscribes, and the ack lost with the frame rides with its next frame.
    await until(() => server.open().length === 1 && server.subscriptionCount() === 1);
    const again = server.open()[0]!;
    expect(again).not.toBe(ws);
    await client.mutation(send, { channel: "x", body: "two" });
    await until(() => msgs(again, "ack").length >= 1);
    expect((msgs(again, "ack")[0] as Extract<ClientMessage, { t: "ack" }>).mids).toHaveLength(1);
    await until(() => JSON.stringify(seen.at(-1)) === JSON.stringify(["one", "two"]));
    client.close();
  });

  it("nothing more goes out on it in the same loop (a later batch could run under an identity whose auth was lost)", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    await tick();
    const ws = server.open()[0]!;
    vi.spyOn(ws, "send").mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    // Three full frames' worth in one turn: the first (full) frame throws, the second fills up in the same loop.
    const all = Array.from({ length: 2 * 512 + 1 }, (_, i) => client.mutation(send, { channel: "x", body: `m${i}` }));
    expect(msgs(ws, "mut")).toHaveLength(0);
    expect(ws.readyState).toBe(1); // still reported open: only dropped after the loop
    await Promise.all(all);
    expect(msgs(ws, "mut")).toHaveLength(0);
    const again = server.open()[0]!;
    expect(again).not.toBe(ws);
    expect(msgs(again, "mut")).toHaveLength(2 * 512 + 1);
    client.close();
  });

  it("a one-shot query queued before a sign-in is not retried over HTTP with the new identity's token", async () => {
    const server = messagesServer({ batch: true, query: true });
    const client = makeClient(server, { auth: () => "user:amy" });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    await tick();
    const ws = server.open()[0]!;
    vi.spyOn(ws, "send").mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    const q = client.query(unsafeRef("users:me"), {}, { transport: "socket" });
    client.setAuth(() => "user:bob"); // same turn: the query's frame is still waiting for the flush
    await expect(q).rejects.toMatchObject({ code: "identity_changed" });
    expect(server.httpRequests.filter((r) => r.path === "/api/query")).toHaveLength(0);
    client.close();
  });
});

describe("a mutation discarded before the turn's frame goes out", () => {
  it("is taken out of the frame: the server never runs it", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    await tick();
    const ws = server.open()[0]!;
    // Hold the end-of-turn flush (it is two microtasks away) until the discard has run.
    const held: Array<() => void> = [];
    vi.stubGlobal("queueMicrotask", (f: () => void) => held.push(f));
    let kept: Promise<unknown>;
    let gone: Promise<unknown>;
    try {
      kept = client.mutation(send, { channel: "x", body: "kept" });
      gone = client.mutation(send, { channel: "x", body: "gone" });
      const pending = (client as unknown as { pending: Array<{ record: { args: { body: string } } }> }).pending;
      expect(pending.map((p) => p.record.args.body)).toEqual(["kept", "gone"]);
      // Only "gone" is discarded (as `discardPending` does for each).
      const p = pending[1]!;
      (client as unknown as { drop(p: unknown, e: EmberError): void }).drop(p, new EmberError("discarded", "pending mutation discarded"));
      expect(msgs(ws, "mut")).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
    for (const f of held) f();
    await expect(gone).rejects.toMatchObject({ code: "discarded" });
    await kept;
    expect(msgs(ws, "mut").map((m) => (m as Extract<ClientMessage, { t: "mut" }>).args.body)).toEqual(["kept"]);
    expect(server.subscriptionCount()).toBe(1);
    client.close();
  });

  it("discardPending in the same turn: nothing of it goes out", async () => {
    const server = messagesServer({ batch: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    await tick();
    const ws = server.open()[0]!;
    const before = ws.framesIn;
    const held: Array<() => void> = [];
    vi.stubGlobal("queueMicrotask", (f: () => void) => held.push(f));
    let m: Promise<unknown>;
    let n: Promise<number>;
    try {
      m = client.mutation(send, { channel: "x", body: "a" });
      m.catch(() => undefined);
      n = client.discardPending();
      expect(await n).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
    for (const f of held) f();
    await expect(m).rejects.toMatchObject({ code: "discarded" });
    await tick(10);
    expect(msgs(ws, "mut")).toHaveLength(0);
    expect(ws.framesIn - before).toBe(0);
    client.close();
  });
});

describe("acks (feature \"ack\")", () => {
  it("are coalesced and ride with the next frame going out", async () => {
    const server = messagesServer({ batch: true, ack: true, query: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    const ws = server.open()[0]!;
    await tick();
    const acked = () => msgs(ws, "ack").flatMap((m) => (m as Extract<ClientMessage, { t: "ack" }>).mids).length;
    let before = ws.framesIn;
    // One after the other: each mutation's frame carries the ack of the one before (no frame of its own).
    for (let i = 0; i < 5; i++) await client.mutation(send, { channel: "x", body: `m${i}` });
    await tick(10);
    expect(ws.framesIn - before).toBe(5);
    expect(acked()).toBe(4);
    // The last one waits (2 s at most) and rides with the next frame going out.
    before = ws.framesIn;
    void client.query(unsafeRef("messages:count"), {}, { transport: "socket" });
    await until(() => acked() === 5);
    expect(ws.framesIn - before).toBe(1);
    client.close();
  });

  it("go out on their own after 2 s, and at once at 64 waiting", async () => {
    const server = messagesServer({ batch: true, ack: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    const ws = server.open()[0]!;
    await Promise.all(Array.from({ length: 64 }, (_, i) => client.mutation(send, { channel: "x", body: `b${i}` })));
    await until(() => msgs(ws, "ack").length === 1);
    expect((msgs(ws, "ack")[0] as Extract<ClientMessage, { t: "ack" }>).mids).toHaveLength(64);
    await client.mutation(send, { channel: "x", body: "late" });
    await tick(50);
    expect(msgs(ws, "ack")).toHaveLength(1);
    await until(() => msgs(ws, "ack").length === 2, 3000);
    client.close();
  });

  it("waiting acks go out before an idle socket closes, and on close()", async () => {
    const server = messagesServer({ batch: true, ack: true });
    const client = makeClient(server, { idleTimeoutMs: 20 });
    await client.mutation(send, { channel: "x", body: "one" });
    const ws = server.history[0]!;
    await until(() => ws.readyState === 3);
    expect(msgs(ws, "ack")).toHaveLength(1);
    const c2 = makeClient(server);
    c2.subscribe(list, { channel: "x" }, {}, () => {});
    await c2.mutation(send, { channel: "x", body: "two" });
    await tick(10);
    const ws2 = server.history.at(-1)!;
    expect(msgs(ws2, "ack")).toHaveLength(0);
    c2.close();
    expect(msgs(ws2, "ack")).toHaveLength(0); // delivered on the next microtask
    await tick();
    expect(msgs(ws2, "ack")).toHaveLength(1);
    client.close();
  });

  it("on close(), acks and what the turn queued go out as one array frame the server still reads whole", async () => {
    const server = messagesServer({ batch: true, ack: true, query: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await client.mutation(send, { channel: "x", body: "one" });
    await tick(10);
    const ws = server.open()[0]!;
    const batches = ws.batchesIn;
    void client.query(unsafeRef("messages:count"), {}, { transport: "socket" }).catch(() => undefined);
    client.close();
    await tick();
    expect(ws.batchesIn - batches).toBe(1);
    expect(msgs(ws, "ack")).toHaveLength(1);
    expect(msgs(ws, "q")).toHaveLength(1);
  });

  it("a socket that drops before they go leaves them to the next socket of the same identity", async () => {
    const server = messagesServer({ batch: true, ack: true });
    const client = makeClient(server, { auth: () => "user:dan" });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await client.mutation(send, { channel: "x", body: "one" });
    await tick(10);
    const ws = server.open()[0]!;
    expect(msgs(ws, "ack")).toHaveLength(0);
    ws.drop();
    await until(() => server.open().length === 1 && server.subscriptionCount() === 1);
    const again = server.open()[0]!;
    // Carried over: they ride with the next frame (here a mutation), not one of their own.
    const before = again.framesIn;
    await client.mutation(send, { channel: "x", body: "two" });
    expect(again.framesIn - before).toBe(1);
    expect(msgs(again, "ack").flatMap((m) => (m as Extract<ClientMessage, { t: "ack" }>).mids)).toHaveLength(1);
    client.close();
  });

  it("acks of two sockets that dropped in a row, same identity, are kept together for the next one", async () => {
    const server = messagesServer({ batch: true, ack: true });
    const client = makeClient(server, { auth: () => "user:dan" });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    type AckConn = { gen: number; authGen: number; ready: boolean; acks?: string[] };
    const c = client as unknown as { conns: Map<string, AckConn>; queueAck(conn: AckConn, gen: number, auth: number, mid: string, version?: number): void };
    const conn = c.conns.get(SHARD)!;
    const auth = conn.authGen;
    const ws = server.open()[0]!;
    ws.drop();
    await until(() => !conn.ready);
    // An ack restored for socket 2, then a late one (storage removal finishing) from socket 1, while disconnected.
    c.queueAck(conn, conn.gen, auth, "m2");
    c.queueAck(conn, conn.gen - 1, auth, "m1");
    expect(conn.acks).toEqual(["m2", "m1"]);
    await until(() => server.open().length === 1 && server.subscriptionCount() === 1);
    const again = server.open()[0]!;
    await client.mutation(send, { channel: "x", body: "two" });
    await until(() => msgs(again, "ack").length >= 1);
    expect(msgs(again, "ack").flatMap((m) => (m as Extract<ClientMessage, { t: "ack" }>).mids)).toEqual(expect.arrayContaining(["m2", "m1"]));
    client.close();
  });

  it("are not carried to a socket of another identity; on an open socket they go before the identity's auth frame", async () => {
    const server = messagesServer({ batch: true, ack: true });
    const client = makeClient(server, { auth: () => "user:dan" });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await client.mutation(send, { channel: "x", body: "one" });
    await tick(10);
    const ws = server.open()[0]!;
    // Switching users on the open socket: the ack goes first, then `auth`.
    client.setAuth(() => "user:eve");
    await until(() => msgs(ws, "auth").length === 1);
    const order = ws.sent.filter((m) => m !== "ping" && typeof m === "object" && (m.t === "ack" || m.t === "auth")).map((m) => (m as ClientMessage).t);
    expect(order).toEqual(["ack", "auth"]);
    // A drop, then another user before the next socket: eve's waiting ack is not sent as amy's.
    await client.mutation(send, { channel: "x", body: "two" });
    await tick(10);
    ws.drop();
    client.setAuth(() => "user:amy");
    await until(() => server.open().length === 1 && server.subscriptionCount() === 1);
    const again = server.open()[0]!;
    await client.mutation(send, { channel: "x", body: "three" });
    await tick(10);
    expect(msgs(again, "ack")).toHaveLength(0);
    client.close();
  });

  it("acks that did not fit in a full frame keep the busy-shard guard (out early, not after 2 s)", async () => {
    const server = messagesServer({ batch: true, ack: true });
    const client = makeClient(server);
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await client.mutation(send, { channel: "x", body: "one" });
    await tick(10);
    const ws = server.open()[0]!;
    // One turn fills a frame (512 messages): the waiting ack has no room and is queued again.
    for (let i = 0; i < 512; i++) client.subscribe(list, { channel: `full${i}` }, {}, () => {});
    await until(() => server.subscriptionCount() === 513);
    expect(msgs(ws, "ack")).toHaveLength(0);
    // The shard moves 64 versions past it: the ack goes now.
    const other = makeClient(server);
    const started = Date.now();
    for (let i = 0; i < 65; i++) await other.mutation(send, { channel: "x", body: `o${i}` });
    await until(() => msgs(ws, "ack").length === 1, 1500);
    expect(Date.now() - started).toBeLessThan(1900);
    other.close();
    client.close();
  });

  it("go out when the page is hidden (connectivity \"background\")", async () => {
    const server = messagesServer({ batch: true, ack: true });
    let emit: (e: "background") => void = () => {};
    const client = makeClient(server, { connectivity: { subscribe: (e) => ((emit = e), () => {}) } });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await client.mutation(send, { channel: "x", body: "one" });
    await tick(10);
    const ws = server.open()[0]!;
    expect(msgs(ws, "ack")).toHaveLength(0);
    emit("background");
    await tick();
    expect(msgs(ws, "ack")).toHaveLength(1);
    client.close();
  });

  it("queued in this turn's frame when the socket closes before it goes out, they wait for the next socket", async () => {
    const server = messagesServer({ batch: true, ack: true });
    let emit: (e: "background") => void = () => {};
    const client = makeClient(server, { connectivity: { subscribe: (e) => ((emit = e), () => {}) } });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await client.mutation(send, { channel: "x", body: "one" });
    await tick(10);
    const ws = server.open()[0]!;
    // An `ack` frame queued for this turn's flush (`flushOut` waits two microtasks): the socket closes first.
    (client as unknown as { flushAcks(c: unknown): void }).flushAcks((client as unknown as { conns: Map<string, unknown> }).conns.get(SHARD));
    ws.close();
    await tick();
    expect(msgs(ws, "ack")).toHaveLength(0);
    await until(() => server.open().length === 1 && server.open()[0] !== ws && server.subscriptionCount() === 1);
    const again = server.open()[0]!;
    emit("background");
    await until(() => msgs(again, "ack").length === 1);
    expect((msgs(again, "ack")[0] as Extract<ClientMessage, { t: "ack" }>).mids).toHaveLength(1);
    client.close();
  });

  it("queued in this turn's frame when the socket closes just before the flush (its close event not run yet), they wait too", async () => {
    const server = messagesServer({ batch: true, ack: true });
    let emit: (e: "background") => void = () => {};
    const client = makeClient(server, { connectivity: { subscribe: (e) => ((emit = e), () => {}) } });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await client.mutation(send, { channel: "x", body: "one" });
    await tick(10);
    const ws = server.open()[0]!;
    (client as unknown as { flushAcks(c: unknown): void }).flushAcks((client as unknown as { conns: Map<string, unknown> }).conns.get(SHARD));
    queueMicrotask(() => ws.close()); // before the deferred flush (two microtasks)
    await tick();
    expect(msgs(ws, "ack")).toHaveLength(0);
    await until(() => server.open().length === 1 && server.open()[0] !== ws && server.subscriptionCount() === 1);
    const again = server.open()[0]!;
    emit("background");
    await until(() => msgs(again, "ack").length === 1);
    expect((msgs(again, "ack")[0] as Extract<ClientMessage, { t: "ack" }>).mids).toHaveLength(1);
    client.close();
  });

  it("sent on their own (timer, threshold, page hidden) and lost with a send that throws, they wait for the next socket", async () => {
    const server = messagesServer({ batch: true, ack: true });
    let emit: (e: "background") => void = () => {};
    const client = makeClient(server, { connectivity: { subscribe: (e) => ((emit = e), () => {}) } });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await client.mutation(send, { channel: "x", body: "one" });
    await tick(10);
    const ws = server.open()[0]!;
    expect(msgs(ws, "ack")).toHaveLength(0);
    vi.spyOn(ws, "send").mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    emit("background"); // an `ack` frame of its own: lost
    await tick();
    expect(msgs(ws, "ack")).toHaveLength(0);
    await until(() => server.open().length === 1 && server.open()[0] !== ws && server.subscriptionCount() === 1);
    const again = server.open()[0]!;
    emit("background");
    await until(() => msgs(again, "ack").length === 1);
    expect((msgs(again, "ack")[0] as Extract<ClientMessage, { t: "ack" }>).mids).toHaveLength(1);
    client.close();
  });
});

/** A fake JWT (`header.payload.sig`) the fake server's `verify` reads. */
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (sub: string, exp: number, extra: Record<string, unknown> = {}) => `${b64({ alg: "none" })}.${b64({ sub, exp, ...extra })}.sig`;
const verify = (token: string) => {
  const p = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { sub: string; exp: number };
  return { subject: p.sub, exp: p.exp };
};

describe("auth refresh", () => {
  it("a refresh that gets the same token back sends no auth frame; a new token is sent once", async () => {
    const server = messagesServer({ verify });
    let token = jwt("amy", Math.floor(Date.now() / 1000) + 3600);
    const client = makeClient(server, { auth: () => token });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    const ws = server.open()[0]!;
    const refresh = () => (client as unknown as { reauthAll(identityChanged: boolean): Promise<void> }).reauthAll(false);
    await refresh();
    await refresh();
    await tick();
    expect(msgs(ws, "auth")).toHaveLength(0);
    token = jwt("amy", Math.floor(Date.now() / 1000) + 7200);
    await refresh();
    await refresh();
    await tick();
    expect(msgs(ws, "auth")).toEqual([{ t: "auth", token }]);
    client.close();
  });

  it("an expired token the fetcher hands back again is not resent (no auth/sub bounce loop): the sub shows the error", async () => {
    // The fake server reads this clock: the token is valid for the first sub and expired (by +2 s) for the second.
    let clock = Date.now();
    const server = messagesServer({ now: () => clock });
    const token = `user:amy:${Math.floor(clock / 1000) + 1}`;
    const errors: EmberError[] = [];
    const client = makeClient(server, { auth: () => token, onError: (e) => errors.push(e), refreshAuthBeforeExpiryMs: false });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    const ws = server.open()[0]!;
    expect(errors).toHaveLength(0);
    clock += 2_000;
    const seen: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "late" }, {}, (s) => seen.push(s));
    await until(() => seen.at(-1)?.status === "error");
    await tick(20);
    expect(msgs(ws, "auth")).toHaveLength(0);
    expect(msgs(ws, "sub").filter((m) => (m as Extract<ClientMessage, { t: "sub" }>).args.channel === "late")).toHaveLength(1);
    expect(errors.map((e) => e.code)).toContain("auth_expired");
    client.close();
  });

  it("a sub refused as expired with no fresh token yet is sent again once a fresh token goes out on the open socket", async () => {
    let clock = Date.now();
    const server = messagesServer({ now: () => clock });
    let token = `user:amy:${Math.floor(clock / 1000) + 1}`;
    const client = makeClient(server, { auth: () => token, refreshAuthBeforeExpiryMs: false });
    client.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => server.subscriptionCount() === 1);
    const ws = server.open()[0]!;
    clock += 2_000;
    const seen: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "late" }, {}, (s) => seen.push(s));
    await until(() => seen.at(-1)?.status === "error");
    // A fresh token later (a refresh, a sign-in): the refused sub goes again under it, on the same socket.
    token = `user:amy:${Math.floor(clock / 1000) + 3600}`;
    await (client as unknown as { reauthAll(identityChanged: boolean): Promise<void> }).reauthAll(false);
    await until(() => seen.at(-1)?.status === "success");
    expect(server.open()[0]).toBe(ws);
    expect(msgs(ws, "auth")).toEqual([{ t: "auth", token }]);
    expect(msgs(ws, "sub").filter((m) => (m as Extract<ClientMessage, { t: "sub" }>).args.channel === "late")).toHaveLength(2);
    client.close();
  });

  it("backs off while the fetcher keeps returning the same token (2 s, 4 s, ... up to 30 s), and resets on a new one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = messagesServer({ verify });
    let token = jwt("amy", Math.floor(Date.now() / 1000) + 20); // inside the 30 s refresh window already
    let calls = 0;
    const client = makeClient(server, { auth: () => (calls++, token) });
    await (client as unknown as { fetchToken(): Promise<string | null> }).fetchToken();
    calls = 0;
    // The old loop asked every second: 60 times a minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(6);
    token = jwt("amy", Math.floor(Date.now() / 1000) + 3600);
    calls = 0;
    await vi.advanceTimersByTimeAsync(31_000);
    // The new token: no refresh until 30 s before its exp.
    calls = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(0);
    client.close();
  });
});
