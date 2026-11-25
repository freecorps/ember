// A value computed for one identity never reaches a listener of another (CWE-200): every async completion (a local
// query, a local watch, a snapshot cache read, an `httpFirst` fetch) is dropped once the identity it was requested
// under is no longer the client's, whatever happened to the subscription meanwhile (grace, reuse); and after `setAuth`
// replaces a token source, local queries wait for the new one's token instead of running as the last identity.
import { describe, expect, it } from "vitest";
import { makeClient, messagesServer, tick, until } from "./helpers.ts";
import { MemoryPendingStorage, unsafeRef, type LocalQueryRequest, type LocalQueryResult, type QuerySnapshot, type StorageAdapter } from "../src/index.ts";
import type { CachedSnapshot, SnapshotCache } from "../src/snapshot-cache.ts";

const me = unsafeRef("users:me");
const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, "")}.sig`;
const subjectOf = (t: string) => (JSON.parse(atob(t.split(".")[1]!)) as { sub: string }).sub;
const verify = (t: string) => ({ subject: subjectOf(t) });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** An adapter whose local query results the test hands out (each request waits for it). */
function heldAdapter() {
  const requests: Array<{ req: LocalQueryRequest; d: ReturnType<typeof deferred<LocalQueryResult | undefined>> }> = [];
  const storage: StorageAdapter = {
    load: async () => ({ identity: null }),
    persistPending: new MemoryPendingStorage(),
    applyPatch: () => {},
    runQueryLocally: (req) => {
      const d = deferred<LocalQueryResult | undefined>();
      requests.push({ req, d });
      return d.promise;
    },
  };
  return { storage, requests };
}

const offlineServer = () => {
  const server = messagesServer({ batch: true, verify });
  server.refuseConnections = 1_000_000; // offline: nothing from the server, only what the client holds
  return server;
};

describe("async results of a previous identity", () => {
  it("a local query of the previous identity resolving after the subscription was reused: dropped (CodeRabbit's sequence)", async () => {
    const server = offlineServer();
    const { storage, requests } = heldAdapter();
    const client = makeClient(server, { unsubscribeGraceMs: 60_000, auth: () => jwt("alice"), storage, backoff: { initialMs: 600_000, maxMs: 600_000 } });
    // 1. Alice's local query starts and stays pending (past the 250 ms the `sub` waits for it).
    const off = client.subscribe(me, {}, {}, () => {});
    await until(() => requests.some((r) => r.req.identity?.subject === "alice"));
    await tick(300);
    const alices = [...requests];
    // 2. Switch to Bob while the subscription still has a listener; Bob's token settles.
    client.setAuth(() => jwt("bob"));
    await tick(5);
    // 3. The listener leaves (grace starts), and Bob subscribes again: the same subscription is reused.
    off();
    await tick(5);
    const seen: QuerySnapshot[] = [];
    const off2 = client.subscribe(me, {}, {}, (s) => seen.push(s));
    // 4. Alice's requests resolve.
    for (const r of alices) r.d.resolve({ value: "alice's", source: "local" });
    await tick(5);
    expect(seen.map((s) => s.value)).not.toContain("alice's");
    expect(client.localQueryResult(me, {})?.value).toBeUndefined();
    off2();
    client.close();
  });

  it("the same through a local watch: a callback of the previous identity's watch is ignored", async () => {
    const server = offlineServer();
    const watches: Array<{ req: LocalQueryRequest; cb: (r: LocalQueryResult | undefined) => void }> = [];
    const storage: StorageAdapter = {
      load: async () => ({ identity: null }),
      persistPending: new MemoryPendingStorage(),
      applyPatch: () => {},
      runQueryLocally: () => undefined,
      watchQueryLocally: (req, cb) => {
        watches.push({ req, cb });
        return () => {};
      },
    };
    const client = makeClient(server, { unsubscribeGraceMs: 60_000, auth: () => jwt("alice"), storage, backoff: { initialMs: 600_000, maxMs: 600_000 } });
    const off = client.subscribe(me, {}, {}, () => {});
    await until(() => watches.some((w) => w.req.identity?.subject === "alice"));
    await tick(300);
    const alices = [...watches];
    client.setAuth(() => jwt("bob"));
    await tick(5);
    off();
    await tick(5);
    const seen: QuerySnapshot[] = [];
    const off2 = client.subscribe(me, {}, {}, (s) => seen.push(s));
    for (const w of alices) w.cb({ value: "alice's", source: "local" });
    await tick(5);
    expect(seen.map((s) => s.value)).not.toContain("alice's");
    expect(client.localQueryResult(me, {})?.value).toBeUndefined();
    off2();
    client.close();
  });

  it("a snapshot cache read for the previous identity (same fetcher, now answering for someone else): dropped", async () => {
    const server = offlineServer();
    const reads: Array<{ identity: string; d: ReturnType<typeof deferred<CachedSnapshot | undefined>> }> = [];
    const cache: SnapshotCache = {
      get: (identity) => {
        const d = deferred<CachedSnapshot | undefined>();
        reads.push({ identity, d });
        return d.promise;
      },
      set: () => {},
      delete: () => {},
      clear: () => {},
    };
    let who = "alice";
    // Reconnect attempts fetch the token again: the fetcher answers for bob once `who` changes (authGen stays).
    const client = makeClient(server, { auth: () => jwt(who), snapshotCache: cache, backoff: { initialMs: 5, maxMs: 5 } });
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    await until(() => reads.some((r) => r.identity.includes("alice")));
    who = "bob";
    await tick(60); // a few reconnect attempts, each fetching the token: bob's now
    for (const r of reads) if (r.identity.includes("alice")) r.d.resolve({ value: "alice's", version: 1, epoch: "e", ik: "i", at: Date.now() });
    await tick(5);
    expect(seen.map((s) => s.value)).not.toContain("alice's");
    expect(client.localQueryResult(me, {})?.value).toBeUndefined();
    client.close();
  });

  it("an httpFirst answer fetched for the previous identity (same fetcher, now answering for someone else): dropped", async () => {
    const server = messagesServer({ batch: true, verify, ident: true, query: true });
    server.refuseConnections = 1_000_000;
    const held: Array<{ release: () => void; authorization: string | null }> = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/api/query")) return server.fetch(input, init);
      const d = deferred<Response>();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      held.push({ release: () => void server.fetch(input, init).then(d.resolve, d.reject), authorization: headers.authorization ?? null });
      return d.promise;
    };
    let who = "alice";
    const client = makeClient(server, { httpFirst: true, fetch, auth: () => jwt(who), backoff: { initialMs: 5, maxMs: 5 } });
    // Alice's token is known (a first subscription's connect attempts fetched it); the socket keeps failing to open.
    client.subscribe(unsafeRef("messages:count"), {}, {}, () => {});
    await until(() => server.history.length >= 2);
    held.length = 0;
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    await until(() => held.length === 1);
    expect(held[0]!.authorization).toBe(`Bearer ${jwt("alice")}`);
    who = "bob";
    await tick(60); // reconnect attempts fetch bob's token
    held[0]!.release();
    await tick(20);
    expect(seen.map((s) => s.value)).not.toContain("alice");
    expect(client.localQueryResult(me, {})?.value).toBeUndefined();
    client.close();
  });

  it("a local read still pending (past the wait) at the identity change: read again for the new identity", async () => {
    const server = offlineServer();
    const { storage, requests } = heldAdapter();
    const client = makeClient(server, { auth: () => jwt("alice"), storage, backoff: { initialMs: 600_000, maxMs: 600_000 } });
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    await until(() => requests.some((r) => r.req.identity?.subject === "alice"));
    await tick(300); // past LOCAL_WAIT_MS: no local value, no read the sub waits for, no watch
    client.setAuth(() => jwt("bob"));
    await until(() => requests.some((r) => r.req.identity?.subject === "bob"));
    for (const r of requests) r.d.resolve({ value: `${r.req.identity?.subject}'s`, source: "local" });
    await until(() => seen.at(-1)?.value === "bob's");
    expect(seen.map((s) => s.value)).not.toContain("alice's");
    client.close();
  });

  it("current-identity results still land (no regression)", async () => {
    const server = offlineServer();
    const { storage, requests } = heldAdapter();
    const client = makeClient(server, { auth: () => jwt("alice"), storage, backoff: { initialMs: 600_000, maxMs: 600_000 } });
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    await until(() => requests.some((r) => r.req.identity?.subject === "alice"));
    await tick(5);
    for (const r of requests) r.d.resolve({ value: r.req.identity?.subject ?? "nobody", source: "local" });
    await until(() => seen.at(-1)?.value === "alice");
    client.close();
  });
});

describe("right after setAuth, before the new token", () => {
  const adapter = () => {
    const requests: LocalQueryRequest[] = [];
    const storage: StorageAdapter = {
      load: async () => ({ identity: null }),
      persistPending: new MemoryPendingStorage(),
      applyPatch: () => {},
      runQueryLocally: (req) => {
        requests.push(req);
        return req.identity ? { value: req.identity.subject, source: "local" } : undefined;
      },
    };
    return { storage, requests };
  };

  it("a new local query waits for the new identity: never runs as the last one", async () => {
    const server = offlineServer();
    const { storage, requests } = adapter();
    const client = makeClient(server, { auth: () => jwt("alice"), storage, backoff: { initialMs: 600_000, maxMs: 600_000 } });
    let last: QuerySnapshot | undefined;
    const off = client.subscribe(me, {}, {}, (s) => (last = s));
    await until(() => last?.value === "alice");
    off();
    await tick(5);
    const bob = deferred<string>();
    client.setAuth(() => bob.promise);
    const n = requests.length;
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    await tick(300);
    expect(requests.slice(n).map((r) => r.identity?.subject)).not.toContain("alice");
    expect(seen.map((s) => s.value)).not.toContain("alice");
    bob.resolve(jwt("bob"));
    await until(() => seen.at(-1)?.value === "bob");
    expect(seen.map((s) => s.value)).not.toContain("alice");
    expect(requests.slice(n).map((r) => r.identity?.subject)).toEqual(["bob"]);
    client.close();
  });

  it("the new source's token fails: nothing local (not the last identity's)", async () => {
    const server = offlineServer();
    const { storage, requests } = adapter();
    const client = makeClient(server, { auth: () => jwt("alice"), storage, backoff: { initialMs: 600_000, maxMs: 600_000 } });
    let last: QuerySnapshot | undefined;
    const off = client.subscribe(me, {}, {}, (s) => (last = s));
    await until(() => last?.value === "alice");
    off();
    await tick(5);
    client.setAuth(() => Promise.reject(new Error("offline")));
    const n = requests.length;
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    await tick(300);
    expect(requests.length).toBe(n);
    expect(seen.map((s) => s.value)).not.toContain("alice");
    client.close();
  });

  it("the new source fails, then recovers to the same user: local reads start again", async () => {
    const server = offlineServer();
    const { storage } = adapter();
    const client = makeClient(server, { auth: () => jwt("alice"), storage, backoff: { initialMs: 5, maxMs: 5 } });
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    await until(() => seen.at(-1)?.value === "alice");
    let failing = true;
    let fetches = 0;
    client.setAuth(async () => {
      fetches++;
      if (failing) throw new Error("offline");
      return jwt("alice");
    });
    await until(() => fetches >= 2); // the replacement fetch failed (and a reconnect attempt failed again)
    expect(seen.at(-1)?.value).toBeUndefined();
    failing = false;
    // A reconnect attempt fetches the token again: the same user, while the socket still cannot open.
    await until(() => seen.at(-1)?.value === "alice");
    client.close();
  });

  it("a subscription still listened to: the previous identity's local value leaves the screen at setAuth", async () => {
    const server = offlineServer();
    const { storage } = adapter();
    const client = makeClient(server, { auth: () => jwt("alice"), storage, backoff: { initialMs: 600_000, maxMs: 600_000 } });
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    await until(() => seen.at(-1)?.value === "alice");
    const bob = deferred<string>();
    client.setAuth(() => bob.promise);
    expect(client.localQueryResult(me, {})?.value).toBeUndefined();
    expect(seen.at(-1)?.value).toBeUndefined();
    bob.resolve(jwt("bob"));
    await until(() => seen.at(-1)?.value === "bob");
    client.close();
  });

  it("the first source of a client built without one keeps the last session's identity (offline-first start)", async () => {
    const server = offlineServer();
    const requests: LocalQueryRequest[] = [];
    const storage: StorageAdapter = {
      load: async () => ({ identity: { subject: "alice" } }),
      persistPending: new MemoryPendingStorage(),
      applyPatch: () => {},
      runQueryLocally: (req) => (requests.push(req), req.identity ? { value: req.identity.subject, source: "local" } : undefined),
    };
    const client = makeClient(server, { storage, backoff: { initialMs: 600_000, maxMs: 600_000 } });
    client.setAuth(() => new Promise<string>(() => {})); // e.g. bindEmberAuth({ initial: true }), offline
    const seen: QuerySnapshot[] = [];
    client.subscribe(me, {}, {}, (s) => seen.push(s));
    await until(() => seen.at(-1)?.value === "alice");
    client.close();
  });
});
