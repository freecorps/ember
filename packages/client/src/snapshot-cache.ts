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
  /** The value changed: its key is rewritten on the next flush. */
  dirty: boolean;
}

type IndexRow = [identity: string, key: string, slot: number, version: number, epoch: string, ik: string, at: number, size: number, gen: string];
type Header = [2, identity: string, key: string, version: number, epoch: string, ik: string, at: number, gen: string];
type V1 = { v: 1; by: Record<string, Record<string, { v?: unknown; version?: unknown; epoch?: unknown; ik?: unknown; at?: unknown }>> };

const isThenable = (x: unknown): x is Promise<unknown> => typeof (x as { then?: unknown } | null)?.then === "function";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

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
  /** Slots whose key must be removed (unless reused meanwhile). */
  private readonly toRemove = new Set<number>();
  /** Format 1 was read: its key goes once what it held is durably in format 2. */
  private legacy = false;
  /** A moved value could not be written this session: the format 1 key stays (the next load moves it again). */
  private legacyFailed = false;
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
    this.owners.set(e.slot, e);
  }

  /** Format 2's index. */
  private readIndex(raw: string | null): void {
    if (!raw) return;
    let x: { v?: unknown; t?: unknown; n?: unknown };
    try {
      x = JSON.parse(raw) as typeof x;
    } catch {
      // unreadable: start over (its entries are overwritten as slots are reused)
      this.indexDirty = true;
      return;
    }
    if (x?.v !== 2 || !Array.isArray(x.n)) return;
    for (const r of x.n as unknown[]) {
      if (!Array.isArray(r) || r.length < 8) continue;
      const [identity, key, slot, version, epoch, ik, at, size, gen] = r as IndexRow;
      if (typeof identity !== "string" || typeof key !== "string" || !Number.isSafeInteger(slot) || slot < 0) continue;
      if (!isNum(version) || typeof epoch !== "string" || typeof ik !== "string" || !isNum(at)) continue;
      if (this.owners.has(slot) || this.entries!.get(identity)?.has(key)) continue;
      const sz = isNum(size) && size >= 0 ? size : -1;
      this.add({ identity, key, slot, version, epoch, ik, at, size: sz, gen: typeof gen === "string" ? gen : "", ixAt: at, ixSize: sz, value: undefined, loaded: false, dirty: false });
      if (slot >= this.top) this.top = slot + 1;
    }
    if (Number.isSafeInteger(x.t) && (x.t as number) > this.top) this.top = x.t as number;
    this.ixTop = this.top;
    for (let s = 0; s < this.top; s++) if (!this.owners.has(s)) this.free.push(s);
  }

  /**
   * Format 1 (one blob): its entries move to their own keys on the next flush (one the index has with a newer `at`
   * wins), and the blob goes once they are written.
   */
  private readV1(raw: string | null): void {
    if (raw === null || raw === "") return;
    this.legacy = true;
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
          if (cur && cur.at > e.at) continue;
          const moved = { version: e.version, epoch: e.epoch, ik: e.ik, at: e.at, size: e.v.length, gen: this.newGen(), value: undefined, loaded: false, json: e.v };
          if (cur) Object.assign(cur, moved);
          else this.add({ identity, key, slot: this.alloc(), ixAt: 0, ixSize: -1, dirty: false, ...moved });
          const x = cur ?? this.entries!.get(identity)!.get(key)!;
          x.dirty = true;
          this.dirty.add(x);
        }
      }
    }
    this.schedule();
  }

  private alloc(): number {
    const s = this.free.length ? this.free.pop()! : this.top++;
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
    // Not read yet: its age is the one in its own header (the index's `at` may lag behind a rewrite).
    let raw: string | null | Promise<string | null>;
    try {
      raw = this.kv!.getItem(this.slotKey(e.slot));
    } catch {
      raw = null;
    }
    if (isThenable(raw)) return raw.then((r) => this.fill(e, r), () => this.fill(e, null));
    return this.fill(e, raw);
  }

  /**
   * An entry's value from its key, checked against its header. The index's version and `at` count only for the value
   * generation they were written for (the same `gen` in both): a touch confirms that very value. Any other header
   * (rewritten after the index, by this tab or another) describes its own value: its version, epoch and tag are used.
   */
  private fill(e: Entry, raw: string | null): CachedSnapshot | undefined {
    const cur = this.entries?.get(e.identity)?.get(e.key);
    if (cur !== e) return cur?.loaded ? this.snapshot(cur) : undefined;
    if (e.loaded) return this.snapshot(e);
    const nl = raw ? raw.indexOf("\n") : -1;
    let header: unknown[] | null = null;
    try {
      header = nl < 0 ? null : (JSON.parse(raw!.slice(0, nl)) as unknown[]);
    } catch {
      header = null;
    }
    if (Array.isArray(header) && header[0] === 2 && (header[1] !== e.identity || header[2] !== e.key)) {
      // Another query's (another tab reused the slot, or wrote it after this index): a miss here, and the key is
      // left alone — it is not this instance's to remove — and not reused by it either.
      this.disown(e);
      return undefined;
    }
    const [, , , version, epoch, ik, at, gen] = (header ?? []) as Header;
    let value: unknown;
    try {
      if (!header || header[0] !== 2 || !isNum(version) || typeof epoch !== "string" || typeof ik !== "string" || !isNum(at)) throw new Error("no entry");
      value = parse(raw!.slice(nl + 1));
    } catch {
      // Missing or unreadable: gone.
      this.forget(e);
      return undefined;
    }
    if (typeof gen === "string" && gen !== "" && gen === e.gen && epoch === e.epoch && ik === e.ik) {
      e.version = Math.max(e.version, version);
      e.at = Math.max(e.at, at);
    } else {
      e.version = version;
      e.epoch = epoch;
      e.ik = ik;
      e.at = at;
      e.gen = typeof gen === "string" ? gen : "";
    }
    e.size = raw!.length - nl - 1;
    e.value = value;
    e.loaded = true;
    if (this.now() - e.at > this.maxAgeMs) {
      this.forget(e);
      return undefined;
    }
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
        slot: this.alloc(),
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
      // Slots no entry uses may hold anyone's value (a write the index never listed, another tab's): they go too.
      for (let s = 0; s < this.top; s++) if (!this.owners.has(s)) this.toRemove.add(s);
      // The index names queries (their args) too: a full clear writes it empty even with nothing loaded.
      if (identity === undefined) this.indexDirty = true;
      if (this.legacy || identity === undefined) {
        // Format 1 is not filtered by identity: a sign-out leaves none of it.
        this.legacy = false;
        this.remove(this.legacyKey);
      }
      this.flush();
    };
    const m = this.load();
    if (isThenable(m)) void m.then(run, run);
    else run();
  }

  /** Drops an entry from memory (its key is removed on the next flush). */
  private forget(e: Entry): void {
    if (!this.unlink(e)) return;
    this.free.push(e.slot);
    this.toRemove.add(e.slot);
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
    if (this.owners.get(e.slot) === e) this.owners.delete(e.slot);
    this.dirty.delete(e);
    return true;
  }

  private change(f: () => void): void {
    const m = this.load();
    if (isThenable(m)) {
      void m.then(() => {
        f();
        this.schedule();
      });
      return;
    }
    f();
    this.schedule();
  }

  private schedule(): void {
    if (this.flushing || this.timer || (!this.indexDirty && !this.toRemove.size && !this.dirty.size)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
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
    if (!this.entries) return;
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
    for (const s of this.toRemove) if (!this.owners.has(s)) this.remove(this.slotKey(s));
    this.toRemove.clear();
    if (!this.owners.size) {
      this.top = 0;
      this.free = [];
    }
    let ix: boolean | Promise<boolean> = true;
    if (this.top > this.ixTop) ix = this.writeIndex();
    const moved: Array<Promise<boolean>> = [];
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
      const failed = () => {
        if (e.gen !== gen) return;
        if (wasMoved) this.legacyFailed = true;
        this.forget(e);
      };
      let r = this.put(this.slotKey(e.slot), data, failed);
      if (r === false) {
        // Out of space: make room from the oldest others, once; else give this one up.
        this.evictOldest(e);
        r = this.put(this.slotKey(e.slot), data, failed);
        if (r === false) {
          if (wasMoved) this.legacyFailed = true;
          this.forget(e);
          continue;
        }
      }
      if (wasMoved && r !== true) moved.push(r);
      if (e.at - e.ixAt >= this.drift || e.ixSize < 0 || Math.abs(e.size - e.ixSize) > Math.max(256, e.ixSize / 4)) this.indexDirty = true;
    }
    if (this.indexDirty) ix = this.writeIndex();
    if (this.legacy && !this.legacyFailed && ix !== false && !this.indexDirty) {
      // Format 1 goes only once the values it held and an index listing them are stored.
      const pending = ix === true ? moved : [...moved, ix];
      const drop = () => {
        if (!this.legacy || this.legacyFailed) return;
        this.legacy = false;
        this.remove(this.legacyKey);
      };
      if (!pending.length) drop();
      else void Promise.all(pending).then((oks) => oks.every(Boolean) && drop());
    }
  }

  /** The index as memory has it. Refused (sync or later): it stays to write, and a retry is scheduled. */
  private writeIndex(): boolean | Promise<boolean> {
    const rows: IndexRow[] = [];
    for (const m of this.entries!.values()) for (const e of m.values()) rows.push([e.identity, e.key, e.slot, e.version, e.epoch, e.ik, e.at, e.size, e.gen]);
    const top = this.top;
    const r = this.put(this.indexKey, JSON.stringify({ v: 2, t: top, n: rows }), () => {
      this.indexDirty = true;
      this.ixTop = 0;
      this.schedule();
    });
    if (r === false) {
      this.indexDirty = true;
      return false;
    }
    this.indexDirty = false;
    this.ixTop = top;
    for (const m of this.entries!.values()) {
      for (const e of m.values()) {
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
      this.toRemove.delete(e.slot);
      this.remove(this.slotKey(e.slot));
    }
  }

  /**
   * `setItem`, best effort: false when it threw (quota), true when a sync store took it, and for an async store a
   * promise of whether it did (`failed` runs if it is refused).
   */
  private put(key: string, value: string, failed: () => void): boolean | Promise<boolean> {
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

  private remove(key: string): void {
    const kv = this.kv;
    try {
      const r = kv?.removeItem ? kv.removeItem(key) : kv?.setItem(key, "");
      if (isThenable(r)) r.catch(() => undefined);
    } catch {
      // best effort: an unremoved entry is not listed, and its slot is reused
    }
  }
}
