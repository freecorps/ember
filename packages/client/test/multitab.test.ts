// Option `multiTab` (PR 4C-4d): one socket per shard for all tabs of an origin, through the tab that leads. Tabs here are
// clients with their own fake BroadcastChannel endpoints and Web Lock scopes (test/fake-tabs.ts) on one fake server.
import { afterEach, describe, expect, it } from "vitest";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";
import { FakeBrowser, type FakeTab } from "../src/testing.ts";
import { multiTabSupported, unsafeRef, type EmberClientOptions, type QueryReference, type QuerySnapshot } from "../src/index.ts";
import { socketIdentityKey } from "../src/multitab.ts";
import type { FakeEmberServer, FakeSocket } from "../src/testing.ts";

const list = unsafeRef<"query">("messages:list");
const send = unsafeRef<"mutation">("messages:send");
const me = unsafeRef<"query">("users:me");
const whoCount = unsafeRef<"query">("who:count");

const jwt = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;
const payloadOf = (t: string) => JSON.parse(atob(t.split(".")[1]!)) as { sub: string; exp?: number };
/** JWT-like tokens for the fake server: `{sub, exp?}` (anything else: invalid). */
const verifyJwt = (t: string) => {
  try {
    const p = payloadOf(t);
    return p.sub ? { subject: p.sub, ...(p.exp ? { exp: p.exp } : {}) } : null;
  } catch {
    return null;
  }
};

const extraQueries = {
  "who:count": (db: { all(t: string): unknown[] }, _a: unknown, ctx: { identity: { subject: string } | null }) => `${ctx.identity?.subject ?? "anon"}:${db.all("messages").length}`,
};

interface Tab {
  tab: FakeTab;
  client: ReturnType<typeof makeClient>;
  /** Real sockets this tab opened (as the leader, or its own fallback). */
  sockets: FakeSocket[];
  /** The tab dies: locks freed, channels dead, its sockets dropped by the network. */
  crash(): void;
}

const open: Tab[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.client.close();
});

function tabClient(browser: FakeBrowser, server: FakeEmberServer, opts: Partial<EmberClientOptions> & { openTimeoutMs?: number } = {}): Tab {
  const tab = browser.tab();
  const sockets: FakeSocket[] = [];
  const Base = server.WebSocket;
  const WS = class extends Base {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  };
  const { openTimeoutMs, ...rest } = opts;
  const client = makeClient(server, {
    WebSocket: WS,
    multiTab: { locks: tab.locks, BroadcastChannel: tab.BroadcastChannel, lifecycle: false, openTimeoutMs: openTimeoutMs ?? 2_000, clientIdTimeoutMs: 100 },
    ...rest,
  });
  const t: Tab = {
    tab,
    client,
    sockets,
    crash: () => {
      tab.crash();
      for (const s of sockets) s.drop();
      client.close();
    },
  };
  open.push(t);
  return t;
}

function watch(client: Tab["client"], ref: QueryReference, args: Record<string, unknown> = {}) {
  const seen: QuerySnapshot[] = [];
  const off = client.subscribe(ref, args, {}, (s) => seen.push(s));
  return { seen, off, value: () => seen.at(-1)?.value, ok: () => seen.at(-1)?.status === "success" };
}

const shardSockets = (server: FakeEmberServer) => server.open(SHARD);
const sentOf = (ws: FakeSocket, t: string) => ws.sent.filter((m) => m !== "ping" && m.t === t);

describe("socketIdentityKey", () => {
  it("anonymous, opaque by string, a JWT by its claims apart from exp/iat/nbf/jti", () => {
    expect(socketIdentityKey(null)).toBe("anon");
    expect(socketIdentityKey(undefined)).toBe("anon");
    expect(socketIdentityKey("user:alice")).toBe("o:user:alice");
    expect(socketIdentityKey("user:alice")).not.toBe(socketIdentityKey("user:alice:2"));
    const a = jwt({ sub: "alice", org: "x", exp: 1, iat: 2, jti: "a" });
    expect(socketIdentityKey(a)).toBe(socketIdentityKey(jwt({ org: "x", sub: "alice", exp: 9, nbf: 3, jti: "b" })));
    expect(socketIdentityKey(a)).not.toBe(socketIdentityKey(jwt({ sub: "alice", org: "y", exp: 1 })));
    expect(socketIdentityKey(a)).not.toBe(socketIdentityKey(jwt({ sub: "alice", org: "x", iss: "other", exp: 1 })));
    expect(socketIdentityKey(a)).not.toBe(socketIdentityKey(jwt({ sub: "bob", org: "x", exp: 1 })));
  });
});

describe("multiTab: one socket per shard for every tab", () => {
  it("elects a leader; followers subscribe and mutate through its socket; one clientId; exactly one execution", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const a = tabClient(browser, server);
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server);
    const c = tabClient(browser, server);
    await until(() => b.client.tabRole === "follower" && c.client.tabRole === "follower");
    const ws = [a, b, c].map((t) => watch(t.client, list, { channel: "g" }));
    await until(() => ws.every((w) => w.ok()));
    expect(shardSockets(server)).toHaveLength(1);
    expect(b.sockets).toHaveLength(0);
    expect(c.sockets).toHaveLength(0);
    expect(server.subscriptionCount(SHARD)).toBe(3);
    // Tabs without a stored clientId took the leader's: a mutation's dedup key does not depend on the socket.
    await Promise.all([a.client.ready(), b.client.ready(), c.client.ready()]);
    expect(b.client.clientId).toBe(a.client.clientId);
    expect(c.client.clientId).toBe(a.client.clientId);

    await expect(b.client.mutation(send, { channel: "g", body: "from b" })).resolves.toBeTypeOf("string");
    await expect(c.client.mutation(send, { channel: "g", body: "from c" })).resolves.toBeTypeOf("string");
    await until(() => ws.every((w) => (w.value() as string[] | undefined)?.length === 2));
    expect(server.executions).toBe(2);
    expect(shardSockets(server)).toHaveLength(1);
  });

  it("a follower's unsubscribe leaves the shared socket; the other tabs keep theirs", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const a = tabClient(browser, server);
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server);
    const wa = watch(a.client, list, { channel: "g" });
    const wb = watch(b.client, list, { channel: "h" });
    await until(() => wa.ok() && wb.ok());
    expect(server.subscriptionCount(SHARD)).toBe(2);
    wb.off();
    await until(() => server.subscriptionCount(SHARD) === 1);
    server.mutateDirect(SHARD, "messages:send", { channel: "g", body: "still live" });
    await until(() => (wa.value() as string[]).includes("still live"));
  });

  it("works with features batch, ident, ack and query (array frames, acks and one-shot `q` routed)", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer({ batch: true, ident: true, ack: true, query: true });
    const a = tabClient(browser, server);
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server);
    const wa = watch(a.client, list, { channel: "g" });
    const wb = watch(b.client, list, { channel: "g" });
    await until(() => wa.ok() && wb.ok());
    await Promise.all([b.client.mutation(send, { channel: "g", body: "1" }), b.client.mutation(send, { channel: "g", body: "2" })]);
    await until(() => (wa.value() as string[]).length === 2 && (wb.value() as string[]).length === 2);
    // One-shot over the socket (feature "query"): `q` with a rewritten qid, its `qres` routed back.
    await expect(b.client.query(list, { channel: "g" })).resolves.toEqual(["1", "2"]);
    const ws = shardSockets(server);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.batchesIn).toBeGreaterThan(0);
    expect(sentOf(ws[0]!, "q")).toHaveLength(1);
    // The follower's acks reach the shard on the shared socket (they go before the socket closes).
    b.client.close();
    await until(() => sentOf(ws[0]!, "ack").length > 0);
    expect(server.httpRequests.filter((r) => r.path === "/api/query")).toHaveLength(0);
  });

  it("a tab signed in as someone else gets a socket of its own; same identity shares", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const a = tabClient(browser, server, { auth: () => "user:alice" });
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server, { auth: () => "user:bob" });
    const c = tabClient(browser, server, { auth: () => "user:alice" });
    const d = tabClient(browser, server);
    const w = [a, b, c, d].map((t) => watch(t.client, me));
    await until(() => w.every((x) => x.ok()));
    expect(w.map((x) => x.value())).toEqual(["alice", "bob", "alice", null]);
    const ids = shardSockets(server)
      .map((s) => s.identity?.subject ?? "anon")
      .sort();
    expect(ids).toEqual(["alice", "anon", "bob"]);
    // Every value a tab ever saw was its own identity's.
    expect(w[0]!.seen.every((s) => s.value === undefined || s.value === "alice")).toBe(true);
    expect(w[1]!.seen.every((s) => s.value === undefined || s.value === "bob")).toBe(true);
    expect(w[3]!.seen.every((s) => s.value === undefined || s.value === null)).toBe(true);
  });

  it("claims split groups: same subject, another org claim → another socket", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer({ verify: verifyJwt });
    const a = tabClient(browser, server, { auth: () => jwt({ sub: "alice", org: "x" }) });
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server, { auth: () => jwt({ sub: "alice", org: "y" }) });
    const c = tabClient(browser, server, { auth: () => jwt({ sub: "alice", org: "x" }) });
    const w = [a, b, c].map((t) => watch(t.client, me));
    await until(() => w.every((x) => x.ok()));
    expect(shardSockets(server)).toHaveLength(2);
  });

  it("setAuth in one tab: it moves to a socket of the new identity, never sees the old one's values after, and the others never see an auth frame", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer({ queries: extraQueries });
    const a = tabClient(browser, server, { auth: () => "user:alice" });
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server, { auth: () => "user:alice" });
    const wa = watch(a.client, whoCount);
    const wb = watch(b.client, whoCount);
    await until(() => wa.value() === "alice:0" && wb.value() === "alice:0");
    const shared = shardSockets(server)[0]!;
    // A commit's patch for both tabs is in flight on the shared socket when b switches account.
    shared.hold();
    server.mutateDirect(SHARD, "messages:send", { channel: "g", body: "x" }, { subject: "alice" });
    await tick(5);
    const from = wb.seen.length;
    b.client.setAuth(() => "user:bob");
    await tick(5);
    shared.release();
    await until(() => wb.value() === "bob:1");
    await until(() => wa.value() === "alice:1");
    // After setAuth, b only ever showed loading or bob's values.
    expect(wb.seen.slice(from).every((s) => s.value === undefined || String(s.value).startsWith("bob:"))).toBe(true);
    // The shared alice socket never carried b's sign-in.
    expect(sentOf(shared, "auth")).toHaveLength(0);
    expect(shared.identity?.subject).toBe("alice");
    const bob = shardSockets(server).find((s) => s.identity?.subject === "bob");
    expect(bob).toBeDefined();
    // b's new socket is the leader's too (a group of its own), not a direct one.
    expect(b.sockets).toHaveLength(0);
    // Signing out in a: its socket moves to an anonymous one; b stays bob.
    a.client.setAuth(undefined);
    await until(() => wa.value() === "anon:1");
    expect(wb.value()).toBe("bob:1");
    expect(wa.seen.slice(wa.seen.findIndex((s) => s.value === "anon:1")).every((s) => s.value === "anon:1" || s.value === undefined)).toBe(true);
  });

  it("a renewal of the same identity (later exp) renews the shared socket in place; authExpired goes to every tab and recovers", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer({ verify: verifyJwt });
    const now = Math.floor(Date.now() / 1000);
    let aExp = now + 1000;
    let bExp = now + 2000;
    const a = tabClient(browser, server, { auth: () => jwt({ sub: "alice", exp: aExp }), refreshAuthBeforeExpiryMs: false });
    await until(() => a.client.tabRole === "leader");
    const wa = watch(a.client, list, { channel: "g" });
    await until(() => wa.ok());
    const b = tabClient(browser, server, { auth: () => jwt({ sub: "alice", exp: bExp }), refreshAuthBeforeExpiryMs: false });
    const wb = watch(b.client, list, { channel: "g" });
    await until(() => wb.ok());
    const shared = shardSockets(server);
    expect(shared).toHaveLength(1);
    // b's hello token expires later: it went to the shared socket as a renewal.
    await until(() => sentOf(shared[0]!, "auth").length === 1);
    expect(shared[0]!.identity).toMatchObject({ subject: "alice", exp: bExp });

    aExp = now + 3000;
    bExp = now + 4000;
    server.expireAuth(SHARD);
    await until(() => sentOf(shared[0]!, "auth").length >= 2);
    await b.client.mutation(send, { channel: "g", body: "after" });
    await until(() => (wa.value() as string[]).includes("after") && (wb.value() as string[]).includes("after"));
    expect(shardSockets(server)).toHaveLength(1);
  });

  it("the leader closes: a follower takes over, its subscriptions come back on the new leader's socket", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const a = tabClient(browser, server);
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server);
    const c = tabClient(browser, server);
    const wb = watch(b.client, list, { channel: "g" });
    const wc = watch(c.client, list, { channel: "g" });
    await until(() => wb.ok() && wc.ok());
    a.client.close();
    await until(() => b.client.tabRole === "leader" || c.client.tabRole === "leader");
    await until(() => shardSockets(server).length === 1 && server.subscriptionCount(SHARD) === 2);
    server.mutateDirect(SHARD, "messages:send", { channel: "g", body: "after handover" });
    await until(() => (wb.value() as string[]).includes("after handover") && (wc.value() as string[]).includes("after handover"));
    expect(shardSockets(server)).toHaveLength(1);
  });

  it("the leader crashes before the shard saw a follower's mutation: it is resent through the next leader and runs once", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const a = tabClient(browser, server);
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server);
    const wb = watch(b.client, list, { channel: "g" });
    await until(() => wb.ok());
    const shared = shardSockets(server)[0]!;
    shared.holdIncoming();
    const p = b.client.mutation(send, { channel: "g", body: "survives" });
    await until(() => (shared.heldIncoming ?? []).some((f) => f.includes('"mut"')));
    a.crash();
    await until(() => b.client.tabRole === "leader");
    await expect(p).resolves.toBeTypeOf("string");
    await until(() => (wb.value() as string[]).includes("survives"));
    expect(server.executions).toBe(1);
    expect(b.client.connectionState().pendingMutations).toBe(0);
  });

  it("the leader crashes after the shard ran it but before its answer: the resend is a dedup hit (no second execution)", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const a = tabClient(browser, server);
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server);
    const c = tabClient(browser, server);
    const wb = watch(b.client, list, { channel: "g" });
    const wc = watch(c.client, list, { channel: "g" });
    await until(() => wb.ok() && wc.ok());
    const shared = shardSockets(server)[0]!;
    shared.hold();
    const results: unknown[] = [];
    const p = b.client.mutation(send, { channel: "g", body: "once" }).then((v) => results.push(v));
    await until(() => server.executions === 1);
    const firstId = server.rows(SHARD, "messages")[0]!._id;
    a.crash();
    await p;
    expect(results).toEqual([firstId]);
    await until(() => (wb.value() as string[]).includes("once") && (wc.value() as string[]).includes("once"));
    await tick(20);
    expect(server.executions).toBe(1);
    expect(server.rows(SHARD, "messages")).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(shardSockets(server)).toHaveLength(1);
  });

  it("a follower tab that dies: the leader learns it from the tab's lock and drops its subscriptions", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const a = tabClient(browser, server);
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server);
    const wa = watch(a.client, list, { channel: "g" });
    const wb = watch(b.client, list, { channel: "h" });
    await until(() => wa.ok() && wb.ok());
    expect(server.subscriptionCount(SHARD)).toBe(2);
    b.tab.crash(); // no code of b runs any more
    await until(() => server.subscriptionCount(SHARD) === 1);
    expect(shardSockets(server)).toHaveLength(1);
  });

  it("a frozen leader: a new tab's socket falls back to its own after openTimeoutMs", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const a = tabClient(browser, server);
    await until(() => a.client.tabRole === "leader");
    const wa = watch(a.client, list, { channel: "g" });
    await until(() => wa.ok());
    a.tab.freeze();
    const b = tabClient(browser, server, { openTimeoutMs: 50 });
    const wb = watch(b.client, list, { channel: "g" });
    await until(() => wb.ok());
    expect(b.client.tabRole).toBe("follower");
    expect(b.sockets).toHaveLength(1);
    expect(shardSockets(server)).toHaveLength(2);
    await b.client.mutation(send, { channel: "g", body: "direct" });
    await until(() => (wb.value() as string[]).includes("direct"));
  });

  it("without Web Locks or BroadcastChannel: nothing changes (a socket per client)", async () => {
    const server = messagesServer();
    const a = makeClient(server, { multiTab: { locks: null } });
    const b = makeClient(server, { multiTab: { BroadcastChannel: null } });
    const c = makeClient(server, { multiTab: { locks: null, BroadcastChannel: null } });
    expect([a.tabRole, b.tabRole, c.tabRole]).toEqual([null, null, null]);
    expect(multiTabSupported({ locks: null })).toBe(false);
    const w = [a, b, c].map((cl) => watch(cl, list, { channel: "g" }));
    await until(() => w.every((x) => x.ok()));
    expect(shardSockets(server)).toHaveLength(3);
    for (const cl of [a, b, c]) cl.close();
  });

  it("a server without feature batch: pipelined array frames get the shard's refusal, the client resends one by one", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer({ batch: false });
    const a = tabClient(browser, server);
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server);
    const errors: string[] = [];
    const c = tabClient(browser, server, { onError: (e) => errors.push(e.code) });
    const ws = [a, b, c].flatMap((t) => [watch(t.client, list, { channel: "g" }), watch(t.client, list, { channel: "h" })]);
    await until(() => ws.every((w) => w.ok()));
    expect(shardSockets(server)).toHaveLength(1);
    expect(server.subscriptionCount(SHARD)).toBe(6);
    expect(errors).toEqual([]);
  });
});

describe("multiTab over the platform's own BroadcastChannel and Web Locks (Node 24 has both)", () => {
  it.skipIf(!multiTabSupported())("two clients share one socket; the leader closes and the other takes over", async () => {
    const server = messagesServer();
    const name = `real-${Math.random()}`;
    const a = makeClient(server, { multiTab: { name, lifecycle: false } });
    await until(() => a.tabRole === "leader");
    const b = makeClient(server, { multiTab: { name, lifecycle: false } });
    await until(() => b.tabRole === "follower");
    const wa = watch(a, list, { channel: "g" });
    const wb = watch(b, list, { channel: "g" });
    await until(() => wa.ok() && wb.ok());
    expect(shardSockets(server)).toHaveLength(1);
    await b.mutation(send, { channel: "g", body: "real" });
    await until(() => (wa.value() as string[]).includes("real"));
    a.close();
    await until(() => b.tabRole === "leader");
    server.mutateDirect(SHARD, "messages:send", { channel: "g", body: "after" });
    await until(() => (wb.value() as string[]).includes("after"));
    expect(shardSockets(server)).toHaveLength(1);
    expect(server.executions).toBe(2); // b's mutation once, and the direct one
    b.close();
  });
});

describe("multiTab heartbeats", () => {
  it("the leader answers a follower's ping; a silent shared socket is closed by the leader's heartbeat and every tab reconnects", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const heartbeat = { intervalMs: 40, timeoutMs: 40 };
    const a = tabClient(browser, server, { heartbeat });
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server, { heartbeat });
    const wa = watch(a.client, list, { channel: "g" });
    const wb = watch(b.client, list, { channel: "g" });
    await until(() => wa.ok() && wb.ok());
    const first = shardSockets(server)[0]!;
    // Quiet for a while: the tabs' pings are answered by the leader (no reconnect), the leader pings the shard.
    await tick(150);
    expect(shardSockets(server)).toEqual([first]);
    expect(first.sent.filter((m) => m === "ping").length).toBeGreaterThan(0);
    // Half-open shared socket: no pong. The leader closes it; both tabs reconnect onto a new shared socket.
    first.silent = true;
    await until(() => shardSockets(server).length === 1 && shardSockets(server)[0] !== first, 3000);
    server.mutateDirect(SHARD, "messages:send", { channel: "g", body: "back" });
    await until(() => (wa.value() as string[]).includes("back") && (wb.value() as string[]).includes("back"), 3000);
  });
});
