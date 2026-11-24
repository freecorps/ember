// A light snapshot cache for the client (no offline engine): the last confirmed value of each subscription, so a
// repeat visit paints from it with no round trip (`source: "cache"`) and subscribes with `resume` (the shard answers
// `unchanged` when nothing it read changed). Kept per identity, bounded, never holds errors, cleared on sign-out.
//
// Storage layout (key-value store, format 2): one key per stored query, and a small index.
//
//   <prefix>:snapshots:v2   {"v":2,"t":top,"n":[[identity, key, slot, version, epoch, ik, at, size, gen], ...]}
//   <prefix>:snap:<slot>    [2, identity, key, version, epoch, ik, at, gen] + "\n" + the value's JSON (tagged)
//
// A changed value rewrites its own key only; the index is rewritten when queries come and go, when versions move
// without a new value (`set`/`touch` with the very value object already stored: the shard confirmed it is still
// current, e.g. on page hide), and when an entry's `at` or size drifted far from the index's. Each entry carries its
// own header, so it is self-describing: an entry whose header does not name the index's (identity, key) is a miss (a
// slot reused by another tab; its key is left alone), and an index version or `at` counts only over the value
// generation `gen` it was written for — any other header (a value rewritten after the index, by this tab or another)
// stands for itself. Every slot key is below `t`, which is stored before a slot past it is written: a sign-out
// removes every one of them, also those of writes the index never listed. The value's JSON is appended raw after the
// header line: no string-in-JSON escaping. Values are parsed once and kept.
//
// Several instances (tabs) share the store, each with the index in memory. The stored one is read before each
// rewrite (a sync store: at the start of every flush) and, when another instance wrote it since, followed (`absorb`):
// its `t`, its queries this one does not have, which slot holds which query. A new query's slot is picked at the flush,
// after that read, so it is not one another tab lists. A read, write or removal of a key waits for this instance's
// write of it still on its way; a queued value write is dropped if its entry left the slot meanwhile; a slot is
// removed for a forgotten entry only while its header still names that value; a failed read is a miss, never a
// missing key. `clear(identity)` goes by each slot's own header (an index can be stale). Stored rows are checked
// (whole rows, slots below `MAX_SLOTS`, `at` not in the future) before anything is derived from them.
//
// Format 1 (one blob, `<prefix>:snapshots`) is read on load whenever it is there (a migration that did not finish,
// or an older client that wrote it again: what it holds moves to format 2 unless the index has it newer) and removed
// once its values and an index listing them are stored. An older client ignores the format 2 keys.
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
  /** Store a value (the same `value` object again with a newer version: an implementation may update the version only). */
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
}

export interface SnapshotCacheOptions {
  /** Total size of the stored values (JSON characters). Least recently stored go first. Default 512 KiB. */
  maxBytes?: number;
  /** Older snapshots are not used (and are dropped). Default 7 days. */
  maxAgeMs?: number;
  /** Key prefix in the key-value store. Default `"ember"`. */
  prefix?: string;
  now?: () => number;
}

/** In memory: survives client re-creation in one page (SPA navigation), not a reload. */
export function memorySnapshotCache(opts: SnapshotCacheOptions = {}): SnapshotCache {
  return new SplitCache(null, opts);
}

/**
 * Over `localStorage`, `sessionStorage` or an AsyncStorage-like store (`getItem`/`setItem`, sync or async; `removeItem`
 * when it has one): one entry per query plus a small index, read lazily, written at most every 250 ms (only what
 * changed). With a synchronous store (localStorage) the first paint of a repeat visit needs no round trip at all.
 */
export function keyValueSnapshotCache(kv: KeyValueStore, opts: SnapshotCacheOptions = {}): SnapshotCache {
  return new SplitCache(kv, opts);
}


/** A stored query in memory. */
interface Entry {
  identity: string;
  key: string;
  /** Its key's number; -1 until the flush that first writes it picks one (after reading what the store lists). */
  slot: number;
  version: number;
  epoch: string;
  ik: string;
  at: number;
  /** JSON length of the value (-1: not known yet). */
  size: number;
  /** Generation of the value: written in its key's header and in its index row (see `fill`). */
  gen: string;
  /** `at` and `size` as the stored index has them (it is rewritten when they drift too far: `drifted`). */
  ixAt: number;
  ixSize: number;
  /** The value, once parsed or set (`loaded`). */
  value: unknown;
  loaded: boolean;
  /** The value's JSON waiting to be written (moved from format 1), when `value` is not parsed yet. */
  json?: string | undefined;
  /**
   * Format 1's value of this query, when the index has a newer one: used if that one's key turns out missing (a
   * stop before it was written: format 1 stays until it is).
   */
  fallback?: { json: string; version: number; epoch: string; ik: string; at: number } | undefined;
  /** The value changed: its key is rewritten on the next flush. */
  dirty: boolean;
}

type IndexRow = [identity: string, key: string, slot: number, version: number, epoch: string, ik: string, at: number, size: number, gen: string];
type Header = [2, identity: string, key: string, version: number, epoch: string, ik: string, at: number, gen: string];
type V1 = { v: 1; by: Record<string, Record<string, { v?: unknown; version?: unknown; epoch?: unknown; ik?: unknown; at?: unknown }>> };

/** A query's name in maps (identities hold `\u0000`). */
const qid = (identity: string, key: string) => JSON.stringify([identity, key]);
/** A value's: its query and generation. */
const vid = (identity: string, key: string, gen: string) => JSON.stringify([identity, key, gen]);
/** What a read gave: the value, `null` (no such key), `undefined` (the read failed). */
type Read = string | null | undefined;
const isThenable = (x: unknown): x is Promise<unknown> => typeof (x as { then?: unknown } | null)?.then === "function";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/**
 * How far a stored `t` may reach past the highest slot its index lists. Slots past that one are only those freed at
 * the top (their keys go before the index that drops them) and writes the index never listed: a few. A larger `t` is
 * corrupt (or foreign) and is clamped, so load and sign-out never do work proportional to it.
 */
const SLOT_SLACK = 1024;
/**
 * Slots a cache uses are below this (it stores no more queries than that): far more than a store holds (an index
 * that long is megabytes). A stored row past it is corrupt (or foreign) and is ignored, so it never sets how far load
 * and sign-out go.
 */
const MAX_SLOTS = 1 << 16;
const RETRY_MS = 250;
const MAX_RETRY_MS = 30_000;

/** A stored index, checked: its rows (each valid, slots below `MAX_SLOTS`, no slot or query twice) and its `t`. */
interface StoredIndex {
  /** Above every listed slot; a larger stored `t` is kept up to `SLOT_SLACK` past the highest one (never past `MAX_SLOTS`). */
  top: number;
  rows: IndexRow[];
}

/**
 * The index as stored (`null`: none, or unreadable). Every reader of it goes through here, so a row is used (listed,
 * kept by a sign-out of another identity, counted for `t`) only when it is a whole, valid row. An `at` in the future
 * counts as now (it would never age out).
 */
function parseIndex(raw: string | null, now: number): StoredIndex | null {
  if (!raw) return null;
  let x: { v?: unknown; t?: unknown; n?: unknown };
  try {
    x = JSON.parse(raw) as typeof x;
  } catch {
    return null;
  }
  if (x?.v !== 2 || !Array.isArray(x.n)) return null;
  const rows: IndexRow[] = [];
  const slots = new Set<number>();
  const queries = new Set<string>();
  let top = 0;
  for (const r of x.n as unknown[]) {
    if (!Array.isArray(r) || r.length < 8) continue;
    const [identity, key, slot, version, epoch, ik, at, size, gen] = r as IndexRow;
    if (typeof identity !== "string" || typeof key !== "string" || !Number.isSafeInteger(slot) || slot < 0 || slot >= MAX_SLOTS) continue;
    if (!isNum(version) || typeof epoch !== "string" || typeof ik !== "string" || !isNum(at)) continue;
    const q = qid(identity, key);
    if (slots.has(slot) || queries.has(q)) continue;
    slots.add(slot);
    queries.add(q);
    rows.push([identity, key, slot, version, epoch, ik, Math.min(at, now), isNum(size) && size >= 0 ? size : -1, typeof gen === "string" ? gen : ""]);
    if (slot >= top) top = slot + 1;
  }
  if (Number.isSafeInteger(x.t) && (x.t as number) > top) top = Math.min(x.t as number, top + SLOT_SLACK, MAX_SLOTS);
  return { top, rows };
}

/** A stored row as an entry not read yet. */
function fromRow([identity, key, slot, version, epoch, ik, at, size, gen]: IndexRow): Entry {
  return { identity, key, slot, version, epoch, ik, at, size, gen, ixAt: at, ixSize: size, value: undefined, loaded: false, dirty: false };
}

class SplitCache implements SnapshotCache {
  private entries: Map<string, Map<string, Entry>> | null = null;
  private loading: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The index must be written (membership, versions, generations, or `at`/`size` drifted). */
  private indexDirty = false;
  /** Entries whose value must be written. */
  private readonly dirty = new Set<Entry>();
  /** Slot → the entry using it. */
  private readonly owners = new Map<number, Entry>();
  /** Slots below `top` nobody uses (reused before `top` grows, so the keys stay bounded by the number of entries). */
  private free: number[] = [];
  /** Every slot key is below `top`; `ixTop`: the `top` the stored index has (a sign-out removes every slot below it). */
  private top = 0;
  private ixTop = 0;
  /**
   * Slots whose key must be removed (unless reused meanwhile), with the value this instance had there (`vid`; `null`:
   * a sign-out's, removed whatever the store lists).
   */
  private readonly toRemove = new Map<number, string | null>();
  /** Slots removed since the index was last written, the same way: a stored row naming that value there is not taken back. */
  private readonly removed = new Map<number, string | null>();
  /**
   * The stored index as this instance last read or wrote it: another one stored means another instance wrote it
   * since, and what it lists is taken in before this one's replaces it (`absorb`).
   */
  private ixRaw: string | null = null;
  /** The store answered `getItem` synchronously (on load): the stored index is cheap to read before slots are picked. */
  private sync = true;
  /** A full sign-out just removed every slot no entry here uses: with no entries left, `t` can go back to 0. */
  private swept = false;
  /** Format 1 was read: its key goes once what it held is durably in format 2. */
  private legacy = false;
  /** A moved value could not be written this session: the format 1 key stays (the next load moves it again). */
  private legacyFailed = false;
  /** The format 1 blob as read: only that revision is removed (an older tab may have written a newer one since). */
  private legacyRaw: string | null = null;
  /** Writes of moved values and of indexes listing them still on their way (across flushes): format 1 waits for them. */
  private readonly legacyWrites = new Set<Promise<boolean>>();
  /** The last write of each key still on its way (async store): the next one to the same key goes after it. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Flushes whose index was refused, in a row: the retry backs off (reset by a stored index or new work). */
  private retries = 0;
  private flushes = 0;
  private refusedFlush = -1;
  /** A sign-out is reading what the store lists now: nothing is written until it has. */
  private sweeping = 0;
  private flushing = false;
  private readonly writer = Math.random().toString(36).slice(2, 8);
  private gens = 0;
  private readonly prefix: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  /** How far the index's `at` may lag an entry's (and how much longer an entry not read yet is kept for it). */
  private readonly drift: number;
  private readonly now: () => number;

  constructor(
    private readonly kv: KeyValueStore | null,
    opts: SnapshotCacheOptions,
  ) {
    this.prefix = opts.prefix ?? "ember";
    this.maxBytes = opts.maxBytes ?? 512 * 1024;
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600 * 1000;
    this.drift = this.maxAgeMs / 8;
    this.now = opts.now ?? Date.now;
  }

  private get indexKey() {
    return `${this.prefix}:snapshots:v2`;
  }
  private get legacyKey() {
    return `${this.prefix}:snapshots`;
  }
  private slotKey(slot: number) {
    return `${this.prefix}:snap:${slot}`;
  }
  private newGen(): string {
    return `${this.writer}${(++this.gens).toString(36)}`;
  }

  // ------------------------------------------------------------------------------------------------ loading

  /**
   * The entries, loaded on first use (synchronously when the store is): the index, and format 1 if it is still there
   * (a migration that did not finish, or an older client that wrote it again): never rejects.
   */
  private load(): Map<string, Map<string, Entry>> | Promise<Map<string, Map<string, Entry>>> {
    if (this.entries) return this.entries;
    if (!this.kv) return (this.entries = new Map());
    if (this.loading) return this.loading.then(() => this.entries!);
    const kv = this.kv;
    const get = (k: string): string | null | Promise<string | null> => {
      try {
        return kv.getItem(k);
      } catch {
        return null;
      }
    };
    const done = (index: string | null, v1: string | null) => {
      if (this.entries) return this.entries;
      this.entries = new Map();
      try {
        this.readIndex(index);
        this.readV1(v1);
      } catch {
        // what was read is kept
      }
      return this.entries;
    };
    const index = get(this.indexKey);
    const v1 = get(this.legacyKey);
    if (isThenable(index) || isThenable(v1)) {
      this.sync = false;
      const settle = (x: string | null | Promise<string | null>) => Promise.resolve(x).catch(() => null);
      this.loading ??= Promise.all([settle(index), settle(v1)]).then(
        ([i, o]) => void done(i, o),
        () => void done(null, null),
      );
      return this.loading.then(() => this.entries ?? done(null, null));
    }
    return done(index, v1);
  }

  private add(e: Entry): void {
    const m = this.entries!;
    let byKey = m.get(e.identity);
    if (!byKey) m.set(e.identity, (byKey = new Map()));
    byKey.set(e.key, e);
    if (e.slot >= 0) this.owners.set(e.slot, e);
  }

  /** Format 2's index. */
  private readIndex(raw: string | null): void {
    this.ixRaw = raw;
    if (!raw) return;
    const ix = parseIndex(raw, this.now());
    if (!ix) {
      // unreadable: start over (its entries are overwritten as slots are reused)
      this.indexDirty = true;
      return;
    }
    for (const r of ix.rows) this.add(fromRow(r));
    this.top = this.ixTop = ix.top;
    for (let s = 0; s < this.top; s++) if (!this.owners.has(s)) this.free.push(s);
  }

  /**
   * The stored index, when another instance wrote it since this one last read or wrote it (another tab, or this
   * one's load could not read it): the newer word on what each slot holds, which this instance follows.
   *
   * - Its `t` is taken: slots past this one's may hold its values (a sign-out must reach them), and slots past it are
   *   listed again before a value goes there (a sign-out elsewhere may have lowered it).
   * - A slot it lists for another query than the one using it here was reused by that tab: the entry here moves to a
   *   new slot at the next flush (one not read yet is dropped: its value was overwritten).
   * - A query this one has, listed in another slot, moves there (its own older slot is removed); one this one does not
   *   have becomes an entry here (not read yet), so the index this one writes next still lists it.
   * - No slot it lists is picked here for a new query.
   *
   * A row naming a slot this one removes (or just removed) for that same value, or for a sign-out, is not taken; one
   * naming another value there (another query, or a newer generation of it) is: that tab wrote the slot since, and its
   * value is not this one's to remove (a sign-out of an identity still removes every slot whose header names it).
   * `skip`: rows of that identity are not taken (a sign-out of it), `true`: no rows at all (a full sign-out).
   */
  private absorb(raw: string | null, skip?: string | true): boolean {
    if (raw === this.ixRaw) return false;
    this.ixRaw = raw;
    const ix = parseIndex(raw, this.now());
    this.ixTop = ix?.top ?? 0;
    if (!ix) return false;
    let changed = false;
    const blocked = new Set<number>();
    if (skip !== true) {
      const take: IndexRow[] = [];
      for (const r of ix.rows) {
        const [identity, key, slot, , , , , , gen] = r;
        if (identity === skip) continue;
        const gone = this.toRemove.has(slot) ? this.toRemove.get(slot) : this.removed.has(slot) ? this.removed.get(slot) : undefined;
        if (gone !== undefined) {
          if (gone === null || gone === vid(identity, key, gen)) continue;
          this.toRemove.delete(slot);
        }
        take.push(r);
        blocked.add(slot);
      }
      const displaced: Entry[] = [];
      for (const [identity, key, slot] of ix.rows) {
        const owner = this.owners.get(slot);
        if (!owner || (owner.identity === identity && owner.key === key)) continue;
        this.owners.delete(slot);
        owner.slot = -1;
        displaced.push(owner);
      }
      for (const r of take) {
        const [identity, key, slot] = r;
        if (this.owners.has(slot)) continue; // (this query's already)
        const ours = this.entries!.get(identity)?.get(key);
        if (ours) {
          if (ours.slot >= 0) {
            this.owners.delete(ours.slot);
            this.free.push(ours.slot);
            this.toRemove.set(ours.slot, vid(identity, key, ours.gen));
          }
          ours.slot = slot;
          this.owners.set(slot, ours);
          // not read yet: the store's row describes it
          if (!ours.loaded && ours.json === undefined) Object.assign(ours, fromRow(r));
        } else this.add(fromRow(r));
        changed = true;
      }
      for (const e of displaced) {
        if (e.slot >= 0) continue;
        changed = true;
        if (e.loaded || e.json !== undefined) {
          e.dirty = true;
          this.dirty.add(e);
        } else this.unlink(e);
      }
    }
    if (ix.top > this.top) {
      for (let s = this.top; s < ix.top; s++) if (!this.owners.has(s)) this.free.push(s);
      this.top = ix.top;
      changed = true;
    }
    // An entry here the store does not list where it is: the tab that wrote that index removed it (a delete, a
    // sign-out), and its key with it. A value held here is written again (and listed); one not read yet is dropped.
    const at = new Map<number, string>();
    for (const [identity, key, slot] of ix.rows) at.set(slot, qid(identity, key));
    for (const [slot, e] of [...this.owners]) {
      if (at.get(slot) === qid(e.identity, e.key)) continue;
      changed = true;
      if (e.loaded || e.json !== undefined) {
        e.dirty = true;
        this.dirty.add(e);
      } else {
        this.unlink(e);
        this.free.push(slot);
      }
    }
    if (changed || blocked.size) this.free = this.free.filter((s) => !this.owners.has(s) && !blocked.has(s));
    if (this.dirty.size) this.schedule();
    return changed;
  }

  /**
   * Format 1 (one blob): its entries move to their own keys on the next flush (one the index has with a newer `at`
   * wins), and the blob goes once they are written.
   */
  private readV1(raw: string | null): void {
    if (raw === null || raw === "") return;
    this.legacy = true;
    this.legacyRaw = raw;
    this.indexDirty = true;
    let b: V1 | null = null;
    try {
      b = JSON.parse(raw) as V1;
    } catch {
      b = null;
    }
    if (b && b.v === 1 && b.by && typeof b.by === "object") {
      for (const [identity, m] of Object.entries(b.by)) {
        if (!m || typeof m !== "object") continue;
        for (const [key, e] of Object.entries(m)) {
          // Format 1 always stored `v` (the tagged JSON of the value): it encoded every value before writing.
          if (!e || typeof e.v !== "string" || !isNum(e.version) || typeof e.epoch !== "string" || typeof e.ik !== "string" || !isNum(e.at)) continue;
          const cur = this.entries!.get(identity)?.get(key);
          const at = Math.min(e.at, this.now());
          if (cur && cur.at > at) {
            if (!cur.loaded && cur.json === undefined) cur.fallback = { json: e.v, version: e.version, epoch: e.epoch, ik: e.ik, at };
            continue;
          }
          const moved = { version: e.version, epoch: e.epoch, ik: e.ik, at, size: e.v.length, gen: this.newGen(), value: undefined, loaded: false, json: e.v };
          if (cur) Object.assign(cur, moved);
          else this.add({ identity, key, slot: -1, ixAt: 0, ixSize: -1, dirty: false, ...moved });
          const x = cur ?? this.entries!.get(identity)!.get(key)!;
          x.dirty = true;
          this.dirty.add(x);
        }
      }
    }
    this.schedule();
  }

  /** A slot no entry uses (-1: `MAX_SLOTS` are in use). */
  private alloc(): number {
    let s = -1;
    while (this.free.length) {
      const f = this.free.pop()!;
      if (!this.owners.has(f)) {
        s = f;
        break;
      }
    }
    if (s < 0) {
      if (this.top >= MAX_SLOTS) return -1;
      s = this.top++;
    }
    this.toRemove.delete(s);
    return s;
  }

  // ------------------------------------------------------------------------------------------------ reads

  get(identity: string, key: string): CachedSnapshot | undefined | Promise<CachedSnapshot | undefined> {
    const m = this.load();
    if (isThenable(m)) return m.then(() => this.read(identity, key));
    return this.read(identity, key);
  }

  private read(identity: string, key: string): CachedSnapshot | undefined | Promise<CachedSnapshot | undefined> {
    const e = this.entries!.get(identity)?.get(key);
    if (!e) return undefined;
    if (e.loaded || e.json !== undefined) {
      if (this.now() - e.at > this.maxAgeMs) {
        this.delete(identity, key);
        return undefined;
      }
      if (!e.loaded) {
        try {
          e.value = parse(e.json!);
          e.loaded = true;
        } catch {
          this.delete(identity, key);
          return undefined;
        }
      }
      return this.snapshot(e);
    }
    // Not read yet: its age is the one in its own header (the index's `at` may lag behind a rewrite). A write of its
    // key still on its way (a moved value, written but not parsed) lands first: read before it, the key is missing.
    const raw = this.getRaw(this.slotKey(e.slot));
    if (isThenable(raw)) return raw.then((r) => this.fill(e, r));
    return this.fill(e, raw);
  }

  /** `getItem`, after any write or removal of that key still on its way (async store); never rejects. */
  private getRaw(key: string): Read | Promise<Read> {
    const get = () => this.getNow(key);
    const prev = this.inflight.get(key);
    return prev ? prev.then(get, get) : get();
  }

  /** `getItem` now; `undefined` when it fails (not known: never taken for a missing key). */
  private getNow(key: string): Read | Promise<Read> {
    try {
      const r = this.kv!.getItem(key);
      return isThenable(r) ? r.then((x) => x, () => undefined) : r;
    } catch {
      return undefined;
    }
  }

  /**
   * An entry's value from its key, checked against its header. The index's version and `at` count only for the value
   * generation they were written for (the same `gen` in both): a touch confirms that very value. Any other header
   * (rewritten after the index, by this tab or another) describes its own value: its version, epoch and tag are used.
   */
  private fill(e: Entry, raw: Read): CachedSnapshot | undefined {
    const cur = this.entries?.get(e.identity)?.get(e.key);
    if (cur !== e) return cur?.loaded ? this.snapshot(cur) : undefined;
    if (e.loaded) return this.snapshot(e);
    // The read failed: a miss this time (the value may well be there).
    if (raw === undefined) return undefined;
    const nl = raw ? raw.indexOf("\n") : -1;
    let header: unknown[] | null = null;
    try {
      const h: unknown = nl < 0 ? null : JSON.parse(raw!.slice(0, nl));
      // Anything but a tuple (`{}`, a number) is unreadable: the miss below.
      header = Array.isArray(h) ? h : null;
    } catch {
      header = null;
    }
    if (Array.isArray(header) && header[0] === 2 && (header[1] !== e.identity || header[2] !== e.key)) {
      // Another query's (another tab reused the slot, or wrote it after this index): a miss here, and the key is
      // left alone — it is not this instance's to remove — and not reused by it either.
      this.disown(e);
      return this.fallBack(e, true);
    }
    const [, , , version, epoch, ik, at, gen] = (header ?? []) as Header;
    let value: unknown;
    try {
      if (!header || header[0] !== 2 || !isNum(version) || typeof epoch !== "string" || typeof ik !== "string" || !isNum(at)) throw new Error("no entry");
      value = parse(raw!.slice(nl + 1));
    } catch {
      // Missing or unreadable: gone (or format 1's value, if it is still there).
      const x = this.fallBack(e, false);
      if (!x) this.forget(e);
      return x;
    }
    // An `at` in the future counts as now (it would never age out).
    const hat = Math.min(at, this.now());
    if (typeof gen === "string" && gen !== "" && gen === e.gen && epoch === e.epoch && ik === e.ik) {
      e.version = Math.max(e.version, version);
      e.at = Math.max(e.at, hat);
    } else {
      e.version = version;
      e.epoch = epoch;
      e.ik = ik;
      e.at = hat;
      e.gen = typeof gen === "string" ? gen : "";
    }
    e.size = raw!.length - nl - 1;
    e.value = value;
    e.loaded = true;
    e.fallback = undefined;
    if (this.now() - e.at > this.maxAgeMs) {
      this.forget(e);
      return undefined;
    }
    return this.snapshot(e);
  }

  /**
   * The value format 1 still has for an entry whose key did not have one: moved again (written at the next flush, to
   * its slot, or to a new one when the slot holds another query: `away`).
   */
  private fallBack(e: Entry, away: boolean): CachedSnapshot | undefined {
    const f = e.fallback;
    if (!f || this.now() - f.at > this.maxAgeMs) return undefined;
    let value: unknown;
    try {
      value = parse(f.json);
    } catch {
      return undefined;
    }
    if (away) {
      // disowned: back in, with no slot yet
      e.slot = -1;
      this.add(e);
    }
    Object.assign(e, { value, loaded: true, json: f.json, version: f.version, epoch: f.epoch, ik: f.ik, at: f.at, size: f.json.length, gen: this.newGen(), fallback: undefined, dirty: true });
    this.dirty.add(e);
    this.indexDirty = true;
    this.schedule();
    return this.snapshot(e);
  }

  private snapshot(e: Entry): CachedSnapshot {
    return { value: e.value, version: e.version, epoch: e.epoch, ik: e.ik, at: e.at };
  }

  // ------------------------------------------------------------------------------------------------ writes

  set(identity: string, key: string, entry: CachedSnapshot): void {
    this.change(() => {
      const cur = this.entries!.get(identity)?.get(key);
      if (cur && cur.loaded && cur.value === entry.value && cur.epoch === entry.epoch && cur.ik === entry.ik) {
        // The same value, confirmed later: the index only (bound to this value's generation).
        this.confirm(cur, entry);
        return;
      }
      const e: Entry = cur ?? {
        identity,
        key,
        slot: -1,
        version: 0,
        epoch: "",
        ik: "",
        at: 0,
        size: -1,
        gen: "",
        ixAt: 0,
        ixSize: -1,
        value: undefined,
        loaded: true,
        dirty: true,
      };
      if (!cur) this.add(e);
      e.value = entry.value;
      e.loaded = true;
      e.json = undefined;
      e.fallback = undefined;
      e.version = entry.version;
      e.epoch = entry.epoch;
      e.ik = entry.ik;
      e.at = entry.at;
      e.size = -1;
      e.gen = this.newGen();
      e.dirty = true;
      this.dirty.add(e);
      // The entry's header carries the version; the index changes for a new query (or when `at`/`size` drift).
      if (!cur) this.indexDirty = true;
    });
  }

  touch(identity: string, key: string, entry: CachedSnapshot): void {
    // Not loaded: nothing this session stored, so nothing the client's value can be.
    const cur = this.entries?.get(identity)?.get(key);
    if (!cur || !cur.loaded || cur.value !== entry.value || cur.epoch !== entry.epoch || cur.ik !== entry.ik) return;
    this.confirm(cur, entry);
    this.kick();
    this.schedule();
  }

  /** The value `e` holds is current as of `entry.version` / `entry.at`: a newer version, or `at` past the drift, is indexed. */
  private confirm(e: Entry, entry: CachedSnapshot): void {
    if (entry.version > e.version) {
      e.version = entry.version;
      this.indexDirty = true;
    }
    if (entry.at > e.at) {
      e.at = entry.at;
      if (e.at - e.ixAt >= this.drift) this.indexDirty = true;
    }
  }

  delete(identity: string, key: string): void {
    this.change(() => {
      const e = this.entries!.get(identity)?.get(key);
      if (e) this.forget(e);
    });
  }

  clear(identity?: string): void {
    const run = () => {
      const entries = (this.entries ??= new Map());
      for (const [id, m] of [...entries]) {
        if (identity !== undefined && id !== identity) continue;
        for (const e of [...m.values()]) this.forget(e);
      }
      // The index names queries (their args) too: a full clear writes it empty even with nothing loaded.
      if (identity === undefined) this.indexDirty = true;
      if (this.legacy || identity === undefined) {
        // Format 1 is not filtered by identity: a sign-out leaves none of it.
        this.legacy = false;
        this.remove(this.legacyKey);
      }
      this.kick();
      // Slots no entry here uses may hold anyone's value (a write the index never listed, another tab's written since
      // this one loaded): what the store lists now says how far they go, so it is read before the index is rewritten
      // (after this instance's own index write still on its way).
      const raw: Read | Promise<Read> = this.kv ? this.getRaw(this.indexKey) : null;
      if (!isThenable(raw)) return this.sweep(identity, raw);
      this.sweeping++;
      void raw.then((r) => {
        this.sweeping--;
        this.sweep(identity, r);
      });
    };
    const m = this.load();
    if (isThenable(m)) void m.then(run, run);
    else run();
  }

  /**
   * Below the larger of this instance's `top` and the stored index's `t`: a full sign-out removes every slot no entry
   * here uses; `clear(identity)` removes every slot whose own header names that identity (or is unreadable) — an index
   * can be stale (a tab that missed a sign-out still lists its old slots), the header is what the slot holds — and keeps
   * the others (another identity's, and still listed). Then writes.
   */
  private sweep(identity: string | undefined, raw: Read): void {
    // (the index could not be read: what this instance knows still goes)
    const stored = raw === undefined ? null : parseIndex(raw, this.now());
    if (raw !== undefined && this.absorb(raw, identity ?? true)) this.indexDirty = true;
    // The stored index names that identity's queries: rewritten without them, also when nothing here had them.
    if (stored?.rows.some((r) => identity === undefined || r[0] === identity)) this.indexDirty = true;
    const end = Math.max(this.top, stored?.top ?? 0);
    if (end > this.top) {
      for (let s = this.top; s < end; s++) if (!this.owners.has(s)) this.free.push(s);
      this.top = end;
      this.indexDirty = true;
    }
    if (identity === undefined) {
      for (let s = 0; s < end; s++) if (!this.owners.has(s)) this.toRemove.set(s, null);
      this.swept = true;
      this.flush();
      return;
    }
    const reads: Array<Read | Promise<Read>> = [];
    let wait = false;
    for (let s = 0; s < end; s++) {
      const r = this.getRaw(this.slotKey(s));
      if (isThenable(r)) wait = true;
      reads.push(r);
    }
    const listed = new Map<number, string>();
    for (const [id, , slot] of stored?.rows ?? []) listed.set(slot, id);
    const decide = (raws: Read[]) => {
      raws.forEach((r, s) => this.judge(identity, s, r, listed.get(s)));
      this.flush();
    };
    if (!wait) return decide(reads as Read[]);
    this.sweeping++;
    void Promise.all(reads).then((rs) => {
      this.sweeping--;
      decide(rs);
    });
  }

  /**
   * `clear(identity)`: what slot `s` holds (`raw`) decides whether it goes; an entry here it no longer holds moves. One
   * that could not be read goes unless the stored index lists it under another identity (`listed`).
   */
  private judge(identity: string, s: number, raw: Read, listed: string | undefined): void {
    if (raw === null || raw === "") return;
    if (raw === undefined) {
      if (listed === undefined || listed === identity) this.toRemove.set(s, null);
      return;
    }
    const nl = raw.indexOf("\n");
    let h: unknown = null;
    try {
      h = nl < 0 ? null : JSON.parse(raw.slice(0, nl));
    } catch {
      h = null;
    }
    const owner = this.owners.get(s);
    if (Array.isArray(h) && h[0] === 2 && typeof h[1] === "string" && typeof h[2] === "string" && h[1] !== identity) {
      if (owner && (owner.identity !== h[1] || owner.key !== h[2])) this.displace(owner);
      return;
    }
    if (owner) this.displace(owner);
    this.toRemove.set(s, null);
    this.free.push(s);
  }

  /** An entry whose slot holds another value now: written again to a new slot (one not read yet is dropped). */
  private displace(e: Entry): void {
    if (this.owners.get(e.slot) === e) this.owners.delete(e.slot);
    e.slot = -1;
    if (e.loaded || e.json !== undefined) {
      e.dirty = true;
      this.dirty.add(e);
      this.indexDirty = true;
      this.schedule();
    } else this.unlink(e);
  }

  /** Drops an entry from memory (its key is removed on the next flush). */
  private forget(e: Entry): void {
    if (!this.unlink(e)) return;
    if (e.slot >= 0) {
      this.free.push(e.slot);
      this.toRemove.set(e.slot, vid(e.identity, e.key, e.gen));
    }
    this.indexDirty = true;
    this.schedule();
  }

  /** Drops an entry whose slot holds another query: the slot is neither removed nor reused by this instance. */
  private disown(e: Entry): void {
    this.unlink(e);
  }

  private unlink(e: Entry): boolean {
    const m = this.entries?.get(e.identity);
    if (!m || m.get(e.key) !== e) return false;
    m.delete(e.key);
    if (!m.size) this.entries!.delete(e.identity);
    if (e.slot >= 0 && this.owners.get(e.slot) === e) this.owners.delete(e.slot);
    this.dirty.delete(e);
    return true;
  }

  private change(f: () => void): void {
    const m = this.load();
    if (isThenable(m)) {
      void m.then(() => {
        f();
        this.kick();
        this.schedule();
      });
      return;
    }
    f();
    this.kick();
    this.schedule();
  }

  /** New work: a backed-off retry goes back to 250 ms. */
  private kick(): void {
    if (!this.retries) return;
    this.retries = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** In 250 ms; after refused index writes in a row, 250 ms × 2ⁿ⁻¹ up to 30 s (a store that keeps refusing). */
  private schedule(): void {
    if (this.flushing || this.sweeping || this.timer || (!this.indexDirty && !this.toRemove.size && !this.dirty.size)) return;
    const delay = this.retries ? Math.min(RETRY_MS * 2 ** (this.retries - 1), MAX_RETRY_MS) : RETRY_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
  }

  /** Encodes what changed; drops expired and oversized entries, then the least recently stored past `maxBytes`. */
  private evict(): Map<Entry, string> {
    const out = new Map<Entry, string>();
    const all: Entry[] = [];
    let size = 0;
    const now = this.now();
    for (const m of [...this.entries!.values()]) {
      for (const e of [...m.values()]) {
        if (e.dirty) {
          let json = e.json;
          if (json === undefined) {
            try {
              json = stringify(e.value);
            } catch {
              this.forget(e);
              continue;
            }
          }
          e.size = json.length;
          out.set(e, json);
        }
        // An entry not read yet may have been rewritten after the index (its `at` lags by up to `drift`).
        const maxAge = e.loaded || e.json !== undefined ? this.maxAgeMs : this.maxAgeMs + this.drift;
        if (now - e.at > maxAge || e.size > this.maxBytes) {
          out.delete(e);
          this.forget(e);
          continue;
        }
        all.push(e);
        size += Math.max(0, e.size);
      }
    }
    if (size > this.maxBytes) {
      all.sort((x, y) => x.at - y.at);
      for (const e of all) {
        if (size <= this.maxBytes) break;
        size -= Math.max(0, e.size);
        out.delete(e);
        this.forget(e);
      }
    }
    return out;
  }

  /** Writes what changed now (the client calls it on close and when the page is hidden). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // A sign-out reading the store's index: it writes once it has (an index written now would hide what it lists).
    if (!this.entries || this.sweeping) return;
    this.flushing = true;
    try {
      this.write();
    } finally {
      this.flushing = false;
    }
    // Something could not be written (an index the store refused): try again later.
    this.schedule();
  }

  /**
   * Order, so that a stop at any point leaves nothing wrong behind: (1) keys of removed entries; (2) the index first
   * when new slots appear past the stored one's `t` (a sign-out must find every slot that may hold a value); (3) the
   * changed values; (4) the index. An index row naming a value not written yet (a stop after (2)) is a miss on load,
   * and one naming an older value (a stop after (4) with (3) lost, an async write refused) uses that value's own
   * header: the generation tells them apart.
   */
  private write(): void {
    const entries = this.entries!;
    this.flushes++;
    const writes = this.evict();
    const kv = this.kv;
    if (!kv) {
      for (const e of writes.keys()) {
        e.dirty = false;
        e.json = undefined;
      }
      this.dirty.clear();
      this.toRemove.clear();
      this.indexDirty = false;
      return;
    }
    // A sync store: what another tab listed since is taken in first (one read), so no key is removed or written here
    // that it uses now, and a new query's slot is not one it lists.
    let read = false;
    if (this.sync) {
      const raw = this.getNow(this.indexKey);
      if (raw !== undefined && !isThenable(raw)) {
        read = true;
        if (this.absorb(raw)) this.indexDirty = true;
        // (a value moved off a slot that tab took: written again below, at its new slot)
        for (const e of [...this.dirty]) {
          if (writes.has(e)) continue;
          try {
            const json = e.json ?? stringify(e.value);
            e.size = json.length;
            writes.set(e, json);
          } catch {
            this.forget(e);
          }
        }
      }
    }
    for (const [s, q] of this.toRemove) {
      if (this.owners.has(s)) continue;
      this.remove(this.slotKey(s), q ?? undefined);
      this.removed.set(s, q);
    }
    this.toRemove.clear();
    const swept = this.swept;
    this.swept = false;
    // New queries (and moved ones) get their slots now. `MAX_SLOTS` in use: not stored.
    for (const e of [...writes.keys()]) {
      if (e.slot >= 0) continue;
      const s = this.alloc();
      if (s < 0) {
        writes.delete(e);
        this.forget(e);
        continue;
      }
      e.slot = s;
      this.owners.set(s, e);
      // (a new slot: listed by the index below)
      this.indexDirty = true;
    }
    // Right after a full sign-out removed every slot, with no entry placed since: `t` starts over — only with a sync
    // store, and only once the index saying so is stored (written later, it could hide a slot another tab wrote
    // meanwhile under the old `t`). Otherwise free slots below `t` may still hold values nobody lists and stay below it.
    if (swept && this.sync && !this.owners.size && read) {
      this.indexDirty = true;
      if (this.writeIndex(read, true) === true) {
        this.top = 0;
        this.ixTop = 0;
        this.free = [];
      }
    }
    // New slots: listed first. Their values go after that index (an async store need not keep the order of writes),
    // and not at all when it is refused (a sign-out elsewhere could not find them): they stay to write.
    const from = this.ixTop;
    const announce = this.top > from ? this.writeIndex(read) : null;
    let listed = announce !== false;
    // (registered before the writes' own waits on it, so it is known when they run)
    if (isThenable(announce)) void announce.then((ok) => (listed = ok));
    const after = isThenable(announce) ? announce : undefined;
    for (const [e, json] of writes) {
      // Made room for an earlier one meanwhile: gone.
      if (entries.get(e.identity)?.get(e.key) !== e) continue;
      const wasMoved = e.json !== undefined;
      e.dirty = false;
      e.json = undefined;
      this.dirty.delete(e);
      const gen = e.gen;
      const header: Header = [2, e.identity, e.key, e.version, e.epoch, e.ik, e.at, gen];
      const data = `${JSON.stringify(header)}\n${json}`;
      // Refused later (an async store out of space): not stored, so not listed either — unless a newer value of
      // the same query took its place meanwhile (that one is written on its own).
      // A moved value refused keeps format 1 even then: the blob is still the only copy of it.
      const failed = () => {
        if (wasMoved) this.legacyFailed = true;
        if (e.gen !== gen) return;
        this.forget(e);
      };
      const again = () => {
        if (entries.get(e.identity)?.get(e.key) !== e || e.gen !== gen) return;
        if (wasMoved) e.json ??= json;
        e.dirty = true;
        this.dirty.add(e);
        this.schedule();
      };
      if (e.slot >= from && !listed) {
        again();
        continue;
      }
      const wait = e.slot >= from ? after : undefined;
      const slot = e.slot;
      // When it waited: not if the entry is gone meanwhile (deleted, dropped: the slot may hold another tab's value
      // now), nor if that index was refused, nor if the entry left the slot (another tab's index, read since, lists
      // another query there, or this query in another slot): then written again later, where it is then.
      const skip = () => {
        if (entries.get(e.identity)?.get(e.key) !== e) return true;
        if ((wait && !listed) || e.slot !== slot) return again(), true;
        return false;
      };
      let r = this.put(this.slotKey(slot), data, failed, wait, skip);
      if (r === false) {
        // Out of space: make room from the oldest others, once; else give this one up.
        this.evictOldest(e);
        r = this.put(this.slotKey(slot), data, failed, wait, skip);
        if (r === false) {
          if (wasMoved) this.legacyFailed = true;
          this.forget(e);
          continue;
        }
      }
      if (wasMoved && r !== true) this.trackLegacy(r);
      if (e.at - e.ixAt >= this.drift || e.ixSize < 0 || Math.abs(e.size - e.ixSize) > Math.max(256, e.ixSize / 4)) this.indexDirty = true;
    }
    if (this.indexDirty) this.writeIndex(read);
    this.dropLegacy();
  }

  /** A write format 1 waits for (a moved value, an index listing them): it is checked again once that one settles. */
  private trackLegacy(r: Promise<boolean>): void {
    this.legacyWrites.add(r);
    void r.then(() => {
      this.legacyWrites.delete(r);
      this.dropLegacy();
    });
  }

  /**
   * Format 1 goes once every value it held and an index listing them are stored (none of those writes still on its
   * way, none refused), and only the very blob that was read: one an older tab wrote since stays for the next load.
   */
  private dropLegacy(): void {
    if (!this.legacy || this.legacyFailed || this.indexDirty || this.legacyWrites.size) return;
    for (const e of this.dirty) if (e.json !== undefined) return;
    this.legacy = false;
    const read = this.legacyRaw;
    this.legacyRaw = null;
    const drop = (cur: Read) => {
      if (cur === read) this.remove(this.legacyKey);
    };
    const cur = this.getRaw(this.legacyKey);
    if (isThenable(cur)) void cur.then(drop);
    else drop(cur);
  }

  /**
   * The index as memory has it, after taking in what another instance stored since (`absorb`: the store's index is read
   * just before, after this one's own index write still on its way). Refused (sync or later), or the stored one could
   * not be read: it stays to write, and a retry is scheduled.
   */
  private writeIndex(read = false, empty = false): boolean | Promise<boolean> {
    const kv = this.kv!;
    const flush = this.flushes;
    const refused = () => {
      this.indexDirty = true;
      // once per flush (it may write the index twice)
      if (this.refusedFlush !== flush) this.retries++;
      this.refusedFlush = flush;
    };
    const late = () => {
      refused();
      this.ixTop = 0;
      this.schedule();
    };
    /** Takes in the stored index (`undefined`: unreadable), then writes this one. */
    const write = (stored: string | null | undefined): boolean | Promise<boolean> => {
      if (stored === undefined) return false;
      this.absorb(stored);
      this.removed.clear();
      const rows: IndexRow[] = [];
      for (const m of this.entries!.values()) {
        // (a query set after the flush that wrote this, not placed yet: the next index lists it)
        for (const e of m.values()) if (e.slot >= 0) rows.push([e.identity, e.key, e.slot, e.version, e.epoch, e.ik, e.at, e.size, e.gen]);
      }
      const data = JSON.stringify({ v: 2, t: empty && !rows.length ? 0 : this.top, n: rows });
      const w = this.setItem(this.indexKey, data, late);
      if (w === true) this.ixRaw = data;
      if (!isThenable(w)) return w;
      return w.then((ok) => {
        if (ok) this.ixRaw = data;
        return ok;
      });
    };
    let r: boolean | Promise<boolean>;
    const prev = this.inflight.get(this.indexKey);
    let raw: string | null | Promise<string | null> | undefined;
    if (read) raw = this.ixRaw; // (just read and taken in by this flush: a sync store, nothing changed since)
    else if (!prev) {
      try {
        raw = kv.getItem(this.indexKey);
      } catch {
        raw = undefined;
      }
    }
    if (!prev && !isThenable(raw)) {
      r = write(raw);
      if (isThenable(r)) this.track(this.indexKey, r);
    } else {
      // (After the write on its way: read directly, as this write is the key's last one from now on.)
      const read: Promise<string | null | undefined> = prev
        ? prev.then(() => this.getNow(this.indexKey))
        : (raw as Promise<string | null>).then((x) => x, () => undefined);
      r = read
        .then((x) => {
          const w = write(x);
          if (w === false) late();
          return w;
        })
        .then(undefined, () => (late(), false));
      this.track(this.indexKey, r);
    }
    if (r === false) {
      refused();
      return false;
    }
    if (r === true) this.retries = 0;
    else {
      void r.then((ok) => ok && (this.retries = 0));
      if (this.legacy) this.trackLegacy(r);
    }
    this.indexDirty = false;
    this.ixTop = this.top;
    for (const m of this.entries!.values()) {
      for (const e of m.values()) {
        if (e.slot < 0) continue;
        e.ixAt = e.at;
        e.ixSize = e.size;
      }
    }
    return r;
  }

  /** Frees about a quarter of the stored bytes, oldest first (never `keep`). */
  private evictOldest(keep: Entry): void {
    const all: Entry[] = [];
    let total = 0;
    for (const m of this.entries!.values()) for (const e of m.values()) if (e !== keep) (all.push(e), (total += Math.max(0, e.size)));
    all.sort((x, y) => x.at - y.at);
    let freed = 0;
    for (const e of all) {
      if (freed >= total / 4) break;
      freed += Math.max(0, e.size);
      this.forget(e);
      if (e.slot < 0) continue;
      this.toRemove.delete(e.slot);
      this.remove(this.slotKey(e.slot), vid(e.identity, e.key, e.gen));
      this.removed.set(e.slot, vid(e.identity, e.key, e.gen));
    }
  }

  /**
   * `setItem`, best effort: false when it threw (quota), true when a sync store took it, and for an async store a
   * promise of whether it did (`failed` runs if it is refused).
   */
  private put(key: string, value: string, failed: () => void, after?: Promise<unknown>, skip?: () => boolean): boolean | Promise<boolean> {
    const last = this.inflight.get(key);
    const prev = last && after ? Promise.all([last, after]) : (last ?? after);
    if (prev) {
      // The last write of this key is still on its way: this one goes after it (an async store need not keep the
      // order of writes to one key, and the older value must not land last). `after`: the index listing its slot
      // (`skip`: it was refused, this write is not made).
      const r = prev.then(() => {
        if (skip?.()) return false;
        const x = this.setItem(key, value, failed);
        if (x === false) failed();
        return x;
      });
      this.track(key, r);
      return r;
    }
    const r = this.setItem(key, value, failed);
    if (isThenable(r)) this.track(key, r);
    return r;
  }

  private setItem(key: string, value: string, failed: () => void): boolean | Promise<boolean> {
    try {
      const r = this.kv!.setItem(key, value);
      if (!isThenable(r)) return true;
      return r.then(
        () => true,
        () => {
          failed();
          return false;
        },
      );
    } catch {
      return false;
    }
  }

  private track(key: string, r: Promise<unknown>): void {
    this.inflight.set(key, r);
    void r.then(() => {
      if (this.inflight.get(key) === r) this.inflight.delete(key);
    });
  }

  /**
   * Removes a key, after a write of it still on its way. `only`: just when it still holds that value (`vid`: missing,
   * unreadable or that one) — an entry this instance forgot, whose slot another tab may have written since (with or
   * without listing it yet); a sign-out removes whatever is there.
   */
  private remove(key: string, only?: string): void {
    const kv = this.kv;
    const drop = () => {
      try {
        const r = kv?.removeItem ? kv.removeItem(key) : kv?.setItem(key, "");
        return isThenable(r) ? r.catch(() => undefined) : undefined;
      } catch {
        // best effort: an unremoved entry is not listed, and its slot is reused
        return undefined;
      }
    };
    const holds = (raw: Read) => {
      if (raw === undefined) return false; // not known: left alone
      if (raw === null || raw === "") return true;
      let h: unknown = null;
      try {
        const nl = raw.indexOf("\n");
        h = nl < 0 ? null : JSON.parse(raw.slice(0, nl));
      } catch {
        h = null;
      }
      if (!Array.isArray(h) || h[0] !== 2) return true;
      return vid(String(h[1]), String(h[2]), typeof h[7] === "string" ? h[7] : "") === only;
    };
    const run = (): Promise<unknown> | undefined => {
      if (only === undefined) return drop();
      const raw = this.getNow(key);
      if (!isThenable(raw)) return holds(raw) ? drop() : undefined;
      return raw.then((x) => (holds(x) ? drop() : undefined));
    };
    const prev = this.inflight.get(key);
    // After a write of the same key still on its way (a sign-out must not be undone by it).
    if (prev) this.track(key, prev.then(run));
    else {
      const r = run();
      if (r) this.track(key, r);
    }
  }
}
