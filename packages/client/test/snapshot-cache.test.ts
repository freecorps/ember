// The snapshot cache's storage (format 2, PR 3B-1b): one key per query plus a light index, only what changed written
// per flush, values parsed once, format 1 never read (the writer removes it), entries checked against their own header, quota
// handled, versions kept current on page hide (`touch`), and one writer per store however many tabs share it.
import { describe, expect, it, vi } from "vitest";
import { keyValueSnapshotCache, memorySnapshotCache, unsafeRef, type CachedSnapshot, type QuerySnapshot, type SnapshotCache, type SnapshotCacheOptions } from "../src/index.ts";
import type { ConnectivityEvent } from "../src/connectivity.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";
import { channelHub, fakeLocks } from "./snapshot-tabs.ts";

/** A localStorage-like store that counts what it is asked to write. */
function kv(opts: { quota?: number; remove?: boolean } = {}) {
  const m = new Map<string, string>();
  const stats = { sets: 0, bytes: 0, gets: 0 };
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const store = {
    getItem: (k: string) => (stats.gets++, m.get(k) ?? null),
    setItem: (k: string, v: string) => {
      // keys count too (a new key's name is charged once, as a browser does)
      const old = m.get(k);
      if (opts.quota !== undefined && used() - (old?.length ?? -k.length) + v.length > opts.quota) throw new DOMException("full", "QuotaExceededError");
      stats.sets++;
      stats.bytes += v.length;
      m.set(k, v);
    },
    ...(opts.remove === false ? {} : { removeItem: (k: string) => void m.delete(k) }),
  };
  return { m, stats, store };
}

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
  /** Lets every write on its way land (or be refused), also those queued behind them. */
  const settle = async () => {
    do {
      while (pending.length) pending.shift()!();
      await tick();
    } while (pending.length);
  };
  return { ...base, log, store, settle, refuse: (f: ((k: string) => boolean) | null) => (refuse = f) };
}

const snap = (value: unknown, version = 1, at = Date.now()): CachedSnapshot => ({ value, version, epoch: "E", ik: "t", at });
const rows = (n: number, tag = "") => Array.from({ length: n }, (_, i) => ({ _id: `id${i}`, _creationTime: i, body: `row ${i} ${tag} "quoted" \\ ${"x".repeat(60)}` }));
const slotKeys = (m: Map<string, string>) => [...m.keys()].filter((k) => k.startsWith("ember:snap:"));
const listed = (m: Map<string, string>) => (JSON.parse(m.get("ember:snapshots:v2") ?? '{"n":[]}') as { n: unknown[][] }).n;

describe("snapshot cache storage", () => {
  it("a changed query rewrites its own key and the index only (and no string-in-JSON escaping)", () => {
    const { m, stats, store } = kv();
    const c = keyValueSnapshotCache(store, { maxBytes: 10 * 1024 * 1024 });
    for (let i = 0; i < 100; i++) c.set("anon", `q${i}`, snap(rows(50, `${i}`)));
    c.flush!();
    const first = { ...stats };
    stats.sets = stats.bytes = 0;
    c.set("anon", "q7", snap(rows(50, "changed"), 2));
    c.flush!();
    console.log(
      `[client] snapshot flush, 100 queries × 50 rows: first ${first.sets} keys / ${(first.bytes / 1024).toFixed(0)} KiB; one changed query: ${stats.sets} keys / ${(stats.bytes / 1024).toFixed(1)} KiB (format 1 rewrote the whole blob every flush)`,
    );
    expect(stats.sets).toBe(2); // its key, the index
    expect(stats.bytes).toBeLessThan(first.bytes / 50);
    const raw = [...m.values()].find((v) => v.includes("changed"))!;
    const [header, value] = [raw.slice(0, raw.indexOf("\n")), raw.slice(raw.indexOf("\n") + 1)];
    expect(JSON.parse(header)).toEqual([2, "anon", "q7", 2, "E", "t", expect.any(Number), expect.any(String)]);
    expect(JSON.parse(value)).toEqual(rows(50, "changed"));
    // Nothing changed: nothing written.
    stats.sets = 0;
    c.flush!();
    expect(stats.sets).toBe(0);
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
    expect(stats.gets).toBe(2); // the index, then q1's key (q2 not read; format 1 never)
    expect((b.get("anon", "q1") as CachedSnapshot).value).toBe(first.value);
    expect(stats.gets).toBe(2);
    expect(b.get("bob", "q1")).toBeUndefined();
  });

  it("format 1 (one blob, an older client's) is never read: the writer removes it once loaded, readers never see it", async () => {
    const r = recording();
    const reads: string[] = [];
    const store = { ...r.store, getItem: (k: string) => (reads.push(k), r.store.getItem(k)) };
    const blob = JSON.stringify({ v: 1, by: { anon: { q: { v: '["old"]', version: 4, epoch: "E", ik: "t", at: Date.now() } } } });
    // A reader (another tab writes) finds nothing there, and leaves it alone.
    r.m.set("ember:snapshots", blob);
    const locks = fakeLocks();
    void locks.request("ember-snapshots:ember", {}, () => new Promise(() => {}));
    const reader = keyValueSnapshotCache(store, { tabs: { locks, channel: channelHub().open() } });
    expect(reader.get("anon", "q")).toBeUndefined();
    reader.clear();
    expect(r.m.get("ember:snapshots")).toBe(blob);
    await reader.close!();
    // The writer: one removal (no read of it) once the index is loaded; nothing of it comes back.
    const c = keyValueSnapshotCache(store);
    expect(c.get("anon", "q")).toBeUndefined();
    c.flush!();
    expect(r.m.has("ember:snapshots")).toBe(false);
    expect(r.log.filter((l) => l.includes("ember:snapshots") && !l.includes(":v2"))).toEqual(["remove ember:snapshots"]);
    expect(reads.filter((k) => k === "ember:snapshots")).toEqual([]);
    expect(keyValueSnapshotCache(store).get("anon", "q")).toBeUndefined();
  });

  it("a key holding another query, or unreadable, is a miss — never a wrong value", () => {
    const two = kv();
    const a = keyValueSnapshotCache(two.store);
    a.set("anon", "mine", snap(["mine"]));
    a.flush!();
    two.m.set("ember:snap:0", `${JSON.stringify([2, "anon", "theirs", 9, "E", "t", Date.now(), "g"])}\n["theirs"]`);
    expect(keyValueSnapshotCache(two.store).get("anon", "mine")).toBeUndefined();
    two.m.set("ember:snap:0", "garbage");
    expect(keyValueSnapshotCache(two.store).get("anon", "mine")).toBeUndefined();
    two.m.set("ember:snap:0", '{}\n["q"]');
    expect(keyValueSnapshotCache(two.store).get("anon", "mine")).toBeUndefined();
  });

  it("touch moves the version of the very value stored (index only); another object or tag is left alone", () => {
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
    expect((keyValueSnapshotCache(store).get("anon", "q") as CachedSnapshot).version).toBe(9);
    // An index version does not apply over a value written after the index (a stop between the two): that value's
    // own header counts, here another epoch and a lower version.
    store.setItem(slotKeys(m)[0]!, `${JSON.stringify([2, "anon", "q", 2, "E2", "t", Date.now(), "other-gen"])}\n["older"]`);
    expect(keyValueSnapshotCache(store).get("anon", "q")).toMatchObject({ value: ["older"], version: 2, epoch: "E2" });
  });

  it("out of space: the oldest entries make room; what still does not fit is not indexed", () => {
    const { m, store } = kv({ quota: 6000 });
    const c = keyValueSnapshotCache(store, { maxBytes: 1024 * 1024 });
    for (let i = 0; i < 8; i++) {
      c.set("anon", `q${i}`, snap(rows(6, `${i}`), 1, Date.now() - 1000 + i));
      c.flush!();
    }
    const keys = listed(m).map((r) => r[1] as string);
    expect(keys).toContain("q7");
    expect(keys.length).toBeLessThan(8);
    const again = keyValueSnapshotCache(store, { maxBytes: 1024 * 1024 });
    for (const k of keys) expect((again.get("anon", k) as CachedSnapshot).value).toEqual(rows(6, k.slice(1)));
    c.set("anon", "huge", snap("y".repeat(10_000)));
    c.flush!();
    expect(c.get("anon", "huge")).toBeUndefined();
  });

  it("an async store (AsyncStorage): reads wait for it; writes (and format 1's removal) work the same", async () => {
    const { m, store } = kv();
    m.set("ember:snapshots", JSON.stringify({ v: 1, by: { anon: { k: { v: "[1,2]", version: 2, epoch: "E", ik: "t", at: Date.now() } } } }));
    const asyncStore = {
      getItem: async (k: string) => store.getItem(k),
      setItem: async (k: string, v: string) => store.setItem(k, v),
      removeItem: async (k: string) => store.removeItem!(k),
    };
    const c = keyValueSnapshotCache(asyncStore);
    expect(await c.get("anon", "k")).toBeUndefined();
    c.set("anon", "k2", snap(["x"]));
    c.flush!();
    await tick();
    const again = keyValueSnapshotCache(asyncStore);
    expect(await again.get("anon", "k2")).toMatchObject({ value: ["x"] });
    expect(await again.get("anon", "k")).toBeUndefined();
    expect(m.has("ember:snapshots")).toBe(false);
  });

  it("clear(identity) removes that identity's keys at once; the memory cache needs no store", () => {
    const { m, store } = kv({ remove: false });
    const c = keyValueSnapshotCache(store);
    c.set("anon", "a", snap([1]));
    c.set("u\u0000i\u0000ana", "a", snap([2]));
    c.flush!();
    c.clear("u\u0000i\u0000ana");
    expect(c.get("u\u0000i\u0000ana", "a")).toBeUndefined();
    expect(c.get("anon", "a")).toMatchObject({ value: [1] });
    // (no removeItem: removed keys are overwritten with "")
    expect([...m].filter(([, v]) => v !== "").map(([k]) => k).sort()).toEqual(["ember:snap:0", "ember:snapshots:v2"]);
    expect(listed(m)).toHaveLength(1);
    const mem = memorySnapshotCache({ maxBytes: 20 });
    mem.set("anon", "x", snap(["0123456789"], 1, Date.now() - 2));
    mem.set("anon", "y", snap(["abcdefghij"], 1, Date.now() - 1));
    mem.flush!();
    expect(mem.get("anon", "x")).toBeUndefined();
    expect(mem.get("anon", "y")).toMatchObject({ value: ["abcdefghij"] });
  });

  it("new slots are listed (index `t`) before their value is written; removed keys go before the index", () => {
    const r = recording();
    const c = keyValueSnapshotCache(r.store);
    c.set("anon", "a", snap(["a"]));
    c.flush!();
    // (format 1 goes first: it is removed once the index is loaded)
    expect(r.log).toEqual(["remove ember:snapshots", "set ember:snapshots:v2", "set ember:snap:0", "set ember:snapshots:v2"]);
    expect(JSON.parse(r.m.get("ember:snapshots:v2")!)).toMatchObject({ t: 1 });
    r.log.length = 0;
    c.delete("anon", "a");
    // its key goes at once; the index (listing a key that is gone: a miss) with the next flush
    expect(r.log).toEqual(["remove ember:snap:0"]);
    expect(keyValueSnapshotCache(r.store, { tabs: null }).get("anon", "a")).toBeUndefined();
    c.flush!();
    expect(r.log).toEqual(["remove ember:snap:0", "set ember:snapshots:v2"]);
    // (the index logs the delete: a tab that had not heard of it drops that value)
    expect(JSON.parse(r.m.get("ember:snapshots:v2")!)).toEqual({ v: 2, t: 0, n: [], k: [[expect.any(Number), "anon", "a", expect.any(String)]] });
    // The index that would list a new slot is refused: the value is not written past the stored `t`.
    r.refuse((k) => k === "ember:snapshots:v2");
    r.log.length = 0;
    c.set("anon", "b", snap(["b"]));
    c.flush!();
    expect(r.log.filter((l) => l !== "set ember:snapshots:v2")).toEqual([]);
    expect(r.m.has("ember:snap:0")).toBe(false);
    r.refuse(null);
    c.flush!();
    expect(keyValueSnapshotCache(r.store).get("anon", "b")).toMatchObject({ value: ["b"] });
  });

  it("sign-out removes values the index never listed (a stop between a value and the index)", () => {
    const { m, store } = kv();
    const a = keyValueSnapshotCache(store);
    for (const k of ["a", "b", "c"]) a.set("u\u0000i\u0000ana", k, snap([k]));
    a.flush!();
    const index = JSON.parse(m.get("ember:snapshots:v2")!) as { t: number; n: unknown[][] };
    m.set("ember:snapshots:v2", JSON.stringify({ ...index, n: index.n.filter((r) => r[1] !== "b") }));
    const b = keyValueSnapshotCache(store);
    b.clear("u\u0000i\u0000ana");
    expect(slotKeys(m)).toEqual([]);
    expect(listed(m)).toEqual([]);
  });

  it("an index the store fails to read is never written over: the writer stays in memory and loads it later", async () => {
    const { m, store } = kv();
    const a = keyValueSnapshotCache(store);
    a.set("anon", "kept", snap(["kept"]));
    a.flush!();
    const before = m.get("ember:snapshots:v2");
    let failing = true;
    const flaky = { ...store, getItem: (k: string) => (failing && k === "ember:snapshots:v2" ? Promise.reject(new Error("io")) : Promise.resolve(store.getItem(k))), setItem: async (k: string, v: string) => store.setItem(k, v) };
    const b = keyValueSnapshotCache(flaky);
    expect(await b.get("anon", "kept")).toBeUndefined();
    b.set("anon", "new", snap(["new"]));
    b.clear("u\u0000i\u0000ana");
    b.flush!();
    await tick();
    expect(m.get("ember:snapshots:v2")).toBe(before);
    failing = false;
    await tick(300);
    b.flush!();
    await tick();
    const c = keyValueSnapshotCache(store);
    expect(c.get("anon", "kept")).toMatchObject({ value: ["kept"] });
    expect(c.get("anon", "new")).toMatchObject({ value: ["new"] });
  });

  it("an index the store keeps refusing is retried with backoff; new work retries promptly again", () => {
    vi.useFakeTimers();
    try {
      const r = recording();
      const c = keyValueSnapshotCache(r.store);
      c.set("anon", "a", snap(["a"]));
      c.flush!();
      r.refuse((k) => k === "ember:snapshots:v2");
      c.set("anon", "a", snap(["a2"], 2));
      const attempts = () => r.log.filter((l) => l === "set ember:snapshots:v2").length;
      const triedWithin = (ms: number) => {
        const n = attempts();
        vi.advanceTimersByTime(ms);
        return attempts() > n;
      };
      expect(triedWithin(250)).toBe(true); // the flush
      expect(triedWithin(250)).toBe(true); // the first retry is prompt
      expect(triedWithin(499)).toBe(false);
      expect(triedWithin(1)).toBe(true);
      expect(triedWithin(999)).toBe(false);
      expect(triedWithin(1)).toBe(true);
      vi.advanceTimersByTime(120_000);
      let tries = 0;
      for (let i = 0; i < 90; i++) if (triedWithin(1000)) tries++;
      expect(tries).toBeGreaterThanOrEqual(2);
      expect(tries).toBeLessThanOrEqual(4);
      r.refuse(null);
      c.set("anon", "r", snap(["r"])); // new work: tried again in 250 ms, not at the end of the backoff
      vi.advanceTimersByTime(250);
      expect(listed(r.m)).toHaveLength(2);
      const done = attempts();
      vi.advanceTimersByTime(120_000);
      expect(attempts()).toBe(done);
    } finally {
      vi.useRealTimers();
    }
  });

  it("async writes land in order; one refused after a newer value took its place does not drop the newer one", async () => {
    const r = recording({ async: true });
    const c = keyValueSnapshotCache(r.store);
    await c.get("anon", "q");
    c.set("anon", "q", snap(["v1"], 1));
    c.flush!();
    await r.settle();
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

  it("every sign-out removes format 1 again, whole (an older client in another tab may have written it since)", () => {
    const { m, store } = kv();
    const c = keyValueSnapshotCache(store);
    c.set("anon", "q", snap(["q"]));
    c.flush!();
    const blob = () => JSON.stringify({ v: 1, by: { anon: { q: { v: '["old"]', version: 1, epoch: "E", ik: "t", at: Date.now() } } } });
    m.set("ember:snapshots", blob());
    c.delete("anon", "q");
    c.flush!();
    expect(m.has("ember:snapshots")).toBe(true); // a delete leaves it (it is never read)
    c.clear("u\u0000i\u0000ana");
    expect(m.has("ember:snapshots")).toBe(false);
    m.set("ember:snapshots", blob());
    c.clear();
    expect(m.has("ember:snapshots")).toBe(false);
  });

  it("index rows are checked before they count; a corrupt `t` is bounded by `MAX_SLOTS`, so load and sign-out stay bounded", () => {
    const r = recording();
    const now = Date.now();
    const row = (key: string, slot: unknown) => ["anon", key, slot, 1, "E", "t", now, 3, "g"];
    r.m.set("ember:snapshots:v2", JSON.stringify({ v: 2, t: 1e9, n: [row("far", 1e9), row("past", 1 << 16), ["anon", "short", 5000], row("q", 2), row("dup", 2)] }));
    r.m.set("ember:snap:2", `${JSON.stringify([2, "anon", "q", 1, "E", "t", now, "g"])}\n["q"]`);
    const t0 = performance.now();
    const c = keyValueSnapshotCache(r.store);
    expect(c.get("anon", "q")).toMatchObject({ value: ["q"] });
    expect(c.get("anon", "far")).toBeUndefined();
    expect(c.get("anon", "past")).toBeUndefined();
    expect(c.get("anon", "dup")).toBeUndefined();
    c.clear();
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.log.filter((l) => l.startsWith("remove ember:snap:")).length).toBeLessThanOrEqual(65_536);
    expect(r.m.has("ember:snap:2")).toBe(false);
  });

  it("an `at` far in the future (index or header) is a miss, also for a new instance; a little ahead still ages out", () => {
    let now = 1_000_000_000_000;
    const { m, store } = kv();
    const far = now + 365 * 24 * 3600 * 1000;
    const near = now + 30_000; // another tab's clock, a bit ahead
    m.set("ember:snapshots:v2", JSON.stringify({ v: 2, t: 3, n: [["anon", "a", 0, 1, "E", "t", far, 3, "g"], ["anon", "b", 1, 1, "E", "t", now, 3, "g"], ["anon", "c", 2, 1, "E", "t", near, 3, "g"]] }));
    m.set("ember:snap:0", `${JSON.stringify([2, "anon", "a", 1, "E", "t", far, "g"])}\n["a"]`);
    m.set("ember:snap:1", `${JSON.stringify([2, "anon", "b", 1, "E", "t", far, "h"])}\n["b"]`); // header past the index
    m.set("ember:snap:2", `${JSON.stringify([2, "anon", "c", 1, "E", "t", near, "g"])}\n["c"]`);
    const opts = { now: () => now, maxAgeMs: 60_000, tabs: null };
    const reader = (): SnapshotCacheOptions => {
      const locks = fakeLocks();
      void locks.request("ember-snapshots:ember", {}, () => new Promise(() => {})); // someone else writes
      return { ...opts, tabs: { locks, channel: channelHub().open() } };
    };
    for (const c of [keyValueSnapshotCache(store, opts), keyValueSnapshotCache(store, reader())]) {
      expect(c.get("anon", "a")).toBeUndefined();
      expect(c.get("anon", "b")).toBeUndefined();
      expect(c.get("anon", "c")).toMatchObject({ value: ["c"], at: near });
    }
    // its age counts from its own `at` in every instance: no restart at each load
    now = near + 60_001;
    expect(keyValueSnapshotCache(store, opts).get("anon", "c")).toBeUndefined();
  });

  it("slots are reused without rescanning: 5000 queries stored and churned with keys bounded by the entries", () => {
    const { m, stats, store } = kv();
    const ix = { sets: 0, bytes: 0 };
    let removes = 0;
    const counted = {
      getItem: store.getItem,
      setItem: (k: string, v: string) => {
        if (k === "ember:snapshots:v2") (ix.sets++, (ix.bytes += v.length));
        store.setItem(k, v);
      },
      removeItem: (k: string) => (removes++, store.removeItem!(k)),
    };
    const t0 = performance.now();
    const c = keyValueSnapshotCache(counted, { maxBytes: 10 * 1024 * 1024 });
    for (let i = 0; i < 5000; i++) c.set("anon", `k${i}`, snap([i]));
    c.flush!();
    const first = { ...ix };
    // A delete removes its value's key at once; the index follows with the next flush: once for all 2000.
    for (let i = 0; i < 2000; i++) c.delete("anon", `k${i}`);
    expect(removes).toBe(1 + 2000); // format 1, then each deleted key
    expect(m.has("ember:snap:0")).toBe(false);
    expect(ix.sets).toBe(first.sets);
    for (let i = 0; i < 2000; i++) c.set("anon", `n${i}`, snap([i]));
    c.flush!();
    // Two index writes per flush at most (`t` raised before a slot past it, then the rows), each about 5000 rows: no
    // rewrite per entry (it was 2003 writes and 475 MiB of index JSON).
    expect(first.sets).toBeLessThanOrEqual(2);
    expect(ix.sets - first.sets).toBeLessThanOrEqual(2);
    expect(ix.bytes).toBeLessThan(4 * 5000 * 60);
    expect(stats.sets).toBe(ix.sets + 5000 + 2000);
    expect(slotKeys(m).length).toBe(5000);
    expect(listed(m)).toHaveLength(5000);
    expect(performance.now() - t0).toBeLessThan(20_000); // a backstop only: the counts above are the check
  });

  it("deletes from a reader tab reach the writer's store in one index write, acknowledged after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { m, store } = kv();
      let ixSets = 0;
      const counted = { ...store, setItem: (k: string, v: string) => (k === "ember:snapshots:v2" && ixSets++, store.setItem(k, v)) };
      const locks = fakeLocks();
      const hub = channelHub();
      const acks: string[] = [];
      const spy = hub.open();
      spy.onmessage = (e) => void ((e.data as { k?: string }).k === "ack" && acks.push((e.data as { id: string }).id));
      const a = keyValueSnapshotCache(counted, { tabs: { locks, channel: hub.open() }, maxBytes: 10 * 1024 * 1024 });
      const b = keyValueSnapshotCache(counted, { tabs: { locks, channel: hub.open() } });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 500; i++) a.set("anon", `k${i}`, snap([i]));
      a.flush!();
      ixSets = 0;
      for (let i = 0; i < 200; i++) b.delete("anon", `k${i}`);
      await vi.advanceTimersByTimeAsync(0);
      // every deleted key is gone now; nothing acknowledged before an index without them is stored
      expect(slotKeys(m)).toHaveLength(300);
      expect(ixSets).toBe(0);
      expect(acks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(ixSets).toBe(1);
      expect(acks).toHaveLength(200);
      expect(listed(m)).toHaveLength(300);
      expect(keyValueSnapshotCache(store, { tabs: null }).get("anon", "k3")).toBeUndefined();
      await b.close!();
      await a.close!();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("snapshot cache: one writer for every tab", () => {
  /** Tabs over one localStorage-like store, electing a writer with (fake) Web Locks over a (fake) channel. */
  function tabs(store: ReturnType<typeof kv>["store"], opts: SnapshotCacheOptions = {}) {
    const locks = fakeLocks();
    const hub = channelHub();
    const writers: SnapshotCache[] = [];
    const open = () => {
      const c: SnapshotCache = keyValueSnapshotCache(store, { ...opts, tabs: { locks, channel: hub.open() }, onWriterChange: (w) => void (w && writers.push(c)) });
      return c;
    };
    return { open, writers, locks };
  }

  it("only the writer writes; another tab reads what it stored (header-checked) and keeps its own values in memory", async () => {
    const { m, stats, store } = kv();
    const t = tabs(store);
    const a = t.open();
    const b = t.open();
    await until(() => t.writers.length === 1);
    expect(t.writers[0]).toBe(a);
    a.set("anon", "q", snap(["from a"]));
    a.flush!();
    // b reads a's value from the store.
    expect(b.get("anon", "q")).toMatchObject({ value: ["from a"] });
    stats.sets = 0;
    b.set("anon", "mine", snap(["from b"]));
    b.set("anon", "q", snap(["b's newer q"], 5));
    b.flush!();
    await tick(300);
    expect(stats.sets).toBe(0); // a reader never writes
    expect(b.get("anon", "mine")).toMatchObject({ value: ["from b"] });
    expect(a.get("anon", "mine")).toBeUndefined();
    // When a goes, b takes over: what it holds newer than the store is written.
    await a.close!();
    await until(() => t.writers.length === 2);
    expect(t.writers[1]).toBe(b);
    b.flush!();
    const fresh = keyValueSnapshotCache(store, { tabs: null });
    expect(fresh.get("anon", "mine")).toMatchObject({ value: ["from b"] });
    expect(fresh.get("anon", "q")).toMatchObject({ value: ["b's newer q"], version: 5 });
    expect(slotKeys(m)).toHaveLength(2);
    await b.close!();
  });

  it("a sign-out in a reader tab removes that identity from the store (through the writer) and from every tab", async () => {
    const { m, store } = kv();
    const t = tabs(store);
    const a = t.open();
    const b = t.open();
    const c = t.open();
    await until(() => t.writers.length === 1);
    a.set("u\u0000i\u0000ana", "x", snap(["ana's"]));
    a.set("anon", "y", snap(["public"]));
    a.flush!();
    b.get("u\u0000i\u0000ana", "x");
    c.set("u\u0000i\u0000ana", "z", snap(["ana's, in c"]));
    b.clear("u\u0000i\u0000ana");
    await tick();
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    expect(listed(m).map((r) => r[0])).toEqual(["anon"]);
    expect(c.get("u\u0000i\u0000ana", "z")).toBeUndefined();
    // c taking over later brings nothing of ana's back
    await a.close!();
    await until(() => t.writers.length === 2);
    t.writers[1]!.flush!();
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    expect(keyValueSnapshotCache(store, { tabs: null }).get("anon", "y")).toMatchObject({ value: ["public"] });
    await b.close!();
    await c.close!();
  });

  it("a sign-out the writer never acknowledged is sent again to the next writer", async () => {
    const { m, store } = kv();
    const locks = fakeLocks();
    const hub = channelHub({ manual: true });
    const writers: SnapshotCache[] = [];
    const ends = [hub.open(), hub.open(), hub.open()];
    const [a, b, c] = ends.map((channel) => {
      const x: SnapshotCache = keyValueSnapshotCache(store, { tabs: { locks, channel }, onWriterChange: (w) => void (w && writers.push(x)) });
      return x;
    });
    await until(() => writers.length === 1);
    expect(writers[0]).toBe(a);
    a!.set("u\u0000i\u0000ana", "x", snap(["ana's"]));
    a!.flush!();
    c!.clear("u\u0000i\u0000ana");
    // Neither a nor b gets that message (lost); a goes.
    hub.drop((to) => to !== ends[2]);
    await a!.close!();
    await until(() => writers.length === 2);
    expect(writers[1]).toBe(b);
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(true);
    // b announces itself; c sends what no writer acknowledged again, and b removes it.
    for (let i = 0; i < 4; i++) {
      hub.deliver(1e9);
      await tick();
    }
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    expect(listed(m)).toEqual([]);
    await b!.close!();
    await c!.close!();
  });

  it("a tab that takes over before hearing of a sign-out does not store back what it held (the index logs it)", async () => {
    const { m, store } = kv();
    const locks = fakeLocks();
    const hub = channelHub({ manual: true });
    const writers: SnapshotCache[] = [];
    const ends = [hub.open(), hub.open()];
    const [a, b] = ends.map((channel) => {
      const x: SnapshotCache = keyValueSnapshotCache(store, { tabs: { locks, channel }, onWriterChange: (w) => void (w && writers.push(x)) });
      return x;
    });
    await until(() => writers.length === 1);
    b!.set("u\u0000i\u0000ana", "x", snap(["ana's, in b's memory"]));
    a!.clear("u\u0000i\u0000ana");
    hub.drop(() => true); // b has not heard of it yet
    await a!.close!();
    await until(() => writers.length === 2);
    b!.flush!();
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    expect(b!.get("u\u0000i\u0000ana", "x")).toBeUndefined();
    // a value stored after the sign-out is kept
    b!.set("u\u0000i\u0000ana", "x", snap(["ana's, signed in again"], 2, Date.now() + 10));
    b!.flush!();
    expect(keyValueSnapshotCache(store, { tabs: null }).get("u\u0000i\u0000ana", "x")).toMatchObject({ value: ["ana's, signed in again"] });
    await b!.close!();
  });

  it("a reader's touch moves the stored version of that very value generation only", async () => {
    const { m, store } = kv();
    const t = tabs(store);
    const a = t.open();
    const b = t.open();
    await until(() => t.writers.length === 1);
    a.set("anon", "q", snap(["v"], 3));
    a.flush!();
    const read = b.get("anon", "q") as CachedSnapshot;
    b.touch!("anon", "q", { ...read, version: 9 });
    await tick();
    a.flush!();
    expect(listed(m)[0]![3]).toBe(9);
    // The writer has a new value since: a touch for the old generation does nothing.
    a.set("anon", "q", snap(["v2"], 10));
    a.flush!();
    b.touch!("anon", "q", { ...read, version: 20 });
    await tick();
    a.flush!();
    expect(keyValueSnapshotCache(store, { tabs: null }).get("anon", "q")).toMatchObject({ value: ["v2"], version: 10 });
    await a.close!();
    await b.close!();
  });

  it("over sessionStorage, or without a page, every instance writes its own store", () => {
    // A page with Web Locks (held by another tab) and BroadcastChannel, whatever the host has.
    const g = globalThis as { sessionStorage?: unknown; document?: unknown; BroadcastChannel?: unknown };
    const prev = { s: g.sessionStorage, d: g.document, b: g.BroadcastChannel, n: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
    const locks = fakeLocks();
    void locks.request("ember-snapshots:ember", {}, () => new Promise(() => {}));
    const hub = channelHub();
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true, writable: true });
    g.BroadcastChannel = function () {
      return hub.open();
    };
    g.document = {};
    const { store } = kv();
    try {
      // localStorage-like: a reader (another tab writes), so nothing is written here
      g.sessionStorage = kv().store;
      const reader = keyValueSnapshotCache(store);
      reader.set("anon", "q", snap(["q"]));
      reader.flush!();
      expect(keyValueSnapshotCache(store, { tabs: null }).get("anon", "q")).toBeUndefined();
      // over sessionStorage itself: its own store's only user, writing from the start
      g.sessionStorage = store;
      const c = keyValueSnapshotCache(store);
      c.set("anon", "q", snap(["q"]));
      c.flush!();
      expect(keyValueSnapshotCache(store).get("anon", "q")).toMatchObject({ value: ["q"] });
    } finally {
      g.sessionStorage = prev.s;
      g.document = prev.d;
      g.BroadcastChannel = prev.b;
      if (prev.n) Object.defineProperty(globalThis, "navigator", prev.n);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
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
    const versionOf = (channel: string) => listed(m).find((r) => (r[1] as string).includes(`"${channel}"`))![3] as number;
    const before = versionOf("c");
    for (let i = 0; i < 3; i++) await client.mutation(unsafeRef<"mutation">("messages:send"), { channel: "d", body: `d${i}` });
    await until(() => (other.at(-1)!.value as string[]).length === 3);
    await tick(300);
    expect(versionOf("c")).toBe(before);
    for (const l of listeners) l("background");
    expect(versionOf("c")).toBeGreaterThan(before);
    expect(versionOf("c")).toBe(versionOf("d"));
    client.close();
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

describe("snapshot cache: crashes, handover, ordering and format 1", () => {
  const ANA = "u\u0000i\u0000ana";
  const BOB = "u\u0000i\u0000bob";
  const NAME = "ember-snapshots:ember";
  const v1Blob = () => JSON.stringify({ v: 1, by: { anon: { q: { v: '["q"]', version: 1, epoch: "E", ik: "t", at: Date.now() } } } });
  const slotOf = (identity: string, key: string, version: number, gen: string, at: number, value: unknown) =>
    `${JSON.stringify([2, identity, key, version, "E", "t", at, gen])}\n${JSON.stringify(value)}`;
  /** Another tab holding the lock (the outgoing writer); `release()` is its tab going away. */
  function outgoing(locks: ReturnType<typeof fakeLocks>) {
    let gone = false;
    let release: (() => void) | null = null;
    void locks.request(NAME, {}, () => new Promise<void>((r) => ((release = r), gone && r())));
    return () => {
      gone = true;
      release?.();
    };
  }

  it("an observer that throws keeps the lock: no second writer until close, and close still resolves", async () => {
    const { store } = kv();
    const locks = fakeLocks();
    const hub = channelHub();
    const calls: string[] = [];
    const a = keyValueSnapshotCache(store, {
      tabs: { locks, channel: hub.open() },
      onWriterChange: (w) => {
        calls.push(`a ${w}`);
        throw new Error("observer");
      },
    });
    await until(() => calls.length === 1);
    const b = keyValueSnapshotCache(store, { tabs: { locks, channel: hub.open() }, onWriterChange: (w) => void calls.push(`b ${w}`) });
    await tick(20);
    expect(calls).toEqual(["a true"]);
    a.set("anon", "q", snap(["from a"]));
    a.flush!();
    expect(b.get("anon", "q")).toMatchObject({ value: ["from a"] });
    await a.close!();
    await until(() => calls.includes("b true"));
    expect(calls).toEqual(["a true", "a false", "b true"]);
    await b.close!();
  });

  it("taking over, a held value never overwrites a newer one the outgoing writer stored after its last index", async () => {
    const { m, store } = kv();
    const locks = fakeLocks();
    const hub = channelHub();
    const release = outgoing(locks);
    const now = Date.now();
    // It listed q and r at version 1, then stored q at version 3 in place and stopped before its index.
    m.set("ember:snapshots:v2", JSON.stringify({ v: 2, t: 2, n: [["anon", "q", 0, 1, "E", "t", now - 30, 4, "g1"], ["anon", "r", 1, 1, "E", "t", now - 30, 6, "h1"]] }));
    m.set("ember:snap:0", slotOf("anon", "q", 3, "g3", now - 10, ["q3"]));
    m.set("ember:snap:1", slotOf("anon", "r", 1, "h1", now - 30, ["r1"]));
    let writer = false;
    const b = keyValueSnapshotCache(store, { tabs: { locks, channel: hub.open() }, onWriterChange: (w) => void (writer = w) });
    b.set("anon", "q", snap(["q2"], 2, now - 20));
    b.set("anon", "r", snap(["r2"], 2, now - 20));
    release();
    await until(() => writer);
    b.flush!();
    expect(b.get("anon", "q")).toMatchObject({ value: ["q3"], version: 3 });
    const fresh = keyValueSnapshotCache(store, { tabs: null });
    expect(fresh.get("anon", "q")).toMatchObject({ value: ["q3"], version: 3 });
    // r's key holds what the index lists: the newer value held replaces it
    expect(fresh.get("anon", "r")).toMatchObject({ value: ["r2"], version: 2 });
    await b.close!();
  });

  it("taking over, a `set` that replaces a held value before the first flush is checked against its slot too", async () => {
    const { m, store } = kv();
    const locks = fakeLocks();
    const release = outgoing(locks);
    const now = Date.now();
    // The index lists q (slot 0) and r (slot 1) at version 1; the outgoing writer stored q v3 in place, then stopped.
    m.set("ember:snapshots:v2", JSON.stringify({ v: 2, t: 2, n: [["anon", "q", 0, 1, "E", "t", now - 30, 4, "g1"], ["anon", "r", 1, 1, "E", "t", now - 30, 6, "h1"]] }));
    m.set("ember:snap:0", slotOf("anon", "q", 3, "g3", now - 10, ["q3"]));
    m.set("ember:snap:1", slotOf("anon", "r", 1, "h1", now - 30, ["r1"]));
    let writer = false;
    const b = keyValueSnapshotCache(store, { tabs: { locks, channel: channelHub().open() }, onWriterChange: (w) => void (writer = w) });
    b.set("anon", "q", snap(["q2"], 2, now - 20));
    b.set("anon", "r", snap(["r2"], 2, now - 20));
    release();
    await until(() => writer);
    // before its first flush, another v2 value replaces each held one
    b.set("anon", "q", snap(["q2, again"], 2, now - 5));
    b.set("anon", "r", snap(["r2, again"], 2, now - 5));
    b.flush!();
    const fresh = keyValueSnapshotCache(store, { tabs: null });
    expect(fresh.get("anon", "q")).toMatchObject({ value: ["q3"], version: 3 });
    // r's key holds v1, as listed: replaced
    expect(fresh.get("anon", "r")).toMatchObject({ value: ["r2, again"], version: 2 });
    await b.close!();
  });

  it("a delete of another query never lets a value stored in its millisecond outlive a sign-out made then in another tab", async () => {
    const now = 1_700_000_000_000;
    const { m, store } = kv();
    const locks = fakeLocks();
    const hub = channelHub({ manual: true });
    let writer = false;
    const a = keyValueSnapshotCache(store, { now: () => now, tabs: { locks, channel: hub.open() }, onWriterChange: (w) => void (writer = w) });
    const b = keyValueSnapshotCache(store, { now: () => now, tabs: { locks, channel: hub.open() } });
    await until(() => writer);
    hub.deliver(1e9);
    // The writer deletes an unrelated query, then stores ana's value, all in one millisecond; then (same millisecond)
    // ana signs out in the other tab.
    a.delete("anon", "other");
    a.set(ANA, "x", snap(["ana's"], 1, now));
    a.flush!();
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(true);
    b.clear(ANA);
    hub.deliver(1e9);
    await tick();
    hub.deliver(1e9);
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    expect(a.get(ANA, "x")).toBeUndefined();
    // and a value ana's tab stores after its own sign-out, in that millisecond too, stays (its own order)
    b.set(ANA, "y", snap(["ana's, signed in again"], 2, now));
    expect(b.get(ANA, "y")).toMatchObject({ value: ["ana's, signed in again"] });
    await a.close!();
    await b.close!();
  });

  it("past 64 logged deletes the oldest becomes a sign-out of its identity: a takeover never stores back what it deleted", async () => {
    const { m, store } = kv();
    const locks = fakeLocks();
    const hub = channelHub({ manual: true });
    const writers: SnapshotCache[] = [];
    const [a, b, c] = [hub.open(), hub.open(), hub.open()].map((channel) => {
      const x: SnapshotCache = keyValueSnapshotCache(store, { tabs: { locks, channel }, onWriterChange: (w) => void (w && writers.push(x)) });
      return x;
    });
    await until(() => writers.length === 1);
    a!.set("anon", "kept", snap(["kept"]));
    a!.flush!();
    // b holds e (its own), and never hears of its delete, nor of the 70 that follow
    b!.set("anon", "e", snap(["e, in b's memory"]));
    await tick(2);
    a!.delete("anon", "e");
    for (let i = 0; i < 70; i++) a!.delete("anon", `z${i}`);
    a!.flush!();
    hub.drop(() => true);
    const log = (JSON.parse(m.get("ember:snapshots:v2")!) as { k: unknown[][] }).k;
    expect(log.filter((k) => k[2] !== null)).toHaveLength(64);
    expect(log.some((k) => k[1] === "anon" && k[2] === null)).toBe(true);
    // what the index lists is still read by a reader (its rows come after every kill it logs)
    expect(c!.get("anon", "kept")).toMatchObject({ value: ["kept"] });
    await a!.close!();
    await until(() => writers.length === 2);
    b!.flush!();
    expect([...m.values()].some((v) => v.includes("in b's memory"))).toBe(false);
    expect(keyValueSnapshotCache(store, { tabs: null }).get("anon", "kept")).toMatchObject({ value: ["kept"] });
    await b!.close!();
    await c!.close!();
  });

  it("past 64 logged sign-outs the oldest fold into one of everyone: a takeover still drops what the first covered", async () => {
    let now = 1_700_000_000_000;
    const clock = () => now;
    const { m, store } = kv();
    const locks = fakeLocks();
    const release = outgoing(locks);
    let writer = false;
    const b = keyValueSnapshotCache(store, { now: clock, tabs: { locks, channel: channelHub().open() }, onWriterChange: (w) => void (writer = w) });
    // b holds ana's value, and never hears of her sign-out, nor of the 200 that follow (other identities)
    b.set(ANA, "x", snap(["ana's"], 1, now));
    now += 10;
    const w = keyValueSnapshotCache(store, { now: clock, tabs: null });
    w.clear(ANA);
    for (let i = 0; i < 200; i++) {
      now += 1;
      w.clear(`u\u0000i\u0000user${i}`);
    }
    w.flush!();
    const log = (JSON.parse(m.get("ember:snapshots:v2")!) as { k: unknown[][] }).k;
    expect(log.length).toBeLessThanOrEqual(64);
    expect(log.filter((k) => k[1] === null && k[2] === null)).toHaveLength(1);
    now += 10;
    release();
    await until(() => writer);
    b.flush!();
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    expect(b.get(ANA, "x")).toBeUndefined();
    // An index logging more than is read one by one (not written here): the oldest fold too, ana's (first) still covers
    // a value held from before it.
    const locks2 = fakeLocks();
    const release2 = outgoing(locks2);
    let writer2 = false;
    const c = keyValueSnapshotCache(store, { now: clock, tabs: { locks: locks2, channel: channelHub().open() }, onWriterChange: (x) => void (writer2 = x) });
    c.set(ANA, "x", snap(["ana's, before"], 1, now));
    now += 100;
    const k = [[now, ANA, null, "z.0"], ...Array.from({ length: 2000 }, (_, i) => [now + 50 + i / 100, "anon", `k${i}`, `z.${i + 1}`])];
    m.set("ember:snapshots:v2", JSON.stringify({ v: 2, t: 0, n: [], k }));
    now += 100;
    release2();
    await until(() => writer2);
    c.flush!();
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    await b.close!();
    await c.close!();
  });

  // The clock moved back (an NTP correction): what a sign-out covered in its own tab's order it still covers once logged.
  /** `y` writes the store (its own instance) and `r`, a reader waiting for the lock, reads ana's value from it. */
  function storedThenRead(now: () => number) {
    const { m, store } = kv();
    const locks = fakeLocks();
    const release = outgoing(locks);
    const state = { writer: false };
    const y = keyValueSnapshotCache(store, { now, tabs: null });
    y.set(ANA, "x", snap(["ana's"], 1, now()));
    y.flush!();
    const r = keyValueSnapshotCache(store, { now, tabs: { locks, channel: channelHub().open() }, onWriterChange: (w) => void (state.writer = w) });
    expect(r.get(ANA, "x")).toMatchObject({ value: ["ana's"] });
    /** `r` takes over (it never heard of anything since) and writes what it holds. */
    const takeOver = async () => {
      release();
      await until(() => state.writer);
      r.flush!();
      expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
      expect(r.get(ANA, "x")).toBeUndefined();
      await r.close!();
    };
    return { m, store, y, r, takeOver };
  }

  it("a sign-out logged later by another tab never replaces one that covers values it does not (the clock moved back)", async () => {
    let now = 1_700_000_000_200;
    const t = storedThenRead(() => now);
    // y signs ana out after storing her value (at 200), at 100 by the clock: it covers that value by y's own order
    now -= 100;
    t.y.clear(ANA);
    // another instance signs her out at 150: by time it covers what was stored up to 150, not her value at 200
    now += 50;
    keyValueSnapshotCache(t.store, { now: () => now, tabs: null }).clear(ANA);
    await t.takeOver();
  });

  it("a sign-out logged by another tab is not replaced by an earlier one of a tab whose later values it covers", async () => {
    let now = 1_700_000_000_200;
    const { m, store } = kv();
    const locks = fakeLocks();
    const release = outgoing(locks);
    let writer = false;
    // z signs ana out at 200, then (its clock moved back) stores a value of hers at 150: after that sign-out, by z's order
    const z = keyValueSnapshotCache(store, { now: () => now, tabs: null });
    z.clear(ANA);
    now -= 50;
    z.set(ANA, "x", snap(["ana's"], 1, now));
    z.flush!();
    const r = keyValueSnapshotCache(store, { now: () => now, tabs: { locks, channel: channelHub().open() }, onWriterChange: (w) => void (writer = w) });
    expect(r.get(ANA, "x")).toMatchObject({ value: ["ana's"] });
    // another instance signs her out at 180: it covers her value stored at 150 (z's sign-out at 200 does not)
    now += 30;
    keyValueSnapshotCache(store, { now: () => now, tabs: null }).clear(ANA);
    release();
    await until(() => writer);
    r.flush!();
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    expect(r.get(ANA, "x")).toBeUndefined();
    await r.close!();
  });

  it("folding logged sign-outs never uncovers a value stored before one of them by its own tab (the clock moved back)", async () => {
    let now = 1_700_000_000_105;
    const t = storedThenRead(() => now);
    // y signs ana out at 100 (after storing her value at 105), then 64 others: the oldest fold into one of everyone
    now -= 5;
    t.y.clear(ANA);
    for (let i = 0; i < 64; i++) {
      now += 1;
      t.y.clear(`u\u0000i\u0000user${i}`);
    }
    const log = (JSON.parse(t.m.get("ember:snapshots:v2")!) as { k: unknown[][] }).k;
    expect(log.length).toBeLessThanOrEqual(64);
    expect(log.some((k) => k[1] === ANA)).toBe(false);
    await t.takeOver();
  });

  it("a takeover with the clock moved back never narrows a logged sign-out", async () => {
    let now = 1_700_000_000_105;
    const { m, store } = kv();
    const locks = fakeLocks();
    const release = outgoing(locks);
    let writer = false;
    const b = keyValueSnapshotCache(store, { now: () => now, tabs: { locks, channel: channelHub().open() }, onWriterChange: (w) => void (writer = w) });
    // b holds ana's value (stored at 105) and never hears of her sign-out at 110
    b.set(ANA, "x", snap(["ana's"], 1, now));
    now += 5;
    keyValueSnapshotCache(store, { now: () => now, tabs: null }).clear(ANA);
    // it takes over at 100 (the clock moved back): the logged sign-out still covers what was stored up to 110
    now -= 10;
    release();
    await until(() => writer);
    b.flush!();
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    expect(b.get(ANA, "x")).toBeUndefined();
    const log = (JSON.parse(m.get("ember:snapshots:v2")!) as { k: unknown[][] }).k;
    expect(log.find((k) => k[1] === ANA)?.[0]).toBe(now + 10);
    await b.close!();
  });

  it("a sign-out whose key removal is refused: the index that reserves a new slot no longer lists that key", async () => {
    const base = kv();
    let refuse = false;
    let ixWrites = 0;
    const store = {
      getItem: base.store.getItem,
      setItem: (k: string, v: string) => {
        // the reservation (first index of the flush) is stored, the index after the values is refused
        if (refuse && k === "ember:snapshots:v2" && ++ixWrites > 1) throw new DOMException("full", "QuotaExceededError");
        base.store.setItem(k, v);
      },
      removeItem: (k: string) => {
        if (refuse && k.startsWith("ember:snap:")) throw new DOMException("refused", "InvalidStateError");
        base.store.removeItem!(k);
      },
    };
    const w = keyValueSnapshotCache(store, { tabs: null });
    w.set(ANA, "x", snap(["ana's"]));
    w.flush!();
    // bob's value waits for a new slot (past `t`) when ana signs out: her key stays (its removal refused)
    w.set(BOB, "y", snap(["bob's"]));
    refuse = true;
    w.clear(ANA);
    expect(slotKeys(base.m).some((k) => base.m.get(k)!.includes("ana's"))).toBe(true);
    expect(listed(base.m).some((r) => r[0] === ANA)).toBe(false);
    // a tab that never heard of the sign-out does not find her value through that index
    const locks = fakeLocks();
    const release = outgoing(locks);
    const r = keyValueSnapshotCache(store, { tabs: { locks, channel: channelHub().open() } });
    expect(r.get(ANA, "x")).toBeUndefined();
    refuse = false;
    await w.close!();
    await r.close!();
    release();
  });

  it("a takeover never answers an older version than it held when a widened logged delete drops its own value", async () => {
    let now = 1_700_000_000_000;
    const { store } = kv();
    const locks = fakeLocks();
    const release = outgoing(locks);
    let writer = false;
    const w = keyValueSnapshotCache(store, { now: () => now, tabs: null });
    w.set(BOB, "d", snap(["bob's, v1"], 1, now));
    w.flush!();
    // b holds a newer value of that query (its own, never stored) and hears of nothing
    now += 1;
    const b = keyValueSnapshotCache(store, { now: () => now, tabs: { locks, channel: channelHub().open() }, onWriterChange: (x) => void (writer = x) });
    b.set(BOB, "d", snap(["bob's, v2"], 2, now));
    // a delete of another of bob's queries, then 64 more: logged as a sign-out of bob, which covers b's value
    now += 1;
    w.delete(BOB, "b");
    for (let i = 0; i < 64; i++) w.delete("anon", `z${i}`);
    w.flush!();
    release();
    await until(() => writer);
    // a miss, never the index's v1 (older than what b held)
    expect(b.get(BOB, "d")).toBeUndefined();
    b.flush!();
    expect(keyValueSnapshotCache(store, { now: () => now, tabs: null }).get(BOB, "d")).toBeUndefined();
    await b.close!();
  });

  it("a value stored right after this tab's own sign-out, in the same millisecond, stays (while loading, or taking over)", async () => {
    const now = 1_700_000_000_000;
    const clock = () => now;
    // An async store still loading: the sign-out waits for it, the value after it stays.
    const r = recording({ async: true });
    const c = keyValueSnapshotCache(r.store, { now: clock });
    void c.get(ANA, "x");
    c.clear(ANA);
    c.set(ANA, "x", snap(["after"], 1, now));
    await r.settle();
    c.flush!();
    await r.settle();
    expect(await c.get(ANA, "x")).toMatchObject({ value: ["after"] });
    // A reader taking over: its own sign-out goes to the store, the value after it stays, and reads as after it.
    const { store } = kv();
    const locks = fakeLocks();
    const hub = channelHub();
    const release = outgoing(locks);
    let writer = false;
    const b = keyValueSnapshotCache(store, { now: clock, tabs: { locks, channel: hub.open() }, onWriterChange: (w) => void (writer = w) });
    b.clear(ANA);
    b.set(ANA, "x", snap(["after, in b"], 1, now));
    release();
    await until(() => writer);
    expect(b.get(ANA, "x")).toMatchObject({ value: ["after, in b"] });
    b.flush!();
    const reader = keyValueSnapshotCache(store, { now: clock, tabs: { locks, channel: hub.open() } });
    expect(reader.get(ANA, "x")).toMatchObject({ value: ["after, in b"] });
    await b.close!();
    await reader.close!();
  });

  it("a sign-out stays until a writer acknowledges it, whatever the number of deletes queued after it", async () => {
    const { m, store } = kv();
    const locks = fakeLocks();
    const hub = channelHub({ manual: true });
    const writers: SnapshotCache[] = [];
    const [a, b] = [hub.open(), hub.open()].map((channel) => {
      const x: SnapshotCache = keyValueSnapshotCache(store, { tabs: { locks, channel }, onWriterChange: (w) => void (w && writers.push(x)) });
      return x;
    });
    await until(() => writers.length === 1);
    a!.set(ANA, "x", snap(["ana's"]));
    a!.flush!();
    b!.clear(ANA);
    await tick(2);
    for (let i = 0; i < 100; i++) b!.delete("anon", `k${i}`);
    // none of it reaches a, which goes; b takes over
    hub.drop(() => true);
    await a!.close!();
    await until(() => writers.length === 2);
    b!.flush!();
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    await b!.close!();
  });

  it("a delete or sign-out heard from a tab that went before it reached the writer is sent again until acknowledged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const micro = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    try {
      const { m, store } = kv();
      const locks = fakeLocks();
      const hub = channelHub({ manual: true });
      const ends = [hub.open(), hub.open(), hub.open()];
      const writers: SnapshotCache[] = [];
      const [a, , c] = ends.map((channel) => {
        const x: SnapshotCache = keyValueSnapshotCache(store, { tabs: { locks, channel }, onWriterChange: (w) => void (w && writers.push(x)) });
        return x;
      });
      await micro();
      hub.deliver(1e9);
      expect(writers).toEqual([a]);
      a!.set(ANA, "x", snap(["ana's"]));
      a!.flush!();
      c!.clear(ANA);
      // c's message reaches b only; then c's tab crashes (what it sent to a is lost)
      hub.deliver(1e9, Math.random, (to) => to === ends[1]);
      hub.dropFrom(ends[2]!);
      ends[2]!.close!();
      hub.deliver(1e9);
      expect([...m.values()].some((v) => v.includes("ana's"))).toBe(true);
      vi.advanceTimersByTime(1000);
      hub.deliver(1e9);
      await micro();
      hub.deliver(1e9);
      expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the index keeps every sign-out it logs, however many deletes follow (and drops what a newer one covers)", () => {
    const { m, store } = kv();
    const c = keyValueSnapshotCache(store);
    c.clear(ANA);
    for (let i = 0; i < 100; i++) c.delete("anon", `k${i}`);
    c.flush!();
    const log = () => (JSON.parse(m.get("ember:snapshots:v2")!) as { k: Array<[number, string | null, string | null, string]> }).k;
    expect(log().some(([, i, key]) => i === ANA && key === null)).toBe(true);
    expect(log().filter(([, , key]) => key !== null)).toHaveLength(64);
    c.clear();
    c.flush!();
    expect(log()).toEqual([[expect.any(Number), null, null, expect.any(String)]]);
  });

  it("never stores a value in a slot past `MAX_SLOTS` (an index there would not be read back)", () => {
    const { m, store } = kv();
    const c = keyValueSnapshotCache(store, { maxBytes: 1 << 30 });
    for (let i = 0; i <= 65_536; i++) c.set("anon", `q${i}`, snap(i));
    c.flush!();
    expect(m.has("ember:snap:65536")).toBe(false);
    const rows = listed(m);
    expect(rows).toHaveLength(65_536);
    expect(rows.every((r) => (r[2] as number) < 65_536)).toBe(true);
    const again = keyValueSnapshotCache(store);
    expect(again.get("anon", "q65535")).toMatchObject({ value: 65_535 });
  });

  it("sign-out removes keys a flush reserved past what its rows list before it stopped", () => {
    const { m, store } = kv();
    // t stored (2000 slots reserved), values written, the index listing them never stored
    m.set("ember:snapshots:v2", JSON.stringify({ v: 2, t: 2000, n: [] }));
    m.set("ember:snap:1500", slotOf(ANA, "x", 1, "g", Date.now(), ["ana's"]));
    const c = keyValueSnapshotCache(store);
    c.clear(ANA);
    expect(m.has("ember:snap:1500")).toBe(false);
  });

  it("the writer hands the store over only once format 1's removal is done", async () => {
    const { m, store } = kv();
    m.set("ember:snapshots", v1Blob());
    let removing: (() => void) | null = null;
    const slow = {
      getItem: async (k: string) => store.getItem(k),
      setItem: async (k: string, v: string) => store.setItem(k, v),
      removeItem: (k: string) =>
        k === "ember:snapshots"
          ? new Promise<void>((res) => {
              removing = () => (store.removeItem!(k), res());
            })
          : Promise.resolve(store.removeItem!(k)),
    };
    const locks = fakeLocks();
    let writer = false;
    const a = keyValueSnapshotCache(slow, { tabs: { locks, channel: channelHub().open() }, onWriterChange: (w) => void (writer = w) });
    await until(() => writer);
    expect(await a.get("anon", "q")).toBeUndefined();
    a.flush!();
    await until(() => removing !== null);
    let closed = false;
    void a.close!().then(() => (closed = true));
    await tick(20);
    expect(closed).toBe(false);
    expect(locks.holder(NAME)).not.toBeNull();
    removing!();
    await until(() => closed);
    expect(m.has("ember:snapshots")).toBe(false);
  });

  it("format 1 whose removal was refused is removed again on its own (backed off), with nothing new to write", async () => {
    const { m, store } = kv();
    m.set("ember:snapshots", v1Blob());
    let refusals = 2;
    const busy = {
      ...store,
      removeItem: (k: string) => {
        if (k === "ember:snapshots" && refusals-- > 0) throw new Error("busy");
        store.removeItem!(k);
      },
    };
    const c = keyValueSnapshotCache(busy);
    expect(c.get("anon", "q")).toBeUndefined();
    c.flush!();
    expect(m.has("ember:snapshots")).toBe(true);
    await tick(400); // the first retry (250 ms), refused again
    expect(m.has("ember:snapshots")).toBe(true);
    await tick(700); // the next (500 ms later)
    expect(m.has("ember:snapshots")).toBe(false);
  });

  it("a version a touch stored is not undone by an index written while a newer value is on its way", async () => {
    const base = kv();
    const queue: Array<() => void> = [];
    const store = {
      getItem: async (k: string) => base.store.getItem(k),
      setItem: (k: string, v: string) => new Promise<void>((res) => queue.push(() => (base.store.setItem(k, v), res()))),
      removeItem: async (k: string) => base.store.removeItem!(k),
    };
    const step = async () => {
      queue.shift()?.();
      await tick();
    };
    const drain = async () => {
      for (let i = 0; i < 3; i++) {
        await tick();
        while (queue.length) await step();
      }
    };
    const c = keyValueSnapshotCache(store);
    const v = ["v"];
    c.set("anon", "q", snap(v, 1));
    c.flush!();
    await drain();
    c.touch!("anon", "q", snap(v, 5));
    c.flush!();
    await drain();
    expect(listed(base.m).find((r) => r[1] === "q")![3]).toBe(5);
    // A flush on its way (another query's key, then the index); meanwhile a newer value for q.
    c.set("anon", "other", snap(["o"]));
    c.flush!();
    c.set("anon", "q", snap(["v2"], 6));
    // (`t` first, as other's key is a new slot; then other's key; then the index, still listing q's stored value)
    while (!listed(base.m).some((r) => r[1] === "other")) await step();
    expect(listed(base.m).find((r) => r[1] === "q")![3]).toBe(5);
    c.flush!();
    await drain();
    expect(keyValueSnapshotCache(base.store).get("anon", "q")).toMatchObject({ value: ["v2"], version: 6 });
  });
});

describe("snapshot cache: acknowledgements", () => {
  it("a sign-out reaching a writer whose store fails to load is acknowledged only once it is stored", async () => {
    const { m, store } = kv();
    const now = Date.now();
    m.set("ember:snapshots:v2", JSON.stringify({ v: 2, t: 1, n: [["u\u0000i\u0000ana", "x", 0, 1, "E", "t", now, 7, "g"]] }));
    m.set("ember:snap:0", `${JSON.stringify([2, "u\u0000i\u0000ana", "x", 1, "E", "t", now, "g"])}\n["ana's"]`);
    let down = true;
    const flaky = {
      getItem: async (k: string) => {
        if (k === "ember:snapshots:v2" && down) throw new Error("io");
        return store.getItem(k);
      },
      setItem: async (k: string, v: string) => store.setItem(k, v),
      removeItem: async (k: string) => store.removeItem!(k),
    };
    const locks = fakeLocks();
    const hub = channelHub();
    const acks: string[] = [];
    const reader = hub.open();
    reader.onmessage = (e) => {
      const x = e.data as { k: string; id?: string };
      if (x.k === "ack") acks.push(x.id!);
    };
    const w = keyValueSnapshotCache(flaky, { tabs: { locks, channel: hub.open() } });
    await tick(5);
    reader.postMessage({ ember: "snapshots/1", k: "kill", from: "other", id: "k1", i: "u\u0000i\u0000ana", at: now + 1 });
    await tick(5);
    // the store did not load (yet): nothing acknowledged, ana's value still there
    expect(acks).toEqual([]);
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(true);
    down = false;
    await until(() => acks.includes("k1"), 3000);
    expect([...m.values()].some((v) => v.includes("ana's"))).toBe(false);
    await w.close!();
  });
});
