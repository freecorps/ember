// The snapshot cache against a reference model (PR 3B-1b): one to three instances (tabs) over one shared store — sync
// (localStorage) or async with operations completing in a random order — electing one writer with (fake) Web Locks
// and talking over a (fake) BroadcastChannel whose messages arrive late and interleaved; random set / touch / get /
// delete / sign-out / flush / time / delivery interleavings, some writes refused, and tabs that close (the writer
// hands over mid-run) or crash (their writes on the way never land, their messages not yet delivered are lost; a writer
// can so stop between a value and its index). Also: observers (`onWriterChange`) that throw; a format 1 blob holding
// several identities, whose read can fail; a tab that signs out then queues a burst of deletes (more than any bound on
// what it keeps unacknowledged) before any reaches a writer, which may crash meanwhile; a sign-out followed by a `set`
// for that identity in the very same instant. Seeded: a failure prints its seed.
//
// Checked, always: a value is only ever returned under the identity and key it was stored for, with a version it was
// given (its own, or exactly one a touch confirmed for that very value), and its epoch and tag. Right after a sign-out
// by the writer over a sync store, no key or index row holds a value of whoever signed out; right after a delete, no
// key holds the deleted value (its index row goes with the next flush). Once everything settled, no stored key or
// index row holds a value deleted or signed out anywhere (stored before that delete or sign-out), unless every tab
// that knew of it was gone before a writer applied it. With no refusals: every tab still holds what it stored (or a
// newer version), and a new instance finds every value a writer held when it closed or holds now (or a newer one),
// unless deleted or signed out since. Never two writers at once. Once settled, a new instance finds nothing deleted or
// signed out (from either format) and, with no refusals, every format 1 value not deleted since and every value the
// store held when a tab crashed (or a newer version), unless deleted or signed out since.
//
// MODEL_SEEDS=n runs n seeds per case (8 000 pass; the default keeps the suite fast); MODEL_ONLY=<seed> runs that seed
// only, MODEL_TRACE=<seed> logs it (MODEL_TRACE_LEN=n: n characters of each write).
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
          // (reads of format 1 fail more often: a writer that could not read it must still never bring back what was deleted)
          getItem: (k) => new Promise<string | null>((res, rej) => queue.push({ tab, run: () => (rand() < (k === "ember:snapshots" ? ctl.failRate * 3 : ctl.failRate / 4) ? rej(new Error("io")) : res(m.get(k) ?? null)), fail: () => rej(new Error("gone")) })),
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
/** Keys only format 1 holds (no tab sets them). */
const LEGACY_ONLY = ["f", "g"];
const E = "E";
const IK = "t";

/** A stored value: who it is for and which `set` made it. */
type Val = [identity: string, key: string, nonce: number];
type Held = { value: Val; version: number; at: number };
type Kill = { who: string | undefined; key: string | undefined; at: number; id?: string; lost?: boolean };
/** A value a new instance must find (or a newer version), unless deleted or signed out after `at`. */
type Kept = { id: string; key: string; version: number; at: number; why: string };
const namesQ = (k: Kill, id: string, key: string) => (k.who === undefined || k.who === id) && (k.key === undefined || k.key === key);

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
  /** Format 1, left by an older client: values for several identities, some under keys no tab sets. */
  const legacy: Kept[] = [];
  if (rand() < 0.5) {
    const by: Record<string, Record<string, unknown>> = {};
    for (const id of IDS) {
      for (const key of [...KEYS, ...LEGACY_ONLY]) {
        if (rand() < 0.5) continue;
        const value: Val = [id, key, ++nonce];
        const v = ++version;
        versions.set(nonce, new Set([v]));
        const at = clock - 5_000 + legacy.length;
        (by[id] ??= {})[key] = { v: JSON.stringify(value), version: v, epoch: E, ik: IK, at };
        legacy.push({ id, key, version: v, at, why: "format 1" });
      }
    }
    s.m.set("ember:snapshots", JSON.stringify({ v: 1, by }));
  }
  /**
   * What the store held when a tab crashed: what a reader would find there (index row, then its key's header). Kept
   * unless deleted or signed out after what the index row says (a new writer applies one to the rows, without reading
   * every key: a key rewritten after its row may go with it, never come back after it).
   */
  const persisted: Kept[] = [];
  const readable = (why: string) => {
    const ix = JSON.parse(s.m.get("ember:snapshots:v2") ?? '{"n":[]}') as { n: unknown[][] };
    for (const r of ix.n) {
      const raw = s.m.get(`ember:snap:${r[2] as number}`);
      if (!raw) continue;
      const h = JSON.parse(raw.slice(0, raw.indexOf("\n"))) as unknown[];
      if (h[1] !== r[0] || h[2] !== r[1]) continue;
      const v = h[7] === r[8] && h[4] === r[4] && h[5] === r[5] ? Math.max(h[3] as number, r[3] as number) : (h[3] as number);
      persisted.push({ id: h[1] as string, key: h[2] as string, version: v, at: Math.min(h[6] as number, r[6] as number), why });
    }
  };

  interface Tab {
    id: number;
    cache: SnapshotCache;
    end: ReturnType<typeof hub.open>;
    dead: boolean;
    writer: boolean;
    /** Its `onWriterChange` throws (after noting the change). */
    throws: boolean;
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
    const t: Tab = { id, cache: null!, end: null!, dead: false, writer: false, throws: rand() < 0.3, held: new Map() };
    const none = () => (cfg.async ? Promise.resolve() : undefined);
    const store: KeyValueStore = {
      getItem: (k) => (t.dead ? (cfg.async ? Promise.resolve(null) : null) : base.getItem(k)),
      setItem: (k, v) => (t.dead ? none() : (trace(`    tab ${id} store set ${k} ${v.slice(0, Number(process.env.MODEL_TRACE_LEN) || 120)}`), base.setItem(k, v))),
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
    const onWriterChange = (w: boolean) => {
      t.writer = w;
      if (t.throws) throw new Error(`observer of tab ${id}`);
    };
    t.cache = keyValueSnapshotCache(store, { now, maxBytes: 1 << 30, tabs: { locks, channel: end }, onWriterChange });
    // Deliveries: the receiver knows of the kill from then on.
    const inner = end.onmessage;
    end.onmessage = (e) => {
      const x = e.data as { k: string; id?: string };
      if (x.k === "kill") knowers.get(x.id!)?.tabs.add(id);
      trace(`    tab ${id} gets ${JSON.stringify(e.data)}`);
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
    const r: { done?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
    p.then(
      (value) => (r.done = { ok: true, value }),
      (error: unknown) => (r.done = { ok: false, error }),
    );
    for (let guard = 0; !r.done; guard++) {
      if (guard > 20_000) fail("never settles");
      await s.step(1);
      hub.deliver(1, rand);
      await spin();
    }
    if (!r.done.ok) fail(`rejected: ${r.done.error instanceof Error ? r.done.error.stack : String(r.done.error)}`);
    return (r.done as { value: T }).value;
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
  /**
   * Nothing stored up to `k.at` that `k` names (slots; and the index and format 1 unless `rowsToo` is false). (A `set`
   * right after a sign-out, in the same instant, is stored as after it.)
   */
  const erased = (k: Kill, rowsToo: boolean) => {
    const names = (identity: unknown, key: unknown) => (k.who === undefined || identity === k.who) && (k.key === undefined || key === k.key);
    const { slots, rows } = stored();
    for (const { k: sk, h } of slots) if (names(h[1], h[2]) && (h[6] as number) <= k.at) fail(`after ${JSON.stringify(k)}, ${sk} still holds ${JSON.stringify(h)}`);
    if (!rowsToo) return;
    for (const r of rows) if (names(r[0], r[1]) && (r[6] as number) <= k.at) fail(`after ${JSON.stringify(k)}, the index lists ${JSON.stringify(r)}`);
    const blob = s.m.get("ember:snapshots");
    const by = blob ? (JSON.parse(blob) as { by: Record<string, Record<string, { at: number }>> }).by : {};
    for (const [id, m] of Object.entries(by)) for (const [key, x] of Object.entries(m)) if (names(id, key) && x.at <= k.at) fail(`after ${JSON.stringify(k)}, format 1 still holds ${JSON.stringify([id, key, x])}`);
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

  /** A tab stores a value (the shard sent it). */
  const store1 = (t: Tab, id: string, key: string) => {
    const value: Val = [id, key, ++nonce];
    const v = ++version;
    versions.set(nonce, new Set([v]));
    trace(`tab ${t.id}${t.writer ? "*" : ""} set ${JSON.stringify(value)} v${v}`);
    t.cache.set(id, key, { value, version: v, epoch: E, ik: IK, at: clock });
    t.held.set(q(id, key), { value, version: v, at: clock });
  };
  /** A tab deletes (`key`) or signs out (`key` undefined; `who` undefined: everyone). */
  const kill1 = (t: Tab, who: string | undefined, key: string | undefined) => {
    const k: Kill = { who, key, at: clock };
    trace(`tab ${t.id}${t.writer ? "*" : ""} ${key !== undefined ? "delete" : "clear"} ${JSON.stringify(who)} ${key ?? ""}`);
    making = k;
    if (key !== undefined) t.cache.delete(who!, key);
    else t.cache.clear(who);
    making = null;
    if (!k.id) fail("a delete / sign-out posted nothing");
    kills.push(k);
    kill(who, key, k.at);
    return k;
  };
  /** A tab goes: it closes (a writer hands over), or crashes. */
  const leave = async (t: Tab, crash: boolean) => {
    trace(`tab ${t.id}${t.writer ? "*" : ""} ${crash ? "crashes" : "closes"}`);
    if (crash) {
      // it sends nothing more (what it posted that did not arrive yet is lost too), and what it had on the way to the
      // store never lands
      t.dead = true;
      hub.dropFrom(t.end);
      t.end.close!();
      s.crash(t.id);
      readable(`stored when tab ${t.id} crashed (step ${time})`);
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
  };

  const ops = 160;
  for (time = 0; time < ops; time++) {
    clock += 1; // every operation at its own instant
    await spin();
    const writers = [...tabs, ...gone].filter((x) => x.writer && !x.dead);
    if (writers.length > 1) fail(`two writers: tabs ${writers.map((x) => x.id).join(", ")}`);
    const t = pick(tabs);
    const id = pick(IDS);
    const key = rand() < 0.75 ? KEYS[(t.id + Math.floor(rand() * 2)) % KEYS.length]! : pick(KEYS);
    const x = rand();
    if (x < 0.28) {
      store1(t, id, key);
    } else if (x < 0.36) {
      // the shard confirmed the value this tab holds at a newer version (touch, or set with that very object)
      const h = t.held.get(q(id, key));
      if (h) {
        const v = ++version;
        versions.get(h.value[2])!.add(v);
        const entry = { value: h.value, version: v, epoch: E, ik: IK, at: clock };
        trace(`tab ${t.id} confirm ${JSON.stringify(h.value)} v${v}`);
        if (rand() < 0.5) t.cache.touch!(id, key, entry);
        else {
          // a set stores it at that version (only the version moves when the cache holds that very object); a touch
          // may be ignored (the cache holds another value now)
          t.cache.set(id, key, entry);
          h.version = v;
        }
      }
    } else if (x < 0.54) {
      await get(t, id, key);
    } else if (x < 0.59) {
      const k = kill1(t, id, key);
      // a delete removes its value's key at once (the index follows)
      if (t.writer && !cfg.async && !cfg.failRate) erased(k, false);
    } else if (x < 0.63) {
      const who = rand() < 0.5 ? undefined : id;
      const k = kill1(t, who, undefined);
      // a sign-out is written through with the index
      if (t.writer && !cfg.async && !cfg.failRate) erased(k, true);
      const y = rand();
      if (y < 0.15) {
        // in the very same instant, right after it, this tab stores a value for whoever signed out: it stays
        store1(t, who ?? id, key);
      } else if (y < 0.3) {
        // then, a moment later (so the sign-out does not cover them), a burst of deletes before any of it reaches a
        // writer (more than a tab could keep if it kept the latest ones only), and the writer may crash meanwhile
        clock += 1;
        for (let i = 0; i < 70; i++) kill1(t, id, `z${i}`);
        const w = tabs.find((o) => o.writer && o !== t);
        if (w && rand() < 0.5) await leave(w, true);
      }
    } else if (x < 0.69) {
      t.cache.flush!();
    } else if (x < 0.77) {
      await advance(Math.floor(rand() * 700));
    } else if (x < 0.86) {
      hub.deliver(1 + Math.floor(rand() * 4), rand);
      await spin();
    } else if (x < 0.93) {
      await s.step(1 + Math.floor(rand() * 4));
    } else if (x < 0.955) {
      await drainAll();
    } else if (x < 0.96) {
      // the writer crashes in the middle of a flush (a value key written, its index not yet)
      const w = tabs.find((o) => o.writer);
      if (w) {
        w.cache.flush!();
        await s.step(Math.floor(rand() * 4));
        await leave(w, true);
      }
    } else {
      await leave(t, x >= 0.985);
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

  // A new instance (a reader: a writer holds the lock) finds nothing deleted or signed out, in either format.
  const fresh = keyValueSnapshotCache(s.store(-1), { now, tabs: { locks, channel: hub.open() } });
  const freshGet = async (id: string, key: string) => {
    const r = fresh.get(id, key);
    const got = r instanceof Promise ? await settleWhile(r) : r;
    check(id, key, got);
    return got;
  };
  for (const id of IDS) {
    for (const key of [...KEYS, ...LEGACY_ONLY]) {
      const got = await freshGet(id, key);
      const k = got && kills.find((k) => !k.lost && namesQ(k, id, key) && got.at <= k.at);
      if (k) fail(`a new instance finds ${JSON.stringify(got.value)} (stored at ${got.at}) after ${JSON.stringify(k)}`);
    }
  }

  if (cfg.failRate) return;
  // What each tab still holds is what it says it holds (or a newer version).
  for (const t of tabs) {
    for (const [k, h] of t.held) {
      const [id, key] = k.split("\u0001") as [string, string];
      const got = await get(t, id, key);
      if (!got || got.version < h.version) fail(`tab ${t.id} lost ${JSON.stringify(h.value)} v${h.version}: ${JSON.stringify(got?.value)} v${got?.version}`);
    }
  }
  /** Deleted or signed out since `at`. */
  const since = (id: string, key: string, at: number) => kills.some((k) => namesQ(k, id, key) && k.at >= at);
  // The new instance finds what writers held, what the store held when a tab crashed, and format 1's values.
  const kept: Kept[] = [...persisted, ...legacy];
  for (const t of [...tabs.filter((x) => x.writer), ...gone.filter((x) => x.closedAsWriter)]) {
    for (const [k, h] of t.held) {
      const [id, key] = k.split("\u0001") as [string, string];
      kept.push({ id, key, version: h.version, at: h.at, why: `held by tab ${t.id}` });
    }
  }
  for (const p of kept) {
    // (what a tab holds is no longer in `held` once deleted or signed out)
    if (!p.why.startsWith("held") && since(p.id, p.key, p.at)) continue;
    const got = await freshGet(p.id, p.key);
    if (!got || got.version < p.version) fail(`a new instance does not find ${JSON.stringify([p.id, p.key])} v${p.version} (${p.why}): ${JSON.stringify(got?.value)} v${got?.version}`);
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
      const only = Number(process.env.MODEL_ONLY);
      for (let seed = only || 1; seed <= (only || n); seed++) await run(seed, cfg);
    }, 600_000);
  }
});
