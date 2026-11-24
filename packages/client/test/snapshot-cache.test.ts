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
    expect(JSON.parse(header)).toEqual([2, "anon", "q7", 2, "E", "t", expect.any(Number), expect.any(String)]);
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
    expect(stats.gets).toBe(3); // the index, format 1's key (gone), then q1's key (q2 not read)
    expect((b.get("anon", "q1") as CachedSnapshot).value).toBe(first.value);
    expect(stats.gets).toBe(3);
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
    const { m, store, stats } = kv();
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
    // An index version does not apply over a value written after the index (another tab, a lost index write):
    // that value's own header counts, here another epoch and a lower version.
    const slot = [...m.keys()].find((k) => k.startsWith("ember:snap:"))!;
    store.setItem(slot, `${JSON.stringify([2, "anon", "q", 2, "E2", "t", Date.now(), "other-gen"])}\n["older"]`);
    expect(keyValueSnapshotCache(store).get("anon", "q")).toMatchObject({ value: ["older"], version: 2, epoch: "E2" });
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
    // The next visit subscribes with `resume` from that version, and the shard confirms it.
    const next = makeClient(s, { snapshotCache: keyValueSnapshotCache(store) });
    const again: QuerySnapshot[] = [];
    next.subscribe(list, { channel: "c" }, {}, (x) => again.push(x));
    await until(() => again.some((x) => x.status === "success" && !x.source));
    const ws = s.open(SHARD).at(-1)!;
    const sub = ws.sent.find((x) => x !== "ping" && x.t === "sub") as { resume?: { version: number } };
    expect(sub.resume?.version).toBe(versionOf("c"));
    expect(ws.received.some((x) => x !== "pong" && x.t === "snap" && (x as { unchanged?: boolean }).unchanged === true)).toBe(true);
    next.close();
  });
});

describe("snapshot cache: crashes, other tabs, async stores", () => {
  /** A store that records the order of writes and can refuse or delay them. */
  function recording(opts: { async?: boolean } = {}) {
    const base = kv();
    const log: string[] = [];
    let refuse: ((k: string) => boolean) | null = null;
    const pending: Array<() => void> = [];
    const store = {
      getItem: (k: string) => (opts.async ? Promise.resolve(base.store.getItem(k)) : base.store.getItem(k)),
      setItem: (k: string, v: string): void | Promise<void> => {
        log.push(`set ${k}`);
        if (!opts.async) {
          if (refuse?.(k)) throw new DOMException("full", "QuotaExceededError");
          return base.store.setItem(k, v);
        }
        const no = refuse?.(k) ?? false;
        return new Promise<void>((resolve, reject) => pending.push(() => (no ? reject(new Error("full")) : (base.store.setItem(k, v), resolve()))));
      },
      removeItem: (k: string) => {
        log.push(`remove ${k}`);
        base.m.delete(k);
      },
    };
    const settle = async () => {
      while (pending.length) pending.shift()!();
      await tick();
    };
    return { ...base, log, store, settle, refuse: (f: ((k: string) => boolean) | null) => (refuse = f) };
  }

  it("another tab's older value in the slot is not confirmed at this tab's indexed version (value generations)", () => {
    const { store } = kv();
    const a = keyValueSnapshotCache(store);
    const fresh = ["new"];
    a.set("anon", "q", snap(fresh, 5));
    a.flush!();
    a.touch!("anon", "q", snap(fresh, 8)); // index: version 8 for this value
    a.flush!();
    // Tab B, which loaded before A's touch, writes its older value to the same key (no index write).
    const b = keyValueSnapshotCache(store);
    b.get("anon", "q");
    b.set("anon", "q", snap(["old"], 5));
    b.flush!();
    expect(keyValueSnapshotCache(store).get("anon", "q")).toMatchObject({ value: ["old"], version: 5 });
    // and A's own touched value, reread untouched, keeps its version
    const c = keyValueSnapshotCache(store);
    c.set("anon", "r", snap(["r"], 3));
    c.flush!();
    c.touch!("anon", "r", snap((c.get("anon", "r") as CachedSnapshot).value, 9));
    c.flush!();
    expect(keyValueSnapshotCache(store).get("anon", "r")).toMatchObject({ value: ["r"], version: 9 });
  });

  it("a slot that holds another query is a miss and is left alone (not removed, not reused)", () => {
    const { m, store } = kv();
    const a = keyValueSnapshotCache(store);
    a.set("anon", "mine", snap(["mine"]));
    a.flush!();
    const stale = keyValueSnapshotCache(store);
    // Another tab reused slot 0 for its own query.
    const theirs = `${JSON.stringify([2, "anon", "theirs", 9, "E", "t", Date.now(), "g"])}\n["theirs"]`;
    m.set("ember:snap:0", theirs);
    expect(stale.get("anon", "mine")).toBeUndefined();
    stale.set("anon", "other", snap(["other"]));
    stale.flush!();
    expect(m.get("ember:snap:0")).toBe(theirs);
  });

  it("new slots are listed (index `t`) before their value is written; removed keys go before the index", () => {
    const r = recording();
    const c = keyValueSnapshotCache(r.store);
    c.set("anon", "a", snap(["a"]));
    c.flush!();
    expect(r.log).toEqual(["set ember:snapshots:v2", "set ember:snap:0"]);
    r.log.length = 0;
    c.delete("anon", "a");
    c.flush!();
    expect(r.log).toEqual(["remove ember:snap:0", "set ember:snapshots:v2"]);
    // A refused index write: the removal happened anyway, and the index is retried.
    c.set("anon", "b", snap(["b"]));
    c.flush!();
    r.log.length = 0;
    r.refuse((k) => k === "ember:snapshots:v2");
    c.delete("anon", "b");
    c.flush!();
    expect(r.m.has("ember:snap:0")).toBe(false);
    r.refuse(null);
    c.flush!();
    expect(JSON.parse(r.m.get("ember:snapshots:v2")!).n).toEqual([]);
  });

  it("sign-out removes values the index never listed (a stop between a value and the index)", () => {
    const { m, store } = kv();
    const a = keyValueSnapshotCache(store);
    for (const k of ["a", "b", "c"]) a.set("u\u0000i\u0000ana", k, snap([k]));
    a.flush!();
    // A stop right after a value went to a reused slot, before the index listing it: the index lists nothing there.
    const index = JSON.parse(m.get("ember:snapshots:v2")!) as { t: number; n: unknown[][] };
    m.set("ember:snapshots:v2", JSON.stringify({ ...index, n: index.n.filter((r) => r[1] !== "b") }));
    const b = keyValueSnapshotCache(store);
    b.clear();
    expect([...m.keys()].filter((k) => k.startsWith("ember:snap:"))).toEqual([]);
    expect(JSON.parse(m.get("ember:snapshots:v2")!).n).toEqual([]);
    // per identity too: what no entry owns goes with it
    const c = keyValueSnapshotCache(store);
    c.set("anon", "x", snap(["x"]));
    c.set("u\u0000i\u0000bob", "y", snap(["y"]));
    c.flush!();
    m.set("ember:snap:7", `${JSON.stringify([2, "u\u0000i\u0000bob", "z", 1, "E", "t", Date.now(), "g"])}\n["z"]`);
    const ix = JSON.parse(m.get("ember:snapshots:v2")!) as { t: number };
    m.set("ember:snapshots:v2", JSON.stringify({ ...ix, t: 8 }));
    const d = keyValueSnapshotCache(store);
    d.clear("u\u0000i\u0000bob");
    expect(m.has("ember:snap:7")).toBe(false);
    expect(d.get("anon", "x")).toMatchObject({ value: ["x"] });
  });

  it("an async write refused after a newer value took its place does not drop the newer one", async () => {
    const r = recording({ async: true });
    const c = keyValueSnapshotCache(r.store);
    await c.get("anon", "q");
    c.set("anon", "q", snap(["v1"], 1));
    c.flush!();
    r.refuse((k) => k.startsWith("ember:snap:"));
    c.set("anon", "q", snap(["v2"], 2));
    c.flush!();
    c.set("anon", "q", snap(["v3"], 3)); // while v2's write is pending
    await r.settle(); // v2 refused
    r.refuse(null);
    c.flush!();
    await r.settle();
    expect(await keyValueSnapshotCache(r.store).get("anon", "q")).toMatchObject({ value: ["v3"], version: 3 });
  });

  it("an async index write refused is retried on its own", async () => {
    const r = recording({ async: true });
    const c = keyValueSnapshotCache(r.store);
    await c.get("anon", "q");
    r.refuse((k) => k === "ember:snapshots:v2");
    c.set("anon", "q", snap(["v"], 1));
    c.flush!();
    await r.settle();
    r.refuse(null);
    await tick(300); // the retry the refusal scheduled
    await r.settle();
    expect(await keyValueSnapshotCache(r.store).get("anon", "q")).toMatchObject({ value: ["v"] });
  });

  it("format 1 stays until its values and an index listing them are stored; a failed move is retried next load", async () => {
    const r = recording({ async: true });
    const blob = JSON.stringify({ v: 1, by: { anon: { k: { v: "[1,2]", version: 2, epoch: "E", ik: "t", at: Date.now() } } } });
    r.m.set("ember:snapshots", blob);
    const c = keyValueSnapshotCache(r.store);
    expect(await c.get("anon", "k")).toMatchObject({ value: [1, 2] });
    r.refuse((k) => k.startsWith("ember:snap:"));
    c.flush!();
    await r.settle();
    await tick(300);
    await r.settle();
    expect(r.m.get("ember:snapshots")).toBe(blob);
    r.refuse(null);
    const d = keyValueSnapshotCache(r.store);
    expect(await d.get("anon", "k")).toMatchObject({ value: [1, 2], version: 2 });
    d.flush!();
    await r.settle();
    await tick();
    expect(r.m.has("ember:snapshots")).toBe(false);
    expect(await keyValueSnapshotCache(r.store).get("anon", "k")).toMatchObject({ value: [1, 2], version: 2 });
  });

  it("an older client wrote format 1 again: what it holds newer than the index comes back", () => {
    const { m, store } = kv();
    const a = keyValueSnapshotCache(store);
    a.set("anon", "k", snap(["v2 era"], 3, Date.now() - 1000));
    a.flush!();
    m.set("ember:snapshots", JSON.stringify({ v: 1, by: { anon: { k: { v: '["downgraded"]', version: 7, epoch: "E", ik: "t", at: Date.now() } } } }));
    const b = keyValueSnapshotCache(store);
    expect(b.get("anon", "k")).toMatchObject({ value: ["downgraded"], version: 7 });
    b.flush!();
    expect(m.has("ember:snapshots")).toBe(false);
    expect(keyValueSnapshotCache(store).get("anon", "k")).toMatchObject({ value: ["downgraded"], version: 7 });
  });

  it("a value rewritten after the index is aged by its own header, not the index's `at`", () => {
    let now = 1_000_000;
    const { store } = kv();
    const opts = { maxAgeMs: 10_000, now: () => now };
    const a = keyValueSnapshotCache(store, opts);
    a.set("anon", "q", snap(["first"], 1, now));
    a.flush!();
    now += 5_000;
    a.set("anon", "q", snap(["second"], 2, now)); // its own key only (within the index's drift)
    a.flush!();
    now += 6_000; // 11 s after the index's `at`, 6 s after the value's
    expect(keyValueSnapshotCache(store, opts).get("anon", "q")).toMatchObject({ value: ["second"], version: 2 });
    now += 5_000;
    expect(keyValueSnapshotCache(store, opts).get("anon", "q")).toBeUndefined();
  });

  it("touch refreshes `at` of a value whose version did not move; corrupt index sizes are ignored", () => {
    let now = 1_000_000;
    const { m, store } = kv();
    const opts = { maxAgeMs: 8_000, now: () => now };
    const a = keyValueSnapshotCache(store, opts);
    const v = ["same"];
    a.set("anon", "q", snap(v, 4, now));
    a.flush!();
    now += 7_000;
    a.touch!("anon", "q", snap(v, 4, now));
    a.flush!();
    now += 7_000;
    expect(keyValueSnapshotCache(store, opts).get("anon", "q")).toMatchObject({ value: ["same"], version: 4 });
    const index = JSON.parse(m.get("ember:snapshots:v2")!) as { n: unknown[][] };
    index.n[0]![7] = -1e9;
    m.set("ember:snapshots:v2", JSON.stringify(index));
    const b = keyValueSnapshotCache(store, opts);
    b.set("anon", "r", snap(["r"], 1, now));
    b.flush!();
    expect(b.get("anon", "q")).toMatchObject({ value: ["same"] });
  });

  it("slots are reused without rescanning: 5000 queries migrate and churn with keys bounded by the entries", () => {
    const { m, store } = kv();
    const by: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) by[`k${i}`] = { v: `[${i}]`, version: 1, epoch: "E", ik: "t", at: Date.now() };
    m.set("ember:snapshots", JSON.stringify({ v: 1, by: { anon: by } }));
    const t0 = performance.now();
    const c = keyValueSnapshotCache(store, { maxBytes: 10 * 1024 * 1024 });
    c.get("anon", "k0");
    c.flush!();
    for (let i = 0; i < 2000; i++) c.delete("anon", `k${i}`);
    for (let i = 0; i < 2000; i++) c.set("anon", `n${i}`, snap([i]));
    c.flush!();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect([...m.keys()].filter((k) => k.startsWith("ember:snap:")).length).toBe(5000);
  });
});
