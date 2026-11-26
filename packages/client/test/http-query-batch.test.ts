// `query()` over HTTP and `fetchForHydration()`: the calls of one turn for one shard go out as one
// `POST /api/query/batch` (as `httpFirst` does since #160), each answered with its own entry; a runtime without the
// batch gets them one by one after one refused try.
import { describe, expect, it } from "vitest";
import type { FakeEmberServer } from "../src/testing.ts";
import { makeClient, messagesServer, SHARD } from "./helpers.ts";
import { unsafeRef } from "../src/index.ts";

const list = unsafeRef<"query">("messages:list");
const count = unsafeRef<"query">("messages:count");
const boom = unsafeRef<"query">("boom:query");
const me = unsafeRef<"query">("users:me");
const token = (payload: object) => `h.${btoa(JSON.stringify(payload)).replace(/=+$/, "")}.sig`;
const jwt = (sub: string) => token({ sub });
const verify = (t: string) => {
  const part = t.split(".")[1];
  if (!part) return null;
  try {
    const p = JSON.parse(atob(part)) as { sub: string; old?: boolean };
    // A token marked `old` is one that expired on the way: refused (401), as the Worker refuses it.
    return p.old ? null : { subject: p.sub };
  } catch {
    return null;
  }
};

async function seeded(opts: Parameters<typeof messagesServer>[0] = {}) {
  const server = messagesServer({ ident: true, queryBatch: true, verify, ...opts });
  const writer = makeClient(server);
  await writer.mutation(unsafeRef("messages:send"), { channel: "x", body: "hello" });
  await writer.mutation(unsafeRef("messages:send"), { channel: "y", body: "world" });
  writer.close();
  server.httpRequests.length = 0;
  return server;
}

const paths = (server: { httpRequests: Array<{ path: string }> }) => server.httpRequests.map((r) => r.path);

describe("HTTP queries of one turn go out as one batch per shard", () => {
  it("query(): one POST /api/query/batch for the turn's queries of a shard, one request per shard", async () => {
    const server = await seeded();
    const client = makeClient(server, { WebSocket: null });
    const [x, y, n, other] = await Promise.all([
      client.query(list, { channel: "x" }),
      client.query(list, { channel: "y" }),
      client.query(count, {}),
      client.query(count, {}, { shard: "org:other" }),
    ]);
    expect([x, y, n, other]).toEqual([["hello"], ["world"], 2, 0]);
    // org:acme's three in one request; org:other's alone (a batch of one is a plain query).
    expect(paths(server).sort()).toEqual(["/api/query", "/api/query/batch"]);
    expect(server.httpRequests.find((r) => r.path === "/api/query/batch")!.body).toMatchObject({ shard: SHARD, queries: [{ fn: "messages:list" }, { fn: "messages:list" }, { fn: "messages:count" }] });
    // Another turn: another request.
    expect(await client.query(list, { channel: "x" })).toEqual(["hello"]);
    expect(paths(server)).toHaveLength(3);
    client.close();
  });

  it("one failing query rejects alone; the token goes once for all; an invalid token refuses each as alone", async () => {
    const server = await seeded();
    let current = jwt("ana");
    const client = makeClient(server, { WebSocket: null, auth: () => current });
    const out = await Promise.allSettled([client.query(list, { channel: "x" }), client.query(boom, {}), client.query(me, {})]);
    expect(out[0]).toMatchObject({ status: "fulfilled", value: ["hello"] });
    expect(out[1]).toMatchObject({ status: "rejected", reason: { code: "nope" } });
    expect(out[2]).toMatchObject({ status: "fulfilled", value: "ana" });
    expect(paths(server)).toEqual(["/api/query/batch"]);
    expect(server.httpRequests[0]!.authorization).toBe(`Bearer ${current}`);

    current = "not-a-jwt";
    client.setAuth(() => current);
    const refused = await Promise.allSettled([client.query(list, { channel: "x" }), client.query(me, {})]);
    expect(refused.map((r) => r.status === "rejected" && (r.reason as { code: string }).code)).toEqual(["unauthenticated", "unauthenticated"]);
    client.close();
  });

  it("fetchForHydration(): the turn's reads in one request, each with its version, epoch and identity tag", async () => {
    const server = await seeded();
    const ssr = makeClient(server, { WebSocket: null });
    const hydrated = await Promise.all([ssr.fetchForHydration(list, { channel: "x" }), ssr.fetchForHydration(list, { channel: "y" }), ssr.fetchForHydration(count, {})]);
    expect(paths(server)).toEqual(["/api/query/batch"]);
    expect(hydrated.map((h) => h.value)).toEqual([["hello"], ["world"], 2]);
    for (const h of hydrated) expect(h).toMatchObject({ version: expect.any(Number), epoch: expect.any(String), ik: expect.any(String), shard: SHARD });
    ssr.close();

    // The browser client starts from them and resumes: the shard answers `unchanged`.
    const browser = makeClient(server);
    browser.hydrate(...hydrated);
    const seen: unknown[] = [];
    browser.subscribe(list, { channel: "x" }, {}, (s) => seen.push(s.value));
    expect(seen).toEqual([["hello"]]);
    browser.close();
  });

  it("a runtime without the batch: one refused try, then one request per query from then on", async () => {
    const server = await seeded({ queryBatch: false });
    const client = makeClient(server, { WebSocket: null });
    expect(await Promise.all([client.query(list, { channel: "x" }), client.query(list, { channel: "y" })])).toEqual([["hello"], ["world"]]);
    expect(paths(server)).toEqual(["/api/query/batch", "/api/query", "/api/query"]);
    server.httpRequests.length = 0;
    expect(await Promise.all([client.query(list, { channel: "x" }), client.query(count, {})])).toEqual([["hello"], 2]);
    expect(paths(server)).toEqual(["/api/query", "/api/query"]);
    client.close();
  });

  it("the arguments are the ones of the call: a caller changing its object afterwards changes nothing", async () => {
    const server = await seeded();
    const client = makeClient(server, { WebSocket: null });
    const args = { channel: "x" };
    const pending = [client.query(list, args)];
    args.channel = "y";
    pending.push(client.query(list, args));
    expect(await Promise.all(pending)).toEqual([["hello"], ["world"]]);
    expect(paths(server)).toEqual(["/api/query/batch"]);
    client.close();
  });

  it("an argument that cannot be encoded (a cycle) rejects its query alone; the others of the turn are answered", async () => {
    const server = await seeded();
    const client = makeClient(server, { WebSocket: null });
    const cyclic: Record<string, unknown> = { channel: "x" };
    cyclic.self = cyclic;
    const out = await Promise.allSettled([client.query(list, { channel: "x" }), client.query(list, cyclic), client.query(list, { channel: "y" })]);
    expect(out[0]).toMatchObject({ status: "fulfilled", value: ["hello"] });
    expect(out[1]!.status).toBe("rejected");
    expect(out[2]).toMatchObject({ status: "fulfilled", value: ["world"] });
    client.close();
  });

  const intercept = (server: FakeEmberServer, answer: (path: string) => Response | null) => {
    const real = server.fetch;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      return answer(path) ?? (await real(input, init));
    }) as typeof fetch;
  };

  it("a 401 of the batch renews the token and sends the batch again once; still refused, each query rejects unauthenticated", async () => {
    const server = await seeded();
    const tokens = [token({ sub: "ana", old: true }), jwt("ana")];
    let asked = 0;
    const client = makeClient(server, { WebSocket: null, auth: () => tokens[Math.min(asked++, tokens.length - 1)]! });
    expect(await Promise.all([client.query(me, {}), client.query(list, { channel: "x" })])).toEqual(["ana", ["hello"]]);
    expect(paths(server)).toEqual(["/api/query/batch", "/api/query/batch"]);
    expect(server.httpRequests.map((r) => r.authorization)).toEqual([`Bearer ${tokens[0]}`, `Bearer ${tokens[1]}`]);

    // A fetcher that has nothing better: one try, each query refused with the request's error.
    server.httpRequests.length = 0;
    client.setAuth(() => tokens[0]!);
    const refused = await Promise.allSettled([client.query(me, {}), client.query(list, { channel: "x" })]);
    expect(refused.map((r) => r.status === "rejected" && (r.reason as { code: string }).code)).toEqual(["unauthenticated", "unauthenticated"]);
    expect(paths(server)).toEqual(["/api/query/batch"]);
    client.close();
  });

  it("a server error or 429 of the batch is each query's error; a 413 sends them one by one and keeps the batch", async () => {
    const server = await seeded();
    let refuse: Response | null = null;
    const client = makeClient(server, {
      WebSocket: null,
      fetch: intercept(server, (path) => {
        if (path !== "/api/query/batch" || !refuse) return null;
        const r = refuse;
        refuse = null;
        return r;
      }),
    });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    refuse = json(503, { ok: false, error: { code: "overloaded", message: "try later" }, results: "not-per-query" });
    const down = await Promise.allSettled([client.query(list, { channel: "x" }), client.query(count, {})]);
    expect(down.map((r) => r.status === "rejected" && (r.reason as { code: string; message: string }).code)).toEqual(["overloaded", "overloaded"]);
    refuse = json(429, { ok: false, error: { code: "rate_limited", message: "slow down" } });
    const limited = await Promise.allSettled([client.query(list, { channel: "x" }), client.query(count, {})]);
    expect(limited.map((r) => r.status === "rejected" && (r.reason as { code: string }).code)).toEqual(["rate_limited", "rate_limited"]);

    refuse = json(413, { ok: false, error: { code: "too_large", message: "a query batch is at most N bytes" } });
    expect(await Promise.all([client.query(list, { channel: "x" }), client.query(count, {})])).toEqual([["hello"], 2]);
    expect((client as unknown as { queryBatch: boolean | undefined }).queryBatch).not.toBe(false);
    server.httpRequests.length = 0;
    expect(await Promise.all([client.query(list, { channel: "y" }), client.query(count, {})])).toEqual([["world"], 2]);
    expect(paths(server)).toEqual(["/api/query/batch"]);
    client.close();
  });
});
