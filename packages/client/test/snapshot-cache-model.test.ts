// The snapshot cache against a reference model (PR 3B-1b): one to three instances (tabs) over one shared store — sync
// (localStorage) or async with operations completing in a random order — electing one writer with (fake) Web Locks
// and talking over a (fake) BroadcastChannel whose messages arrive late and interleaved; random set / touch / get /
// delete / sign-out / flush / time / delivery interleavings, some writes refused, and tabs that close (the writer
// hands over mid-run) or crash (their writes on the way never land, their messages in flight are lost). Seeded: a
// failure prints its seed.
//
// Checked, always: a value is only ever returned under the identity and key it was stored for, with a version it was
// given (its own, or exactly one a touch confirmed for that very value), and its epoch and tag. Right after a sign-out
// by the writer over a sync store, no key holds a value of whoever signed out; once everything settled, no stored key
// or index row holds a value deleted or signed out anywhere (stored before that delete or sign-out), unless every tab
// that knew of it was gone before a writer applied it. With no refusals: every tab still holds what it stored (or a
// newer version), and a new instance finds every value a writer held when it closed or holds now (or a newer one),
// unless deleted or signed out since.
//
// MODEL_SEEDS=n runs n seeds per case (5 000 pass; the default keeps the suite fast); MODEL_TRACE=<seed> logs a run.
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { keyValueSnapshotCache, type CachedSnapshot, type SnapshotCache } from "../src/index.ts";
import type { KeyValueStore } from "../src/storage.ts";
import { channelHub, fakeLocks } from "./snapshot-tabs.ts";

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
  type Op = { tab: number; run: () => void; fail: () => void };
  const queue: Op[] = [];
  const ctl = { failRate: 0 };
  const store = (tab: number): KeyValueStore =>
    async
      ? {
          getItem: (k) => new Promise<string | null>((res, rej) => queue.push({ tab, run: () => (rand() < ctl.failRate / 4 ? rej(new Error("io")) : res(m.get(k) ?? null)), fail: () => rej(new Error("gone")) })),
          setItem: (k, v) => new Promise<void>((res, rej) => queue.push({ tab, run: () => (rand() < ctl.failRate ? rej(new Error("full")) : (m.set(k, v), res())), fail: () => rej(new Error("gone")) })),
          removeItem: (k) => new Promise<void>((res, rej) => queue.push({ tab, run: () => (m.delete(k), res()), fail: () => rej(new Error("gone")) })),
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
      queue.splice(Math.floor(rand() * queue.length), 1)[0]!.run();
      await spin();
    }
    await spin();
  };
  /** A crashed tab: what it had on the way never lands. */
  const crash = (tab: number) => {
    for (const op of queue.filter((o) => o.tab === tab)) {
      queue.splice(queue.indexOf(op), 1);
      op.fail();
    }
  };
  return { m, store, ctl, step, crash, waiting: () => queue.length };
}

interface Config {
  async: boolean;
  tabs: number;
  failRate: number;
}

const IDS = ["anon", "u\u0000i\u0000ana", "u\u0000i\u0000bob"];
const KEYS = ["a", "b", "c", "d", "e"];
const E = "E";
const IK = "t";

/** A stored value: who it is for and which `set` made it. */
type Val = [identity: string, key: string, nonce: number];
type Held = { value: Val; version: number; at: number };
type Kill = { who: string | undefined; key: string | undefined; at: number; id?: string; lost?: boolean };

async function run(seed: number, cfg: Config): Promise<void> {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const s = sharedStore(rand, cfg.async);
  s.ctl.failRate = cfg.failRate;
  const locks = fakeLocks();
  const hub = channelHub({ manual: true });
  let clock = 1_700_000_000_000;
  const now = () => clock;
  let version = 0;
  let nonce = 0;
  let time = 0;
  /** The versions each value was given: its own, and each one a touch (or a set of that very object) confirmed. */
  const versions = new Map<number, Set<number>>();
  const trace = process.env.MODEL_TRACE === `${seed}` ? (...a: unknown[]) => console.log(time, ...a) : () => {};
  const fail = (what: string): never => {
    throw new Error(`seed ${seed} (${JSON.stringify(cfg)}), step ${time}: ${what}`);
  };

  interface Tab {
    id: number;
    cache: SnapshotCache;
    end: { close?(): void };
    dead: boolean;
    writer: boolean;
    /** It was the writer when it closed (it wrote what it held, then handed over). */
    closedAsWriter?: boolean;
    /** What this instance stored and should still hold. */
    held: Map<string, Held>;
  }
  const q = (id: string, key: string) => `${id}\u0001${key}`;
  let tabIds = 0;
  /** Which tabs know of each delete / sign-out (by its id): its maker and those it reached; `acked`: a writer applied it. */
  const knowers = new Map<string, { tabs: Set<number>; acked: boolean }>();
  const kills: Kill[] = [];
  const byEnd = new Map<unknown, Tab>();
  const all: Tab[] = [];
  const open = (): Tab => {
    const id = tabIds++;
    const base = s.store(id);
    const t: Tab = { id, cache: null!, end: null!, dead: false, writer: false, held: new Map() };
    const none = () => (cfg.async ? Promise.resolve() : undefined);
    const store: KeyValueStore = {
      getItem: (k) => (t.dead ? (cfg.async ? Promise.resolve(null) : null) : base.getItem(k)),
      setItem: (k, v) => (t.dead ? none() : (trace(`    tab ${id} store set ${k} ${v.slice(0, 120)}`), base.setItem(k, v))),
      removeItem: (k) => (t.dead ? none() : (trace(`    tab ${id} store remove ${k}`), base.removeItem!(k))),
    };
    const end = hub.open();
    t.end = end;
    // Watch the messages it posts: the delete / sign-out being made (its id is the cache's), what it makes known,
    // and acknowledgements (a writer stored it).
    const post = end.postMessage.bind(end);
    end.postMessage = (m) => {
      if (t.dead) return post(m); // throws: closed
      const x = m as { k: string; id?: string };
      if (x.k === "kill") {
        if (making && !knowers.has(x.id!)) {
          knowers.set(x.id!, { tabs: new Set(), acked: false });
          making.id = x.id!;
        }
        knowers.get(x.id!)?.tabs.add(id);
      }
      if (x.k === "ack" && knowers.has(x.id!)) knowers.get(x.id!)!.acked = true;
      trace(`    tab ${id} posts ${JSON.stringify(m)}`);
      post(m);
    };
    t.cache = keyValueSnapshotCache(store, { now, maxBytes: 1 << 30, tabs: { locks, channel: end }, onWriterChange: (w) => (t.writer = w) });
    // Deliveries: the receiver knows of the kill from then on.
    const inner = end.onmessage;
    end.onmessage = (e) => {
      const x = e.data as { k: string; id?: string };
      if (x.k === "kill") knowers.get(x.id!)?.tabs.add(id);
      inner?.(e);
    };
    byEnd.set(end, t);
    all.push(t);
    return t;
  };
  /** The delete / sign-out being made right now. */
  let making: Kill | null = null;
  const tabs: Tab[] = Array.from({ length: cfg.tabs }, open);
  const gone: Tab[] = [];

  /** Marks kills no live tab knows of and no writer applied: they may be lost. */
  const orphans = () => {
    for (const k of kills) {
      if (!k.id || k.lost) continue;
      const w = knowers.get(k.id)!;
      if (!w.acked && ![...w.tabs].some((id) => all.find((t) => t.id === id && !t.dead))) k.lost = true;
    }
  };

  const check = (id: string, key: string, got: CachedSnapshot | undefined) => {
    if (!got) return;
    const v = got.value as Val;
    if (!Array.isArray(v) || v[0] !== id || v[1] !== key) fail(`get(${JSON.stringify(id)}, ${key}) returned ${JSON.stringify(v)}`);
    const given = versions.get(v[2]);
    if (!given) fail(`unknown value ${JSON.stringify(v)}`);
    if (!given!.has(got.version)) fail(`${JSON.stringify(v)} at version ${got.version}, given only ${[...given!].join(", ")}`);
    if (got.epoch !== E || got.ik !== IK) fail(`${JSON.stringify(v)} with epoch/ik ${got.epoch}/${got.ik}`);
  };
  /** Awaits a cache promise while the store and the channel keep going (a read may wait on them). */
  const settleWhile = async <T,>(p: Promise<T>): Promise<T> => {
    let done = false;
    let out: T;
    void p.then((x) => ((done = true), (out = x)));
    for (let guard = 0; !done; guard++) {
      if (guard > 20_000) fail("never settles");
      await s.step(1);
      hub.deliver(1, rand);
      await spin();
    }
    return out!;
  };
  const get = async (t: Tab, id: string, key: string) => {
    const r = t.cache.get(id, key);
    const got = r instanceof Promise ? await settleWhile(r) : r;
    check(id, key, got);
    trace(`  tab ${t.id} get -> ${JSON.stringify(got?.value)} v${got?.version}`);
    return got;
  };
  const kill = (who: string | undefined, key: string | undefined, at: number) => {
    for (const t of all) {
      for (const [k, h] of [...t.held]) {
        const [i, kk] = k.split("\u0001") as [string, string];
        if ((who === undefined || i === who) && (key === undefined || kk === key) && h.at <= at) t.held.delete(k);
      }
    }
  };
  /** What the store holds: every value key's header, and the index rows. */
  const stored = () => {
    const slots: Array<{ k: string; h: unknown[] }> = [];
    for (const [k, v] of s.m) {
      if (!k.startsWith("ember:snap:") || !v) continue;
      slots.push({ k, h: JSON.parse(v.slice(0, v.indexOf("\n"))) as unknown[] });
    }
    const ix = JSON.parse(s.m.get("ember:snapshots:v2") ?? '{"n":[]}') as { n: unknown[][] };
    return { slots, rows: ix.n };
  };
  /** Nothing stored up to `k.at` that `k` names (slots; and the index unless `rowsToo` is false). */
  const erased = (k: Kill, rowsToo: boolean) => {
    const names = (identity: unknown, key: unknown) => (k.who === undefined || identity === k.who) && (k.key === undefined || key === k.key);
    const { slots, rows } = stored();
    for (const { k: sk, h } of slots) if (names(h[1], h[2]) && (h[6] as number) <= k.at) fail(`after ${JSON.stringify(k)}, ${sk} still holds ${JSON.stringify(h)}`);
    if (rowsToo) for (const r of rows) if (names(r[0], r[1]) && (r[6] as number) <= k.at) fail(`after ${JSON.stringify(k)}, the index lists ${JSON.stringify(r)}`);
  };
  const drainAll = async () => {
    for (let guard = 0; ; guard++) {
      await spin();
      if (!s.waiting() && !hub.waiting()) {
        await spin();
        if (!s.waiting() && !hub.waiting()) return;
      }
      if (guard > 20_000) fail("the store never settles");
      await s.step(s.waiting());
      hub.deliver(hub.waiting(), rand);
    }
  };
  const advance = async (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
    await spin();
  };

  const ops = 160;
  for (time = 0; time < ops; time++) {
    clock += 1; // every operation at its own instant
    await spin();
    const t = pick(tabs);
    const id = pick(IDS);
    const key = rand() < 0.75 ? KEYS[(t.id + Math.floor(rand() * 2)) % KEYS.length]! : pick(KEYS);
    const x = rand();
    if (x < 0.28) {
      const value: Val = [id, key, ++nonce];
      const v = ++version;
      versions.set(nonce, new Set([v]));
      trace(`tab ${t.id}${t.writer ? "*" : ""} set ${JSON.stringify(value)} v${v}`);
      t.cache.set(id, key, { value, version: v, epoch: E, ik: IK, at: clock });
      t.held.set(q(id, key), { value, version: v, at: clock });
    } else if (x < 0.36) {
      // the shard confirmed the value this tab holds at a newer version (touch, or set with that very object)
      const h = t.held.get(q(id, key));
      if (h) {
        const v = ++version;
        versions.get(h.value[2])!.add(v);
        const entry = { value: h.value, version: v, epoch: E, ik: IK, at: clock };
        trace(`tab ${t.id} confirm ${JSON.stringify(h.value)} v${v}`);
        if (rand() < 0.5) t.cache.touch!(id, key, entry);
        else t.cache.set(id, key, entry);
      }
    } else if (x < 0.54) {
      await get(t, id, key);
    } else if (x < 0.59 || x < 0.63) {
      const isDelete = x < 0.59;
      const who = isDelete ? id : rand() < 0.5 ? undefined : id;
      const k: Kill = { who, key: isDelete ? key : undefined, at: clock };
      trace(`tab ${t.id}${t.writer ? "*" : ""} ${isDelete ? "delete" : "clear"} ${JSON.stringify(who)} ${isDelete ? key : ""}`);
      making = k;
      if (isDelete) t.cache.delete(id, key);
      else t.cache.clear(who);
      making = null;
      if (!k.id) fail("a delete / sign-out posted nothing");
      kills.push(k);
      kill(who, k.key, k.at);
      if (t.writer && !cfg.async && !cfg.failRate) erased(k, true);
    } else if (x < 0.69) {
      t.cache.flush!();
    } else if (x < 0.77) {
      await advance(Math.floor(rand() * 700));
    } else if (x < 0.86) {
      hub.deliver(1 + Math.floor(rand() * 4), rand);
      await spin();
    } else if (x < 0.93) {
      await s.step(1 + Math.floor(rand() * 4));
    } else if (x < 0.96) {
      await drainAll();
    } else {
      const crash = x >= 0.985;
      trace(`tab ${t.id}${t.writer ? "*" : ""} ${crash ? "crashes" : "closes"}`);
      if (crash) {
        // it sends nothing more, and what it had on the way to the store never lands
        t.dead = true;
        t.end.close!();
        s.crash(t.id);
        await settleWhile(t.cache.close!());
        t.held.clear();
      } else {
        // the page hides (flush, as the client does) and goes; a writer hands the store to the next tab
        t.cache.flush!();
        const was = t.writer;
        await settleWhile(t.cache.close!());
        t.dead = true;
        // what a reader held was in its memory only
        if (was && !cfg.failRate) t.closedAsWriter = true;
        else t.held.clear();
      }
      orphans();
      gone.push(t);
      tabs[tabs.indexOf(t)] = open();
    }
  }

  // Settle: no more refusals; every message arrives; every tab flushes; retries (backed off up to 30 s) run.
  s.ctl.failRate = 0;
  for (let i = 0; i < 4; i++) {
    await drainAll();
    for (const t of tabs) t.cache.flush!();
    await drainAll();
    await advance(31_000);
    await drainAll();
  }
  orphans();
  if (!tabs.some((t) => t.writer)) fail("no writer after settling");

  // Deleted and signed out: nothing of it stored (unless every tab that knew of it went before a writer applied it).
  for (const k of kills) if (!k.lost) erased(k, true);

  if (cfg.failRate) return;
  // What each tab still holds is what it says it holds (or a newer version).
  for (const t of tabs) {
    for (const [k, h] of t.held) {
      const [id, key] = k.split("\u0001") as [string, string];
      const got = await get(t, id, key);
      if (!got || got.version < h.version) fail(`tab ${t.id} lost ${JSON.stringify(h.value)} v${h.version}: ${JSON.stringify(got?.value)} v${got?.version}`);
    }
  }
  // A new instance (a reader: a writer holds the lock) finds what writers held.
  const fresh = keyValueSnapshotCache(s.store(-1), { now, tabs: { locks, channel: hub.open() } });
  for (const t of [...tabs.filter((x) => x.writer), ...gone.filter((x) => x.closedAsWriter)]) {
    for (const [k, h] of t.held) {
      const [id, key] = k.split("\u0001") as [string, string];
      const r = fresh.get(id, key);
      const got = r instanceof Promise ? await settleWhile(r) : r;
      check(id, key, got);
      if (!got || got.version < h.version) fail(`a new instance does not find ${JSON.stringify(h.value)} v${h.version} (tab ${t.id}): ${JSON.stringify(got?.value)} v${got?.version}`);
    }
  }
}

describe("snapshot cache: several tabs, one writer, against a model", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const configs: Array<[string, Config, number]> = [
    ["sync, 3 tabs", { async: false, tabs: 3, failRate: 0 }, 400],
    ["sync, 3 tabs, refused writes", { async: false, tabs: 3, failRate: 0.1 }, 400],
    ["async, 1 tab at a time, refused writes", { async: true, tabs: 1, failRate: 0.1 }, 400],
    ["async, 3 tabs", { async: true, tabs: 3, failRate: 0 }, 400],
    ["async, 3 tabs, refused writes", { async: true, tabs: 3, failRate: 0.1 }, 400],
  ];
  for (const [name, cfg, seeds] of configs) {
    it(name, async () => {
      const n = Number(process.env.MODEL_SEEDS) || seeds;
      for (let seed = 1; seed <= n; seed++) await run(seed, cfg);
    }, 600_000);
  }
});
