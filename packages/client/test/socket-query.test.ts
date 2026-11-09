import { describe, expect, it, vi } from "vitest";
import { MemoryPendingStorage } from "../src/index.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

async function connected(opts: Parameters<typeof messagesServer>[0] = { query: true }) {
  const server = messagesServer(opts);
  const storage = new MemoryPendingStorage();
  const put = vi.spyOn(storage, "put");
  const client = makeClient(server, { storage });
  client.subscribe("messages:list", { channel: "x" }, {}, () => {});
  await until(() => client.connectionState().shards[SHARD] === "open");
  return { server, client, storage, put, ws: server.open()[0]! };
}

describe("one-shot socket queries", () => {
  it("uses negotiated socket queries, correlates concurrent results and never queues or persists them", async () => {
    const { server, client, ws, put, storage } = await connected();
    ws.hold();
    const a = client.query("messages:list", { channel: "x" });
    const b = client.query("users:me", {});
    await until(() => ws.received.filter((m) => m !== "pong" && m.t === "qres").length === 2);
    ws.held!.reverse();
    ws.release();
    expect(await a).toEqual([]);
    expect(await b).toBeNull();
    expect(ws.sent.filter((m) => m !== "ping" && m.t === "q")).toHaveLength(2);
    expect(server.subscriptionCount()).toBe(1);
    expect(server.httpRequests).toHaveLength(0);
    expect(client.connectionState().pendingMutations).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(await storage.load()).toEqual([]);
    client.close();
  });

  it("falls back to HTTP without the feature or a socket for that shard; http forces HTTP", async () => {
    const { server, client, ws } = await connected({ query: false });
    expect(await client.query("messages:count")).toBe(0);
    expect(ws.sent.filter((m) => m !== "ping" && m.t === "q")).toHaveLength(0);
    expect(server.httpRequests).toHaveLength(1);
    client.close();
    const current = await connected();
    expect(await current.client.query("messages:count", {}, { transport: "http" })).toBe(0);
    expect(await current.client.query("messages:count", {}, { shard: "org:other" })).toBe(0);
    expect(await current.client.query("messages:count", {}, { shard: "org:missing", transport: "socket" })).toBe(0);
    expect(current.server.history).toHaveLength(1);
    expect(current.server.httpRequests).toHaveLength(3);
    current.client.close();
  });

  it("goes over HTTP while the socket still runs as the previous identity (sign-in/out in flight)", async () => {
    const { server, client, ws } = await connected();
    client.clearAuth();
    expect(await client.query("messages:count")).toBe(0);
    expect(server.httpRequests).toHaveLength(1);
    // Once `{t:"auth"}` went out, the socket is current again.
    await until(() => ws.sent.some((m) => m !== "ping" && m.t === "auth"));
    expect(await client.query("messages:count")).toBe(0);
    expect(server.httpRequests).toHaveLength(1);
    expect(ws.sent.filter((m) => m !== "ping" && m.t === "q")).toHaveLength(1);
    client.close();
  });

  it("a forced socket query refused by an older runtime (qid-less bad_frame) is asked over HTTP", async () => {
    const { server, client } = await connected({ query: false, refuseQ: true });
    expect(await client.query("messages:count", {}, { transport: "socket" })).toBe(0);
    expect(server.httpRequests).toHaveLength(1);
    client.close();
  });

  it("socket override sends q on an open socket even without negotiation", async () => {
    const { server, client, ws } = await connected({ query: false });
    expect(await client.query("messages:count", {}, { transport: "socket" })).toBe(0);
    expect(ws.sent.some((m) => m !== "ping" && m.t === "q")).toBe(true);
    expect(server.httpRequests).toHaveLength(0);
    client.close();
  });

  it("retries once over HTTP on disconnect and never replays q after reconnect", async () => {
    const { server, client, ws, put } = await connected();
    ws.hold();
    const args = { channel: "x" };
    const result = client.query("messages:list", args);
    args.channel = "changed-after-send";
    await until(() => ws.received.some((m) => m !== "pong" && m.t === "qres"));
    ws.drop();
    expect(await result).toEqual([]);
    expect(server.httpRequests[0]!.body).toMatchObject({ args: { channel: "x" } });
    await until(() => server.history.length === 2 && client.connectionState().shards[SHARD] === "open");
    ws.release(); // old replies cannot settle or replay the call
    await tick();
    expect(server.httpRequests).toHaveLength(1);
    expect(server.open()[0]!.sent.some((m) => m !== "ping" && m.t === "q")).toBe(false);
    expect(put).not.toHaveBeenCalled();
    client.close();
  });

  it("propagates socket and fallback errors without retrying server refusals", async () => {
    const { server, client, ws } = await connected();
    await expect(client.query("boom:query")).rejects.toMatchObject({ code: "nope", message: "query exploded" });
    expect(server.httpRequests).toHaveLength(0);
    ws.hold();
    const result = client.query("boom:query");
    const rejection = expect(result).rejects.toMatchObject({ code: "nope" });
    await until(() => ws.held!.length === 1);
    ws.drop();
    await rejection;
    expect(server.httpRequests).toHaveLength(1);
    client.close();
  });

  it("falls back once when send throws", async () => {
    const { server, client, ws } = await connected();
    vi.spyOn(ws, "send").mockImplementationOnce(() => { throw new Error("closed during send"); });
    expect(await client.query("messages:count")).toBe(0);
    expect(server.httpRequests).toHaveLength(1);
    client.close();
  });

  it("keeps an idle socket alive until qres and rejects callers on client close", async () => {
    const server = messagesServer({ query: true });
    const client = makeClient(server, { idleTimeoutMs: 5 });
    const off = client.subscribe("messages:count", {}, {}, () => {});
    await until(() => client.connectionState().shards[SHARD] === "open");
    const ws = server.open()[0]!;
    ws.hold();
    off();
    const result = client.query("messages:count");
    const rejection = expect(result).rejects.toMatchObject({ code: "closed" });
    await tick(15);
    expect(ws.readyState).toBe(1);
    client.close();
    await rejection;
    expect(server.httpRequests).toHaveLength(0);
  });
});
