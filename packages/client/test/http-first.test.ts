// `httpFirst`: while a shard's socket opens, a new subscription's first value comes over HTTP (one round trip instead
// of the upgrade plus `sub`), and the socket's `sub` resumes from it (the server answers `unchanged`).
import { describe, expect, it } from "vitest";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";
import { unsafeRef } from "../src/index.ts";
import type { FakeEmberServer } from "../src/testing.ts";

const list = unsafeRef("messages:list");

async function seeded(opts: { ident: boolean }) {
  // The upgrade takes a few ms (as a real round trip does): the socket now opens in parallel with the client's load.
  const server = messagesServer({ ident: opts.ident, query: true, batch: true, openDelayMs: 10 });
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

  it("the socket ready before the HTTP answer: the fetch is cancelled and the socket's snapshot is the only download", async () => {
    const server = await seeded({ ident: true });
    const slow = slowFetch(server, () => 200);
    const client = makeClient(server, { httpFirst: true, fetch: slow.fetch });
    const seen: unknown[] = [];
    client.subscribe(list, { channel: "x" }, {}, (s) => s.status === "success" && seen.push(s.value));
    await until(() => slow.signals.length === 1);
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual(["hello"]);
    expect(slow.signals[0]!.aborted).toBe(true);
    const ws = server.open()[0]!;
    // One `sub` (not one at `ready` and one more when the answer came), a full snapshot.
    expect(ws.sent.filter((m) => m !== "ping" && m.t === "sub")).toHaveLength(1);
    expect(ws.received.find((m) => m !== "pong" && m.t === "snap")).toMatchObject({ value: ["hello"] });
    await tick(250);
    expect(seen).toHaveLength(1);
    expect(ws.sent.filter((m) => m !== "ping" && m.t === "sub")).toHaveLength(1);
    client.close();
  });

  it("unsubscribing or closing cancels the fetch", async () => {
    const server = await seeded({ ident: true });
    const slow = slowFetch(server, () => 200);
    const client = makeClient(server, { httpFirst: true, fetch: slow.fetch });
    const off = client.subscribe(list, { channel: "x" }, {}, () => {});
    client.subscribe(list, { channel: "y" }, {}, () => {});
    await until(() => slow.signals.length === 2);
    off();
    await tick();
    expect(slow.signals.map((s) => s.aborted)).toEqual([true, false]);
    client.close();
    expect(slow.signals.map((s) => s.aborted)).toEqual([true, true]);
  });

  it("signed out (token known: null): fetched anonymously, without a call to the auth fetcher per subscription", async () => {
    const server = messagesServer({ ident: true, query: true, batch: true, openDelayMs: 60 });
    let calls = 0;
    const client = makeClient(server, { httpFirst: true, auth: () => (calls++, null) });
    await (client as unknown as { fetchToken(): Promise<string | null> }).fetchToken();
    calls = 0;
    const before = server.httpRequests.length;
    for (let i = 0; i < 5; i++) {
      client.subscribe(list, { channel: `s${i}` }, {}, () => {});
      await tick(2);
    }
    await until(() => server.httpRequests.length - before === 5);
    expect(server.httpRequests.slice(before).map((r) => r.authorization)).toEqual([null, null, null, null, null]);
    // Only the socket's own (hello), not one more per subscription.
    expect(calls).toBeLessThanOrEqual(1);
    client.close();
  });

  it("the subs that waited for their HTTP answers go together, in one frame, after the last answer", async () => {
    const server = await seeded({ ident: true });
    let n = 0;
    const slow = slowFetch(server, () => 15 + 10 * n++);
    const known = server.history.length;
    const client = makeClient(server, { httpFirst: true, fetch: slow.fetch });
    const seen = new Map<string, unknown>();
    for (const ch of ["x", "y", "z"]) client.subscribe(list, { channel: ch }, {}, (s) => s.status === "success" && seen.set(ch, s.value));
    // Hello goes out (the socket opens at 10 ms) but the server reads nothing yet: no `ready` before the answers.
    await until(() => server.history.length === known + 1);
    const ws = server.history.at(-1)!;
    ws.holdIncoming();
    await until(() => seen.size === 3);
    await tick(5);
    ws.releaseIncoming();
    await until(() => server.subscriptionCount() === 3);
    // hello, then one array frame with the three subs (each resuming from its HTTP value).
    expect(ws.framesIn).toBe(2);
    expect(ws.batchesIn).toBe(1);
    const subs = ws.sent.filter((m) => m !== "ping" && m.t === "sub");
    expect(subs).toHaveLength(3);
    for (const m of subs) expect(m).toMatchObject({ resume: { version: expect.any(Number) } });
    client.close();
  });

  it("an answer that came before hello still waits for the shard's others: one frame, not one with hello and one after", async () => {
    const server = await seeded({ ident: true });
    let n = 0;
    // x answers before the socket opens (10 ms), y and z after it.
    const slow = slowFetch(server, () => (n++ === 0 ? 1 : 30 + 10 * n));
    const known = server.history.length;
    const client = makeClient(server, { httpFirst: true, fetch: slow.fetch });
    const seen = new Map<string, unknown>();
    for (const ch of ["x", "y", "z"]) client.subscribe(list, { channel: ch }, {}, (s) => s.status === "success" && seen.set(ch, s.value));
    await until(() => seen.has("x"));
    await until(() => server.history.length === known + 1);
    const ws = server.history.at(-1)!;
    ws.holdIncoming();
    await until(() => seen.size === 3);
    await tick(5);
    ws.releaseIncoming();
    await until(() => server.subscriptionCount() === 3);
    const frames = ws.sent.filter((m) => m !== "ping");
    expect(frames.map((m) => m.t)).toEqual(["hello", "sub", "sub", "sub"]);
    // hello, then the three subs in one array frame.
    expect(ws.batchesIn).toBe(1);
    expect(ws.framesIn).toBe(2);
    client.close();
  });
});

/** `server.fetch`, each request answered after `delay()` ms, aborting with its signal as `fetch` does. */
function slowFetch(server: FakeEmberServer, delay: () => number) {
  const signals: AbortSignal[] = [];
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal) signals.push(signal);
    const ms = delay();
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      };
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(server.fetch(input, init));
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof globalThis.fetch;
  return { fetch, signals };
}
