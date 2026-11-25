// `httpFirst` fetches of one turn for one shard go out as one `POST /api/query/batch` (feature "qbatch"); an older
// runtime (no batch) gets `POST /api/query` per query, after one refused try.
import { describe, expect, it } from "vitest";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";
import { unsafeRef, type QuerySnapshot } from "../src/index.ts";
import type { FakeEmberServer, FakeServerOptions } from "../src/testing.ts";

const list = unsafeRef("messages:list");
const me = unsafeRef("users:me");
const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, "")}.sig`;
const subjectOf = (t: string) => (JSON.parse(atob(t.split(".")[1]!)) as { sub: string }).sub;
const verify = (t: string) => ({ subject: subjectOf(t) });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** `neverOpen`: once seeded, sockets stay opening (every subscription of the test is made while they are). */
async function seeded(opts: FakeServerOptions = {}, neverOpen = false) {
  const server = messagesServer({ ident: true, query: true, batch: true, openDelayMs: 10, ...opts });
  const writer = makeClient(server);
  await writer.mutation(unsafeRef("messages:send"), { channel: "x", body: "hello" });
  await writer.mutation(unsafeRef("messages:send"), { channel: "y", body: "world" });
  writer.close();
  if (neverOpen) (server as unknown as { opts: FakeServerOptions }).opts.openDelayMs = 3_600_000;
  return server;
}

/** A fetch whose `/api/query*` answers wait until the test releases them; the requests and their signals. */
function heldFetch(server: FakeEmberServer) {
  const held: Array<{ path: string; body: any; authorization: string | null; signal: AbortSignal | undefined; release: () => void }> = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.startsWith("/api/query")) return server.fetch(input, init);
    const d = deferred<Response>();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const signal = init?.signal ?? undefined;
    let done = false;
    signal?.addEventListener("abort", () => {
      if (!done) d.resolve(Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })) as never);
    });
    held.push({
      path: url.pathname,
      body: JSON.parse(String(init?.body)),
      authorization: headers.authorization ?? null,
      signal,
      release: () => {
        done = true;
        void server.fetch(input, init).then(d.resolve);
      },
    });
    return d.promise;
  };
  return { fetch, held };
}

const subsSent = (server: FakeEmberServer) => server.open().flatMap((ws) => ws.sent.filter((m) => m !== "ping" && m.t === "sub"));

describe("httpFirst batched", () => {
  it("N subscriptions of one turn: one POST /api/query/batch, then the subs resume from it (unchanged)", async () => {
    const server = await seeded({ queryBatch: true });
    const before = server.httpRequests.length;
    const client = makeClient(server, { httpFirst: true });
    const seen = new Map<string, unknown>();
    for (const channel of ["x", "y", "z"]) client.subscribe(list, { channel }, {}, (s) => s.status === "success" && seen.set(channel, s.value));
    await until(() => seen.size === 3);
    expect(seen).toEqual(new Map<string, unknown>([["x", ["hello"]], ["y", ["world"]], ["z", []]]));
    const reqs = server.httpRequests.slice(before);
    expect(reqs.map((r) => r.path)).toEqual(["/api/query/batch"]);
    expect((reqs[0]!.body as any).queries).toEqual([
      { fn: "messages:list", args: { channel: "x" }, warm: true },
      { fn: "messages:list", args: { channel: "y" }, warm: true },
      { fn: "messages:list", args: { channel: "z" }, warm: true },
    ]);
    expect((reqs[0]!.body as any).shard).toBe(SHARD);
    await until(() => server.open()[0]?.received.filter((m) => m !== "pong" && m.t === "snap").length === 3);
    const ws = server.open()[0]!;
    for (const m of ws.received) if (m !== "pong" && m.t === "snap") expect(m).toMatchObject({ unchanged: true });
    for (const s of subsSent(server)) expect(s).toMatchObject({ resume: { version: expect.any(Number), epoch: expect.any(String), ik: expect.any(String) } });
    // The ready confirmed "qbatch".
    expect((client as unknown as { queryBatch: boolean | undefined }).queryBatch).toBe(true);
    client.close();
  });

  it("an older runtime: the batch is refused once, then POST /api/query per query", async () => {
    const server = await seeded();
    const before = server.httpRequests.length;
    const client = makeClient(server, { httpFirst: true });
    const seen = new Map<string, unknown>();
    client.subscribe(list, { channel: "x" }, {}, (s) => s.status === "success" && seen.set("x", s.value));
    client.subscribe(list, { channel: "y" }, {}, (s) => s.status === "success" && seen.set("y", s.value));
    await until(() => seen.size === 2);
    expect(server.httpRequests.slice(before).map((r) => r.path)).toEqual(["/api/query/batch", "/api/query", "/api/query"]);
    expect(seen).toEqual(new Map<string, unknown>([["x", ["hello"]], ["y", ["world"]]]));
    await until(() => subsSent(server).length === 2);
    // Known now: another shard's fetches go one by one, with no second try.
    const mark = server.httpRequests.length;
    client.subscribe(list, { channel: "x" }, { shard: "org:other" }, () => {});
    client.subscribe(list, { channel: "y" }, { shard: "org:other" }, () => {});
    await until(() => server.httpRequests.length - mark === 2);
    expect(server.httpRequests.slice(mark).map((r) => r.path)).toEqual(["/api/query", "/api/query"]);
    client.close();
  });

  it("errors are per query: the failing one gets its error from the socket, the others their value", async () => {
    const server = await seeded({ queryBatch: true });
    const client = makeClient(server, { httpFirst: true });
    const seen: QuerySnapshot[] = [];
    let boom: QuerySnapshot | undefined;
    client.subscribe(list, { channel: "x" }, {}, (s) => s.status === "success" && seen.push(s));
    client.subscribe(unsafeRef("boom:query"), {}, {}, (s) => (boom = s));
    await until(() => seen.length === 1 && boom?.status === "error");
    expect(seen[0]!.value).toEqual(["hello"]);
    expect(boom).toMatchObject({ status: "error", error: { code: "nope" } });
    client.close();
  });

  it("unsubscribing one query keeps the batch going for the others; closing cancels it", async () => {
    const server = await seeded({ queryBatch: true }, true);
    const { fetch, held } = heldFetch(server);
    const client = makeClient(server, { httpFirst: true, fetch });
    const gone: QuerySnapshot[] = [];
    const off = client.subscribe(list, { channel: "x" }, {}, (s) => gone.push(s));
    const seen: unknown[] = [];
    client.subscribe(list, { channel: "y" }, {}, (s) => s.status === "success" && seen.push(s.value));
    await until(() => held.length === 1);
    expect(held[0]!.path).toBe("/api/query/batch");
    off();
    await tick();
    expect(held[0]!.signal?.aborted).toBe(false);
    held[0]!.release();
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual(["world"]);
    // The batch answered "x" too: the unsubscribed query never gets it.
    await tick(20);
    expect(gone.filter((s) => s.status === "success")).toEqual([]);
    expect(client.localQueryResult(list, { channel: "x" })?.value).toBeUndefined();
    // Closing with a batch in flight cancels it.
    client.subscribe(list, { channel: "a" }, { shard: "org:b" }, () => {});
    client.subscribe(list, { channel: "b" }, { shard: "org:b" }, () => {});
    await until(() => held.length === 2);
    client.close();
    expect(held[1]!.signal?.aborted).toBe(true);
  });

  it("an answer that comes after the identity changed is dropped for every query of the batch", async () => {
    const server = await seeded({ queryBatch: true, verify });
    server.refuseConnections = 1_000_000;
    const { fetch, held } = heldFetch(server);
    let who = "alice";
    const client = makeClient(server, { httpFirst: true, fetch, auth: () => jwt(who), backoff: { initialMs: 5, maxMs: 5 } });
    // Alice's token is known (a first subscription's connect attempts fetched it); the socket keeps failing to open.
    client.subscribe(unsafeRef("messages:count"), {}, {}, () => {});
    await until(() => server.history.length >= 2);
    held.length = 0;
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    client.subscribe(list, { channel: "x" }, {}, (s) => seen.push(s));
    await until(() => held.length === 1);
    expect(held[0]).toMatchObject({ path: "/api/query/batch", authorization: `Bearer ${jwt("alice")}` });
    who = "bob";
    await tick(60); // reconnect attempts fetch bob's token
    held[0]!.release();
    await tick(20);
    expect(seen.filter((s) => s.status === "success")).toEqual([]);
    expect(client.localQueryResult(me, {})?.value).toBeUndefined();
    client.close();
  });

  it("a setAuth in the same turn: nothing of the old identity is sent in the batch, the subscriptions follow the new one", async () => {
    const turn = async (switchUser: boolean) => {
      const server = await seeded({ queryBatch: true, verify });
      const { fetch, held } = heldFetch(server);
      const client = makeClient(server, { httpFirst: true, fetch, auth: () => jwt("alice") });
      await (client as unknown as { fetchToken(): Promise<string | null> }).fetchToken();
      let who: unknown;
      let x: unknown;
      client.subscribe(me, {}, {}, (s) => s.status === "success" && (who = s.value));
      client.subscribe(list, { channel: "x" }, {}, (s) => s.status === "success" && (x = s.value));
      if (switchUser) client.setAuth(() => jwt("bob"));
      // Held HTTP answers never come: the values below came over the socket (its ready cancels the fetches).
      await until(() => who !== undefined && x !== undefined);
      client.close();
      return { sent: held.map((h) => [h.path, h.authorization]), who, x };
    };
    // Without the switch, Alice's batch goes; with it, in the same turn, not a byte of hers goes (the items asked
    // under her identity are dropped before the send, not re-sent: the new token is not known yet), and the same
    // subscriptions get Bob's values over the socket.
    expect(await turn(false)).toEqual({ sent: [["/api/query/batch", `Bearer ${jwt("alice")}`]], who: "alice", x: ["hello"] });
    const switched = await turn(true);
    expect(switched.sent.filter(([, a]) => a === `Bearer ${jwt("alice")}`)).toEqual([]);
    expect(switched).toMatchObject({ who: "bob", x: ["hello"] });
  });

  it("a whole-request 401: the subscriptions go over the socket (no per-query retry)", async () => {
    const server = await seeded({ queryBatch: true });
    // The HTTP batch is refused as a whole (401); the socket accepts the same caller.
    const paths: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      paths.push(url.pathname);
      if (url.pathname === "/api/query/batch") return new Response(JSON.stringify({ ok: false, error: { code: "unauthenticated", message: "invalid token" } }), { status: 401, headers: { "content-type": "application/json" } });
      return server.fetch(input, init);
    };
    const client = makeClient(server, { httpFirst: true, fetch });
    const seen = new Map<string, unknown>();
    client.subscribe(list, { channel: "x" }, {}, (s) => s.status === "success" && seen.set("x", s.value));
    client.subscribe(list, { channel: "y" }, {}, (s) => s.status === "success" && seen.set("y", s.value));
    await until(() => seen.size === 2);
    expect(seen).toEqual(new Map<string, unknown>([["x", ["hello"]], ["y", ["world"]]]));
    expect(paths.filter((p) => p.startsWith("/api/query"))).toEqual(["/api/query/batch"]);
    // The values came over the socket, as full snapshots (the 401 gave nothing to resume from).
    expect(subsSent(server).length).toBe(2);
    for (const s of subsSent(server)) expect(s).not.toHaveProperty("resume");
    client.close();
  });

  it("the fake server answers a batch item's current resume with unchanged, as the runtime does", async () => {
    const server = await seeded({ queryBatch: true });
    const post = async (body: unknown) => (await (await server.fetch("http://fake/api/query/batch", { method: "POST", body: JSON.stringify(body) })).json()) as any;
    const first = await post({ shard: SHARD, queries: [{ fn: "messages:list", args: { channel: "x" } }] });
    const { version, epoch, ik } = first.results[0];
    expect(first.results[0]).toMatchObject({ ok: true, value: ["hello"] });
    const again = await post({ shard: SHARD, queries: [{ fn: "messages:list", args: { channel: "x" }, resume: { version, epoch, ik } }, { fn: "messages:list", args: { channel: "y" } }] });
    expect(again.results[0]).toEqual({ ok: true, unchanged: true, version, epoch, ik });
    expect(again.results[1]).toMatchObject({ ok: true, value: ["world"] });
  });
});
