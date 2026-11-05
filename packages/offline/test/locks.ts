// A Web Locks API stand-in for Node (exclusive locks, `ifAvailable`, `signal`), shared by simulated tabs. `kill(tab)`
// is a crashed / closed tab: its locks are released without its callbacks returning, its queued requests vanish.
import type { LockManagerLike } from "../src/tabs.ts";

type Waiter = { owner: string; run(): void; cancel(): void };

export class FakeLocks {
  private readonly held = new Map<string, { owner: string; token: object }>();
  private readonly queues = new Map<string, Waiter[]>();
  private readonly dead = new Set<string>();

  forTab(owner: string): LockManagerLike {
    return {
      request: (name: string, a: unknown, b?: unknown) => {
        const [opts, cb] = (typeof a === "function" ? [{}, a] : [a, b]) as [{ ifAvailable?: boolean; signal?: AbortSignal }, (l: unknown) => unknown];
        return this.request(owner, name, opts, cb);
      },
    } as LockManagerLike;
  }

  private request(owner: string, name: string, opts: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (l: unknown) => unknown): Promise<unknown> {
    if (this.dead.has(owner)) return new Promise(() => {});
    return new Promise((resolve, reject) => {
      const run = () => {
        const token = {};
        this.held.set(name, { owner, token });
        let p: Promise<unknown>;
        try {
          p = Promise.resolve(cb({ name }));
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(
          (v) => {
            this.release(name, token);
            resolve(v);
          },
          (e) => {
            this.release(name, token);
            reject(e);
          },
        );
      };
      if (!this.held.has(name)) return run();
      if (opts.ifAvailable) {
        Promise.resolve()
          .then(() => cb(null))
          .then(resolve, reject);
        return;
      }
      const q = this.queues.get(name) ?? [];
      this.queues.set(name, q);
      const w: Waiter = {
        owner,
        run,
        cancel: () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      };
      q.push(w);
      opts.signal?.addEventListener("abort", () => {
        const i = q.indexOf(w);
        if (i >= 0) q.splice(i, 1);
        w.cancel();
      });
    });
  }

  private release(name: string, token: object): void {
    if (this.held.get(name)?.token !== token) return;
    this.held.delete(name);
    const next = this.queues.get(name)?.shift();
    if (next) queueMicrotask(next.run);
  }

  holder(name: string): string | undefined {
    return this.held.get(name)?.owner;
  }

  kill(owner: string): void {
    this.dead.add(owner);
    for (const q of this.queues.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i]!.owner === owner) q.splice(i, 1);
    for (const [name, h] of [...this.held]) if (h.owner === owner) this.release(name, h.token);
  }
}
