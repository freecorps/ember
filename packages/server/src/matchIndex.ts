// Subscription matching at scale (PLAN §4): instead of testing every subscription's read set against every commit,
// db read-set ranges live in one interval structure per (table, index), and a commit's changed keys are stabbed
// into it. Plugin kinds (search, user kinds) keep their `matchesChange` path, bucketed per table.
//
// Same answers as `engine.matches` (no false negatives), split in two:
// - exact: a db range contains the before/after key (and the row passes the recorded filter), a plugin's
//   `matchesChange` said yes, or the key is registered table-wide (unknown index/table, or a failing query's
//   tables) and the change is in one of its tables;
// - loose: a plugin entry of a touched table whose `matchesChange` said no. Exact for plugins that are exact;
//   the runtime uses it to debounce re-runs whose results may still drift (search rank, PLAN §4).

import { compareBytes } from "@ember/values";
import { docKey, indexFields } from "./ddl.ts";
import { passes } from "./filter.ts";
import type { IndexKind, MatchHelpers } from "./indexKinds.ts";
import { fieldOf } from "./layout.ts";
import type { SchemaManifest } from "./schema.ts";
import type { ReadSet, ReadSetEntry, RowChange } from "./types.ts";

export interface MatchResult<K> {
  exact: Set<K>;
  /** Keys whose only hits are plugin entries on a touched table that `matchesChange` rejected (not in `exact`). */
  loose: Set<K>;
}

export interface MatchIndex<K> {
  /**
   * Registers (or replaces) `key`. `readSet` null = no read set (a failing query): the key matches any change to
   * `tables` and nothing else (an empty list never matches a commit).
   */
  set(key: K, readSet: ReadSet | null, tables?: Iterable<string>): void;
  delete(key: K): void;
  has(key: K): boolean;
  readonly size: number;
  /** Keys whose results `changes` may affect. */
  match(changes: readonly RowChange[]): MatchResult<K>;
}

interface Rec<K> {
  key: K;
  lo: Uint8Array;
  hi: Uint8Array;
  entry: ReadSetEntry;
  dead: boolean;
}

/**
 * Half-open byte intervals `[lo, hi)` with stabbing queries. A static part sorted by `lo` with a max-`hi`
 * segment tree, plus a small unsorted buffer for recent inserts; deletions are tombstones. Rebuilt lazily (at
 * query time) when the buffer or the tombstones grow, so subscription churn costs O(1) and a stab costs
 * O(log n + matches).
 */
export class IntervalSet<K> {
  private sorted: Rec<K>[] = [];
  private tree: Uint8Array[] = [];
  private buffer: Rec<K>[] = [];
  private dead = 0;
  private live = 0;

  get size(): number {
    return this.live;
  }

  add(rec: Omit<Rec<K>, "dead">): Rec<K> {
    const r: Rec<K> = { ...rec, dead: false };
    this.buffer.push(r);
    this.live++;
    return r;
  }

  remove(r: Rec<K>): void {
    if (r.dead) return;
    r.dead = true;
    this.dead++;
    this.live--;
  }

  private maybeRebuild(): void {
    const n = this.sorted.length;
    if (this.buffer.length <= 16 + Math.sqrt(n) && this.dead <= 16 + n / 2) return;
    const all = this.sorted.concat(this.buffer).filter((r) => !r.dead);
    all.sort((a, b) => compareBytes(a.lo, b.lo));
    this.sorted = all;
    this.buffer = [];
    this.dead = 0;
    // Segment tree over max(hi): node 1 = root, children 2i / 2i+1, leaves at [size, size + n).
    let size = 1;
    while (size < all.length) size <<= 1;
    const EMPTY = new Uint8Array(0);
    const tree: Uint8Array[] = new Array(2 * size).fill(EMPTY);
    for (let i = 0; i < all.length; i++) tree[size + i] = all[i]!.hi;
    for (let i = size - 1; i >= 1; i--) {
      const a = tree[2 * i]!;
      const b = tree[2 * i + 1]!;
      tree[i] = compareBytes(a, b) >= 0 ? a : b;
    }
    this.tree = tree;
  }

  /** Calls `visit` for every live interval containing `k`. */
  stab(k: Uint8Array, visit: (r: Rec<K>) => void): void {
    this.maybeRebuild();
    for (const r of this.buffer) if (!r.dead && compareBytes(r.lo, k) <= 0 && compareBytes(k, r.hi) < 0) visit(r);
    const all = this.sorted;
    if (!all.length) return;
    // Intervals with lo <= k are a prefix [0, end) of the sorted array.
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareBytes(all[mid]!.lo, k) <= 0) lo = mid + 1;
      else hi = mid;
    }
    const end = lo;
    if (!end) return;
    const size = this.tree.length >>> 1;
    const tree = this.tree;
    // Iterative DFS over nodes covering [0, end) whose max(hi) > k.
    const stack: Array<[number, number, number]> = [[1, 0, size]];
    while (stack.length) {
      const [node, l, r] = stack.pop()!;
      if (l >= end || compareBytes(tree[node]!, k) <= 0) continue;
      if (r - l === 1) {
        const rec = all[l]!;
        if (!rec.dead) visit(rec);
        continue;
      }
      const m = (l + r) >>> 1;
      stack.push([2 * node + 1, m, r], [2 * node, l, m]);
    }
  }
}

interface KeyState<K> {
  recs: Array<{ set: IntervalSet<K>; rec: Rec<K> }>;
  plugin: Array<{ table: string; entry: ReadSetEntry }>;
  tables: Set<string>;
}

export function createMatchIndex<K>(schema: { manifest: SchemaManifest; indexKinds: ReadonlyMap<string, IndexKind> }): MatchIndex<K> {
  return new MatchIndexImpl<K>(schema.manifest, schema.indexKinds);
}

class MatchIndexImpl<K> implements MatchIndex<K> {
  private readonly keys = new Map<K, KeyState<K>>();
  /** table -> index -> intervals */
  private readonly intervals = new Map<string, Map<string, { fields: string[]; set: IntervalSet<K> }>>();
  /** table -> key -> plugin entries */
  private readonly plugins = new Map<string, Map<K, ReadSetEntry[]>>();
  /** table -> keys matching any change to it */
  private readonly tableWide = new Map<string, Set<K>>();
  private readonly helpers: MatchHelpers = { field: (doc, path) => fieldOf(doc, path) };

  constructor(
    private readonly manifest: SchemaManifest,
    private readonly kinds: ReadonlyMap<string, IndexKind>,
  ) {}

  get size(): number {
    return this.keys.size;
  }

  has(key: K): boolean {
    return this.keys.has(key);
  }

  set(key: K, readSet: ReadSet | null, tables?: Iterable<string>): void {
    this.delete(key);
    const st: KeyState<K> = { recs: [], plugin: [], tables: new Set() };
    const wide = (table: string) => {
      if (st.tables.has(table)) return;
      st.tables.add(table);
      let s = this.tableWide.get(table);
      if (!s) this.tableWide.set(table, (s = new Set()));
      s.add(key);
    };
    for (const t of tables ?? []) wide(t);
    for (const entry of readSet ?? []) {
      const t = this.manifest.tables[entry.table];
      if (!t) {
        wide(entry.table);
        continue;
      }
      if (entry.kind === "db") {
        const fields = indexFields(t, entry.index);
        if (!fields) {
          wide(entry.table);
          continue;
        }
        if (compareBytes(entry.lo, entry.hi) >= 0) continue; // empty range: nothing can enter it
        let byIndex = this.intervals.get(entry.table);
        if (!byIndex) this.intervals.set(entry.table, (byIndex = new Map()));
        let slot = byIndex.get(entry.index);
        if (!slot) byIndex.set(entry.index, (slot = { fields, set: new IntervalSet<K>() }));
        st.recs.push({ set: slot.set, rec: slot.set.add({ key, lo: entry.lo, hi: entry.hi, entry }) });
      } else {
        st.plugin.push({ table: entry.table, entry });
        let byKey = this.plugins.get(entry.table);
        if (!byKey) this.plugins.set(entry.table, (byKey = new Map()));
        let list = byKey.get(key);
        if (!list) byKey.set(key, (list = []));
        list.push(entry);
      }
    }
    this.keys.set(key, st);
  }

  delete(key: K): void {
    const st = this.keys.get(key);
    if (!st) return;
    this.keys.delete(key);
    for (const { set, rec } of st.recs) set.remove(rec);
    for (const { table } of st.plugin) {
      const byKey = this.plugins.get(table);
      byKey?.delete(key);
      if (byKey && !byKey.size) this.plugins.delete(table);
    }
    for (const t of st.tables) {
      const s = this.tableWide.get(t);
      s?.delete(key);
      if (s && !s.size) this.tableWide.delete(t);
    }
  }

  match(changes: readonly RowChange[]): MatchResult<K> {
    const exact = new Set<K>();
    const loose = new Set<K>();
    for (const change of changes) {
      for (const k of this.tableWide.get(change.table) ?? []) exact.add(k);
      const byIndex = this.intervals.get(change.table);
      if (byIndex) {
        for (const { fields, set } of byIndex.values()) {
          // Before in range: the row may leave (or change inside) the result; after in range: it may enter.
          for (const doc of [change.before, change.after]) {
            if (!doc) continue;
            set.stab(docKey(doc, fields), (r) => {
              if (!exact.has(r.key) && passes(r.entry.filter, doc)) exact.add(r.key);
            });
          }
        }
      }
      const byKey = this.plugins.get(change.table);
      if (byKey) {
        for (const [key, entries] of byKey) {
          if (exact.has(key)) continue;
          let hit = false;
          for (const entry of entries) {
            const kind = this.kinds.get(entry.kind);
            if (!kind?.matchesChange || kind.matchesChange(entry, change, this.helpers)) {
              hit = true;
              break;
            }
          }
          if (hit) exact.add(key);
          else loose.add(key);
        }
      }
    }
    for (const k of exact) loose.delete(k);
    return { exact, loose };
  }
}
