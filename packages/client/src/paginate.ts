// Live cursor pagination with fixed page boundaries (docs/design/contracts.md "Paginação").
//
// Page `i` is a live query `(fn, {...args, paginationOpts})`. It first loads as `{numItems, cursor}` (cursor = the end
// of the page before it; null for the first page) and, once its first value is in, is *pinned*: re-subscribed as
// `{numItems, cursor, endCursor: <its continueCursor>}`, with `resume` from the value the client already holds (the
// pinned query's value at that version is the same one), so pinning downloads nothing. From then on the page covers a
// fixed key range: it grows and shrinks with its items, a new item lands in exactly one page, and no other page's
// arguments, read set or subscription change.
//
// - A page that grew past twice its size is split in two: a probe `{numItems, cursor}` gives the cursor in the middle;
//   the first half is pinned from it, the second half subscribes fresh. The old page stays live and shown until both
//   halves have their value.
// - A page that became empty is merged into its neighbour (one subscription covering both ranges), likewise shown
//   until the merged page has its value.
// - A page whose replacement is still loading keeps showing its own (live) value: the list never shrinks because of an
//   internal change of subscription.
// - A query that does not honor `endCursor` (hand-written pagination: `continueCursor` null, or a pinned page whose
//   `continueCursor` is not its `endCursor`) falls back to chained pages, as before: page `i`'s cursor follows page
//   `i - 1`'s `continueCursor` (the old page stays shown until the new one arrives; rows are deduplicated by `_id`).

import { EmberError } from "./errors.ts";
import type { PaginationResult } from "./functions.ts";
import type { EmberClient, QueryReference, QuerySnapshot, ShardOptions } from "./client.ts";
import { stringify } from "./wire.ts";

export type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

export interface PaginatedSnapshot<T> {
  readonly results: T[];
  readonly status: PaginationStatus;
  readonly isLoading: boolean;
  /** Set when a page failed (the React hook throws it). */
  readonly error?: EmberError | undefined;
}

/** `watchPaginatedQuery(client, ...)`: a store for `useSyncExternalStore`, plus `loadMore`. */
export interface PaginatedQueryHandle<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PaginatedSnapshot<T>;
  /** Adds a page of `numItems` after the last one (only while `status` is `"CanLoadMore"`). */
  loadMore(numItems: number): void;
}

/** What the paginator needs from the client (internal). */
export interface PageHost {
  /** The subscription key of these page args. */
  key(paginationOpts: Record<string, unknown>): string;
  /**
   * Ref-counted listener on the page query. `seedFrom`: the key of a subscription whose confirmed value is this one's
   * too (pinning): the new subscription starts with it and asks the server to `resume` from it.
   */
  listen(paginationOpts: Record<string, unknown>, listener: () => void, seedFrom?: string): () => void;
  snapshot(key: string): QuerySnapshot;
  /** The confirmed server value of a subscription (no optimistic layers), or undefined. */
  confirmed(key: string): unknown;
}

interface Page {
  /** Start (exclusive): the previous page's end; null for the first page. */
  cursor: string | null;
  /** Pinned end (inclusive), the `endCursor` the page is subscribed with; undefined while it loads unpinned. */
  end?: string | undefined;
  numItems: number;
  key: string;
  off: (() => void) | null;
  /** Split in progress: the probe that finds the cursor in the middle. */
  probe?: { key: string; off: (() => void) | null } | undefined;
  /** A replacement of this page (and the next `span - 1` pages) waiting for its values. */
  swap?: { span: number; pages: Page[] } | undefined;
}

type Result = PaginationResult<unknown> & { continueCursor: string | null };

/** Same row: by `_id` for documents, else by value. */
function sameItem(a: unknown, b: unknown): boolean {
  const id = (x: unknown) => (typeof x === "object" && x !== null ? (x as { _id?: unknown })._id : undefined);
  const ia = id(a);
  if (typeof ia === "string") return ia === id(b);
  return stringify(a) === stringify(b);
}

const isResult = (v: unknown): v is Result => typeof v === "object" && v !== null && Array.isArray((v as Result).page);

export class PaginatedQuery<T> implements PaginatedQueryHandle<T> {
  private pages: Page[];
  private readonly listeners = new Set<() => void>();
  private active = false;
  /** Pages follow each other's `continueCursor` (a query that ignores `endCursor`). */
  private chained = false;
  private reconciling = false;
  private again = false;
  private cache: { snaps: QuerySnapshot[]; shape: number; value: PaginatedSnapshot<T> } | null = null;
  /** Bumped on every structural change (pages added, replaced, removed). */
  private shape = 0;

  constructor(
    private readonly host: PageHost,
    initialNumItems: number,
  ) {
    this.pages = [this.page(null, undefined, initialNumItems)];
  }

  private opts(p: Pick<Page, "cursor" | "end" | "numItems">): Record<string, unknown> {
    return p.end === undefined ? { numItems: p.numItems, cursor: p.cursor } : { numItems: p.numItems, cursor: p.cursor, endCursor: p.end };
  }

  private page(cursor: string | null, end: string | undefined, numItems: number): Page {
    const p: Page = { cursor, end, numItems, key: "", off: null };
    p.key = this.host.key(this.opts(p));
    return p;
  }

  private readonly onChange = () => {
    this.reconcile();
    this.emit();
  };

  private listen(p: Page, seedFrom?: string): void {
    if (this.active && !p.off) p.off = this.host.listen(this.opts(p), this.onChange, seedFrom);
  }

  private release(p: Page): void {
    p.off?.();
    p.off = null;
    p.probe?.off?.();
    p.probe = undefined;
    if (p.swap) for (const q of p.swap.pages) this.release(q);
    p.swap = undefined;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.active) {
      this.active = true;
      for (const p of this.pages) this.listen(p);
      this.reconcile();
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.listeners.delete(listener);
      if (this.listeners.size || !this.active) return;
      this.active = false;
      for (const p of this.pages) this.release(p);
    };
  };

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  /** The confirmed value of a page, when it is a pagination result. */
  private value(key: string): Result | undefined {
    const v = this.host.confirmed(key);
    return isResult(v) ? v : undefined;
  }

  private has(p: Page): boolean {
    return this.host.snapshot(p.key).status === "success";
  }

  /** Puts `next` where `count` pages from index `i` were (they are released). */
  private replace(i: number, count: number, next: Page[]): void {
    for (const old of this.pages.slice(i, i + count)) this.release(old);
    this.pages.splice(i, count, ...next);
    this.shape++;
  }

  /** Pinning, splits, merges and (chained mode) cursor changes; repeated until nothing changes. */
  private reconcile(): void {
    if (!this.active) return;
    if (this.reconciling) {
      this.again = true;
      return;
    }
    this.reconciling = true;
    try {
      let rounds = 0;
      do {
        this.again = false;
        if (this.step()) this.again = true;
      } while (this.again && ++rounds < 32);
    } finally {
      this.reconciling = false;
    }
  }

  /** One change, if any is due (true: something changed, look again). */
  private step(): boolean {
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i]!;
      // A replacement whose pages all have their values takes over.
      if (p.swap) {
        if (p.swap.pages.every((q) => this.has(q))) {
          const { span, pages } = p.swap;
          p.swap = undefined;
          this.replace(i, span, pages);
          return true;
        }
        continue;
      }
      if (this.chained) {
        if (this.chainStep(i)) return true;
        continue;
      }
      const v = this.value(p.key);
      if (!v) continue;
      if (typeof v.continueCursor !== "string") return this.toChained();
      if (p.end === undefined) {
        // First value: pin the page to the range it covers now, starting from the value already here.
        const pinned = this.page(p.cursor, v.continueCursor, p.numItems);
        this.listen(pinned, p.key);
        if (this.has(pinned) || !this.active) this.replace(i, 1, [pinned]);
        else p.swap = { span: 1, pages: [pinned] };
        return true;
      }
      // The query ignores `endCursor`: its pages slide, so they must follow each other.
      if (v.continueCursor !== p.end) return this.toChained();
      if (this.splitStep(p, v)) return true;
      if (v.page.length === 0 && this.pages.length > 1 && this.mergeStep(i)) return true;
    }
    return false;
  }

  /** A page past twice its size: probe for the middle cursor, then replace it by two pinned halves. */
  private splitStep(p: Page, v: Result): boolean {
    if (!p.probe) {
      if (v.page.length <= 2 * p.numItems) return false;
      const probe = { key: this.host.key({ numItems: p.numItems, cursor: p.cursor }), off: null as (() => void) | null };
      p.probe = probe;
      probe.off = this.host.listen({ numItems: p.numItems, cursor: p.cursor }, this.onChange);
      return true;
    }
    if (v.page.length <= 2 * p.numItems) {
      // Shrank back meanwhile: no split.
      p.probe.off?.();
      p.probe = undefined;
      return true;
    }
    const a = this.value(p.probe.key);
    if (!a) return false;
    // The probe's rows must be the start of this page, ending before its end; otherwise a change is still on its way
    // to one of the two (both are live): wait for it.
    const prefix = a.page.length > 0 && a.page.length < v.page.length && a.page.every((x, k) => sameItem(x, v.page[k]));
    if (!prefix || a.isDone || typeof a.continueCursor !== "string" || a.continueCursor === p.end) return false;
    const probe = p.probe;
    p.probe = undefined;
    const first = this.page(p.cursor, a.continueCursor, p.numItems);
    this.listen(first, probe.key);
    probe.off?.();
    const second = this.page(a.continueCursor, p.end, p.numItems);
    this.listen(second);
    p.swap = { span: 1, pages: [first, second] };
    return true;
  }

  /** An empty page is merged into the page before it (or, the first page, into the one after it). */
  private mergeStep(i: number): boolean {
    const j = i > 0 ? i - 1 : i;
    const a = this.pages[j]!;
    const b = this.pages[j + 1]!;
    if (a.swap || b.swap || a.end === undefined || b.end === undefined) return false;
    const merged = this.page(a.cursor, b.end, Math.max(a.numItems, b.numItems));
    this.listen(merged);
    a.swap = { span: 2, pages: [merged] };
    return true;
  }

  /** Every page unpinned, following the previous page's `continueCursor` from now on. */
  private toChained(): boolean {
    this.chained = true;
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i]!;
      if (p.swap) {
        for (const q of p.swap.pages) this.release(q);
        p.swap = undefined;
      }
      p.probe?.off?.();
      p.probe = undefined;
      if (p.end === undefined) continue;
      const next = this.page(p.cursor, undefined, p.numItems);
      this.listen(next);
      p.swap = { span: 1, pages: [next] };
    }
    return true;
  }

  private chainStep(i: number): boolean {
    const p = this.pages[i]!;
    if (i === 0) return false;
    const prev = this.pages[i - 1]!;
    if (prev.swap) return false;
    const v = this.value(prev.key);
    if (!v) return false;
    if (v.isDone || typeof v.continueCursor !== "string") {
      // Nothing after a done page: drop the pages past it.
      this.replace(i, this.pages.length - i, []);
      return true;
    }
    if (p.cursor === v.continueCursor) return false;
    const next = this.page(v.continueCursor, undefined, p.numItems);
    this.listen(next);
    p.swap = { span: 1, pages: [next] };
    return true;
  }

  loadMore = (numItems: number): void => {
    if (this.getSnapshot().status !== "CanLoadMore") return;
    const last = this.pages[this.pages.length - 1]!;
    const v = this.value(last.key);
    const cursor = this.chained ? v?.continueCursor : (last.end ?? v?.continueCursor);
    if (typeof cursor !== "string") return;
    const p = this.page(cursor, undefined, numItems);
    this.pages.push(p);
    this.shape++;
    this.listen(p);
    this.reconcile();
    this.emit();
  };

  getSnapshot = (): PaginatedSnapshot<T> => {
    const snaps = this.pages.map((p) => this.host.snapshot(p.key));
    const c = this.cache;
    if (c && c.shape === this.shape && c.snaps.length === snaps.length && c.snaps.every((s, i) => s === snaps[i])) return c.value;
    const results: T[] = [];
    const seen = this.chained ? new Set<string>() : null;
    let status: PaginationStatus = "CanLoadMore";
    let error: EmberError | undefined;
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i]!;
      if (s.status === "error") {
        error = s.error;
        break;
      }
      const v = s.value as PaginationResult<T> | undefined;
      if (s.status !== "success" || !isResult(v)) {
        status = i === 0 ? "LoadingFirstPage" : "LoadingMore";
        break;
      }
      for (const item of v.page) {
        const id = seen && typeof item === "object" && item !== null ? (item as { _id?: unknown })._id : undefined;
        if (typeof id === "string") {
          if (seen!.has(id)) continue;
          seen!.add(id);
        }
        results.push(item);
      }
      if (i === snaps.length - 1 && v.isDone) status = "Exhausted";
    }
    const value: PaginatedSnapshot<T> = Object.freeze({ results, status, isLoading: status === "LoadingFirstPage" || status === "LoadingMore", ...(error ? { error } : {}) });
    this.cache = { snaps, shape: this.shape, value };
    return value;
  };
}

/**
 * Live cursor pagination with fixed page boundaries (what `usePaginatedQuery` renders; React Native and plain TS
 * too): each page is a live query of `ref` with `args` plus `paginationOpts`; once loaded, a page keeps its key range
 * (`endCursor`), so a new item changes exactly one page. A function, not a client method, so apps that do not
 * paginate do not bundle it.
 */
export function watchPaginatedQuery<T = unknown>(
  client: EmberClient,
  ref: QueryReference,
  args: Record<string, unknown>,
  opts: ShardOptions & { initialNumItems: number },
): PaginatedQueryHandle<T> {
  const host = client.pageHost(ref, args, opts);
  if (host instanceof EmberError) {
    const snap: PaginatedSnapshot<T> = Object.freeze({ results: [], status: "LoadingFirstPage", isLoading: true, error: host });
    return { subscribe: () => () => {}, getSnapshot: () => snap, loadMore: () => {} };
  }
  return new PaginatedQuery<T>(host, opts.initialNumItems);
}
