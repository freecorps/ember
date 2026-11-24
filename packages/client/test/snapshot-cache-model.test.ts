// The snapshot cache against a reference model (PR 3B-1): one to three instances (tabs) over one shared store — sync
// (localStorage) or async with operations completing in a random order — and random set / touch / get / delete /
// clear / clear(identity) / flush / reload interleavings, some writes refused. Seeded: a failure prints its seed.
//
// Checked, always: a value is only ever returned under the identity and key it was stored for, with a version it was
// current at (its own, or one a touch confirmed for that very value), and its epoch and tag. With a sync store: right
// after a sign-out (`clear()`, `clear(identity)`), no stored key holds a value of whoever signed out. With no refusals
// (sync, any number of tabs) or a single instance at a time (async): every tab still holds what it stored, and once
// everything settled a new instance finds every value a tab stored (also one closed since), unless it was deleted or
// signed out since, or another tab that could write it back (it stored, read or deleted that query) was open since —
// tabs share the store, so the last writer wins.
//
// MODEL_SEEDS=n runs n seeds per case (10 000 pass; the default keeps the suite fast); MODEL_TRACE=<seed> logs a run.
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { keyValueSnapshotCache, type CachedSnapshot, type SnapshotCache } from "../src/index.ts";
import type { KeyValueStore } from "../src/storage.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const spin = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** One store shared by every instance. Async: operations wait in a queue and complete in a random order. */
function sharedStore(rand: () => number, async: boolean) {
  const m = new Map<string, string>();
  const queue: Array<() => void> = [];
  const ctl = { failRate: 0 };
  const store: KeyValueStore = async
    ? {
        getItem: (k) => new Promise<string | null>((res, rej) => queue.push(() => (rand() < ctl.failRate / 4 ? rej(new Error("io")) : res(m.get(k) ?? null)))),
        setItem: (k, v) => new Promise<void>((res, rej) => queue.push(() => (rand() < ctl.failRate ? rej(new Error("full")) : (m.set(k, v), res())))),
        removeItem: (k) => new Promise<void>((res) => queue.push(() => (m.delete(k), res()))),
      }
    : {
        getItem: (k) => m.get(k) ?? null,
        setItem: (k, v) => {
          if (rand() < ctl.failRate) throw new DOMException("full", "QuotaExceededError");
          m.set(k, v);
        },
        removeItem: (k) => void m.delete(k),
      };
  /** Completes up to `n` waiting operations, picked at random. */
  const step = async (n: number) => {
    for (let i = 0; i < n && queue.length; i++) {
      queue.splice(Math.floor(rand() * queue.length), 1)[0]!();
      await spin();
    }
    await spin();
  };
  /** Completes everything, also what completing it starts. */
  const drain = async () => {
    for (let guard = 0; ; guard++) {
      await spin();
      if (!queue.length) return;
      if (guard > 10_000) throw new Error("the store never settles");
      await step(queue.length);
    }
  };
  return { m, store, ctl, step, drain, waiting: () => queue.length };
}

interface Config {
  async: boolean;
  tabs: number;
  failRate: number;
  /** Check that settled values are found by a new instance. */
  durable: boolean;
}

const IDS = ["anon", "u\u0000i\u0000ana", "u\u0000i\u0000bob"];
const KEYS = ["a", "b", "c", "d", "e"];
const E = "E";
const IK = "t";

/** A stored value: who it is for and which `set` made it. */
type Val = [identity: string, key: string, nonce: number];

async function run(seed: number, cfg: Config): Promise<void> {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const s = sharedStore(rand, cfg.async);
  s.ctl.failRate = cfg.failRate;
  let clock = 1_700_000_000_000;
  const now = () => clock;
  let version = 0;
  let nonce = 0;
  let time = 0;
  /** The versions each value was current at: its own, up to the newest a touch confirmed. */
  const versions = new Map<number, { min: number; max: number }>();

  interface Tab {
    id: number;
    cache: SnapshotCache;
    /** Closed (at that step): its store calls do nothing (what it sent before still lands). */
    dead: boolean;
    closedAt?: number;
    /** What this instance stored and should still hold: value object, its nonce, and when. */
    held: Map<string, { value: Val; version: number; at: number; time: number }>;
  }
  let tabIds = 0;
  const open = (): Tab => {
    const t: Tab = { id: tabIds++, cache: null!, dead: false, held: new Map() };
    const none = () => (cfg.async ? Promise.resolve() : undefined);
    const store: KeyValueStore = {
      getItem: (k) => (t.dead ? null : s.store.getItem(k)),
      setItem: (k, v) => (t.dead ? none() : s.store.setItem(k, v)),
      removeItem: (k) => (t.dead ? none() : s.store.removeItem!(k)),
    };
    t.cache = keyValueSnapshotCache(store, { now, maxBytes: 1 << 30 });
    return t;
  };
  const tabs: Tab[] = Array.from({ length: cfg.tabs }, open);
  /** Closed tabs: what they held when they closed (flushed, settled) must still be found. */
  const gone: Tab[] = [];
  /**
   * The tabs that may write (identity, key): those that stored, read or deleted it — what a tab holds it may write
   * again (moved off a slot another tab took), also after another tab's sign-out, and a delete reaches the store at
   * its next flush. A tab leaves it with its own sign-out (sync: done at once).
   */
  const writers = new Map<string, Set<number>>();
  const wrote = (t: Tab, id: string, key: string) => {
    let w = writers.get(q(id, key));
    if (!w) writers.set(q(id, key), (w = new Set()));
    w.add(t.id);
  };
  /** (identity, key) → when it was last deleted or signed out anywhere (sign-outs still running count until `drain`). */
  const killed = new Map<string, number>();
  const openClears: Array<string | undefined> = [];
  const q = (id: string, key: string) => `${id}\u0001${key}`;
  const kill = (id: string | undefined, key?: string) => {
    for (const i of IDS) {
      if (id !== undefined && i !== id) continue;
      for (const k of KEYS) {
        if (key !== undefined && k !== key) continue;
        killed.set(q(i, k), time);
      }
    }
    for (const t of [...tabs, ...gone]) {
      for (const k of [...t.held.keys()]) {
        const [i, kk] = k.split("\u0001") as [string, string];
        if ((id === undefined || i === id) && (key === undefined || kk === key)) t.held.delete(k);
      }
    }
  };
  const trace = process.env.MODEL_TRACE === `${seed}` ? (...a: unknown[]) => console.log(time, ...a) : () => {};
  const fail = (what: string): never => {
    throw new Error(`seed ${seed} (${JSON.stringify(cfg)}), step ${time}: ${what}`);
  };

  const check = (id: string, key: string, got: CachedSnapshot | undefined) => {
    if (!got) return;
    const v = got.value as Val;
    if (!Array.isArray(v) || v[0] !== id || v[1] !== key) fail(`get(${JSON.stringify(id)}, ${key}) returned ${JSON.stringify(v)}`);
    const range = versions.get(v[2]);
    if (!range) fail(`unknown value ${JSON.stringify(v)}`);
    if (got.version < range!.min || got.version > range!.max) fail(`${JSON.stringify(v)} at version ${got.version}, current only in ${range!.min}..${range!.max}`);
    if (got.epoch !== E || got.ik !== IK) fail(`${JSON.stringify(v)} with epoch/ik ${got.epoch}/${got.ik}`);
  };
  const get = async (t: Tab, id: string, key: string) => {
    const r = t.cache.get(id, key);
    const got = r instanceof Promise ? await settleWhile(r) : r;
    check(id, key, got);
    trace(`  get -> ${JSON.stringify(got?.value)}`);
    if (got) wrote(t, id, key);
    return got;
  };
  /** Awaits a cache promise while the store keeps completing operations (a read may wait on them). */
  const settleWhile = async <T,>(p: Promise<T>): Promise<T> => {
    let done = false;
    let out: T;
    void p.then((x) => ((done = true), (out = x)));
    for (let guard = 0; !done; guard++) {
      if (guard > 10_000) fail("a read never settles");
      await s.step(1);
    }
    return out!;
  };
  /** Sync store: right after a sign-out, nothing of whoever signed out is stored (removals never fail). */
  const erased = (id: string | undefined) => {
    if (cfg.async) return;
    for (const [k, v] of s.m) {
      if (!k.startsWith("ember:snap:")) continue;
      const h = JSON.parse(v.slice(0, v.indexOf("\n"))) as unknown[];
      if (id === undefined || h[1] === id) fail(`after clear(${JSON.stringify(id)}), ${k} still holds ${v}`);
    }
    if (cfg.failRate) return;
    const ix = JSON.parse(s.m.get("ember:snapshots:v2") ?? '{"n":[]}') as { n: unknown[][] };
    if (ix.n.some((r) => id === undefined || r[0] === id)) fail(`after clear(${JSON.stringify(id)}), the index lists ${JSON.stringify(ix.n)}`);
  };

  const ops = 160;
  const origSet = s.store.setItem.bind(s.store);
  const origRemove = s.store.removeItem!.bind(s.store);
  s.store.setItem = (k, v) => (trace("  set", k, v.slice(0, 160)), origSet(k, v));
  s.store.removeItem = (k) => (trace("  remove", k), origRemove(k));
  for (time = 0; time < ops; time++) {
    const t = pick(tabs);
    const id = pick(IDS);
    // mostly a key of this tab's own, sometimes one every tab uses
    const key = rand() < 0.75 ? KEYS[(t.id + Math.floor(rand() * 2)) % KEYS.length]! : pick(KEYS);
    const x = rand();
    trace(`tab ${t.id}`, x < 0.3 ? "set" : x < 0.4 ? "confirm" : x < 0.6 ? "get" : x < 0.65 ? "delete" : x < 0.69 ? "clear" : x < 0.76 ? "flush" : x < 0.86 ? "time" : x < 0.95 ? "step" : x < 0.98 ? "drain" : "close", JSON.stringify(id), key);
    if (x < 0.3) {
      const value: Val = [id, key, ++nonce];
      const v = ++version;
      versions.set(nonce, { min: v, max: v });
      t.cache.set(id, key, { value, version: v, epoch: E, ik: IK, at: clock });
      t.held.set(q(id, key), { value, version: v, at: clock, time });
      wrote(t, id, key);
    } else if (x < 0.4) {
      // the shard confirmed the value this tab holds at a newer version (touch, or set with that very object)
      const h = t.held.get(q(id, key));
      if (h) {
        const v = ++version;
        const r = versions.get(h.value[2])!;
        const entry = { value: h.value, version: v, epoch: E, ik: IK, at: clock };
        if (rand() < 0.5) t.cache.touch!(id, key, entry);
        else t.cache.set(id, key, entry);
        r.max = v;
      }
    } else if (x < 0.6) {
      await get(t, id, key);
    } else if (x < 0.65) {
      t.cache.delete(id, key);
      kill(id, key);
      wrote(t, id, key);
    } else if (x < 0.69) {
      const who = rand() < 0.5 ? undefined : id;
      trace("  clear of", JSON.stringify(who));
      t.cache.clear(who);
      kill(who);
      if (!cfg.async) for (const [k, w] of writers) if (who === undefined || k.startsWith(`${who}\u0001`)) w.delete(t.id);
      if (cfg.async) openClears.push(who);
      else erased(who);
    } else if (x < 0.76) {
      t.cache.flush!();
    } else if (x < 0.86) {
      const d = Math.floor(rand() * 700);
      clock += d;
      vi.advanceTimersByTime(d);
      await spin();
    } else if (x < 0.95) {
      await s.step(1 + Math.floor(rand() * 4));
    } else if (x < 0.98) {
      // everything lands; a sign-out still running is done
      await s.drain();
      for (const who of openClears.splice(0)) kill(who);
    } else {
      // the tab closes (flushing, as the client does on page hide, with its retries) and another opens
      const fr = s.ctl.failRate;
      s.ctl.failRate = 0;
      t.cache.flush!();
      await s.drain();
      for (let i = 0; i < 3; i++) {
        clock += 31_000;
        vi.advanceTimersByTime(31_000);
        await s.drain();
      }
      s.ctl.failRate = fr;
      for (const who of openClears.splice(0)) kill(who);
      for (const [k, h] of [...t.held]) {
        const [i, kk] = k.split("\u0001") as [string, string];
        if ((await get(t, i, kk))?.value !== h.value) t.held.delete(k); // dropped there (a refused write)
      }
      t.dead = true;
      t.closedAt = time;
      gone.push(t);
      tabs[tabs.indexOf(t)] = open();
    }
  }

  // Settle: no more refusals; every tab flushes; retries (backed off up to 30 s) run.
  s.ctl.failRate = 0;
  for (let i = 0; i < 4; i++) {
    for (const t of tabs) t.cache.flush!();
    await s.drain();
    clock += 31_000;
    vi.advanceTimersByTime(31_000);
    await s.drain();
  }
  for (const who of openClears.splice(0)) kill(who);

  // What each tab still holds is what it says it holds (no refusals: nothing dropped).
  for (const t of tabs) {
    for (const [k, h] of t.held) {
      const [id, key] = k.split("\u0001") as [string, string];
      const got = await get(t, id, key);
      if (!cfg.failRate && (got?.value as Val | undefined)?.[2] !== h.value[2]) fail(`tab ${t.id} lost ${JSON.stringify(h.value)}: ${JSON.stringify(got?.value)}`);
    }
  }
  if (!cfg.durable) return;
  const fresh = open();
  for (const t of [...tabs, ...gone]) {
    for (const [k, h] of t.held) {
      // another tab that may have written it since: last writer wins
      const byTab = new Map([...tabs, ...gone].map((x) => [x.id, x]));
      if ([...(writers.get(k) ?? [])].some((w) => w !== t.id && (byTab.get(w)?.closedAt ?? Infinity) >= h.time)) continue;
      if ((killed.get(k) ?? -1) >= h.time) continue;
      const [id, key] = k.split("\u0001") as [string, string];
      // only what the tab still has (a refused write drops it there too)
      if (!t.dead && (await get(t, id, key))?.value !== h.value) continue;
      const got = await get(fresh, id, key);
      if ((got?.value as Val | undefined)?.[2] !== h.value[2]) fail(`a new instance does not find ${JSON.stringify(h.value)} (tab ${t.id}): ${JSON.stringify(got?.value)}`);
    }
  }
}

describe("snapshot cache: several instances over one store, against a model", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const configs: Array<[string, Config, number]> = [
    ["sync, 3 tabs", { async: false, tabs: 3, failRate: 0, durable: true }, 300],
    ["sync, 3 tabs, refused writes", { async: false, tabs: 3, failRate: 0.1, durable: false }, 200],
    ["async, 1 tab at a time, refused writes", { async: true, tabs: 1, failRate: 0.1, durable: true }, 200],
    ["async, 3 tabs, refused writes", { async: true, tabs: 3, failRate: 0.1, durable: false }, 200],
  ];
  for (const [name, cfg, seeds] of configs) {
    it(name, async () => {
      const n = Number(process.env.MODEL_SEEDS) || seeds;
      for (let seed = 1; seed <= n; seed++) await run(seed, cfg);
    });
  }
});
