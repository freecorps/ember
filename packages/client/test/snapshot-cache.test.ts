// The snapshot cache's storage (format 2, PR 3B-1b): one key per query plus a light index, only what changed written
// per flush, values parsed once, format 1 migrated by the writer, entries checked against their own header, quota
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
      if (opts.quota !== undefined && used() - (m.get(k)?.length ?? 0) + v.length > opts.quota) throw new DOMException("full", "QuotaExceededError");
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
    expect(stats.gets).toBe(3); // the index, format 1's key (gone), then q1's key (q2 not read)
    expect((b.get("anon", "q1") as CachedSnapshot).value).toBe(first.value);
    expect(stats.gets).toBe(3);
    expect(b.get("bob", "q1")).toBeUndefined();
  });

  it("format 1 (one blob) is migrated: values kept, then written per key and the blob removed", () => {
    const { m, store } = kv();
    const at = Date.now();
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

  it("an unreadable format 1 blob, or a key holding another query, is a miss — never a wrong value", () => {
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
    expect(r.log).toEqual(["set ember:snapshots:v2", "set ember:snap:0", "set ember:snapshots:v2"]);
    expect(JSON.parse(r.m.get("ember:snapshots:v2")!)).toMatchObject({ t: 1 });
    r.log.length = 0;
    c.delete("anon", "a");
    // its key goes at once; the index (listing a key that is gone: a miss) with the next flush
    expect(r.log).toEqual(["remove ember:snap:0"]);
    expect(keyValueSnapshotCache(r.store, { tabs: null }).get("anon", "a")).toBeUndefined();
    c.flush!();
    expect(r.log).toEqual(["remove ember:snap:0", "set ember:snapshots:v2"]);
    // (the index logs the delete: a tab that had not heard of it drops that value)
    expect(JSON.parse(r.m.get("ember:snapshots:v2")!)).toEqual({ v: 2, t: 0, n: [], k: [[expect.any(Number), "anon", "a"]] });
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

  it("format 1 stays until its values and an index listing them are stored, and only if it is still the blob read", async () => {
    const r = recording({ async: true });
    const blob = JSON.stringify({ v: 1, by: { anon: { k: { v: "[1,2]", version: 2, epoch: "E", ik: "t", at: Date.now() } } } });
    r.m.set("ember:snapshots", blob);
    const c = keyValueSnapshotCache(r.store);
    expect(await c.get("anon", "k")).toMatchObject({ value: [1, 2] });
    r.refuse((k) => k.startsWith("ember:snap:"));
    c.flush!();
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

    // An older client wrote it again after the writer read it: that one stays, for the next load to merge.
    const { m, store } = kv();
    m.set("ember:snapshots", JSON.stringify({ v: 1, by: { anon: { k: { v: '["old"]', version: 2, epoch: "E", ik: "t", at: Date.now() } } } }));
    const e = keyValueSnapshotCache(store);
    expect(e.get("anon", "k")).toMatchObject({ value: ["old"] });
    const newer = JSON.stringify({ v: 1, by: { anon: { k: { v: '["newer"]', version: 5, epoch: "E", ik: "t", at: Date.now() + 1 } } } });
    m.set("ember:snapshots", newer);
    e.flush!();
    expect(m.get("ember:snapshots")).toBe(newer);
    expect(keyValueSnapshotCache(store).get("anon", "k")).toMatchObject({ value: ["newer"], version: 5 });
  });

  it("index rows are checked before they count; a corrupt `t` is clamped, so load and sign-out stay bounded", () => {
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
    expect(r.log.filter((l) => l.startsWith("remove ember:snap:")).length).toBeLessThanOrEqual(3 + 1024);
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

  it("slots are reused without rescanning: 5000 queries migrate and churn with keys bounded by the entries", () => {
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
    const by: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) by[`k${i}`] = { v: `[${i}]`, version: 1, epoch: "E", ik: "t", at: Date.now() };
    m.set("ember:snapshots", JSON.stringify({ v: 1, by: { anon: by } }));
    const t0 = performance.now();
    const c = keyValueSnapshotCache(counted, { maxBytes: 10 * 1024 * 1024 });
    c.get("anon", "k0");
    c.flush!();
    const migrated = { ...ix };
    // A delete removes its value's key at once; the index follows with the next flush: once for all 2000.
    for (let i = 0; i < 2000; i++) c.delete("anon", `k${i}`);
    expect(removes).toBe(1 + 2000); // format 1, then each deleted key
    expect(m.has("ember:snap:0")).toBe(false);
    expect(ix.sets).toBe(migrated.sets);
    for (let i = 0; i < 2000; i++) c.set("anon", `n${i}`, snap([i]));
    c.flush!();
    // Two index writes per flush at most (`t` raised before a slot past it, then the rows), each about 5000 rows: no
    // rewrite per entry (it was 2003 writes and 475 MiB of index JSON).
    expect(migrated.sets).toBeLessThanOrEqual(2);
    expect(ix.sets - migrated.sets).toBeLessThanOrEqual(2);
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
      await b.close();
      await a.close();
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
    const { store } = kv();
    const g = globalThis as { sessionStorage?: unknown; document?: unknown };
    const prev = { s: g.sessionStorage, d: g.document };
    g.sessionStorage = store;
    g.document = {};
    try {
      const c = keyValueSnapshotCache(store);
      c.set("anon", "q", snap(["q"]));
      c.flush!();
      expect(keyValueSnapshotCache(store).get("anon", "q")).toMatchObject({ value: ["q"] });
    } finally {
      g.sessionStorage = prev.s;
      g.document = prev.d;
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
