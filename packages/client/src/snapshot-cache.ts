// A light snapshot cache for the client (no offline engine): the last confirmed value of each subscription, so a
// repeat visit paints from it with no round trip (`source: "cache"`) and subscribes with `resume` (the shard answers
// `unchanged` when nothing it read changed). Kept per identity, bounded, never holds errors, cleared on sign-out.
//
// Storage layout (key-value store, format 2): one key per stored query, and a small index.
//
//   <prefix>:snapshots:v2   {"v":2,"n":[[identity, key, slot, version, epoch, ik, at, size], ...]}
//   <prefix>:snap:<slot>    [2, identity, key, version, epoch, ik, at] + "\n" + the value's JSON (tagged)
//
// A changed value rewrites its own key only; the index is rewritten when queries come and go, or when versions move
// without a new value (`set` with the very value object already stored: the shard confirmed it is still current, e.g.
// on page hide). Each entry carries its own header, so it is self-describing: an entry whose header does not name the
// index's (identity, key) is ignored (a crash between the entry and the index write, a slot reused by another tab),
// and an index version is used only over a header of the same epoch and identity tag. The value's JSON is appended
// raw after the header line: no string-in-JSON escaping. Values are parsed once and kept.
//
// Format 1 (one blob, `<prefix>:snapshots`) is read once and moved to format 2, then removed.
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
  /** JSON length of the value (-1: not encoded yet). */
  size: number;
  /** The value, once parsed or set (`loaded`). */
  value: unknown;
  loaded: boolean;
  /** The value's JSON waiting to be written (moved from format 1), when `value` is not parsed yet. */
  json?: string | undefined;
  /** The value changed: its key is rewritten on the next flush. */
  dirty: boolean;
}

type IndexRow = [identity: string, key: string, slot: number, version: number, epoch: string, ik: string, at: number, size: number];
type Header = [2, identity: string, key: string, version: number, epoch: string, ik: string, at: number];
type V1 = { v: 1; by: Record<string, Record<string, { v?: unknown; version?: unknown; epoch?: unknown; ik?: unknown; at?: unknown }>> };

const isThenable = (x: unknown): x is Promise<unknown> => typeof (x as { then?: unknown } | null)?.then === "function";

class SplitCache implements SnapshotCache {
  private entries: Map<string, Map<string, Entry>> | null = null;
  private loading: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The index must be written (membership, versions or sizes changed). */
  private indexDirty = false;
  /** Slots whose key must be removed. */
  private freed = new Set<number>();
  /** Format 1 was read: its key goes once format 2 is written. */
  private legacy = false;
  private flushing = false;
  private readonly prefix: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    private readonly kv: KeyValueStore | null,
    opts: SnapshotCacheOptions,
  ) {
    this.prefix = opts.prefix ?? "ember";
    this.maxBytes = opts.maxBytes ?? 512 * 1024;
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600 * 1000;
    this.now = opts.now ?? Date.now;
  }

  private get indexKey() {
    return `${this.prefix}:snapshots:v2`;
  }
  private slotKey(slot: number) {
    return `${this.prefix}:snap:${slot}`;
  }

  // ------------------------------------------------------------------------------------------------ loading

  /** The entries, loaded on first use (synchronously when the store is). */
  private load(): Map<string, Map<string, Entry>> | Promise<Map<string, Map<string, Entry>>> {
    if (this.entries) return this.entries;
    if (!this.kv) return (this.entries = new Map());
    const kv = this.kv;
    const done = (index: string | null, v1: string | null | undefined) => {
      if (this.entries) return this.entries;
      this.entries = new Map();
      if (!this.readIndex(index) && v1 !== undefined) this.readV1(v1);
      return this.entries;
    };
    let index: string | null | Promise<string | null>;
    try {
      index = kv.getItem(this.indexKey);
    } catch {
      index = null;
    }
    const withV1 = (i: string | null): Map<string, Map<string, Entry>> | Promise<Map<string, Map<string, Entry>>> => {
      if (i) return done(i, undefined);
      let old: string | null | Promise<string | null>;
      try {
        old = kv.getItem(`${this.prefix}:snapshots`);
      } catch {
        old = null;
      }
      if (isThenable(old)) return old.then((o) => done(null, o), () => done(null, null));
      return done(null, old);
    };
    if (isThenable(index)) {
      this.loading ??= index.then(withV1, () => withV1(null)).then(() => undefined);
      return this.loading.then(() => this.entries!);
    }
    return withV1(index);
  }

  private add(e: Entry): void {
    const m = this.entries!;
    let byKey = m.get(e.identity);
    if (!byKey) m.set(e.identity, (byKey = new Map()));
    byKey.set(e.key, e);
  }

  /** Format 2's index: true when there was one (even empty). */
  private readIndex(raw: string | null): boolean {
    if (!raw) return false;
    let x: { v?: unknown; n?: unknown };
    try {
      x = JSON.parse(raw) as typeof x;
    } catch {
      // unreadable: start over (its entries are overwritten as slots are reused)
      this.indexDirty = true;
      return true;
    }
    if (x?.v !== 2 || !Array.isArray(x.n)) return false;
    const used = new Set<number>();
    for (const r of x.n as unknown[]) {
      if (!Array.isArray(r) || r.length < 8) continue;
      const [identity, key, slot, version, epoch, ik, at, size] = r as IndexRow;
      if (typeof identity !== "string" || typeof key !== "string" || !Number.isInteger(slot) || slot < 0) continue;
      if (typeof version !== "number" || typeof epoch !== "string" || typeof ik !== "string" || typeof at !== "number") continue;
      if (used.has(slot)) continue;
      used.add(slot);
      this.add({ identity, key, slot, version, epoch, ik, at, size: typeof size === "number" ? size : -1, value: undefined, loaded: false, dirty: false });
    }
    return true;
  }

  /** Format 1 (one blob): every entry moves to its own key on the next flush; the blob goes after that. */
  private readV1(raw: string | null): void {
    if (raw === null) return;
    this.legacy = true;
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
          if (!e || typeof e.v !== "string" || typeof e.version !== "number" || typeof e.epoch !== "string" || typeof e.ik !== "string" || typeof e.at !== "number") continue;
          this.add({ identity, key, slot: this.freeSlot(), version: e.version, epoch: e.epoch, ik: e.ik, at: e.at, size: e.v.length, value: undefined, loaded: false, json: e.v, dirty: true });
        }
      }
    }
    this.indexDirty = true;
    this.schedule();
  }

  /** The smallest slot no entry uses (slots are reused, so the keys stay bounded by the number of entries). */
  private freeSlot(): number {
    const used = new Set<number>();
    for (const m of this.entries!.values()) for (const e of m.values()) used.add(e.slot);
    let s = 0;
    while (used.has(s)) s++;
    this.freed.delete(s);
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
    if (this.now() - e.at > this.maxAgeMs) {
      this.delete(identity, key);
      return undefined;
    }
    if (e.loaded) return this.snapshot(e);
    if (e.json !== undefined) {
      try {
        e.value = parse(e.json);
        e.loaded = true;
      } catch {
        this.delete(identity, key);
        return undefined;
      }
      return this.snapshot(e);
    }
    let raw: string | null | Promise<string | null>;
    try {
      raw = this.kv!.getItem(this.slotKey(e.slot));
    } catch {
      raw = null;
    }
    if (isThenable(raw)) return raw.then((r) => this.fill(e, r), () => this.fill(e, null));
    return this.fill(e, raw);
  }

  /** An entry's value from its key: checked against its header, the newest version of the two kept. */
  private fill(e: Entry, raw: string | null): CachedSnapshot | undefined {
    const cur = this.entries?.get(e.identity)?.get(e.key);
    if (cur !== e) return cur?.loaded ? this.snapshot(cur) : undefined;
    if (e.loaded) return this.snapshot(e);
    const nl = raw ? raw.indexOf("\n") : -1;
    let header: Header | null = null;
    let value: unknown;
    try {
      if (nl < 0) throw new Error("no entry");
      header = JSON.parse(raw!.slice(0, nl)) as Header;
      if (!Array.isArray(header) || header[0] !== 2 || header[1] !== e.identity || header[2] !== e.key) throw new Error("another entry");
      value = parse(raw!.slice(nl + 1));
    } catch {
      // Missing, unreadable, or another query's (a slot written after this index): not ours.
      this.forget(e);
      return undefined;
    }
    const [, , , version, epoch, ik, at] = header;
    if (typeof version !== "number" || typeof epoch !== "string" || typeof ik !== "string" || typeof at !== "number") {
      this.forget(e);
      return undefined;
    }
    // The index's version (a later confirmation of the same value) counts only over the same epoch and tag.
    if (epoch !== e.epoch || ik !== e.ik || version > e.version) {
      e.version = version;
      e.epoch = epoch;
      e.ik = ik;
    }
    e.at = Math.max(e.at, at);
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
        // The same value, confirmed at a later version: the index only.
        if (entry.version > cur.version || entry.at > cur.at) {
          cur.version = Math.max(cur.version, entry.version);
          cur.at = Math.max(cur.at, entry.at);
          this.indexDirty = true;
        }
        return;
      }
      const e: Entry = cur ?? { identity, key, slot: this.freeSlot(), version: 0, epoch: "", ik: "", at: 0, size: -1, value: undefined, loaded: true, dirty: true };
      if (!cur) this.add(e);
      e.value = entry.value;
      e.loaded = true;
      e.json = undefined;
      e.version = entry.version;
      e.epoch = entry.epoch;
      e.ik = entry.ik;
      e.at = entry.at;
      e.size = -1;
      e.dirty = true;
      // The entry's header carries the version; the index changes only for a new query.
      if (!cur) this.indexDirty = true;
    });
  }

  touch(identity: string, key: string, entry: CachedSnapshot): void {
    const m = this.entries;
    // Not loaded: nothing this session stored, so nothing the client's value can be.
    const cur = m?.get(identity)?.get(key);
    if (!cur || !cur.loaded || cur.value !== entry.value || cur.epoch !== entry.epoch || cur.ik !== entry.ik || entry.version <= cur.version) return;
    cur.version = entry.version;
    this.indexDirty = true;
    this.schedule();
  }

  delete(identity: string, key: string): void {
    this.change(() => {
      const e = this.entries!.get(identity)?.get(key);
      if (e) this.forget(e);
    });
  }

  clear(identity?: string): void {
    const run = () => {
      for (const [id, m] of [...this.entries!]) {
        if (identity !== undefined && id !== identity) continue;
        for (const e of [...m.values()]) this.forget(e);
      }
      this.flush();
    };
    const m = this.load();
    if (isThenable(m)) void m.then(run);
    else run();
  }

  /** Drops an entry from memory (its key is removed on the next flush). */
  private forget(e: Entry): void {
    const m = this.entries?.get(e.identity);
    if (!m || m.get(e.key) !== e) return;
    m.delete(e.key);
    if (!m.size) this.entries!.delete(e.identity);
    this.freed.add(e.slot);
    this.indexDirty = true;
    this.schedule();
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
    if (this.flushing || this.timer || (!this.indexDirty && !this.freed.size && !this.anyDirty())) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  private anyDirty(): boolean {
    for (const m of this.entries?.values() ?? []) for (const e of m.values()) if (e.dirty) return true;
    return false;
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
        if (now - e.at > this.maxAgeMs || e.size > this.maxBytes) {
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

  /** Writes what changed now: changed entries first, then the index, then removals (the client calls it on close). */
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

  private write(): void {
    const entries = this.entries!;
    const writes = this.evict();
    const kv = this.kv;
    for (const [e, json] of writes) {
      // Made room for an earlier one meanwhile: gone.
      if (entries.get(e.identity)?.get(e.key) !== e) continue;
      e.dirty = false;
      e.json = undefined;
      if (!kv) continue;
      const header: Header = [2, e.identity, e.key, e.version, e.epoch, e.ik, e.at];
      const ok = this.put(this.slotKey(e.slot), `${JSON.stringify(header)}\n${json}`, () => {
        // Rejected later (an async store out of space): not stored, so not listed either.
        this.forget(e);
      });
      if (!ok) {
        // Out of space: make room from the oldest others, once; else give this one up.
        this.evictOldest(e);
        if (!this.put(this.slotKey(e.slot), `${JSON.stringify(header)}\n${json}`, () => this.forget(e))) this.forget(e);
      }
    }
    if (!kv) {
      this.indexDirty = false;
      this.freed.clear();
      return;
    }
    if (this.indexDirty) {
      const rows: IndexRow[] = [];
      for (const m of entries.values()) for (const e of m.values()) rows.push([e.identity, e.key, e.slot, e.version, e.epoch, e.ik, e.at, e.size]);
      if (this.put(this.indexKey, JSON.stringify({ v: 2, n: rows }), () => (this.indexDirty = true))) {
        this.indexDirty = false;
        if (this.legacy) {
          this.legacy = false;
          this.remove(`${this.prefix}:snapshots`);
        }
      }
    }
    for (const slot of this.freed) if (!this.slotUsed(slot)) this.remove(this.slotKey(slot));
    this.freed.clear();
  }

  private slotUsed(slot: number): boolean {
    for (const m of this.entries!.values()) for (const e of m.values()) if (e.slot === slot) return true;
    return false;
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
      this.remove(this.slotKey(e.slot));
    }
  }

  /** `setItem`, best effort: false when it threw (quota); `failed` runs if an async store rejects it. */
  private put(key: string, value: string, failed: () => void): boolean {
    try {
      const r = this.kv!.setItem(key, value);
      if (isThenable(r)) r.catch(failed);
      return true;
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
