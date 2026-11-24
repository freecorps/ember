// A light snapshot cache for the client (no offline engine): the last confirmed value of each subscription, so a
// repeat visit paints from it with no round trip (`source: "cache"`) and subscribes with `resume` (the shard answers
// `unchanged` when nothing it read changed). Kept per identity, bounded, never holds errors, cleared on sign-out.
//
// Storage layout (key-value store, format 2): one key per stored query, and a small index.
//
//   <prefix>:snapshots:v2   {"v":2,"t":top,"n":[[identity, key, slot, version, epoch, ik, at, size, gen], ...],
//                            "k":[[at, identity | null, key | null], ...]}   (the latest deletes and sign-outs)
//   <prefix>:snap:<slot>    [2, identity, key, version, epoch, ik, at, gen] + "\n" + the value's JSON (tagged)
//
// A changed value rewrites its own key and the index; a version that moved without a new value (`touch`, on page hide)
// rewrites the index only. Each value key carries its own header: a key whose header does not name the (identity,
// key) asked for is a miss, never a value; the index's version counts only over the value generation `gen` it names
// (any other header stands for itself). Every slot key is below `t`, which is stored before a slot past it is written:
// a sign-out removes all of them, also writes no index ever listed (a stop between the value and the index). A slot the
// stored index lists is not reused for another query until an index without it is stored, so the index never names
// a key that holds another query.
//
// One writer. Only one instance per store writes it, whatever the number of tabs: the writer is elected with a Web Lock
// (`ember-snapshots:<prefix>`, held for the instance's life) and the others are readers. A reader reads the stored
// index and keys (checking each header) and keeps its own snapshots in memory; on a BroadcastChannel of the same name
// it sends only what must reach the store: deletes and sign-outs, and version moves of a value it read from the store
// (applied to that very generation only). When the writer goes (tab closed), the next instance in the lock's queue
// takes over: it reads the stored index, merges what it holds in memory (newer version wins), migrates format 1, and
// writes from then on. Without Web Locks or BroadcastChannel (React Native, Node, workers) or over `sessionStorage` an
// instance is its store's only user and writes from the start. So there is no read-modify-write between tabs: the
// index is never rewritten from a stale copy, and a slot is never picked by two tabs.
//
// Deletes and sign-outs (`kill`s). Every instance drops one from memory when it hears of it, and the writer removes it
// from the store at once (a sign-out with the index; a delete its value's key, the index following with the next
// flush, so a run of deletes rewrites it once) and acknowledges it once stored (index included). A tab that knows of one no writer acknowledged sends it again
// to each new writer; the index logs the latest ones (`k`), so a new writer drops what it held from before them even if
// it had not heard of them, and every tab keeps the ones it knows: a value read from the store that one covers is a
// miss. One that arrives from another tab drops the values stored up to the moment it was made (`at`), not later ones.
//
import { parse, stringify } from "./wire.ts";
import type { KeyValueStore } from "./storage.ts";

/** One stored value: the server's, with what `resume` needs. */
export interface CachedSnapshot {
  value: unknown;
  version: number;
  epoch: string;
  /** Identity tag the shard gave the value (feature "ident"): `resume.ik`. */
  ik: string;
  /** ms since epoch, when it was stored. */
  at: number;
}

/**
 * Where the client keeps its snapshots (`EmberClient` option `snapshotCache`). `identity` is the key of who the
 * value was computed for (`"anon"` signed out); a value stored under one identity is never read under another.
 */
export interface SnapshotCache {
  get(identity: string, key: string): CachedSnapshot | undefined | Promise<CachedSnapshot | undefined>;
  /** Store a value (the same `value` object again with a newer version: only the version moves). */
  set(identity: string, key: string, entry: CachedSnapshot): void;
  /**
   * Optional: the value stored for `key` is still current as of `entry.version` (the shard said so) — only when it is the
   * very `entry.value` object this cache holds, with the same epoch and tag; otherwise nothing happens. The client
   * calls it on page hide and close, so a reload resumes from a recent version (the shard's change log still covers
   * it). Never stores anything new.
   */
  touch?(identity: string, key: string, entry: CachedSnapshot): void;
  delete(identity: string, key: string): void;
  /** Forget one identity's snapshots, or every snapshot (written through at once: a sign-out leaves nothing). */
  clear(identity?: string): void;
  /** Write pending changes now (the client calls it on close and when the page is hidden). */
  flush?(): void;
  /**
   * Optional: stop (tests, teardown). A writer writes what is pending, then hands the store to the next instance. The
   * client never calls it: one cache may serve several clients of a page in turn.
   */
  close?(): Promise<void>;
}

/** The part of `navigator.locks` (Web Locks API) used here. */
export interface SnapshotLocks {
  request(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

/** The part of `BroadcastChannel` used here. */
export interface SnapshotChannel {
  postMessage(message: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close?(): void;
}

export interface SnapshotCacheOptions {
  /** Total size of the stored values (JSON characters). Least recently stored go first. Default 512 KiB. */
  maxBytes?: number;
  /** Older snapshots are not used (and are dropped). Default 7 days. */
  maxAgeMs?: number;
  /** Key prefix in the key-value store. Default `"ember"`. */
  prefix?: string;
  now?: () => number;
  /**
   * How the instances sharing the store (tabs) agree on the one that writes it. Default, in a page: `navigator.locks`
   * and `new BroadcastChannel("ember-snapshots:<prefix>")` when both exist and the store is not `sessionStorage` (two
   * different stores in one origin need different prefixes). `null`, the default elsewhere (React Native, Node,
   * workers) and without Web Locks: this instance is the store's only user and writes from the start.
   */
  tabs?: { locks: SnapshotLocks; channel: SnapshotChannel } | null;
  /** Called when this instance becomes the writer (`true`) and when it stops (`false`, on `close`). */
  onWriterChange?(writer: boolean): void;
}

/** In memory: survives client re-creation in one page (SPA navigation), not a reload. */
export function memorySnapshotCache(opts: SnapshotCacheOptions = {}): SnapshotCache {
  return new SplitCache(null, { ...opts, tabs: null });
}

/**
 * Over `localStorage`, `sessionStorage` or an AsyncStorage-like store (`getItem`/`setItem`, sync or async; `removeItem`
 * when it has one): one entry per query plus a small index, read lazily, written at most every 250 ms (only what
 * changed), by one tab at a time. With a synchronous store (localStorage) the first paint of a repeat visit needs no
 * round trip at all.
 */
export function keyValueSnapshotCache(kv: KeyValueStore, opts: SnapshotCacheOptions = {}): SnapshotCache {
  return new SplitCache(kv, opts);
}

/** A query in memory: stored (`slot`, `stored`), held (`value`), or both. */
interface Entry {
  identity: string;
  key: string;
  version: number;
  epoch: string;
  ik: string;
  at: number;
  /** Generation of the value (header and index row). */
  gen: string;
  /** JSON length of the value (-1: not known yet). */
  size: number;
  value: unknown;
  loaded: boolean;
  /** The value's JSON: format 1's (not parsed yet), or encoded for the next write. */
  json?: string | undefined;
  /** Writer: its key's number (-1: none yet). Reader: the slot it was read from. */
  slot: number;
  /** What the store holds for it (the row last written or read); the generation the key holds. */
  stored?: IndexRow | undefined;
  /** Writer: the value must be written. */
  dirty: boolean;
  /** When this instance got it (`set`): a delete or sign-out made earlier in another tab does not drop it. */
  born?: number | undefined;
}

type IndexRow = [identity: string, key: string, slot: number, version: number, epoch: string, ik: string, at: number, size: number, gen: string];
type Header = [2, identity: string, key: string, version: number, epoch: string, ik: string, at: number, gen: string];
type V1 = { v: 1; by: Record<string, Record<string, { v?: unknown; version?: unknown; epoch?: unknown; ik?: unknown; at?: unknown }>> };

/** A delete (`key`), a sign-out of one identity (`i`), or of all; made at `at`. */
type Kill = { id: string; i?: string | undefined; key?: string | undefined; at: number };
type Msg =
  | { ember: "snapshots/1"; k: "writer"; from: string }
  | ({ ember: "snapshots/1"; k: "kill"; from: string } & Kill)
  | { ember: "snapshots/1"; k: "ack"; id: string }
  | { ember: "snapshots/1"; k: "touch"; i: string; key: string; gen: string; version: number; epoch: string; ik: string };

const MAX_SLOTS = 65_536;
/**
 * How far ahead of this clock a stored `at` may be (another tab's clock, a clock moved back). A value further ahead is
 * a miss: counted as "now" it would start its age again at every load, and never expire.
 */
const FUTURE_SLACK = 60_000;
/** How far a stored `t` may reach past the highest slot its index lists (more is corrupt and clamped). */
const TOP_SLACK = 1024;
const isThenable = (x: unknown): x is Promise<unknown> => typeof (x as { then?: unknown } | null)?.then === "function";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isSlot = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < MAX_SLOTS;
const qid = (identity: string, key: string) => JSON.stringify([identity, key]);
const randomTag = () => Math.random().toString(36).slice(2, 10);
/** Newer: same epoch, higher version; another epoch, stored later. */
const newer = (a: { epoch: string; version: number; at: number }, b: { epoch: string; version: number; at: number }) =>
  a.epoch === b.epoch ? a.version > b.version : a.at > b.at;

/** `k` covers `e`: here (`local`) whatever it names; from elsewhere, what was stored up to its `at`. */
const names = (k: Kill, e: Entry, local: boolean) =>
  (k.i === undefined || e.identity === k.i) && (k.key === undefined || e.key === k.key) && (local || (e.born ?? e.at) <= k.at);

/**
 * Calls `f` (a store call), then `after(ok, result)` — synchronously when the store is. What `after` returns (a next
 * store call) is waited for too.
 */
function call(f: () => unknown, after: (ok: boolean, r?: unknown) => void | Promise<void>): void | Promise<void> {
  let r: unknown;
  try {
    r = f();
  } catch {
    return after(false);
  }
  if (isThenable(r)) return r.then((x) => after(true, x), () => after(false));
  return after(true, r);
}

/** Runs the steps in order; a step that returns a promise holds the next ones. `done` at the end. */
function sequence(steps: Array<() => void | Promise<void>>, done: () => void): void {
  let i = 0;
  const next = (): void => {
    while (i < steps.length) {
      const r = steps[i++]!();
      if (isThenable(r)) {
        void r.then(next, next);
        return;
      }
    }
    done();
  };
  next();
}

function defaultTabs(kv: KeyValueStore, name: string): SnapshotCacheOptions["tabs"] {
  const g = globalThis as { navigator?: { locks?: SnapshotLocks }; BroadcastChannel?: new (name: string) => SnapshotChannel; sessionStorage?: unknown; document?: unknown };
  // A page (tabs share its origin's stores); not Node, React Native or a worker.
  if (g.document === undefined) return null;
  try {
    if (g.sessionStorage !== undefined && kv === g.sessionStorage) return null;
  } catch {
    // sessionStorage that throws on access: not this store
  }
  const locks = g.navigator?.locks;
  if (!locks || typeof g.BroadcastChannel !== "function") return null;
  try {
    return { locks, channel: new g.BroadcastChannel(name) };
  } catch {
    return null;
  }
}

class SplitCache implements SnapshotCache {
  private readonly entries = new Map<string, Entry>();
  private role: "reader" | "loading" | "writer" | "closed";
  private readonly ixKey: string;
  private readonly v1Key: string;
  private readonly slotPrefix: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly me = randomTag();
  private gens = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 0;
  private timerDue = 0;
  // writer
  private ready = false;
  private loading: Promise<void> | null = null;
  /** `t` as stored: every slot key is below it. */
  private storedTop = 0;
  /** The index as stored (rows), for the index written before a slot past `t`. */
  private storedRows: IndexRow[] = [];
  /** Slots no entry uses that may still hold something. */
  private readonly garbage = new Set<number>();
  private indexDirty = false;
  private dropV1 = false;
  /** Format 1 as read, and the entries moved from it not stored yet (it is removed when none is left). */
  private v1: { raw: string; waiting: Set<Entry>; failed: boolean } | null = null;
  private flushing = false;
  private again = false;
  /** Waiting for the next flush to end (written or not), and for the store to hold everything (nothing refused). */
  private idle: Array<() => void> = [];
  private clean: Array<() => void> = [];
  private failed = false;
  /** Kills that came while the store was loading: applied to it once loaded. */
  private loadingKills: Kill[] = [];
  /**
   * The latest deletes and sign-outs applied to the store, kept in the index: the next writer applies them to what it
   * holds in memory before writing any of it, and readers to what they read (so a value one covers never comes back,
   * even from a tab that had not heard of it yet).
   */
  private killLog: Kill[] = [];
  // reader
  private ixCache: { raw: string; rows: Map<string, IndexRow>; kills: Kill[] } | null = null;
  private v1Cache: { raw: string; by: V1["by"] } | null = null;
  /**
   * Deletes and sign-outs this instance made or heard of that no writer acknowledged yet: sent again to every new
   * writer (so one is lost only if every tab that knew of it is gone before a writer applies it).
   */
  private readonly unacked = new Map<string, Kill>();
  /**
   * The latest deletes and sign-outs this instance made or heard of (applied or not): a value read from the store that
   * one of them covers (stored up to its `at`) is stale — a writer has not removed it yet — and is a miss.
   */
  private readonly recent: Kill[] = [];
  // tabs
  private readonly channel: SnapshotChannel | null = null;
  private readonly abort: AbortController | null = null;
  private release: (() => void) | null = null;

  constructor(
    private readonly kv: KeyValueStore | null,
    private readonly opts: SnapshotCacheOptions,
  ) {
    const prefix = opts.prefix ?? "ember";
    this.ixKey = `${prefix}:snapshots:v2`;
    this.v1Key = `${prefix}:snapshots`;
    this.slotPrefix = `${prefix}:snap:`;
    this.maxBytes = opts.maxBytes ?? 512 * 1024;
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600 * 1000;
    this.now = opts.now ?? Date.now;
    const name = `ember-snapshots:${prefix}`;
    const tabs = !kv ? null : opts.tabs !== undefined ? opts.tabs : defaultTabs(kv, name);
    if (!tabs) {
      this.role = "writer";
      return;
    }
    this.role = "reader";
    const channel = tabs.channel;
    this.channel = channel;
    channel.onmessage = (e) => this.onMessage(e.data as Msg);
    this.abort = typeof AbortController === "function" ? new AbortController() : null;
    void tabs.locks
      .request(name, this.abort ? { signal: this.abort.signal } : {}, () => this.lead())
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------------------------------------ roles

  /** Holds the lock: take the store over, then write it until `close()`. */
  private async lead(): Promise<void> {
    if (this.role === "closed") return;
    this.role = "writer";
    const r = this.ensure();
    if (r) await r;
    if ((this.role as string) === "closed") return;
    this.post({ ember: "snapshots/1", k: "writer", from: this.me });
    this.opts.onWriterChange?.(true);
    await new Promise<void>((resolve) => (this.release = resolve));
  }

  /**
   * Writer: the store loaded into memory (synchronously when it is sync). An index it cannot read is never taken for
   * an empty one (writing over it would lose what it lists, and its `t`): the instance stays in memory and tries again.
   */
  private ensure(): void | Promise<void> {
    if (this.ready || !this.kv) {
      this.ready = true;
      return;
    }
    if (this.loading) return this.loading;
    this.role = "loading";
    let ixRaw: string | null | undefined;
    const r = sequence2(
      () =>
        call(
          () => this.kv!.getItem(this.ixKey),
          (ok, x) => {
            ixRaw = ok ? ((x as string | null) ?? null) : undefined;
          },
        ),
      () => {
        if (ixRaw === undefined) return;
        return call(
          () => this.kv!.getItem(this.v1Key),
          // A failed read of format 1 is not "no blob": it is migrated by a later load.
          (ok, x) => this.adopt(ixRaw!, ok ? ((x as string | null) ?? null) : null),
        );
      },
    );
    const end = () => {
      this.loading = null;
      if (this.role === "closed") return;
      this.role = "writer";
      if (!this.ready) {
        this.retryMs = Math.min(30_000, this.retryMs ? this.retryMs * 2 : 250);
        this.schedule(this.retryMs);
      }
    };
    if (!r) return end();
    this.loading = r.then(end, end);
    return this.loading;
  }

  /** The stored index (and format 1) become the entries; what this instance held merges in. */
  private adopt(ixRaw: string | null, v1Raw: string | null): void {
    const ix = this.parseIndex(ixRaw);
    // What the index logs: what this instance held from before one of them goes (it had not heard of it). The rows
    // are the writer's that applied them.
    const held = [...this.entries.values()].filter((m) => !ix.kills.some((k) => names(k, m, false)));
    this.entries.clear();
    this.storedRows = [...ix.rows.values()];
    this.storedTop = ix.top;
    this.killLog = ix.kills;
    for (const row of this.storedRows) {
      const [identity, key, slot, version, epoch, ik, at, size, gen] = row;
      this.entries.set(qid(identity, key), { identity, key, version, epoch, ik, at, gen, size, value: undefined, loaded: false, slot, stored: row, dirty: false });
    }
    for (const m of held) {
      const q = qid(m.identity, m.key);
      const e = this.entries.get(q);
      if (e && m.gen === e.gen) {
        // the very value stored (read from it): keep it parsed, and the newer version
        if (m.loaded) {
          e.value = m.value;
          e.loaded = true;
        }
        if (m.version > e.version) {
          e.version = m.version;
          this.indexDirty = true;
        }
        e.born = m.born;
        continue;
      }
      if (e && !newer(m, e)) continue;
      m.slot = e ? e.slot : -1;
      m.stored = e?.stored;
      m.dirty = m.loaded || m.json !== undefined;
      this.entries.set(q, m);
    }
    if (v1Raw) this.migrate(v1Raw);
    // Keys below `t` no row lists: a stop between a value and its index. Removed (or reused) at the next flush.
    const used = new Set([...this.entries.values()].map((e) => e.slot));
    for (let s = 0; s < this.storedTop; s++) if (!used.has(s)) this.garbage.add(s);
    this.ready = true;
    this.role = "writer";
    // Deletes and sign-outs made while this instance read (its own ones no writer acknowledged, and those that came
    // meanwhile) now reach the store too.
    const kills = [...new Map([...this.recent, ...this.unacked.values(), ...this.loadingKills.splice(0)].map((k) => [k.id, k])).values()];
    this.unacked.clear();
    for (const k of kills) this.kill(k, false, false);
    // acknowledged once stored: a writer that goes before leaves them to the tabs that know of them
    for (const k of kills) this.whenWritten(() => this.ack(k.id), true, false);
    // all of them in one flush (one index), now
    if (kills.length) this.flush();
    else if (this.entries.size || this.garbage.size || this.v1 || this.indexDirty) this.schedule();
  }

  private migrate(raw: string): void {
    const waiting = new Set<Entry>();
    this.v1 = { raw, waiting, failed: false };
    let b: V1 | null = null;
    try {
      const x = JSON.parse(raw) as V1;
      if (x && x.v === 1 && typeof x.by === "object" && x.by) b = x;
    } catch {
      // unreadable: removed like a migrated one
    }
    if (!b) return;
    const now = this.now();
    for (const [identity, m] of Object.entries(b.by)) {
      if (!m || typeof m !== "object") continue;
      for (const [key, s] of Object.entries(m)) {
        if (!s || typeof s.v !== "string" || !isNum(s.version) || typeof s.epoch !== "string" || typeof s.ik !== "string" || !isNum(s.at)) continue;
        const at = s.at;
        if (now - at > this.maxAgeMs || at > now + FUTURE_SLACK) continue;
        const q = qid(identity, key);
        const e = this.entries.get(q);
        const cand = { version: s.version, epoch: s.epoch, at };
        if (e && !newer(cand, e)) continue;
        const n: Entry = { identity, key, ...cand, ik: s.ik, gen: this.gen(), size: s.v.length, value: undefined, loaded: false, json: s.v, slot: e ? e.slot : -1, stored: e?.stored, dirty: true };
        this.entries.set(q, n);
        waiting.add(n);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ reads

  get(identity: string, key: string): CachedSnapshot | undefined | Promise<CachedSnapshot | undefined> {
    if (this.role === "closed") return undefined;
    const q = qid(identity, key);
    const held = this.entries.get(q);
    if (held && (held.loaded || held.json !== undefined)) return this.fromMemory(held);
    if (this.role === "writer") {
      const r = this.ensure();
      // (a store that failed to load answers nothing until it loads)
      if (r) return r.then(() => (this.ready ? this.get(identity, key) : undefined));
      if (!this.ready) return undefined;
      const e = this.entries.get(q);
      if (!e) return undefined;
      if (e.loaded || e.json !== undefined) return this.fromMemory(e);
      return this.readSlot(e);
    }
    if (this.role === "loading") return this.loading!.then(() => (this.ready ? this.get(identity, key) : undefined));
    return this.readStored(identity, key);
  }

  private fromMemory(e: Entry): CachedSnapshot | undefined {
    if (this.now() - e.at > this.maxAgeMs) {
      this.drop(e);
      return undefined;
    }
    if (!e.loaded) {
      try {
        e.value = parse(e.json!);
        e.loaded = true;
      } catch {
        this.drop(e);
        return undefined;
      }
    }
    return { value: e.value, version: e.version, epoch: e.epoch, ik: e.ik, at: e.at };
  }

  /** Writer: the value of a stored entry, read from its key. */
  private readSlot(e: Entry): CachedSnapshot | undefined | Promise<CachedSnapshot | undefined> {
    const slot = e.slot;
    const q = qid(e.identity, e.key);
    let out: CachedSnapshot | undefined;
    const r = call(
      () => this.kv!.getItem(this.slotKey(slot)),
      (ok, raw) => {
        // Changed meanwhile (set, delete, sign-out): what is in memory now answers.
        if (this.entries.get(q) !== e || e.slot !== slot) {
          const now = this.entries.get(q);
          out = now && (now.loaded || now.json !== undefined) ? this.fromMemory(now) : undefined;
          return;
        }
        if (e.loaded) return void (out = this.fromMemory(e));
        // A failed read is a miss for now, not a missing key.
        if (!ok) return;
        const h = this.parseSlot(raw as string | null);
        if (!h || h.header[1] !== e.identity || h.header[2] !== e.key || h.header[6] > this.now() + FUTURE_SLACK) {
          this.drop(e);
          return;
        }
        const [, , , version, epoch, ik, at, gen] = h.header;
        if (gen !== e.gen) {
          // Rewritten after the index (in place, or a stop between the two): the header stands for itself.
          Object.assign(e, { version, epoch, ik, at, gen, size: h.size });
          e.stored = [e.identity, e.key, slot, version, epoch, ik, e.at, h.size, gen];
          this.indexDirty = true;
          this.schedule();
        }
        e.value = h.value;
        e.loaded = true;
        out = this.fromMemory(e);
      },
    );
    return r ? r.then(() => out) : out;
  }

  /** Reader: a value from the stored index and its key (or format 1), kept in memory. */
  private readStored(identity: string, key: string): CachedSnapshot | undefined | Promise<CachedSnapshot | undefined> {
    if (!this.kv) return undefined;
    const q = qid(identity, key);
    let out: CachedSnapshot | undefined | Promise<CachedSnapshot | undefined>;
    const done = (e: Entry | undefined) => {
      if (this.role !== "reader") return void (out = this.get(identity, key));
      const now = this.entries.get(q);
      if (now) return void (out = now.loaded || now.json !== undefined ? this.fromMemory(now) : undefined);
      if (!e) return;
      this.entries.set(q, e);
      out = this.fromMemory(e);
    };
    const r = call(
      () => this.kv!.getItem(this.ixKey),
      (ok, raw) => {
        const row = ok ? this.readerIndex((raw as string | null) ?? null).get(q) : undefined;
        if (!row) return this.readV1(identity, key, done);
        return call(
          () => this.kv!.getItem(this.slotKey(row[2])),
          (ok2, s) => {
            const h = ok2 ? this.parseSlot(s as string | null) : null;
            if (!h || h.header[1] !== identity || h.header[2] !== key || h.header[6] > this.now() + FUTURE_SLACK || this.covered(identity, key, h.header[6])) return done(undefined);
            const [, , , version, epoch, ik, at, gen] = h.header;
            // The index's version counts over the generation it names only.
            const v = gen === row[8] && epoch === row[4] && ik === row[5] ? Math.max(version, row[3]) : version;
            const a = at;
            const stored: IndexRow = [identity, key, row[2], v, epoch, ik, a, h.size, gen];
            done({ identity, key, version: v, epoch, ik, at: a, gen, size: h.size, value: h.value, loaded: true, slot: row[2], stored, dirty: false });
          },
        );
      },
    );
    return r ? r.then(() => out) : out;
  }

  private readV1(identity: string, key: string, done: (e: Entry | undefined) => void): void | Promise<void> {
    return call(
      () => this.kv!.getItem(this.v1Key),
      (ok, raw) => {
        if (!ok || !raw) return done(undefined);
        if (this.v1Cache?.raw !== raw) {
          let by: V1["by"] = {};
          try {
            const x = JSON.parse(raw as string) as V1;
            if (x && x.v === 1 && typeof x.by === "object" && x.by) by = x.by;
          } catch {
            // unreadable
          }
          this.v1Cache = { raw: raw as string, by };
        }
        const s = this.v1Cache.by[identity]?.[key];
        if (!s || typeof s.v !== "string" || !isNum(s.version) || typeof s.epoch !== "string" || typeof s.ik !== "string" || !isNum(s.at)) return done(undefined);
        if (s.at > this.now() + FUTURE_SLACK || this.covered(identity, key, s.at)) return done(undefined);
        done({ identity, key, version: s.version, epoch: s.epoch, ik: s.ik, at: s.at, gen: this.gen(), size: s.v.length, value: undefined, loaded: false, json: s.v, slot: -1, dirty: false });
      },
    );
  }

  /** Reader: the stored index's rows, parsed again only when it changed. */
  private readerIndex(raw: string | null): Map<string, IndexRow> {
    if (!raw) {
      this.ixCache = null;
      return new Map();
    }
    if (this.ixCache?.raw !== raw) {
      const ix = this.parseIndex(raw);
      this.ixCache = { raw, rows: ix.rows, kills: ix.kills };
    }
    return this.ixCache.rows;
  }

  // ------------------------------------------------------------------------------------------------ writes

  set(identity: string, key: string, entry: CachedSnapshot): void {
    if (this.role === "closed") return;
    const q = qid(identity, key);
    const e = this.entries.get(q);
    if (e && e.loaded && e.value === entry.value && e.epoch === entry.epoch && e.ik === entry.ik) {
      // the very value held, confirmed at a newer version
      this.touch(identity, key, entry);
      return;
    }
    const n: Entry = {
      identity,
      key,
      version: entry.version,
      epoch: entry.epoch,
      ik: entry.ik,
      at: entry.at,
      gen: this.gen(),
      size: -1,
      value: entry.value,
      loaded: true,
      slot: e ? e.slot : -1,
      stored: e?.stored,
      dirty: true,
      born: this.now(),
    };
    this.entries.set(q, n);
    if (e) this.v1?.waiting.delete(e);
    this.schedule();
  }

  touch(identity: string, key: string, entry: CachedSnapshot): void {
    if (this.role === "closed") return;
    const e = this.entries.get(qid(identity, key));
    if (!e || !e.loaded || e.value !== entry.value || e.epoch !== entry.epoch || e.ik !== entry.ik || !(entry.version > e.version)) return;
    e.version = entry.version;
    if (this.role === "writer") {
      if (e.stored?.[8] === e.gen) this.indexDirty = true;
      this.schedule();
    } else if (this.role === "reader" && e.stored?.[8] === e.gen) {
      // read from the store: the writer moves that very generation
      this.post({ ember: "snapshots/1", k: "touch", i: identity, key, gen: e.gen, version: e.version, epoch: e.epoch, ik: e.ik });
    }
  }

  delete(identity: string, key: string): void {
    this.own({ id: `${this.me}.${this.gen()}`, i: identity, key, at: this.now() });
  }

  clear(identity?: string): void {
    this.own({ id: `${this.me}.${this.gen()}`, i: identity, at: this.now() });
  }

  /** A delete or sign-out made here: applied now; the writer (if not this) gets it until it acknowledges it. */
  private own(k: Kill): void {
    if (this.role === "closed") return;
    this.kill(k, true);
    this.remember(k, this.role === "reader");
    // Every instance drops it from memory (a reader would bring it back when it takes over).
    this.post({ ember: "snapshots/1", k: "kill", from: this.me, ...k });
    if (this.role === "writer") this.whenWritten(() => this.ack(k.id), true, k.key === undefined);
  }

  private remember(k: Kill, unacked: boolean): void {
    // bounded: the oldest go first
    if (unacked) {
      this.unacked.set(k.id, k);
      if (this.unacked.size > 64) this.unacked.delete(this.unacked.keys().next().value!);
    }
    if (this.recent.some((x) => x.id === k.id)) return;
    this.recent.push(k);
    if (this.recent.length > 64) this.recent.shift();
  }

  /** A value read from the store that a delete or sign-out known here (or logged in the index) covers. */
  private covered(identity: string, key: string, at: number): boolean {
    const hit = (k: Kill) => (k.i === undefined || k.i === identity) && (k.key === undefined || k.key === key) && at <= k.at;
    return this.recent.some(hit) || (this.ixCache?.kills.some(hit) ?? false);
  }

  private ack(id: string): void {
    this.post({ ember: "snapshots/1", k: "ack", id });
  }

  /**
   * Drops what `k` names: here, all of it; from another tab, what was stored up to `k.at`. The writer removes it from
   * the store at once: a sign-out with the index (and every key no entry uses, and format 1); a delete its value's key,
   * and the index follows with the next flush (until then it lists a key that is gone: a miss), so a run of deletes
   * rewrites the index once, not once each.
   */
  private kill(k: Kill, local: boolean, now = true): void {
    // A sync store loads now: the kill then reaches what it lists too.
    if (this.role === "writer" && !this.ready) this.ensure();
    const slots = this.dropCovered(k, local);
    if (this.role === "reader" || this.role === "closed") return;
    if (!this.ready) return void this.loadingKills.push(k);
    if (!this.killLog.some((x) => x.at === k.at && x.i === k.i && x.key === k.key)) {
      this.killLog.push(k);
      if (this.killLog.length > 64) this.killLog.shift();
      this.indexDirty = true;
    }
    // Format 1 would bring it back at the next migration (and readers fall back to it).
    if (k.key === undefined || this.v1) this.dropV1 = true;
    if (k.key === undefined) {
      const used = new Set([...this.entries.values()].map((e) => e.slot));
      for (let s = 0; s < this.storedTop; s++) if (!used.has(s)) this.garbage.add(s);
    }
    if (!now) return;
    if (k.key === undefined) return this.flush();
    this.removeNow(slots);
    this.schedule();
  }

  /** Drops what `k` covers; the slots they had. A delete looks its one query up (a run of them stays linear). */
  private dropCovered(k: Kill, local: boolean): number[] {
    const slots: number[] = [];
    const hit = (e: Entry) => {
      if (!names(k, e, local)) return;
      if (e.slot >= 0) slots.push(e.slot);
      this.drop(e);
    };
    if (k.i !== undefined && k.key !== undefined) {
      const e = this.entries.get(qid(k.i, k.key));
      if (e) hit(e);
    } else for (const e of [...this.entries.values()]) hit(e);
    return slots;
  }

  /** Writer: removes these value keys (no entry uses them) now, the index left to the next flush. */
  private removeNow(slots: number[]): void {
    const kv = this.kv;
    if (!kv || !slots.length) return;
    // A flush on its way may still write one of them: the next one removes it, after it.
    if (this.flushing) return void (this.again = true);
    this.flushing = true;
    const steps = slots.map((slot) => () => call(() => this.remove(kv, this.slotKey(slot)), (ok) => void (ok && this.garbage.delete(slot))));
    sequence(steps, () => {
      this.flushing = false;
      if (this.again) {
        this.again = false;
        this.flush();
      }
    });
  }

  private drop(e: Entry): void {
    const q = qid(e.identity, e.key);
    if (this.entries.get(q) !== e) return;
    this.entries.delete(q);
    this.v1?.waiting.delete(e);
    if (this.role !== "writer" && this.role !== "loading") return;
    if (e.slot >= 0) this.garbage.add(e.slot);
    if (e.stored) this.indexDirty = true;
  }

  // ------------------------------------------------------------------------------------------------ flush

  /** A flush in `delay` ms; new work (the default) also ends a backoff: it is tried again in 250 ms. */
  private schedule(delay?: number): void {
    if (this.role === "closed") return;
    if (delay === undefined) {
      delay = 250;
      this.retryMs = 0;
    }
    if (this.timer) {
      if (this.timerDue <= this.now() + delay) return;
      clearTimeout(this.timer);
    }
    this.timerDue = this.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
  }

  /** Writes what changed now (a reader has nothing to write: it only bounds its memory). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.role === "closed") return;
    if (this.role !== "writer" || !this.kv) return void this.evict();
    const r = this.ensure();
    if (r) return void r.then(() => (this.ready ? this.flush() : this.settled()));
    if (!this.ready) {
      this.evict();
      this.failed = true;
      return this.settled();
    }
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.evict();
    const dirty = [...this.entries.values()].filter((e) => e.dirty);
    const work = dirty.length || this.garbage.size || this.indexDirty || this.dropV1 || (this.v1 && !this.v1.waiting.size);
    if (!work) {
      this.failed = false;
      return this.settled();
    }
    this.flushing = true;
    const kv = this.kv;
    const used = new Set<number>();
    for (const e of this.entries.values()) if (e.slot >= 0) used.add(e.slot);
    // A slot the stored index lists (for a query gone since) is not reused before an index without it is stored: the
    // stored index never names a key that holds another query (a stop before the index would leave it mislabelled,
    // out of reach of that query's delete or sign-out).
    const listed = new Set(this.storedRows.map((r) => r[2]));
    let free = 0;
    for (const e of dirty) {
      if (e.slot >= 0) continue;
      while (used.has(free) || listed.has(free)) free++;
      e.slot = free;
      used.add(free);
      this.garbage.delete(free);
    }
    let top = this.storedTop;
    for (const s of used) top = Math.max(top, s + 1);
    const steps: Array<() => void | Promise<void>> = [];
    for (const slot of [...this.garbage]) {
      if (used.has(slot)) {
        this.garbage.delete(slot);
        continue;
      }
      steps.push(() => call(() => this.remove(kv, this.slotKey(slot)), (ok) => void (ok && this.garbage.delete(slot))));
    }
    if (this.dropV1) {
      this.dropV1 = false;
      this.v1 = null;
      steps.push(() => call(() => this.remove(kv, this.v1Key), (ok) => void (ok || (this.dropV1 = true))));
    }
    // A slot past the stored `t` is listed (by `t`) before anything is written to it: a sign-out finds it.
    let topOk = top <= this.storedTop;
    if (!topOk) {
      steps.push(() =>
        call(
          () => kv.setItem(this.ixKey, this.indexJson(top, this.storedRows)),
          (ok) => {
            if (ok) this.storedTop = Math.max(this.storedTop, top);
            topOk = ok;
          },
        ),
      );
    }
    for (const e of dirty) {
      const q = qid(e.identity, e.key);
      const gen = e.gen;
      const slot = e.slot;
      e.dirty = false;
      steps.push(() => {
        if (this.entries.get(q) !== e || e.gen !== gen) return;
        if (!topOk && slot >= this.storedTop) {
          e.dirty = true;
          return;
        }
        const header: Header = [2, e.identity, e.key, e.version, e.epoch, e.ik, e.at, gen];
        const json = e.json!;
        const data = `${JSON.stringify(header)}\n${json}`;
        const write = (tries: number): void | Promise<void> =>
          call(
            () => kv.setItem(this.slotKey(slot), data),
            (ok) => {
              if (this.entries.get(q) !== e || e.gen !== gen) return;
              if (ok) {
                e.stored = [e.identity, e.key, slot, e.version, e.epoch, e.ik, e.at, json.length, gen];
                this.v1?.waiting.delete(e);
                if (e.loaded) e.json = undefined;
                this.indexDirty = true;
                return;
              }
              // Out of space (or refused): the least recently stored other value makes room, a few times.
              const victim = tries < 3 ? this.oldestStored(e) : undefined;
              if (victim) {
                const vs = victim.slot;
                this.drop(victim);
                return call(
                  () => this.remove(kv, this.slotKey(vs)),
                  (gone) => {
                    if (gone) this.garbage.delete(vs);
                    return write(tries + 1);
                  },
                );
              }
              // Not stored (and not listed). The key may hold anything now: removed at the next flush.
              this.drop(e);
              if (this.v1) this.v1.failed = true;
            },
          );
        return write(0);
      });
    }
    steps.push(() => {
      // Once nothing is left to remove, every key past the highest slot in use is empty: `t` comes down.
      let t = this.storedTop;
      if (!this.garbage.size) {
        t = 0;
        for (const e of this.entries.values()) t = Math.max(t, e.slot + 1);
      }
      if (!this.indexDirty && t === this.storedTop) return;
      const rows = this.rows();
      this.indexDirty = false;
      return call(
        () => kv.setItem(this.ixKey, this.indexJson(t, rows)),
        (ok) => {
          if (ok) {
            this.storedRows = rows;
            this.storedTop = t;
            this.retryMs = 0;
          } else this.indexDirty = true;
        },
      );
    });
    // Format 1 goes once everything it held is stored (or gone), and only if it is still the blob that was read.
    steps.push(() => {
      const v1 = this.v1;
      if (!v1 || v1.waiting.size || v1.failed || this.indexDirty) return;
      return call(
        () => kv.getItem(this.v1Key),
        (ok, raw) => {
          if (!ok || this.v1 !== v1) return;
          if (raw !== v1.raw) return void (this.v1 = null);
          return void call(() => this.remove(kv, this.v1Key), (gone) => void (gone && this.v1 === v1 && (this.v1 = null)));
        },
      );
    });
    sequence(steps, () => {
      this.flushing = false;
      const failed = this.indexDirty || this.garbage.size > 0 || this.dropV1 || [...this.entries.values()].some((e) => e.dirty);
      this.failed = failed;
      if (this.again) {
        this.again = false;
        this.flush();
        return;
      }
      if (failed) {
        // The store refused: retried on its own, backed off while it keeps refusing.
        this.retryMs = Math.min(30_000, this.retryMs ? this.retryMs * 2 : 250);
        this.schedule(this.retryMs);
      }
      this.settled();
    });
  }

  private indexJson(t: number, rows: IndexRow[]): string {
    // one older than `maxAgeMs` covers only values that have expired anyway
    const now = this.now();
    this.killLog = this.killLog.filter((k) => now - k.at <= this.maxAgeMs);
    return JSON.stringify({ v: 2, t, n: rows, k: this.killLog.map((k) => [k.at, k.i ?? null, k.key ?? null]) });
  }

  /** The least recently stored entry other than `not` that the store holds. */
  private oldestStored(not: Entry): Entry | undefined {
    let o: Entry | undefined;
    for (const e of this.entries.values()) if (e !== not && e.stored && !e.dirty && (!o || e.at < o.at)) o = e;
    return o;
  }

  /** Index rows: what the store holds for each entry (the version moves over that very generation only). */
  private rows(): IndexRow[] {
    const rows: IndexRow[] = [];
    for (const e of this.entries.values()) {
      const s = e.stored;
      if (!s) continue;
      rows.push(s[8] === e.gen ? [e.identity, e.key, s[2], e.version, e.epoch, e.ik, e.at, s[7], s[8]] : s);
    }
    return rows;
  }

  private settled(): void {
    if (this.flushing) return;
    for (const f of this.idle.splice(0)) f();
    if (!this.failed) for (const f of this.clean.splice(0)) f();
  }

  /** Encodes what is new; then least recently stored first, until the values fit `maxBytes`; expired ones always. */
  private evict(): void {
    const all: Entry[] = [];
    let size = 0;
    const now = this.now();
    for (const e of [...this.entries.values()]) {
      if (e.json === undefined && e.loaded && (e.size < 0 || (e.dirty && this.role === "writer" && this.kv))) {
        try {
          e.json = stringify(e.value);
        } catch {
          this.drop(e);
          continue;
        }
        e.size = e.json.length;
        // nothing to write it to: the size was all it was for
        if (!this.kv || this.role !== "writer") e.json = undefined;
      }
      if (now - e.at > this.maxAgeMs || e.size > this.maxBytes) {
        this.drop(e);
        continue;
      }
      all.push(e);
      size += Math.max(0, e.size);
    }
    if (size <= this.maxBytes) return;
    all.sort((x, y) => x.at - y.at);
    for (const e of all) {
      if (size <= this.maxBytes) break;
      size -= Math.max(0, e.size);
      this.drop(e);
    }
  }

  // ------------------------------------------------------------------------------------------------ tabs

  private post(m: Msg): void {
    try {
      this.channel?.postMessage(m);
    } catch {
      // closed: nothing to tell
    }
  }

  private onMessage(m: Msg): void {
    if (!m || m.ember !== "snapshots/1" || this.role === "closed") return;
    if (m.k === "kill") {
      if (m.from === this.me) return;
      const k: Kill = { id: m.id, i: m.i, key: m.key, at: m.at };
      this.kill(k, false);
      const writes = this.role === "writer" || this.role === "loading";
      this.remember(k, !writes);
      if (writes) this.whenWritten(() => this.ack(k.id), true, k.key === undefined);
    } else if (m.k === "ack") {
      this.unacked.delete(m.id);
    } else if (m.k === "writer") {
      if (m.from === this.me) return;
      for (const k of this.unacked.values()) this.post({ ember: "snapshots/1", k: "kill", from: this.me, ...k });
    } else if (m.k === "touch") {
      if (this.role !== "writer" || !this.ready) return;
      const e = this.entries.get(qid(m.i, m.key));
      if (!e || e.gen !== m.gen || e.epoch !== m.epoch || e.ik !== m.ik || !(m.version > e.version)) return;
      e.version = m.version;
      if (e.stored?.[8] === e.gen) this.indexDirty = true;
      this.schedule();
    }
  }

  /**
   * Runs `f` once what is pending now has been written (`stored`: and nothing refused; else: or tried): by a flush now,
   * or (`now` false) by the next one scheduled.
   */
  private whenWritten(f: () => void, stored = false, now = true): void {
    const r = this.loading;
    if (r && !this.ready) return void r.then(() => this.whenWritten(f, stored, now));
    (stored ? this.clean : this.idle).push(f);
    if (!now) return this.schedule();
    this.flush();
    this.settled();
  }

  async close(): Promise<void> {
    if (this.role === "closed") return;
    if (this.role === "writer" || this.role === "loading") {
      if (this.loading) await this.loading;
      await new Promise<void>((r) => this.whenWritten(r));
    }
    const wasWriter = this.role === "writer";
    this.role = "closed";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.release?.();
    if (this.channel) this.channel.onmessage = null;
    this.channel?.close?.();
    if (wasWriter && this.channel) this.opts.onWriterChange?.(false);
  }

  // ------------------------------------------------------------------------------------------------ formats

  private gen(): string {
    return `${this.me}${(this.gens++).toString(36)}`;
  }

  private slotKey(slot: number): string {
    return `${this.slotPrefix}${slot}`;
  }

  private remove(kv: KeyValueStore, key: string): unknown {
    return kv.removeItem ? kv.removeItem(key) : kv.setItem(key, "");
  }

  /** A value key: its header (checked) and value. Anything else is a miss. */
  private parseSlot(raw: string | null): { header: Header; value: unknown; size: number } | null {
    if (!raw) return null;
    const nl = raw.indexOf("\n");
    if (nl < 0) return null;
    try {
      const h = JSON.parse(raw.slice(0, nl)) as unknown;
      if (!Array.isArray(h) || h.length !== 8 || h[0] !== 2) return null;
      const [, identity, key, version, epoch, ik, at, gen] = h as unknown[];
      if (typeof identity !== "string" || typeof key !== "string" || !isNum(version) || typeof epoch !== "string" || typeof ik !== "string" || !isNum(at) || typeof gen !== "string") return null;
      const json = raw.slice(nl + 1);
      return { header: h as Header, value: parse(json), size: json.length };
    } catch {
      return null;
    }
  }

  /** The stored index, row by row checked (one row per query and per slot); `t` clamped to what the rows reach. */
  private parseIndex(raw: string | null): { rows: Map<string, IndexRow>; top: number; kills: Kill[] } {
    const rows = new Map<string, IndexRow>();
    const kills: Kill[] = [];
    let t: unknown = 0;
    if (raw) {
      try {
        const x = JSON.parse(raw) as { v?: unknown; t?: unknown; n?: unknown; k?: unknown };
        if (x && x.v === 2 && Array.isArray(x.n)) {
          t = x.t;
          const slots = new Set<number>();
          const now = this.now();
          for (const k of Array.isArray(x.k) ? (x.k as unknown[]).slice(-64) : []) {
            if (!Array.isArray(k) || k.length !== 3) continue;
            const [at, i, key] = k as unknown[];
            if (!isNum(at) || (i !== null && typeof i !== "string") || (key !== null && typeof key !== "string")) continue;
            kills.push({ id: "", at: Math.min(at, now), i: i ?? undefined, key: key ?? undefined });
          }
          for (const r of x.n as unknown[]) {
            if (!Array.isArray(r) || r.length !== 9) continue;
            const [identity, key, slot, version, epoch, ik, at, size, gen] = r as unknown[];
            if (typeof identity !== "string" || typeof key !== "string" || !isSlot(slot) || !isNum(version) || typeof epoch !== "string" || typeof ik !== "string" || !isNum(at) || !Number.isInteger(size) || (size as number) < 0 || typeof gen !== "string") continue;
            const q = qid(identity, key);
            if (rows.has(q) || slots.has(slot)) continue;
            // expired, or too far in the future to ever expire (see FUTURE_SLACK)
            const a = at as number;
            if (now - a > this.maxAgeMs || a > now + FUTURE_SLACK) continue;
            slots.add(slot);
            rows.set(q, [identity, key, slot, version, epoch, ik, a, size as number, gen]);
          }
        }
      } catch {
        // unreadable: empty
      }
    }
    let reach = 0;
    for (const r of rows.values()) reach = Math.max(reach, r[2] + 1);
    const top = Number.isInteger(t) ? Math.min(Math.max(t as number, reach), reach + TOP_SLACK, MAX_SLOTS) : reach;
    return { rows, top, kills };
  }
}

/** Two store steps in order; a promise when either is async. */
function sequence2(a: () => void | Promise<void>, b: () => void | Promise<void>): Promise<void> | undefined {
  const r = a();
  if (isThenable(r)) return r.then(() => b());
  const s = b();
  return isThenable(s) ? s : undefined;
}
