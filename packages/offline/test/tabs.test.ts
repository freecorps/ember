// Multi-tab coordination, simulated: tabs are TabCoordinators sharing a FakeLocks (Web Locks) and Node's real
// BroadcastChannel; the "disk" is one MemoryBackend every leader opens. Then two EmberClients in two tabs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmberClient, stableStringify, type LocalQueryResult, type QuerySnapshot } from "@freecorps/ember-client";
import type { Doc } from "@freecorps/ember-server";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { FakeLocks } from "./locks.ts";
import { MemoryBackend, memoryStorage } from "../src/index.ts";
import type { ServableStorage } from "../src/remote.ts";
import { coordinateTabs, type TabCoordinator, type TabRole } from "../src/tabs.ts";

/** An adapter without watchQueryLocally (allowed by ServableStorage). */
const watchless = (s: ServableStorage): ServableStorage => ({
  load: () => s.load(),
  applyPatch: (u) => s.applyPatch(u),
  runQueryLocally: (r) => s.runQueryLocally(r),
  persistPending: s.persistPending,
  close: () => s.close?.(),
});

const SHARD = "org:acme";
const req = (fn: string, args: Record<string, unknown> = {}) => ({ shard: SHARD, fn, args, argsJson: stableStringify(args), identity: null });
const upd = (fn: string, args: Record<string, unknown>, value: unknown, version = 1) => ({ shard: SHARD, fn, args, argsJson: stableStringify(args), value, version });
const bodies = (x: unknown) => (x as Doc[]).map((d) => (d as any).body);
const until = (cond: () => unknown, timeout = 3000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout, interval: 2 },
  );

describe("tabs: one leader writes, followers go through it", () => {
  const live: Array<{ tab: TabCoordinator; channel: BroadcastChannel }> = [];
  afterEach(async () => {
    for (const t of live.splice(0)) {
      await t.tab.close().catch(() => undefined);
      t.channel.close();
    }
  });

  const world = () => {
    const locks = new FakeLocks();
    const disk = new MemoryBackend(schema);
    let opened = 0;
    const name = `t-${Math.random().toString(36).slice(2)}`;
    const store = () => memoryStorage({ schema, queries: offlineQueries, backend: disk });
    const tab = (id: string, open: () => ServableStorage | Promise<ServableStorage> = store) => {
      const channel = new BroadcastChannel(`ember-offline:${name}`);
      const roles: TabRole[] = [];
      const t = coordinateTabs({
        name,
        locks: locks.forTab(id),
        channel,
        open: () => {
          opened++;
          return open();
        },
        onRoleChange: (r) => roles.push(r),
      });
      live.push({ tab: t, channel });
      return { t, roles, id, kill: () => (locks.kill(id), channel.close()) };
    };
    return { tab, store, locks, opened: () => opened, name };
  };

  it("elects one leader; a follower's writes, queue and identity land in the leader's storage", async () => {
    const w = world();
    const a = w.tab("A");
    await until(() => a.t.role === "leader");
    const b = w.tab("B");
    await until(() => b.t.role === "follower");
    expect(w.opened()).toBe(1);
    expect(w.locks.holder(`ember-offline:${w.name}`)).toBe("A");

    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "from b" });
    await b.t.load();
    await b.t.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    await b.t.persistPending.setClientId("shared-client");
    await b.t.persistPending.put({ mid: "m1", shard: SHARD, fn: "messages:send", args: { big: 2n ** 62n, bytes: new Uint8Array([1, 2]) }, createdAt: 1 });
    await b.t.setIdentity({ subject: "ada" });
    // the leader sees all of it; so does the follower, through the leader
    expect(bodies((await a.t.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["from b"]);
    expect((await b.t.runQueryLocally(req("messages:search", { q: "from" })))!.value).toEqual(["from b"]);
    expect(await a.t.persistPending.getClientId()).toBe("shared-client");
    const [pending] = await a.t.persistPending.load();
    expect(pending!.args).toEqual({ big: 2n ** 62n, bytes: new Uint8Array([1, 2]) });
    expect(await a.t.load()).toEqual({ identity: { subject: "ada" } });
    // errors cross too
    await expect(b.t.runQueryLocally(req("messages:list", { channel: 1 }))).rejects.toThrow(/channel/);
  });

  it("streams watched local results to followers when any tab writes", async () => {
    const w = world();
    const a = w.tab("A");
    await until(() => a.t.role === "leader");
    const b = w.tab("B");
    await until(() => b.t.role === "follower");
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "one" });
    const seen: Array<LocalQueryResult | undefined> = [];
    b.t.watchQueryLocally(req("messages:latest", { channel: "a", n: 5 }), (r) => seen.push(r));
    await until(() => seen.length === 1);
    expect(bodies(seen[0]!.value)).toEqual([]);
    await a.t.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    await until(() => seen.length === 2);
    expect(bodies(seen[1]!.value)).toEqual(["one"]);
  });

  it("hands over when the leader dies: the next tab opens the storage, in-flight calls and watches follow", async () => {
    const w = world();
    const a = w.tab("A");
    await until(() => a.t.role === "leader");
    const b = w.tab("B");
    const c = w.tab("C");
    await until(() => b.t.role === "follower" && c.t.role === "follower");
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "before" });
    await b.t.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    const seen: Array<LocalQueryResult | undefined> = [];
    c.t.watchQueryLocally(req("messages:list", { channel: "a" }), (r) => seen.push(r));
    await until(() => seen.length === 1);

    a.kill(); // crash: no close(), the lock is just gone
    srv.m("messages:send", { channel: "a", body: "after" });
    // sent while nobody leads: answered by the next leader
    const write = b.t.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 2));
    await until(() => b.t.role === "leader");
    await write;
    expect(w.opened()).toBe(2);
    await until(() => seen.length === 2);
    expect(bodies(seen[1]!.value)).toEqual(["before", "after"]);
    expect(bodies((await c.t.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["before", "after"]);

    // a graceful close hands over too
    await b.t.close();
    await until(() => c.t.role === "leader");
    expect(bodies((await c.t.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["before", "after"]);
  });

  it("a storage without watchQueryLocally: watches get one-shot results in the leader as in followers", async () => {
    const w = world();
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "one" });
    const a = w.tab("A", () => watchless(w.store()));
    await until(() => a.t.role === "leader");
    const b = w.tab("B");
    await until(() => b.t.role === "follower");
    await a.t.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    const seenA: Array<LocalQueryResult | undefined> = [];
    const seenB: Array<LocalQueryResult | undefined> = [];
    const errors: Error[] = [];
    a.t.watchQueryLocally(req("messages:list", { channel: "a" }), (r) => seenA.push(r), (e) => errors.push(e));
    b.t.watchQueryLocally(req("messages:list", { channel: "a" }), (r) => seenB.push(r), (e) => errors.push(e));
    await until(() => seenA.length === 1 && seenB.length === 1);
    expect(errors).toEqual([]);
    expect(bodies(seenA[0]!.value)).toEqual(["one"]);
    expect(bodies(seenB[0]!.value)).toEqual(["one"]);
  });

  it("two EmberClients in two tabs: the offline tab's subscription follows the online tab's server values", async () => {
    const w = world();
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "first" });
    const a = w.tab("A");
    await until(() => a.t.role === "leader");
    const b = w.tab("B");
    const client = (storage: TabCoordinator, online: boolean) =>
      new EmberClient({
        url: "https://ember.test",
        WebSocket: srv.fake.WebSocket,
        fetch: srv.fake.fetch,
        connectivity: { isOnline: () => online, subscribe: () => () => {} },
        defaultShard: SHARD,
        heartbeat: false,
        storage,
      });
    const ca = client(a.t, true);
    const cb = client(b.t, false);
    const seen: QuerySnapshot<Doc[]>[] = [];
    cb.subscribe("messages:latest", { channel: "a", n: 3 }, {}, (s: QuerySnapshot<Doc[]>) => seen.push(s));
    ca.subscribe("messages:list", { channel: "a" }, {}, () => {});
    await until(() => bodies(seen.at(-1)?.value ?? []).length === 1);
    await ca.mutation("messages:send", { channel: "a", body: "second" });
    await until(() => bodies(seen.at(-1)?.value ?? []).length === 2);
    expect(seen.at(-1)).toMatchObject({ source: "local" });
    expect(bodies(seen.at(-1)!.value)).toEqual(["second", "first"]);
    // both tabs share the client id (dedup spans tabs) and the pending queue
    expect(ca.clientId).toBe(cb.clientId);
    ca.close();
    cb.close();
  });
});
