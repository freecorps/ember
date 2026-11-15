// Live stores of `fromAuth` functions (`shard: { org: fromAuth("org") }`, docs/design/dx.md §3.6): the shard comes from
// a claim of the current token, so it can change while the store is in use (the user switched the active org, signed
// out). `followRoute` keeps one inner store on the current shard and swaps it when the token's claim changes: the old
// subscription goes, the new one starts (loading, unless a value for that shard is already held), and the listeners
// hear about it.

import type { EmberError } from "./errors.ts";

/** @internal Where a `fromAuth` function runs now, and when that may change. */
export interface ClaimRoute {
  /** The shard now: its name, the error that prevents routing (signed out, no claim), or undefined (token not known yet). */
  current(): string | EmberError | undefined;
  /** `cb` runs whenever the token changes (the shard may have changed). Returns the unsubscribe function. */
  onChange(cb: () => void): () => void;
}

interface Store<S> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): S;
}

/** @internal A store that follows `route`: `make(shard)` builds the store of one shard. */
export class RoutedStore<S, H extends Store<S>> implements Store<S> {
  private shard: string | undefined;
  private inner: H | null = null;
  private innerOff: (() => void) | null = null;
  private failed: { error: EmberError; snap: S } | null = null;
  private readonly listeners = new Set<() => void>();
  private routeOff: (() => void) | null = null;

  constructor(
    private readonly route: ClaimRoute,
    private readonly make: (shard: string) => H,
    private readonly loading: S,
    private readonly failure: (error: EmberError) => S,
  ) {}

  /** The store of the current shard (null while there is none). */
  current(): H | null {
    if (!this.listeners.size) this.resolve(false);
    return this.inner;
  }

  getSnapshot = (): S => {
    if (!this.listeners.size) this.resolve(false);
    return this.snapshot();
  };

  private snapshot(): S {
    if (this.failed) return this.failed.snap;
    return this.inner ? this.inner.getSnapshot() : this.loading;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.routeOff = this.route.onChange(() => this.resolve(true));
      this.resolve(false);
      if (this.inner && !this.innerOff) this.innerOff = this.inner.subscribe(this.emit);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.routeOff?.();
      this.routeOff = null;
      this.innerOff?.();
      this.innerOff = null;
    };
  };

  private readonly emit = () => {
    for (const l of [...this.listeners]) l();
  };

  /** After a swap: tells the listeners only when what they would read changed. */
  private emitIfChanged(before: S): void {
    if (this.snapshot() !== before) this.emit();
  }

  /** Follows the route: same shard, nothing; another one, swap; an error, drop the store; unknown, keep what is there. */
  private resolve(notify: boolean): void {
    const cur = this.route.current();
    if (cur === undefined) return;
    const before = this.snapshot();
    if (typeof cur !== "string") {
      if (this.failed?.error.message === cur.message && !this.inner) return;
      this.innerOff?.();
      this.innerOff = null;
      this.inner = null;
      this.shard = undefined;
      this.failed = { error: cur, snap: this.failure(cur) };
      if (notify) this.emitIfChanged(before);
      return;
    }
    if (cur === this.shard && this.inner) return;
    const next = this.make(cur);
    // Subscribe the new one before releasing the old (a shared socket or subscription is not closed and reopened).
    const nextOff = this.listeners.size ? next.subscribe(this.emit) : null;
    this.innerOff?.();
    this.inner = next;
    this.innerOff = nextOff;
    this.shard = cur;
    this.failed = null;
    if (notify) this.emitIfChanged(before);
  }
}
