// Reopening with a cached value (contracts.md "Retomar do que o cliente tem"): the store keeps the version, epoch,
// identity tag and owner of each server value, hands them back with the cached value of its owner only, and the
// client subscribes with `resume` from it (the shard answers `unchanged`: nothing downloaded).
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmberClient, stableStringify, type QuerySnapshot, unsafeRef } from "@freecorps/ember-client";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { backend, type BackendKind } from "./backends.ts";
import { MemoryBackend, memoryStorage } from "../src/index.ts";

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
    // Whose it is cannot be told (an opaque token): nobody's. Nor does it take over alice's record.
    const unknown = { shard: SHARD, fn: "messages:count", args: { channel: "op" }, argsJson: stableStringify({ channel: "op" }), version: 1, value: 9, ownerUnknown: true as const };
    await store.applyPatch(unknown);
    for (const id of [null, { subject: "alice", issuer: "i" }, { subject: "bob" }]) expect(await store.runQueryLocally({ ...req(id), args: unknown.args, argsJson: unknown.argsJson })).toBeUndefined();
    await store.applyPatch({ ...base, value: 4, version: 8, ownerUnknown: true });
    expect(await store.runQueryLocally(req({ subject: "alice", issuer: "i" }))).toBeUndefined();
    expect(await store.runQueryLocally(req({ subject: "bob", issuer: "i" }))).toBeUndefined();
    await store.close();
    // A caller that does not say (an older client) over an owned record: still nobody's, not public.
    await store.applyPatch({ ...base, args: {}, argsJson: "{}", value: 2, version: 9 });
    expect(await store.runQueryLocally({ ...req(null), args: {}, argsJson: "{}" })).toBeUndefined();
    // Written before owners were recorded (an older store): shown as before, never resumed; a log entry without an
    // owner keeps the record's.
    const mb = new MemoryBackend(schema);
    const mem = memoryStorage({ schema, queries: {}, backend: mb });
    await mem.load();
    await mem.applyPatch({ ...base, args: { channel: "l" }, argsJson: stableStringify({ channel: "l" }), value: 5, identity: { subject: "alice", issuer: "i" } });
    await mem.close();
    for (const r of mb.queries.values()) {
      delete r.owner;
      delete r.ik;
    }
    const again = memoryStorage({ schema, queries: {}, backend: mb });
    await again.load();
    expect(await again.runQueryLocally({ ...req({ subject: "bob" }), args: { channel: "l" }, argsJson: stableStringify({ channel: "l" }) })).toEqual({ value: 5, source: "cache" });
    await again.close();
  });
});
