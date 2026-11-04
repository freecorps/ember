import { decodeClientMessage } from "#runtime-protocol";
import { vi } from "vitest";
import { EmberClient, type EmberClientOptions } from "../src/index.ts";
import { FakeEmberServer, FakeFunctionError, type FakeServerOptions } from "../src/testing.ts";

export const SHARD = "org:acme";

/** A messages app: `messages:list({channel})`, `messages:send({channel, body})` ("fail" body throws). */
export function messagesServer(opts: FakeServerOptions = {}) {
  return new FakeEmberServer({
    ...opts,
    decodeClientMessage: (raw) => decodeClientMessage(raw),
    queries: {
      "messages:list": (db, { channel }) => db.where<{ body: string }>("messages", "channel", channel).map((m) => m.body),
      "messages:count": (db) => db.all("messages").length,
      "users:me": (_db, _args, ctx) => ctx.identity?.subject ?? null,
      "boom:query": () => {
        throw new FakeFunctionError("nope", "query exploded");
      },
      ...opts.queries,
    },
    mutations: {
      "messages:send": (db, { channel, body }) => {
        if (body === "fail") throw new FakeFunctionError("invalid_body", "body may not be fail");
        return db.insert("messages", { channel, body });
      },
      ...opts.mutations,
    },
  });
}

export function makeClient(server: FakeEmberServer, opts: Partial<EmberClientOptions> = {}) {
  return new EmberClient({
    url: "https://ember.test",
    WebSocket: server.WebSocket,
    fetch: server.fetch,
    connectivity: null,
    defaultShard: SHARD,
    backoff: { initialMs: 5, maxMs: 20 },
    heartbeat: false,
    ...opts,
  });
}

export const until = (cond: () => unknown, timeout = 2000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout, interval: 2 },
  );

/** Let queued microtasks and 0 ms timers run. */
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
