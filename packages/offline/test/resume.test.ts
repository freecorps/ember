// Reopening with a cached value (contracts.md "Retomar do que o cliente tem"): the store keeps the version, epoch,
// identity tag and owner of each server value, hands them back with the cached value of its owner only, and the
// client subscribes with `resume` from it (the shard answers `unchanged`: nothing downloaded).
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmberClient, stableStringify, type QuerySnapshot, unsafeRef } from "@freecorps/ember-client";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { backend, type BackendKind } from "./backends.ts";

const SHARD = "org:acme";
const until = (cond: () => unknown, timeout = 3000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout, interval: 2 },
  );

describe.each(["sqlite", "indexeddb", "memory", "tinybase"] as BackendKind[])("resume from the offline cache: %s", (kind) => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it("a cached value is resumed on reopen: unchanged, no second download", async () => {
    const srv = engineServer({ ident: true });
    srv.m("messages:send", { channel: "a", body: "one" });
    const b = backend(kind);
    cleanups.push(b.cleanup);
    const open = () =>
      new EmberClient({ url: "https://ember.test", WebSocket: srv.fake.WebSocket, fetch: srv.fake.fetch, connectivity: null, defaultShard: SHARD, heartbeat: false, httpFirst: false, storage: b.make({ schema, queries: offlineQueries }) });
    const c1 = open();
    const s1: QuerySnapshot[] = [];
    c1.subscribe(unsafeRef("messages:count"), {}, {}, (s) => s1.push(s));
    await until(() => s1.some((s) => s.status === "success" && !s.source));
    await c1.flushStorage();
    c1.close();
    const c2 = open();
    const s2: QuerySnapshot[] = [];
    c2.subscribe(unsafeRef("messages:count"), {}, {}, (s) => s2.push(s));
    await until(() => s2.some((s) => s.status === "success" && !s.source));
    expect(s2[0]).toMatchObject({ value: 1, source: "cache" });
    const ws = srv.fake.open(SHARD).at(-1)!;
    const sub = ws.sent.find((m) => m !== "ping" && m.t === "sub") as { resume?: unknown };
    expect(sub.resume).toMatchObject({ epoch: expect.any(String), ik: expect.any(String) });
    expect(ws.received.filter((m) => m !== "pong" && m.t === "snap").map((m) => (m as { unchanged?: boolean }).unchanged)).toEqual([true]);
    await c2.flushStorage();
    c2.close();
  });
});

describe("cached values belong to their owner", () => {
  it("a value stored for one identity is not returned (nor resumable) for another; older records are shown, not resumed", async () => {
    const b = backend("memory");
    const store = b.make({ schema, queries: {} });
    await store.load();
    const args = { channel: "x" };
    const base = { shard: SHARD, fn: "messages:count", args, argsJson: stableStringify(args), version: 7, epoch: "e1", ik: "tagA" };
    await store.applyPatch({ ...base, value: 3, identity: { subject: "alice", issuer: "i" } });
    const req = (identity: { subject: string; issuer?: string } | null) => ({ shard: SHARD, fn: "messages:count", args, argsJson: stableStringify(args), identity });
    expect(await store.runQueryLocally(req({ subject: "alice", issuer: "i" }))).toEqual({ value: 3, source: "cache", version: 7, epoch: "e1", ik: "tagA" });
    expect(await store.runQueryLocally(req({ subject: "bob", issuer: "i" }))).toBeUndefined();
    expect(await store.runQueryLocally(req(null))).toBeUndefined();
    // Signed out: its own records.
    await store.applyPatch({ ...base, argsJson: "{}", args: {}, value: 1, identity: null });
    expect(await store.runQueryLocally({ ...req(null), args: {}, argsJson: "{}" })).toMatchObject({ value: 1, ik: "tagA" });
    // Written without an owner (an older client, an opaque token): shown as before, never resumed.
    await store.applyPatch({ shard: SHARD, fn: "messages:count", args: { channel: "old" }, argsJson: stableStringify({ channel: "old" }), version: 1, value: 9 });
    expect(await store.runQueryLocally({ ...req({ subject: "bob" }), args: { channel: "old" }, argsJson: stableStringify({ channel: "old" }) })).toEqual({ value: 9, source: "cache" });
    await store.close();
  });
});
