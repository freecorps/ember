// `httpFirst`: while a shard's socket opens, a new subscription's first value comes over HTTP (one round trip instead
// of the upgrade plus `sub`), and the socket's `sub` resumes from it (the server answers `unchanged`).
import { describe, expect, it } from "vitest";
import { makeClient, messagesServer, SHARD, until } from "./helpers.ts";
import { unsafeRef } from "../src/index.ts";

const list = unsafeRef("messages:list");

async function seeded(opts: { ident: boolean }) {
  const server = messagesServer({ ident: opts.ident, query: true, batch: true });
  const writer = makeClient(server);
  await writer.mutation(unsafeRef("messages:send"), { channel: "x", body: "hello" });
  writer.close();
  return server;
}

describe("httpFirst", () => {
  it("shows the HTTP value first and subscribes with resume: the socket only confirms it", async () => {
    const server = await seeded({ ident: true });
    const before = server.httpRequests.length;
    const client = makeClient(server, { httpFirst: true });
    const seen: unknown[] = [];
    client.subscribe(list, { channel: "x" }, {}, (s) => s.status === "success" && seen.push(s.value));
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual(["hello"]);
    expect(server.httpRequests.slice(before).map((r) => r.path)).toEqual(["/api/query"]);
    await until(() => server.open().length === 1 && server.open()[0]!.received.some((m) => m !== "pong" && m.t === "snap"));
    const ws = server.open()[0]!;
    const sub = ws.sent.find((m) => m !== "ping" && m.t === "sub");
    expect(sub).toMatchObject({ resume: { version: expect.any(Number), epoch: expect.any(String), ik: expect.any(String) } });
    expect(ws.received.find((m) => m !== "pong" && m.t === "snap")).toMatchObject({ unchanged: true });
    // Live afterwards: a change arrives over the socket.
    await client.mutation(unsafeRef("messages:send"), { channel: "x", body: "again" });
    await until(() => JSON.stringify(seen.at(-1)) === JSON.stringify(["hello", "again"]));
    client.close();
  });

  it("an older server (no epoch over HTTP): the socket subscribes without resume and sends the full snapshot", async () => {
    const server = await seeded({ ident: false });
    const client = makeClient(server, { httpFirst: true });
    const seen: unknown[] = [];
    client.subscribe(list, { channel: "x" }, {}, (s) => s.status === "success" && seen.push(s.value));
    await until(() => server.open().length === 1 && server.open()[0]!.received.some((m) => m !== "pong" && m.t === "snap"));
    const ws = server.open()[0]!;
    expect(ws.sent.find((m) => m !== "ping" && m.t === "sub")).not.toHaveProperty("resume");
    expect(ws.received.find((m) => m !== "pong" && m.t === "snap")).toMatchObject({ value: ["hello"] });
    expect(seen.at(-1)).toEqual(["hello"]);
    client.close();
  });

  it("with a token known before the socket opens; not when fetching it outlasts the upgrade, nor once the socket is open", async () => {
    const server = await seeded({ ident: true });
    let before = server.httpRequests.length;
    const fast = makeClient(server, { httpFirst: true, auth: () => "user:amy" });
    const seen: unknown[] = [];
    fast.subscribe(list, { channel: "x" }, {}, (s) => s.status === "success" && seen.push(s.value));
    await until(() => server.open().some((w) => w.received.some((m) => m !== "pong" && m.t === "snap")));
    expect(server.httpRequests.slice(before).map((r) => [r.path, r.authorization])).toEqual([["/api/query", "Bearer user:amy"]]);
    fast.close();
    before = server.httpRequests.length;
    const slow = makeClient(server, { httpFirst: true, auth: () => new Promise((r) => setTimeout(() => r("user:amy"), 40)) });
    slow.subscribe(list, { channel: "x" }, {}, () => {});
    await until(() => slow.connectionState().shards[SHARD] === "open");
    expect(server.httpRequests.slice(before)).toEqual([]);
    // The socket is open: a new subscription goes over it.
    slow.subscribe(list, { channel: "y" }, {}, () => {});
    await until(() => server.open().at(-1)!.sent.filter((m) => m !== "ping" && m.t === "sub").length === 2);
    expect(server.httpRequests.slice(before)).toEqual([]);
    slow.close();
  });
});
