// `query()` over HTTP and `fetchForHydration()`: the calls of one turn for one shard go out as one
// `POST /api/query/batch` (as `httpFirst` does since #160), each answered with its own entry; a runtime without the
// batch gets them one by one after one refused try.
import { describe, expect, it } from "vitest";
import { makeClient, messagesServer, SHARD } from "./helpers.ts";
import { unsafeRef } from "../src/index.ts";

const list = unsafeRef<"query">("messages:list");
const count = unsafeRef<"query">("messages:count");
const boom = unsafeRef<"query">("boom:query");
const me = unsafeRef<"query">("users:me");
const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, "")}.sig`;
const verify = (t: string) => {
  try {
    return { subject: (JSON.parse(atob(t.split(".")[1]!)) as { sub: string }).sub };
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
    let token = jwt("ana");
    const client = makeClient(server, { WebSocket: null, auth: () => token });
    const out = await Promise.allSettled([client.query(list, { channel: "x" }), client.query(boom, {}), client.query(me, {})]);
    expect(out[0]).toMatchObject({ status: "fulfilled", value: ["hello"] });
    expect(out[1]).toMatchObject({ status: "rejected", reason: { code: "nope" } });
    expect(out[2]).toMatchObject({ status: "fulfilled", value: "ana" });
    expect(paths(server)).toEqual(["/api/query/batch"]);
    expect(server.httpRequests[0]!.authorization).toBe(`Bearer ${token}`);

    token = "not-a-jwt";
    client.setAuth(() => token);
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
});
