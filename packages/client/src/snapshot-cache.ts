// A light snapshot cache for the client (no offline engine): the last confirmed value of each subscription, so a
// repeat visit paints from it with no round trip (`source: "cache"`) and subscribes with `resume` (the shard answers
// `unchanged` when nothing it read changed). Kept per identity, bounded, never holds errors, cleared on sign-out.
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
  set(identity: string, key: string, entry: CachedSnapshot): void;
  delete(identity: string, key: string): void;
  /** Forget one identity's snapshots, or every snapshot (written through at once: a sign-out leaves nothing). */
  clear(identity?: string): void;
  /** Write pending changes now (the client calls it on close). */
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

/** `v`: the value's JSON once written; `value`: the live value until then (encoded only when the blob is written). */
type Stored = { v?: string; value?: unknown; version: number; epoch: string; ik: string; at: number };
type Blob = { v: 1; by: Record<string, Record<string, Stored>> };

/** In memory: survives client re-creation in one page (SPA navigation), not a reload. */
export function memorySnapshotCache(opts: SnapshotCacheOptions = {}): SnapshotCache {
  return new BlobCache(null, opts);
}

/**
 * Over `localStorage`, `sessionStorage` or an AsyncStorage-like store (`getItem`/`setItem`, sync or async): one JSON
 * entry, read once, written at most every 250 ms. With a synchronous store (localStorage) the first paint of a
 * repeat visit needs no round trip at all.
 */
export function keyValueSnapshotCache(kv: KeyValueStore, opts: SnapshotCacheOptions = {}): SnapshotCache {
  return new BlobCache(kv, opts);
}

class BlobCache implements SnapshotCache {
  private blob: Blob | null = null;
  private loading: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly key: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    private readonly kv: KeyValueStore | null,
    opts: SnapshotCacheOptions,
  ) {
    this.key = `${opts.prefix ?? "ember"}:snapshots`;
    this.maxBytes = opts.maxBytes ?? 512 * 1024;
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /** The blob, loaded on first use (synchronously when the store is). */
  private load(): Blob | Promise<Blob> {
    if (this.blob) return this.blob;
    if (!this.kv) return (this.blob = { v: 1, by: {} });
    const read = (raw: string | null): Blob => {
      if (this.blob) return this.blob;
      let b: Blob = { v: 1, by: {} };
      try {
        const x = raw ? (JSON.parse(raw) as Blob) : null;
        if (x && x.v === 1 && typeof x.by === "object" && x.by) b = x;
      } catch {
        // unreadable: start over
      }
      return (this.blob = b);
    };
    let raw: string | null | Promise<string | null>;
    try {
      raw = this.kv.getItem(this.key);
    } catch {
      raw = null;
    }
    if (raw && typeof (raw as Promise<string | null>).then === "function") {
      this.loading ??= (raw as Promise<string | null>).then(read, () => read(null)).then(() => undefined);
      return this.loading.then(() => this.blob!);
    }
    return read(raw as string | null);
  }

  get(identity: string, key: string): CachedSnapshot | undefined | Promise<CachedSnapshot | undefined> {
    const b = this.load();
    if (b instanceof Promise) return b.then(() => this.read(identity, key));
    return this.read(identity, key);
  }

  private read(identity: string, key: string): CachedSnapshot | undefined {
    const e = this.blob?.by[identity]?.[key];
    if (!e) return undefined;
    if (this.now() - e.at > this.maxAgeMs) {
      this.delete(identity, key);
      return undefined;
    }
    try {
      return { value: e.v === undefined ? e.value : parse(e.v), version: e.version, epoch: e.epoch, ik: e.ik, at: e.at };
    } catch {
      this.delete(identity, key);
      return undefined;
    }
  }

  set(identity: string, key: string, entry: CachedSnapshot): void {
    // Kept as is (a patch per change costs nothing here); encoded, sized and evicted when the blob is written.
    this.change((b) => {
      (b.by[identity] ??= {})[key] = { value: entry.value, version: entry.version, epoch: entry.epoch, ik: entry.ik, at: entry.at };
    });
  }

  delete(identity: string, key: string): void {
    this.change((b) => {
      const m = b.by[identity];
      if (!m || !(key in m)) return;
      delete m[key];
      if (!Object.keys(m).length) delete b.by[identity];
    });
  }

  clear(identity?: string): void {
    this.change((b) => {
      if (identity === undefined) b.by = {};
      else delete b.by[identity];
    });
    if (this.blob) this.flush();
  }

  /** Encodes what is new; then least recently stored first, until the values fit `maxBytes`; expired ones always. */
  private evict(b: Blob): void {
    const all: Array<[string, string, Stored]> = [];
    let size = 0;
    const now = this.now();
    for (const [id, m] of Object.entries(b.by)) {
      for (const [k, e] of Object.entries(m)) {
        if (e.v === undefined) {
          try {
            e.v = stringify(e.value);
          } catch {
            delete m[k];
            continue;
          }
          delete e.value;
        }
        if (now - e.at > this.maxAgeMs || e.v.length > this.maxBytes) {
          delete m[k];
          continue;
        }
        all.push([id, k, e]);
        size += e.v.length;
      }
      if (!Object.keys(m).length) delete b.by[id];
    }
    if (size <= this.maxBytes) return;
    all.sort((x, y) => x[2].at - y[2].at);
    for (const [id, k, e] of all) {
      if (size <= this.maxBytes) break;
      size -= e.v!.length;
      const m = b.by[id];
      if (m) {
        delete m[k];
        if (!Object.keys(m).length) delete b.by[id];
      }
    }
  }

  private change(f: (b: Blob) => void): void {
    const b = this.load();
    if (b instanceof Promise) {
      void b.then((x) => {
        f(x);
        this.schedule();
      });
      return;
    }
    f(b);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  /** Writes the blob now (the client calls it on close). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.blob) return;
    this.evict(this.blob);
    if (!this.kv) return;
    try {
      const r = this.kv.setItem(this.key, JSON.stringify(this.blob));
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => undefined);
    } catch {
      // quota: the cache is best effort
    }
  }
}
