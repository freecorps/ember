// Range scans over rows kept sorted by encoded key (memory and TinyBase backends): binary search for the bounds
// instead of testing every row.

import { compareBytes } from "@freecorps/ember-values";
import type { Doc } from "@freecorps/ember-server";

export type KeyedRow = { key: Uint8Array; doc: Doc };

/** The first index whose key is >= `k` (or > `k` with `after`). */
function bound(rows: readonly KeyedRow[], k: Uint8Array, after: boolean): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const c = compareBytes(rows[mid]!.key, k);
    if (c < 0 || (after && c === 0)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Rows with `lo <= key < hi` (as `inKeyRange`), ascending or descending, at most `limit`. */
export function scanSorted(rows: readonly KeyedRow[], lo: Uint8Array, hi: Uint8Array, asc: boolean, limit: number): KeyedRow[] {
  const from = bound(rows, lo, false);
  const to = Math.max(from, bound(rows, hi, false));
  const n = Math.max(0, Math.min(limit, to - from));
  return asc ? rows.slice(from, from + n) : rows.slice(to - n, to).reverse();
}
