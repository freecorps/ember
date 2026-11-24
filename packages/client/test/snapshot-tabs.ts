// Fakes of what the snapshot cache uses to elect its writer: Web Locks (exclusive, FIFO queue, `signal` while queued,
// released before the request settles)
// and a BroadcastChannel hub (each message structured-cloned; delivered on a microtask, or held until `deliver` picks
// it, in order per sender and receiver like a real channel).
import type { SnapshotChannel, SnapshotLocks } from "../src/index.ts";

export function fakeLocks(): SnapshotLocks & { holder(name: string): unknown } {
  const state = new Map<string, { held: unknown; queue: Array<() => void> }>();
  const of = (name: string) => {
    let s = state.get(name);
    if (!s) state.set(name, (s = { held: null, queue: [] }));
    return s;
  };
  return {
    holder: (name) => of(name).held,
    request(name, options, callback) {
      const s = of(name);
      return new Promise((resolve, reject) => {
        const token = {};
        const run = () => {
          s.held = token;
          // Released when the callback settles, before the request settles (as Web Locks): after `await request()`
          // the lock is someone else's.
          const release = () => {
            s.held = null;
            s.queue.shift()?.();
          };
          Promise.resolve()
            .then(() => callback({ name }))
            .then(
              (x) => (release(), resolve(x)),
              (e: unknown) => (release(), reject(e)),
            );
        };
        options.signal?.addEventListener("abort", () => {
          const i = s.queue.indexOf(run);
          if (i < 0) return;
          s.queue.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        });
        if (s.held) s.queue.push(run);
        else run();
      });
    },
  };
}

type End = SnapshotChannel & { closed: boolean };

export function channelHub(opts: { manual?: boolean } = {}) {
  const ends = new Set<End>();
  const held: Array<{ from: End; to: End; data: unknown }> = [];
  const open = (): End => {
    const end: End = {
      closed: false,
      onmessage: null,
      postMessage(m) {
        if (end.closed) throw new DOMException("closed", "InvalidStateError");
        for (const to of ends) {
          if (to === end) continue;
          const data = structuredClone(m);
          if (opts.manual) held.push({ from: end, to, data });
          else queueMicrotask(() => !to.closed && to.onmessage?.({ data }));
        }
      },
      close() {
        end.closed = true;
        ends.delete(end);
      },
    };
    ends.add(end);
    return end;
  };
  /**
   * Manual: delivers up to `n` held messages, each the oldest of its (sender, receiver) pair, picked by `rand`
   * (only those to receivers `to` accepts).
   */
  const deliver = (n: number, rand: () => number = Math.random, to: (end: End) => boolean = () => true) => {
    for (let i = 0; i < n; i++) {
      const firsts = held.filter((m, j) => to(m.to) && held.findIndex((x) => x.from === m.from && x.to === m.to) === j);
      if (!firsts.length) return;
      const m = firsts[Math.floor(rand() * firsts.length)]!;
      held.splice(held.indexOf(m), 1);
      if (!m.to.closed) m.to.onmessage?.({ data: m.data });
    }
  };
  /** Manual: loses the held messages to receivers `to` accepts. */
  const drop = (to: (end: End) => boolean) => {
    for (const m of held.filter((x) => to(x.to))) held.splice(held.indexOf(m), 1);
  };
  /** Manual: loses the held messages `from` sent (its tab crashed before they left). */
  const dropFrom = (from: SnapshotChannel) => {
    for (const m of held.filter((x) => x.from === from)) held.splice(held.indexOf(m), 1);
  };
  /** Manual: a held message `f` accepts is on its way to a receiver still open. */
  const inFlight = (f: (data: unknown) => boolean) => held.some((m) => !m.to.closed && f(m.data));
  return { open, deliver, drop, dropFrom, inFlight, waiting: () => held.length };
}
