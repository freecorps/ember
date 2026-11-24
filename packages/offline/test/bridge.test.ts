// What crosses the RemoteStorage bridge (OPFS Worker, leader tab) per patch: a value once, then RowDiff/ValueDiff of
// the rows that changed (diff.ts finds them by identity); whole values again for a server without the base (new
// leader, older version); and nothing at all for a value the leader's storage said it already holds.
import { describe, expect, it, vi } from "vitest";
import { MemoryPendingStorage, stableStringify, type QueryUpdate } from "@freecorps/ember-client";
import { applyRowDiff, applyValueDiff } from "@freecorps/ember-values";
import type { Doc } from "@freecorps/ember-server";
import { RemoteStorage, serveStorage, type Endpoint, type ServableStorage } from "../src/remote.ts";
import { identityDiff, identityRowDiff, identityValueDiff } from "../src/diff.ts";
import { memoryStorage } from "../src/index.ts";
import { engineServer, offlineQueries, schema } from "./app.ts";

/** A BroadcastChannel stand-in: every message reaches every other endpoint, asynchronously, in order. */
function bus() {
  const ends = new Set<{ listeners: Set<(e: { data: unknown }) => void> }>();
  return (): Endpoint & { sent: Array<Record<string, unknown>> } => {
    const me = { listeners: new Set<(e: { data: unknown }) => void>() };
    ends.add(me);
    const sent: Array<Record<string, unknown>> = [];
    return {
      sent,
      postMessage(data) {
        sent.push(data as Record<string, unknown>);
        const copy = structuredClone(data);
        for (const e of ends) if (e !== me) for (const l of [...e.listeners]) setTimeout(() => l({ data: copy }), 0);
      },
      addEventListener: (_t, l) => void me.listeners.add(l),
      removeEventListener: (_t, l) => void me.listeners.delete(l),
    };
  };
}

const until = (cond: () => unknown) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout: 2000, interval: 2 },
  );

/** A storage that records every update it is handed. */
function recording(extra: Partial<ServableStorage> = {}) {
  const got: QueryUpdate[] = [];
  const s: ServableStorage = {
    load: async () => ({ identity: null }),
    applyPatch: async (u) => void got.push(u),
    runQueryLocally: async () => undefined,
    persistPending: new MemoryPendingStorage(),
    ...extra,
  };
  return { s, got };
}

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: `id${i}`, _creationTime: i, body: `row ${i} ${"x".repeat(80)}` }));
const update = (value: unknown, version: number, extra: Partial<QueryUpdate> = {}): QueryUpdate => ({
  shard: "s",
  fn: "messages:list",
  args: {},
  argsJson: stableStringify({}),
  value,
  version,
  epoch: "E",
  ...extra,
});
const bytesOf = (m: unknown) => JSON.stringify(m).length;
const reqsOf = (e: { sent: Array<Record<string, unknown>> }, op?: string) => e.sent.filter((m) => m.k === "req" && (!op || m.op === op));

describe("identity diffs", () => {
  it("a row diff carries only rows that are not the same object; applying it gives the new value", () => {
    const a = docs(50);
    const b = [...a.slice(0, 10), { ...a[10]!, body: "changed" }, ...a.slice(11, 40), { _id: "new", _creationTime: 99, body: "n" }, ...a.slice(41)];
    const d = identityRowDiff(a, b)!;
    expect(d.upsert.map((x) => x._id)).toEqual(["id10", "new"]);
    expect(d.remove).toEqual(["id40"]);
    expect(applyRowDiff(structuredClone(a), d)).toEqual(b);
    // a moved row (same object) is sent whole: the receiver needs it at its new place
    const moved = [a[49]!, ...a.slice(0, 49)];
    const dm = identityRowDiff(a, moved);
    if (dm) expect(applyRowDiff(structuredClone(a), dm)).toEqual(moved);
  });

  it("a value diff walks objects holding doc arrays ({page}), field order and deletions included", () => {
    const page = docs(20);
    const a = { page, isDone: false, continueCursor: "c1", extra: 1 };
    const b = { isDone: true, page: [...page.slice(1), { _id: "z", _creationTime: 1, body: "z" }], continueCursor: "c1", more: "m" };
    const d = identityValueDiff(a, b)!;
    expect(d.r!.page!.upsert.map((x) => x._id)).toEqual(["z"]);
    expect(d.d).toEqual(["extra"]);
    expect(applyValueDiff(structuredClone(a), d)).toEqual(b);
    expect(Object.keys(applyValueDiff(structuredClone(a), d))).toEqual(Object.keys(b));
  });

  it("values that are not doc arrays nor objects go whole", () => {
    expect(identityDiff(3, 4)).toBeNull();
    expect(identityDiff([1, 2], [1, 2, 3])).toBeNull();
    expect(identityDiff([{ _id: "a" }, { _id: "a" }], [])).toBeNull();
  });
});

describe("patches over the bridge", () => {
  it("the first value goes whole, the next ones as diffs of the changed rows; the server rebuilds them exactly", async () => {
    const endpoint = bus();
    const { s, got } = recording();
    const server = serveStorage(s, endpoint());
    const end = endpoint();
    const remote = new RemoteStorage(end);
    await remote.load();
    let value = docs(500);
    await remote.applyPatch(update(value, 1));
    const whole = bytesOf(reqsOf(end, "applyPatch").at(-1));
    for (let v = 2; v <= 6; v++) {
      value = value.map((d, i) => (i === v * 7 ? { ...d, body: `edited ${v}` } : d));
      await remote.applyPatch(update(value, v));
    }
    const diffs = reqsOf(end, "applyDiff");
    expect(diffs).toHaveLength(5);
    const per = Math.max(...diffs.map(bytesOf));
    console.log(`[offline] bridge bytes per patch (500 rows, 1 changed): whole ${whole} → diff ${per} (${(whole / per).toFixed(0)}x)`);
    expect(per * 50).toBeLessThan(whole);
    expect(got.map((u) => u.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(got.at(-1)!.value).toEqual(value);
    server.stop();
    remote.close();
  });

  it("a new leader gets whole values (also for calls in flight); a server without the base makes the caller resend whole", async () => {
    const endpoint = bus();
    const first = recording();
    const s1 = serveStorage(first.s, endpoint(), { address: "leader" });
    const end = endpoint();
    const remote = new RemoteStorage(end, { to: "leader" });
    await remote.load();
    const v1 = docs(30);
    await remote.applyPatch(update(v1, 1));
    s1.stop();
    // The next leader announces itself: it never saw v1, so v2 cannot be a diff for it.
    const second = recording();
    const s2 = serveStorage(second.s, endpoint(), { address: "leader" });
    s2.announce("tab-2");
    await new Promise((r) => setTimeout(r, 5));
    const v2 = [{ ...v1[0]!, body: "e" }, ...v1.slice(1)];
    await remote.applyPatch(update(v2, 2));
    expect(second.got.map((u) => u.value)).toEqual([v2]);
    // A server that lost the base without announcing (simulated: forget the caller) answers no_base: resent whole.
    s2.dropPeer(remote.id);
    const v3 = [v2[0]!, { ...v2[1]!, body: "e2" }, ...v2.slice(2)];
    await remote.applyPatch(update(v3, 3));
    expect(second.got.at(-1)!.value).toEqual(v3);
    expect(reqsOf(end, "applyDiff").length).toBeGreaterThan(0);
    s2.stop();
    remote.close();
  });

  it("an older server (no diff feature, unknown op) keeps getting whole updates", async () => {
    const endpoint = bus();
    const { s, got } = recording();
    // An older leader: no `features` in its load answer, no `f` in its announcement, `applyDiff` unknown.
    const serverEnd = endpoint();
    serverEnd.addEventListener("message", (ev) => {
      const m = ev.data as { k: string; op: string; id: number; from: string; a: unknown[] };
      if (m.k !== "req") return;
      const reply = (ok: boolean, v?: unknown, e?: unknown) => serverEnd.postMessage({ ember: "offline/1", k: "res", id: m.id, to: m.from, ok, v, e });
      if (m.op === "load") return reply(true, { identity: null, sync: [] });
      if (m.op === "applyPatch") return void Promise.resolve(s.applyPatch(m.a[0] as QueryUpdate)).then(() => reply(true));
      reply(false, undefined, { name: "Error", message: `offline storage: unknown operation ${m.op}` });
    });
    const end = endpoint();
    const remote = new RemoteStorage(end);
    await remote.load();
    const v1 = docs(10);
    await remote.applyPatch(update(v1, 1));
    await remote.applyPatch(update([{ ...v1[0]!, body: "e" }, ...v1.slice(1)], 2));
    expect(reqsOf(end, "applyDiff")).toHaveLength(0);
    expect(got.map((u) => u.version)).toEqual([1, 2]);
    remote.close();
  });

  it("values older than what the leader's store said it holds are not handed over (an equal version still is)", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "hi" });
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    const endpoint = bus();
    const store = memoryStorage({ schema, queries: offlineQueries });
    await store.load();
    const server = serveStorage(store, endpoint(), { address: "leader" });
    const otherTab = new RemoteStorage(endpoint(), { to: "leader" });
    const end = endpoint();
    const tab = new RemoteStorage(end, { to: "leader" });
    await Promise.all([otherTab.load(), tab.load()]);
    const ana = { subject: "ana" };
    const u = { ...update(list, 4, { identity: ana }), fn: "messages:list", args: { channel: "a" }, argsJson: stableStringify({ channel: "a" }) };
    await otherTab.applyPatch(u);
    await until(() => (tab as unknown as { savedRecs: Map<string, unknown> }).savedRecs.size === 1);
    const before = reqsOf(end).length;
    await tab.applyPatch({ ...u, version: 3 }); // older: the store would skip it
    expect(reqsOf(end).length).toBe(before);
    // The same version is sent: a value can change at the same version without a commit (a re-evaluation), and the
    // store takes it.
    const changed = { ...u, value: [{ ...list[0]!, body: "re-evaluated" }] };
    await tab.applyPatch(changed);
    expect(reqsOf(end).length).toBe(before + 1);
    expect(["applyPatch", "applyDiff"]).toContain(reqsOf(end).at(-1)!.op); // reaches the leader's store, which decides
    // Another identity, or a newer version, is sent.
    await tab.applyPatch({ ...u, identity: { subject: "bob" } });
    await tab.applyPatch({ ...u, version: 5 });
    expect(reqsOf(end).length).toBe(before + 3);
    // A drop (clear on sign-out) forgets it: an older version is stored again.
    await otherTab.clear();
    await until(() => (tab as unknown as { savedRecs: Map<string, unknown> }).savedRecs.size === 0);
    await tab.applyPatch({ ...u, version: 3 });
    expect(reqsOf(end).length).toBe(before + 4);
    server.stop();
    tab.close();
    otherTab.close();
    await store.close();
  });

  it("a clear queued before an update the leader already holds: the update is still sent, after the clear", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "hi" });
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    const endpoint = bus();
    const store = memoryStorage({ schema, queries: offlineQueries });
    await store.load();
    const server = serveStorage(store, endpoint(), { address: "leader" });
    const tab = new RemoteStorage(endpoint(), { to: "leader" });
    await tab.load();
    const ana = { subject: "ana" };
    const u = { ...update(list, 4, { identity: ana }), fn: "messages:list", args: { channel: "a" }, argsJson: stableStringify({ channel: "a" }) };
    await tab.applyPatch(u);
    await until(() => (tab as unknown as { savedRecs: Map<string, unknown> }).savedRecs.size === 1);
    // Unawaited clear, then the same value again (e.g. the client re-persisting after a sign-out/sign-in).
    const cleared = tab.clear();
    await tab.applyPatch(u);
    await cleared;
    expect((await store.runQueryLocally({ shard: "s", fn: "messages:list", args: { channel: "a" }, argsJson: stableStringify({ channel: "a" }), identity: ana }))?.value).toEqual(list);
    server.stop();
    tab.close();
    await store.close();
  });

  it("a diff the server cannot rebuild: the calls sent after it wait for the whole value, so order holds", async () => {
    const endpoint = bus();
    const order: string[] = [];
    const { s } = recording({
      applyPatch: async (u) => void order.push(`patch ${u.version}`),
      clear: async () => void order.push("clear"),
    });
    const server = serveStorage(s, endpoint(), { address: "leader" });
    const end = endpoint();
    const remote = new RemoteStorage(end, { to: "leader" });
    await remote.load();
    const v1 = docs(20);
    await remote.applyPatch(update(v1, 1));
    // The server loses the base without announcing (simulated): the next diff is refused.
    server.dropPeer(remote.id);
    const v2 = [{ ...v1[0]!, body: "e" }, ...v1.slice(1)];
    const v3 = [v2[0]!, { ...v2[1]!, body: "e3" }, ...v2.slice(2)];
    const other = update(docs(3), 1, { argsJson: stableStringify({ other: 1 }), args: { other: 1 } });
    const calls = [remote.applyPatch(update(v2, 2)), remote.clear(), remote.applyPatch(update(v3, 3)), remote.applyPatch(other)];
    await Promise.all(calls);
    expect(order).toEqual(["patch 1", "patch 2", "clear", "patch 3", "patch 1"]);
    // v3 still went as a diff against v2 (the retry kept v2's base number)
    expect(reqsOf(end, "applyDiff").length).toBe(2);
    server.stop();
    remote.close();
  });

  it("a new leader replays calls in the caller's order, also a whole-value retry (newer id) and the calls after it", async () => {
    const endpoint = bus();
    const first: string[] = [];
    const never = new Promise<void>(() => {});
    // The first leader takes v1, then never finishes anything (it is about to go away).
    const s1 = serveStorage(
      recording({
        applyPatch: async (u) => (first.push(`patch ${u.version}`), u.version === 1 && !u.args.other ? undefined : never),
        clear: async () => (first.push("clear"), never),
      }).s,
      endpoint(),
      { address: "leader" },
    );
    const end = endpoint();
    const remote = new RemoteStorage(end, { to: "leader" });
    await remote.load();
    const v1 = docs(20);
    await remote.applyPatch(update(v1, 1));
    s1.dropPeer(remote.id); // the next diff is refused: its whole-value retry gets a newer id than the clear after it
    const v2 = [{ ...v1[0]!, body: "e" }, ...v1.slice(1)];
    const v3 = [v2[0]!, { ...v2[1]!, body: "e3" }, ...v2.slice(2)];
    const other = update(docs(3), 1, { argsJson: stableStringify({ other: 1 }), args: { other: 1 } });
    const calls = [remote.applyPatch(update(v2, 2)), remote.clear(), remote.applyPatch(update(v3, 3)), remote.applyPatch(other)];
    await until(() => first.length === 5);
    s1.stop();
    const order: string[] = [];
    const s2 = serveStorage(recording({ applyPatch: async (u) => void order.push(`patch ${u.version}`), clear: async () => void order.push("clear") }).s, endpoint(), { address: "leader" });
    s2.announce("tab-2");
    await Promise.all(calls);
    expect(order).toEqual(["patch 2", "clear", "patch 3", "patch 1"]);
    s2.stop();
    remote.close();
  });
});
