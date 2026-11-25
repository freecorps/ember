// Testing helpers for option `multiTab` (`@freecorps/ember-client/testing`): several "tabs" of one origin in one process: a BroadcastChannel network (same-name channels deliver to each other,
// also within one tab, as browsers do: a structured clone in a later task, in post order) and a Web Locks manager
// (exclusive locks, a FIFO queue per name, `ifAvailable`, `signal`). A tab can crash (its locks free and its channels go
// dead without running any of its code) or freeze (it keeps its locks but no message reaches it).
import type { BroadcastChannelConstructor, BroadcastChannelLike, LockManagerLike } from "./multitab.ts";

type Listener = (ev: { data: unknown }) => void;

class FakeChannel implements BroadcastChannelLike {
  closed = false;
  private readonly listeners = new Set<Listener>();
  constructor(
    private readonly net: FakeBrowser,
    readonly name: string,
    readonly tab: string,
  ) {
    net.join(this);
  }
  postMessage(message: unknown): void {
    if (this.closed) throw new Error("InvalidStateError: channel closed");
    if (this.net.isDead(this.tab)) return;
    this.net.posted++;
    // Serialized when posted (later changes by the sender do not show), deserialized for each destination (as
    // browsers do: no two receivers share an object).
    const data = structuredClone(message);
    for (const other of this.net.peers(this)) {
      setTimeout(() => {
        if (!other.closed && !this.net.isDead(other.tab) && !this.net.isFrozen(other.tab)) other.emit(structuredClone(data));
      }, 0);
    }
  }
  addEventListener(_type: "message", l: Listener): void {
    this.listeners.add(l);
  }
  removeEventListener(_type: "message", l: Listener): void {
    this.listeners.delete(l);
  }
  emit(data: unknown): void {
    for (const l of [...this.listeners]) l({ data });
  }
  close(): void {
    this.closed = true;
    this.net.leave(this);
  }
}

interface LockReq {
  owner: string;
  cb: (lock: unknown) => unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

class FakeLocks {
  private readonly held = new Map<string, string>();
  private readonly queues = new Map<string, LockReq[]>();
  constructor(private readonly net: FakeBrowser) {}

  holder(name: string): string | undefined {
    return this.held.get(name);
  }

  scope(owner: string): LockManagerLike {
    return { request: ((name: string, a: unknown, b?: unknown) => this.request(owner, name, a, b)) as LockManagerLike["request"] };
  }

  private request(owner: string, name: string, a: unknown, b: unknown): Promise<unknown> {
    const opts = (typeof a === "function" ? {} : a) as { ifAvailable?: boolean; signal?: AbortSignal };
    const cb = (typeof a === "function" ? a : b) as (lock: unknown) => unknown;
    return new Promise((resolve, reject) => {
      if (this.net.isDead(owner)) return reject(new Error("InvalidStateError: the tab is gone"));
      if (opts.signal?.aborted) return reject(new Error("AbortError"));
      const req: LockReq = { owner, cb, resolve, reject };
      const q = this.queues.get(name) ?? [];
      if (!this.held.has(name) && !q.length) return this.grant(name, req);
      if (opts.ifAvailable) {
        Promise.resolve()
          .then(() => {
            // A tab that crashed meanwhile runs none of its code.
            if (this.net.isDead(owner)) throw new Error("InvalidStateError: the tab is gone");
            return cb(null);
          })
          .then(resolve, reject);
        return;
      }
      q.push(req);
      this.queues.set(name, q);
      opts.signal?.addEventListener("abort", () => {
        const i = q.indexOf(req);
        if (i >= 0) {
          q.splice(i, 1);
          reject(new Error("AbortError"));
        }
      });
    });
  }

  private grant(name: string, req: LockReq): void {
    this.held.set(name, req.owner);
    queueMicrotask(() => {
      if (this.net.isDead(req.owner)) {
        // It crashed between the grant and its callback: none of its code runs, and the lock (if still its) moves on.
        this.release(name, req.owner);
        return req.reject(new Error("InvalidStateError: the tab is gone"));
      }
      let r: unknown;
      try {
        r = req.cb({ name });
      } catch (e) {
        this.release(name, req.owner);
        return req.reject(e);
      }
      Promise.resolve(r).then(
        (v) => {
          this.release(name, req.owner);
          req.resolve(v);
        },
        (e) => {
          this.release(name, req.owner);
          req.reject(e);
        },
      );
    });
  }

  private release(name: string, owner: string): void {
    if (this.held.get(name) !== owner) return;
    this.held.delete(name);
    const q = this.queues.get(name) ?? [];
    let next: LockReq | undefined;
    while ((next = q.shift()) && this.net.isDead(next.owner));
    if (next) this.grant(name, next);
  }

  crash(owner: string): void {
    // Its queued requests leave the queue and reject (as a request from a tab that is gone does).
    for (const q of this.queues.values())
      for (let i = q.length - 1; i >= 0; i--) if (q[i]!.owner === owner) q.splice(i, 1)[0]!.reject(new Error("InvalidStateError: the tab is gone"));
    for (const [name, o] of [...this.held]) if (o === owner) this.release(name, owner);
  }
}

export interface FakeTab {
  id: string;
  locks: LockManagerLike;
  BroadcastChannel: BroadcastChannelConstructor;
  /** The tab dies: its locks free, its channels stop, none of its code runs for it. */
  crash(): void;
  /** No message reaches the tab any more (it keeps its locks): a frozen or hung tab. */
  freeze(): void;
  /** Messages reach it again (those sent while it was frozen are lost). */
  thaw(): void;
}

export class FakeBrowser {
  readonly locks = new FakeLocks(this);
  /** Messages posted on all channels (each counted once). */
  posted = 0;
  private readonly channels = new Map<string, Set<FakeChannel>>();
  private readonly dead = new Set<string>();
  private readonly frozen = new Set<string>();
  private seq = 0;

  tab(id = `tab${++this.seq}`): FakeTab {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const net = this;
    return {
      id,
      locks: this.locks.scope(id),
      BroadcastChannel: class extends FakeChannel {
        constructor(name: string) {
          super(net, name, id);
        }
      },
      crash: () => {
        this.dead.add(id);
        this.locks.crash(id);
      },
      freeze: () => void this.frozen.add(id),
      thaw: () => void this.frozen.delete(id),
    };
  }

  isDead(tab: string): boolean {
    return this.dead.has(tab);
  }
  isFrozen(tab: string): boolean {
    return this.frozen.has(tab);
  }
  join(c: FakeChannel): void {
    const set = this.channels.get(c.name) ?? new Set();
    set.add(c);
    this.channels.set(c.name, set);
  }
  leave(c: FakeChannel): void {
    this.channels.get(c.name)?.delete(c);
  }
  peers(c: FakeChannel): FakeChannel[] {
    return [...(this.channels.get(c.name) ?? [])].filter((o) => o !== c);
  }
}
