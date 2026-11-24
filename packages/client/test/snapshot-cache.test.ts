// The snapshot cache's storage (format 2, PR 3B-1): one key per query plus a light index, only what changed written
// per flush, values parsed once, format 1 migrated on load, entries checked against their own header, quota handled,
// and versions kept current on page hide (`touch`) so a reload resumes from a recent version.
import { describe, expect, it } from "vitest";
import { keyValueSnapshotCache, memorySnapshotCache, unsafeRef, type CachedSnapshot, type QuerySnapshot } from "../src/index.ts";
import type { ConnectivityEvent } from "../src/connectivity.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

/** A localStorage-like store that counts what it is asked to write. */
function kv(opts: { quota?: number; remove?: boolean } = {}) {
  const m = new Map<string, string>();
  const stats = { sets: 0, bytes: 0, gets: 0 };
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const store = {
    getItem: (k: string) => (stats.gets++, m.get(k) ?? null),
    setItem: (k: string, v: string) => {
      if (opts.quota !== undefined && used() - (m.get(k)?.length ?? 0) + v.length > opts.quota) throw new DOMException("full", "QuotaExceededError");
      stats.sets++;
      stats.bytes += v.length;
      m.set(k, v);
    },
    ...(opts.remove === false ? {} : { removeItem: (k: string) => void m.delete(k) }),
  };
  return { m, stats, store };
}

const snap = (value: unknown, version = 1, at = Date.now()): CachedSnapshot => ({ value, version, epoch: "E", ik: "t", at });
const rows = (n: number, tag = "") => Array.from({ length: n }, (_, i) => ({ _id: `id${i}`, _creationTime: i, body: `row ${i} ${tag} "quoted" \\ ${"x".repeat(60)}` }));

describe("snapshot cache storage", () => {
  it("a changed query rewrites its own key only: no index, no other query (and no string-in-JSON escaping)", () => {
    const { m, stats, store } = kv();
    const c = keyValueSnapshotCache(store, { maxBytes: 10 * 1024 * 1024 });
    for (let i = 0; i < 50; i++) c.set("anon", `q${i}`, snap(rows(20, `${i}`)));
    c.flush!();
    const first = { ...stats };
    stats.sets = stats.bytes = 0;
    c.set("anon", "q7", snap(rows(20, "changed"), 2));
    c.flush!();
    console.log(
      `[client] snapshot flush, 50 queries × 20 rows: first ${first.sets} keys / ${(first.bytes / 1024).toFixed(0)} KiB; one changed query: ${stats.sets} key / ${(stats.bytes / 1024).toFixed(1)} KiB (format 1 rewrote the whole blob, ≈${(first.bytes / 1024).toFixed(0)} KiB re-escaped, every 250 ms)`,
    );
    expect(stats.sets).toBe(1);
    expect(stats.bytes).toBeLessThan(first.bytes / 40);
    const raw = [...m.values()].find((v) => v.includes("changed"))!;
    const [header, value] = [raw.slice(0, raw.indexOf("\n")), raw.slice(raw.indexOf("\n") + 1)];
    expect(JSON.parse(header)).toEqual([2, "anon", "q7", 2, "E", "t", expect.any(Number)]);
    // the value's JSON is appended as is (format 1 embedded it as a JSON string: every quote and backslash escaped)
    expect(JSON.parse(value)).toEqual(rows(20, "changed"));
    // A new query rewrites the index too.
    stats.sets = 0;
    c.set("anon", "new", snap([1]));
    c.flush!();
    expect(stats.sets).toBe(2);
  });

  it("values are parsed once and come back from memory; a reload reads them lazily, one key each", () => {
    const { store, stats } = kv();
    const a = keyValueSnapshotCache(store);
    a.set("anon", "q1", snap(rows(3)));
    a.set("anon", "q2", snap(rows(4)));
    a.flush!();
    const b = keyValueSnapshotCache(store);
    stats.gets = 0;
    const first = b.get("anon", "q1") as CachedSnapshot;
    expect(first.value).toEqual(rows(3));
    expect(stats.gets).toBe(2); // the index, then q1's key (q2 not read)
    expect((b.get("anon", "q1") as CachedSnapshot).value).toBe(first.value);
    expect(stats.gets).toBe(2);
    expect(b.get("bob", "q1")).toBeUndefined();
  });

  it("format 1 (one blob) is migrated on load: values kept, then written per key and the blob removed", () => {
    const { m, store } = kv();
    const at = Date.now();
    // What format 1 stored: `v` is the tagged JSON of the value (bigint/bytes survive).
    m.set(
      "ember:snapshots",
      JSON.stringify({
        v: 1,
        by: {
          anon: { "s\u0000messages:list\u0000{}": { v: JSON.stringify(["a", "b"]), version: 4, epoch: "E1", ik: "t1", at } },
          "u\u0000i\u0000ana": { k2: { v: '{"$int64":"9007199254740993"}', version: 7, epoch: "E1", ik: "t2", at } },
          broken: { k3: { version: 1 } },
        },
      }),
    );
    const c = keyValueSnapshotCache(store);
    expect(c.get("anon", "s\u0000messages:list\u0000{}")).toEqual({ value: ["a", "b"], version: 4, epoch: "E1", ik: "t1", at });
    expect((c.get("u\u0000i\u0000ana", "k2") as CachedSnapshot).value).toBe(9007199254740993n);
    c.flush!();
    expect(m.has("ember:snapshots")).toBe(false);
    expect([...m.keys()].sort()).toEqual(["ember:snap:0", "ember:snap:1", "ember:snapshots:v2"]);
    const again = keyValueSnapshotCache(store);
    expect((again.get("u\u0000i\u0000ana", "k2") as CachedSnapshot).value).toBe(9007199254740993n);
    expect(again.get("anon", "s\u0000messages:list\u0000{}")).toMatchObject({ value: ["a", "b"], version: 4 });
  });

  it("an unreadable format 1 blob, or an index entry whose key holds another query, is a miss — never a wrong value", () => {
    const one = kv();
    one.m.set("ember:snapshots", "{not json");
    const c1 = keyValueSnapshotCache(one.store);
    expect(c1.get("anon", "x")).toBeUndefined();
    c1.flush!();
    expect(one.m.has("ember:snapshots")).toBe(false);

    const two = kv();
    const a = keyValueSnapshotCache(two.store);
    a.set("anon", "mine", snap(["mine"]));
    a.flush!();
    // Another tab (or a crash before the index write) put a different query in that slot.
    two.m.set("ember:snap:0", `${JSON.stringify([2, "anon", "theirs", 9, "E", "t", Date.now()])}\n["theirs"]`);
    const b = keyValueSnapshotCache(two.store);
    expect(b.get("anon", "mine")).toBeUndefined();
    // A truncated entry too.
    a.set("anon", "mine", snap(["mine"], 2));
    a.flush!();
    two.m.set("ember:snap:0", "garbage");
    expect(keyValueSnapshotCache(two.store).get("anon", "mine")).toBeUndefined();
  });

  it("touch moves the version of the very value stored (index only); another object or an unread entry is left alone", () => {
    const { store, stats } = kv();
    const c = keyValueSnapshotCache(store);
    const value = rows(5);
    c.set("anon", "q", snap(value, 3));
    c.flush!();
    stats.sets = stats.bytes = 0;
    c.touch!("anon", "q", snap(value, 9));
    c.touch!("anon", "q", snap(rows(5), 12)); // equal, but not the object stored: not vouched for
    c.touch!("anon", "q", { ...snap(value, 13), ik: "other" });
    c.flush!();
    expect(stats.sets).toBe(1); // the index
    expect(stats.bytes).toBeLessThan(200);
    const reloaded = keyValueSnapshotCache(store);
    expect((reloaded.get("anon", "q") as CachedSnapshot).version).toBe(9);
    // a fresh instance never read "q": its touch does nothing (the client's value did not come from it)
    const fresh = keyValueSnapshotCache(store);
    fresh.touch!("anon", "q", snap(value, 20));
    fresh.flush!();
    expect((keyValueSnapshotCache(store).get("anon", "q") as CachedSnapshot).version).toBe(9);
    // an index version does not apply over an entry of another epoch (it was rewritten after the index)
    expect(reloaded.get("bob", "q")).toBeUndefined();
  });

  it("out of space: the oldest entries make room; what still does not fit is not indexed", () => {
    const { m, store } = kv({ quota: 6000 });
    const c = keyValueSnapshotCache(store, { maxBytes: 1024 * 1024 });
    for (let i = 0; i < 8; i++) {
      c.set("anon", `q${i}`, snap(rows(6, `${i}`), 1, Date.now() - 1000 + i));
      c.flush!();
    }
    const index = JSON.parse(m.get("ember:snapshots:v2")!) as { n: Array<[string, string]> };
    const listed = index.n.map(([, k]) => k);
    expect(listed).toContain("q7");
    expect(listed.length).toBeLessThan(8);
    // every listed entry reads back its own value
    const again = keyValueSnapshotCache(store, { maxBytes: 1024 * 1024 });
    for (const k of listed) expect((again.get("anon", k) as CachedSnapshot).value).toEqual(rows(6, k.slice(1)));
    // A value that can never fit is dropped, not left half-indexed.
    c.set("anon", "huge", snap("y".repeat(10_000)));
    c.flush!();
    expect(c.get("anon", "huge")).toBeUndefined();
  });

  it("an async store (AsyncStorage): reads wait for it; migration and writes work the same", async () => {
    const { m, store } = kv();
    m.set("ember:snapshots", JSON.stringify({ v: 1, by: { anon: { k: { v: "[1,2]", version: 2, epoch: "E", ik: "t", at: Date.now() } } } }));
    const asyncStore = {
      getItem: async (k: string) => store.getItem(k),
      setItem: async (k: string, v: string) => store.setItem(k, v),
      removeItem: async (k: string) => store.removeItem!(k),
    };
    const c = keyValueSnapshotCache(asyncStore);
    expect(await c.get("anon", "k")).toMatchObject({ value: [1, 2], version: 2 });
    c.set("anon", "k2", snap(["x"]));
    c.flush!();
    await tick();
    const again = keyValueSnapshotCache(asyncStore);
    expect(await again.get("anon", "k2")).toMatchObject({ value: ["x"] });
    expect(await again.get("anon", "k")).toMatchObject({ value: [1, 2] });
    expect(m.has("ember:snapshots")).toBe(false);
  });

  it("clear(identity) removes that identity's keys at once; the memory cache needs no store", () => {
    const { m, store } = kv();
    const c = keyValueSnapshotCache(store);
    c.set("anon", "a", snap([1]));
    c.set("u\u0000i\u0000ana", "a", snap([2]));
    c.flush!();
    c.clear("u\u0000i\u0000ana");
    expect(c.get("u\u0000i\u0000ana", "a")).toBeUndefined();
    expect(c.get("anon", "a")).toMatchObject({ value: [1] });
    expect([...m.keys()].sort()).toEqual(["ember:snap:0", "ember:snapshots:v2"]);
    const mem = memorySnapshotCache({ maxBytes: 20 });
    mem.set("anon", "x", snap(["0123456789"], 1, Date.now() - 2));
    mem.set("anon", "y", snap(["abcdefghij"], 1, Date.now() - 1));
    mem.flush!();
    expect(mem.get("anon", "x")).toBeUndefined();
    expect(mem.get("anon", "y")).toMatchObject({ value: ["abcdefghij"] });
  });
});

describe("snapshot versions on page hide", () => {
  it("hiding the page stores the current version of values that did not change, so a reload resumes from it", async () => {
    const s = messagesServer({ ident: true });
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "hello" });
    const { m, store } = kv();
    const listeners = new Set<(e: ConnectivityEvent) => void>();
    const client = makeClient(s, {
      snapshotCache: keyValueSnapshotCache(store),
      connectivity: { isOnline: () => true, subscribe: (l: (e: ConnectivityEvent) => void) => (listeners.add(l), () => listeners.delete(l)) },
    });
    const list = unsafeRef<"query">("messages:list");
    const seen: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "c" }, {}, (x) => seen.push(x));
    const other: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "d" }, {}, (x) => other.push(x));
    await until(() => seen.some((x) => x.status === "success") && other.some((x) => x.status === "success"));
    await tick(300);
    const versionOf = (channel: string) => {
      const index = JSON.parse(m.get("ember:snapshots:v2")!) as { n: Array<[string, string, number, number]> };
      return index.n.find(([, k]) => k.includes(`"${channel}"`))![3];
    };
    const before = versionOf("c");
    // Commits that change only channel d: channel c's value is current as of each, in memory.
    for (let i = 0; i < 3; i++) await client.mutation(unsafeRef<"mutation">("messages:send"), { channel: "d", body: `d${i}` });
    await until(() => (other.at(-1)!.value as string[]).length === 3);
    await tick(300);
    expect(versionOf("c")).toBe(before);
    for (const l of listeners) l("background");
    expect(versionOf("c")).toBeGreaterThan(before);
    expect(versionOf("c")).toBe(versionOf("d"));
    client.close();
  });
});
