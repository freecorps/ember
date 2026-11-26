// @vitest-environment node
// Server rendering: a client without WebSocket (`WebSocket: null`), as on Node 22+ or Workers (both have a global one).
import { Suspense } from "react";
import { renderToString } from "react-dom/server";
import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { EmberClient, anyApi, type FunctionReference } from "@freecorps/ember-client";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { EmberProvider, useQuery, useSuspenseQuery } from "../src/index.ts";

const SHARD = "org:acme";
const api = anyApi as unknown as {
  messages: { list: FunctionReference<"query", "public", { channel: string }, string[]> };
  me: { name: FunctionReference<"query", "public", Record<string, never>, string> };
};

function fakeServer() {
  const server = new FakeEmberServer({
    queries: {
      "messages:list": (db, { channel }) => db.where<{ body: string }>("messages", "channel", channel).map((m) => m.body),
      "me:name": (_db, _args, ctx) => ctx.identity?.subject ?? "anon",
    },
    mutations: { "messages:send": (db, { channel, body }) => db.insert("messages", { channel, body }) },
  });
  server.mutateDirect(SHARD, "messages:send", { channel: "a", body: "hi" });
  return server;
}

const serverClient = (server: FakeEmberServer, extra: Partial<ConstructorParameters<typeof EmberClient>[0]> = {}) =>
  new EmberClient({ url: "https://ember.test", WebSocket: null, fetch: server.fetch, connectivity: null, heartbeat: false, defaultShard: SHARD, ...extra });

function List() {
  const msgs = useQuery(api.messages.list, { channel: "a" });
  return <p>list:{msgs === undefined ? "loading" : msgs.join(",")}</p>;
}
function Suspended() {
  const msgs = useSuspenseQuery(api.messages.list, { channel: "a" });
  return <p>suspended:{msgs.join(",")}</p>;
}
function Me() {
  return <p>me:{useSuspenseQuery(api.me.name, {})}</p>;
}

async function html(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

describe("server rendering", () => {
  it("renderToString shows a hydrated value (useQuery and useSuspenseQuery), without any request", async () => {
    const server = fakeServer();
    const entry = await serverClient(server).fetchForHydration(api.messages.list, { channel: "a" });
    const before = server.httpRequests.length;
    const client = serverClient(server);
    client.hydrate(entry);
    const out = renderToString(
      <EmberProvider client={client}>
        <List />
        <Suspense fallback={<p>fallback</p>}>
          <Suspended />
        </Suspense>
      </EmberProvider>,
    );
    expect(out).toContain("list:<!-- -->hi");
    expect(out).toContain("suspended:<!-- -->hi");
    expect(out).not.toContain("fallback");
    expect(server.httpRequests.length).toBe(before);
    client.close();
  });

  it("useSuspenseQuery without a socket reads once over HTTP, renders the value, and dehydrate() hands it over", async () => {
    const server = fakeServer();
    const client = serverClient(server);
    expect(client.realtime).toBe(false);
    const { prelude } = await prerender(
      <EmberProvider client={client}>
        <Suspense fallback={<p>fallback</p>}>
          <Suspended />
        </Suspense>
      </EmberProvider>,
    );
    const out = await html(prelude);
    expect(out).toContain("suspended:<!-- -->hi");
    expect(server.httpRequests.filter((r) => r.path === "/api/query")).toHaveLength(1);
    const handed = client.dehydrate();
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ fn: "messages:list", shard: SHARD, args: { channel: "a" }, value: ["hi"] });
    client.close();
  });

  it("a failed read goes to the error boundary, not into a loop of fetches", async () => {
    const server = fakeServer();
    const failing = (async () => new Response(JSON.stringify({ ok: false, error: { code: "boom", message: "down" } }), { status: 500 })) as typeof fetch;
    let calls = 0;
    const client = serverClient(server, { fetch: ((...a: Parameters<typeof fetch>) => (calls++, failing(...a))) as typeof fetch });
    const errors: unknown[] = [];
    await prerender(
      <EmberProvider client={client}>
        <Suspense fallback={<p>fallback</p>}>
          <Suspended />
        </Suspense>
      </EmberProvider>,
      { onError: (e) => void errors.push(e) },
    );
    expect(calls).toBe(1);
    expect((errors[0] as Error).message).toBe("down");
    client.close();
  });

  it("the suspension is per identity: a read started for one user is never shown to the next", async () => {
    const server = fakeServer();
    // The first two requests wait until released; later ones go straight through.
    const gates: Array<() => void> = [];
    const slow = ((input: RequestInfo | URL, init?: RequestInit) =>
      gates.length >= 2 ? server.fetch(input, init) : new Promise<Response>((resolve, reject) => gates.push(() => void server.fetch(input, init).then(resolve, reject)))) as typeof fetch;
    const client = serverClient(server, { fetch: slow, auth: async () => "user:alice" });
    const tree = (
      <EmberProvider client={client}>
        <Suspense fallback={<p>fallback</p>}>
          <Me />
        </Suspense>
      </EmberProvider>
    );
    const alice = prerender(tree);
    await until(() => gates.length === 1);
    client.setAuth(async () => "user:bob");
    const bob = prerender(tree);
    // Bob did not wait on Alice's promise: his own read went out with his token.
    await until(() => gates.length === 2);
    const auth = () => server.httpRequests.map((r) => r.authorization);
    // Alice's answer lands after the switch: dropped. Her render retries as Bob (the client is his now).
    gates[0]!();
    await until(() => auth().length === 1);
    gates[1]!();
    const [a, b] = await Promise.all([alice, bob]);
    expect(auth().slice(0, 2)).toEqual(["Bearer user:alice", "Bearer user:bob"]);
    const outA = await html(a.prelude);
    const outB = await html(b.prelude);
    expect(outB).toContain("me:<!-- -->bob");
    expect(outA).not.toContain("alice");
    expect(client.dehydrate().map((h) => h.value)).toEqual(["bob"]);
    client.close();
  });

  it("a read that fails after the identity changed is dropped: the next render reads again as the new user", async () => {
    const server = fakeServer();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (first) {
        first = false;
        await gate;
        return new Response(JSON.stringify({ ok: false, error: { code: "boom", message: "alice's read failed" } }), { status: 500 });
      }
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    const client = serverClient(server, { fetch, auth: async () => "user:alice" });
    const errors: unknown[] = [];
    const tree = (
      <EmberProvider client={client}>
        <Suspense fallback={<p>fallback</p>}>
          <Me />
        </Suspense>
      </EmberProvider>
    );
    const alice = prerender(tree, { onError: (e) => void errors.push(e) });
    // Alice's read reached the server (held at `gate`) before the identity changes.
    await until(() => !first);
    client.setAuth(async () => "user:bob");
    release();
    const out = await html((await alice).prelude);
    expect(errors).toEqual([]);
    expect(out).toContain("me:<!-- -->bob");
    client.close();
  });
});

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
}
