// Option `multiTab` (PR 4C-4d): one socket per shard for all tabs of an origin, through the tab that leads. Tabs here are
// clients with their own fake BroadcastChannel endpoints and Web Lock scopes (test/fake-tabs.ts) on one fake server.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";
import { FakeBrowser, type FakeTab } from "../src/testing.ts";
import { multiTabSupported, unsafeRef, type EmberClientOptions, type QueryReference, type QuerySnapshot } from "../src/index.ts";
import { createMultiTab, socketIdentityKey, type LockManagerLike, type MultiTabOptions } from "../src/multitab.ts";
import { MemoryPendingStorage } from "../src/storage.ts";
import type { WebSocketConstructor } from "../src/client.ts";
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

function tabClient(browser: FakeBrowser, server: FakeEmberServer, opts: Partial<EmberClientOptions> & { openTimeoutMs?: number; tabs?: Partial<MultiTabOptions>; holdNew?: boolean } = {}): Tab {
  const tab = browser.tab();
  const sockets: FakeSocket[] = [];
  const Base = server.WebSocket;
  const WS = class extends Base {
    constructor(url: string) {
      super(url);
      sockets.push(this);
      if (opts.holdNew && sockets.length === 1) this.hold(); // the first socket's server frames wait for `release()`
    }
  };
  const { openTimeoutMs, tabs, holdNew: _hold, ...rest } = opts;
  const client = makeClient(server, {
    WebSocket: WS,
    multiTab: { locks: tab.locks, BroadcastChannel: tab.BroadcastChannel, lifecycle: false, openTimeoutMs: openTimeoutMs ?? 2_000, clientIdTimeoutMs: 100, ...tabs },
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

  it("a claim named __proto__ is a claim like any other (two identities never share a key)", () => {
    // Written as JSON: an object literal's `__proto__` would set the prototype instead of making a claim.
    const raw = (json: string) => `h.${btoa(json).replace(/=+$/, "")}.sig`;
    const x = raw('{"sub":"alice","__proto__":"x","exp":1}');
    expect(socketIdentityKey(x)).not.toBe(socketIdentityKey(raw('{"sub":"alice","__proto__":"y","exp":1}')));
    expect(socketIdentityKey(x)).not.toBe(socketIdentityKey(raw('{"sub":"alice","exp":1}')));
    expect(socketIdentityKey(raw('{"sub":"alice","__proto__":{"admin":true}}'))).not.toBe(socketIdentityKey(raw('{"sub":"alice"}')));
    // Only the timing claims are left out.
    expect(socketIdentityKey(x)).toBe(socketIdentityKey(raw('{"exp":9,"__proto__":"x","sub":"alice"}')));
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

/** A hub that never leads (its lock is never granted), with a leader played by the test: frames are seen one by one. */
function manualHub(name = `n${Math.random()}`) {
  const browser = new FakeBrowser();
  const tab = browser.tab();
  const L = browser.tab();
  const E = "ember-ws/1";
  let inbox: { emit(d: unknown): void } | null = null;
  let onPost: ((m: Record<string, unknown>) => void) | null = null;
  const BC = class extends tab.BroadcastChannel {
    constructor(n: string) {
      super(n);
      if (n.includes(":tab:")) inbox = this as unknown as { emit(d: unknown): void };
    }
    override postMessage(m: unknown): void {
      onPost?.(m as Record<string, unknown>);
      super.postMessage(m);
    }
  };
  const locks: LockManagerLike = {
    request: ((_n: string, a: unknown, b?: unknown) => {
      const opts = (typeof a === "function" ? {} : a) as { ifAvailable?: boolean };
      const cb = (typeof a === "function" ? a : b) as (l: unknown) => unknown;
      return opts.ifAvailable ? Promise.resolve().then(() => cb(null)) : new Promise(() => undefined);
    }) as LockManagerLike["request"],
  };
  const NoWS = class {
    constructor() {
      throw new Error("no direct sockets here");
    }
  } as unknown as WebSocketConstructor;
  const hub = createMultiTab({ name, locks, BroadcastChannel: BC, lifecycle: false, openTimeoutMs: 60_000, WebSocket: NoWS, heartbeat: false })!;
  const ctl = new L.BroadcastChannel(`ember-ws:${name}`);
  const toLeader = new L.BroadcastChannel(`ember-ws:${name}:leader`);
  const toTab = new L.BroadcastChannel(`ember-ws:${name}:tab:${hub.id}`);
  const opens: string[] = [];
  toLeader.addEventListener("message", (ev) => {
    const m = ev.data as { k: string; vid: string };
    if (m.k === "open") opens.push(m.vid);
  });
  return {
    hub,
    E,
    opens,
    announce: (lid: string) => ctl.postMessage({ e: E, k: "leader", lid }),
    opened: (vid: string, lid: string) => toTab.postMessage({ e: E, k: "opened", vid, lid }),
    closed: (vid: string, lid: string) => toTab.postMessage({ e: E, k: "closed", vid, lid, code: 4100, reason: "x" }),
    /** Delivered synchronously to the hub's inbox (as if it were already queued when the hub posts). */
    injectNow: (m: unknown) => inbox!.emit(m),
    onPost: (f: typeof onPost) => (onPost = f),
    WS: hub.socketConstructor(),
  };
}

describe("multiTab: identity, expiry and routing guarantees", () => {
  it("an auth for another identity closes the virtual socket before anything is posted: nothing of the old identity is handed over after", async () => {
    const h = manualHub();
    const ws = new h.WS("wss://x/s");
    const got: unknown[] = [];
    ws.onmessage = (e) => got.push(e.data);
    await until(() => h.opens.length === 1);
    h.opened(h.opens[0]!, "L1");
    await until(() => ws.readyState === 1);
    ws.send(JSON.stringify({ t: "hello", clientId: "c", token: "user:alice" }));
    const states: number[] = [];
    h.onPost((m) => {
      if (m.k !== "send" && m.k !== "close") return;
      states.push(ws.readyState);
      // A frame computed for alice, handed to the tab at the moment of each post.
      h.injectNow({ e: h.E, k: "msg", vid: h.opens[0], lid: "L1", data: '{"t":"snap","qid":1,"version":1,"value":"alice-only"}' });
    });
    ws.send(JSON.stringify([{ t: "unsub", qid: 1 }, { t: "auth", token: "user:bob" }]));
    expect(states).toEqual([3, 3]); // closed already at the first post (the unsub before the auth, then `close`)
    expect(got).toEqual([]);
    h.hub.close();
  });

  it("opened / msg / closed are only taken from the current leader", async () => {
    const h = manualHub();
    h.announce("L2");
    await tick(5);
    const ws = new h.WS("wss://x/s");
    const got: unknown[] = [];
    ws.onmessage = (e) => got.push(e.data);
    await until(() => h.opens.length >= 1);
    const vid = h.opens[0]!;
    h.opened(vid, "L1"); // late answer of a leader that is gone
    await tick(5);
    expect(ws.readyState).toBe(0);
    h.opened(vid, "L2");
    await until(() => ws.readyState === 1);
    h.closed(vid, "L1");
    await tick(5);
    expect(ws.readyState).toBe(1);
    h.closed(vid, "L2");
    await until(() => ws.readyState === 3);
    h.hub.close();
  });

  it("a tab whose own token expired gets nothing more from the shared socket and runs nothing through it, until it renews", async () => {
    const realNow = Date.now.bind(Date);
    let shiftMs = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + shiftMs);
    try {
      const browser = new FakeBrowser();
      const server = messagesServer({ verify: verifyJwt });
      const now = Math.floor(realNow() / 1000);
      const a = tabClient(browser, server, { auth: () => jwt({ sub: "alice", exp: now + 100_000 }), refreshAuthBeforeExpiryMs: false });
      await until(() => a.client.tabRole === "leader");
      let bToken = jwt({ sub: "alice", exp: now + 60 });
      const b = tabClient(browser, server, { auth: () => bToken, refreshAuthBeforeExpiryMs: false });
      const wa = watch(a.client, list, { channel: "g" });
      const wb = watch(b.client, list, { channel: "g" });
      await until(() => wa.ok() && wb.ok());
      expect(shardSockets(server)).toHaveLength(1);

      shiftMs = 120_000; // b's own token has expired; the shared socket's (a's) has not
      server.mutateDirect(SHARD, "messages:send", { channel: "g", body: "after b expired" }, { subject: "alice" });
      await until(() => (wa.value() as string[]).includes("after b expired"));
      await tick(20);
      expect(wb.seen.some((x) => ((x.value as string[] | undefined) ?? []).includes("after b expired"))).toBe(false);
      // Its subscription left the shared socket; its mutation never reaches the shard.
      expect(server.subscriptionCount(SHARD)).toBe(1);
      const ran = server.executions;
      await expect(b.client.mutation(send, { channel: "g", body: "from an expired tab" })).rejects.toMatchObject({ code: "auth_expired" });
      expect(server.executions).toBe(ran);

      // Its own renewal brings it back.
      bToken = jwt({ sub: "alice", exp: now + 200_000 });
      b.client.setAuth(() => bToken);
      await until(() => ((wb.value() as string[] | undefined) ?? []).includes("after b expired"));
      await expect(b.client.mutation(send, { channel: "g", body: "renewed" })).resolves.toBeTypeOf("string");
      await until(() => (wa.value() as string[]).includes("renewed"));
      expect(shardSockets(server)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("a hello the shard refused: a later sign-in of the same identity moves that tab off, the other tab never sees its values", async () => {
    const browser = new FakeBrowser();
    const now = Math.floor(Date.now() / 1000);
    // `jti: "bad"` is refused by the shard; the identity key leaves `jti` out, so both tokens have the same key.
    const server = messagesServer({ verify: (t) => (payloadOf(t) as { jti?: string }).jti === "bad" ? null : verifyJwt(t) });
    const bad = jwt({ sub: "alice", jti: "bad", exp: now + 1000 });
    const a = tabClient(browser, server, { auth: () => bad, refreshAuthBeforeExpiryMs: false, holdNew: true });
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server, { auth: () => bad, refreshAuthBeforeExpiryMs: false });
    const wa = watch(a.client, me);
    const wb = watch(b.client, me);
    // Both said hello on the shared socket before the shard's answer (the refusal, then ready) came.
    await until(() => a.sockets.length === 1 && sentOf(a.sockets[0]!, "hello").length === 1);
    await tick(20);
    a.sockets[0]!.release();
    await until(() => wa.ok() && wb.ok());
    expect([wa.value(), wb.value()]).toEqual([null, null]);
    const refused = shardSockets(server);
    expect(refused).toHaveLength(1);
    b.client.setAuth(() => jwt({ sub: "alice", jti: "good", exp: now + 2000 }));
    await until(() => wb.value() === "alice");
    await tick(20);
    expect(wa.seen.every((x) => x.value === undefined || x.value === null)).toBe(true);
    expect(sentOf(refused[0]!, "auth")).toHaveLength(0);
  });

  it("an observer that closes the client when it becomes leader frees the lock: the next tab leads", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const holder: { client?: Tab["client"] } = {};
    const a = tabClient(browser, server, { tabs: { onRoleChange: (r) => r === "leader" && holder.client?.close() } });
    holder.client = a.client;
    await until(() => a.client.tabRole === "closed");
    const b = tabClient(browser, server);
    await until(() => b.client.tabRole === "leader");
    const wb = watch(b.client, list, { channel: "g" });
    await until(() => wb.ok());
  });

  it("a hub closed in the task that built it does not hold its tab lock once granted", async () => {
    const browser = new FakeBrowser();
    const tab = browser.tab();
    const NoWS = class {} as unknown as WebSocketConstructor;
    const hub = createMultiTab({ name: "closed-early", locks: tab.locks, BroadcastChannel: tab.BroadcastChannel, lifecycle: false, WebSocket: NoWS, heartbeat: false })!;
    hub.close(); // before the lock's grant callback ran
    await tick(5);
    expect(browser.locks.holder(`ember-ws:closed-early:tab:${hub.id}`)).toBeUndefined();
    expect(browser.locks.holder("ember-ws:closed-early")).toBeUndefined();
  });

  it("a tab that adopted the leader's clientId stores it (its queue keeps the dedup key after a reload)", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer();
    const a = tabClient(browser, server, { clientId: "explicit-leader-id" });
    await until(() => a.client.tabRole === "leader");
    await a.client.ready();
    const storage = new MemoryPendingStorage();
    const b = tabClient(browser, server, { storage });
    await b.client.ready();
    expect(b.client.clientId).toBe("explicit-leader-id");
    expect(await storage.getClientId()).toBe("explicit-leader-id");
  });

  it("a mutation whose first socket left: its resend waits for that attempt's answer, a success settles it without going out again", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer({ batch: true, ack: true });
    const a = tabClient(browser, server, { auth: () => "user:alice" });
    await until(() => a.client.tabRole === "leader");
    let emit: (e: "online" | "offline") => void = () => {};
    const b = tabClient(browser, server, { auth: () => "user:alice", connectivity: { subscribe: (e) => ((emit = e as typeof emit), () => {}) } });
    const wa = watch(a.client, list, { channel: "g" });
    const wb = watch(b.client, list, { channel: "g" });
    await until(() => wa.ok() && wb.ok());
    const shared = shardSockets(server)[0]!;
    shared.hold();
    const p = b.client.mutation(send, { channel: "g", body: "once" });
    await until(() => server.executions === 1);
    // b's virtual socket goes and comes back (offline, online): same group, and its client resends the mutation there.
    emit("offline");
    await tick(10);
    emit("online");
    await tick(20);
    // One attempt of a mid out at a time: the resend waits for the answer to the first one.
    expect(sentOf(shared, "mut")).toHaveLength(1);
    shared.release();
    await expect(p).resolves.toBeTypeOf("string");
    expect(sentOf(shared, "mut")).toHaveLength(1);
    expect(server.executions).toBe(1);
    expect(shardSockets(server)).toEqual([shared]);
  });

  it("the answer to the attempt of a socket that left never settles the resent mutation: after a refusal, the resend goes out", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer({ batch: true, ack: true });
    const a = tabClient(browser, server, { auth: () => "user:alice" });
    await until(() => a.client.tabRole === "leader");
    let emit: (e: "online" | "offline") => void = () => {};
    const b = tabClient(browser, server, { auth: () => "user:alice", connectivity: { subscribe: (e) => ((emit = e as typeof emit), () => {}) } });
    const wa = watch(a.client, list, { channel: "g" }); // keeps the shared socket while b's virtual socket is away
    const wb = watch(b.client, list, { channel: "g" });
    await until(() => wa.ok() && wb.ok());
    const shared = shardSockets(server)[0]!;
    shared.hold();
    const p = b.client.mutation(send, { channel: "g", body: "once" });
    await until(() => shared.held!.some((f) => f.includes('"t":"mres"')));
    emit("offline"); // its first virtual socket leaves with that attempt unanswered
    await tick(10);
    emit("online");
    await tick(20);
    expect(sentOf(shared, "mut")).toHaveLength(1);
    // The shard refused the first attempt (expired before it ran): that refusal is no answer to the resend.
    const at = shared.held!.findIndex((f) => f.includes('"t":"mres"'));
    const refuse = (x: unknown) => {
      const r = x as { t: string; mid: string };
      return r.t === "mres" ? { t: "mres", mid: r.mid, ok: false, error: { code: "auth_expired", message: "the token expired" } } : x;
    };
    const frame = JSON.parse(shared.held![at]!) as unknown;
    shared.held![at] = JSON.stringify(Array.isArray(frame) ? frame.map(refuse) : refuse(frame));
    shared.release();
    await expect(p).resolves.toBeTypeOf("string");
    // The resend went out after the refusal, and the shard answered it (from its dedup: one execution).
    expect(sentOf(shared, "mut")).toHaveLength(2);
    expect(server.executions).toBe(1);
  });

  it("a sensitive attempt still awaiting its session check when its socket left: a later attempt's success is not lost to it, nor its refusal handed over", async () => {
    // The shard does not answer the attempts of one mid in order: a `sensitive` one awaits `checkSensitive`, while a
    // later one may run and commit first. Here the oldest attempt is refused last, after the later one succeeded.
    const browser = new FakeBrowser();
    const server = messagesServer({ batch: true, ack: true });
    const a = tabClient(browser, server, { auth: () => "user:alice" });
    await until(() => a.client.tabRole === "leader");
    let emit: (e: "online" | "offline") => void = () => {};
    const b = tabClient(browser, server, { auth: () => "user:alice", connectivity: { subscribe: (e) => ((emit = e as typeof emit), () => {}) } });
    const wa = watch(a.client, list, { channel: "g" });
    const wb = watch(b.client, list, { channel: "g" });
    await until(() => wa.ok() && wb.ok());
    const shared = shardSockets(server)[0]!;
    shared.holdIncoming();
    const p = b.client.mutation(send, { channel: "g", body: "sensitive" });
    const isMut = (x: unknown) => (x as { t?: unknown } | null)?.t === "mut";
    const hasMut = (f: string) => f !== "ping" && [JSON.parse(f) as unknown].flat().some(isMut);
    await until(() => shared.heldIncoming!.some(hasMut));
    emit("offline");
    await tick(10);
    emit("online");
    await tick(20);
    // The oldest attempt waits on its session check (taken out); anything sent after it reaches the shard and runs.
    const at = shared.heldIncoming!.findIndex(hasMut);
    const oldest = [JSON.parse(shared.heldIncoming![at]!) as unknown].flat();
    const mid = (oldest.find(isMut) as { mid: unknown }).mid;
    const rest = oldest.filter((x) => !isMut(x));
    if (rest.length) shared.heldIncoming![at] = JSON.stringify(rest);
    else shared.heldIncoming!.splice(at, 1);
    shared.releaseIncoming();
    await tick(20);
    // Then its check fails (the session was signed out meanwhile, say): its refusal comes last.
    shared.deliver(JSON.stringify({ t: "mres", mid, ok: false, error: { code: "unauthenticated", message: "the session is no longer valid" } }));
    await expect(p).resolves.toBeTypeOf("string");
    expect(server.executions).toBe(1);
  });

  it("waiting members are greeted when the shard refuses the hello token (unauthenticated, then ready, one frame)", async () => {
    const browser = new FakeBrowser();
    const server = messagesServer({ batch: true });
    const a = tabClient(browser, server, { auth: () => "nope", holdNew: true });
    await until(() => a.client.tabRole === "leader");
    const b = tabClient(browser, server, { auth: () => "nope" });
    const w = [a, b].map((t) => watch(t.client, me));
    await until(() => a.sockets.length === 1);
    await tick(20);
    a.sockets[0]!.release();
    await until(() => w.every((x) => x.ok()));
    expect(w.map((x) => x.value())).toEqual([null, null]);
    expect(shardSockets(server)).toHaveLength(1);
  });

  it("a page back from freeze asks the leader again for a socket opened while it was away", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const doc = new EventTarget();
    const win = new EventTarget();
    const saved = { document: g.document, add: g.addEventListener, remove: g.removeEventListener };
    g.document = doc;
    g.addEventListener = win.addEventListener.bind(win);
    g.removeEventListener = win.removeEventListener.bind(win);
    try {
      const browser = new FakeBrowser();
      const server = messagesServer();
      const a = tabClient(browser, server);
      await until(() => a.client.tabRole === "leader");
      const b = tabClient(browser, server, { openTimeoutMs: 60_000, tabs: { lifecycle: true } });
      await until(() => b.client.tabRole === "follower");
      doc.dispatchEvent(new Event("freeze"));
      b.tab.freeze();
      const wb = watch(b.client, list, { channel: "g" });
      await tick(30); // its `open` went out; the leader's `opened` did not reach the frozen page
      b.tab.thaw();
      doc.dispatchEvent(new Event("resume"));
      await until(() => wb.ok(), 1000);
      expect(b.sockets).toHaveLength(0);
    } finally {
      for (const t of open.splice(0)) t.client.close();
      g.document = saved.document;
      g.addEventListener = saved.add;
      g.removeEventListener = saved.remove;
    }
  });
});

describe("FakeBrowser (testing helper)", () => {
  it("a dead tab's lock request settles (rejected); a tab that crashes before its grant runs none of its code", async () => {
    const browser = new FakeBrowser();
    const dead = browser.tab();
    dead.crash();
    await expect(dead.locks.request("x", () => 1)).rejects.toThrow(/gone/);
    const a = browser.tab();
    const b = browser.tab();
    const ran: string[] = [];
    const pa = a.locks.request("y", () => void ran.push("a"));
    const pb = b.locks.request("y", () => void ran.push("b"));
    a.crash(); // before the grant's callback ran
    await expect(pa).rejects.toThrow(/gone/);
    await pb;
    expect(ran).toEqual(["b"]);
    const c = browser.tab();
    c.crash();
    const d = browser.tab();
    const held = d.locks.request("z", () => new Promise((r) => setTimeout(r, 20)));
    const e = browser.tab();
    const pe = e.locks.request("z", { ifAvailable: true }, () => void ran.push("e"));
    e.crash();
    await expect(pe).rejects.toThrow(/gone/);
    await held;
    expect(ran).toEqual(["b"]);
  });

  it("a request queued behind another tab's lock rejects when its tab crashes (and is never granted)", async () => {
    const browser = new FakeBrowser();
    const a = browser.tab();
    const b = browser.tab();
    let release!: () => void;
    const held = a.locks.request("q", () => new Promise<void>((r) => (release = r)));
    await tick(1);
    const ran: string[] = [];
    const pb = b.locks.request("q", () => void ran.push("b"));
    b.crash(); // queued behind a
    await expect(pb).rejects.toThrow(/gone/);
    release();
    await held;
    await tick(1);
    expect(ran).toEqual([]);
    expect(browser.locks.holder("q")).toBeUndefined();
  });

  it("every destination gets its own copy of a message", async () => {
    const browser = new FakeBrowser();
    const [t1, t2, t3] = [browser.tab(), browser.tab(), browser.tab()];
    const from = new t1.BroadcastChannel("c");
    const seen: unknown[] = [];
    for (const t of [t2, t3]) {
      new t.BroadcastChannel("c").addEventListener("message", (ev) => {
        seen.push(structuredClone(ev.data));
        (ev.data as { n: number }).n = 99;
      });
    }
    from.postMessage({ n: 1 });
    await tick(5);
    expect(seen).toEqual([{ n: 1 }, { n: 1 }]);
  });
});
