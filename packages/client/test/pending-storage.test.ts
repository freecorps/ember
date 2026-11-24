// KeyValuePendingStorage coalesces writes: every put/remove made while a write runs (or in the same microtask) goes
// out as one setItem of the resulting queue, in order; a failed write rejects its callers and keeps the stored queue.
import { describe, expect, it } from "vitest";
import { KeyValuePendingStorage, type PendingMutationRecord } from "../src/index.ts";

const rec = (mid: string): PendingMutationRecord => ({ mid, shard: "s", fn: "messages:send", args: { body: mid }, createdAt: 1 });

function store(opts: { async?: boolean; fail?: () => boolean } = {}) {
  const m = new Map<string, string>();
  const writes: string[] = [];
  const set = (k: string, v: string) => {
    if (opts.fail?.()) throw new Error("quota");
    writes.push(v);
    m.set(k, v);
  };
  const kv = opts.async
    ? { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => (await new Promise((r) => setTimeout(r, 5)), set(k, v)) }
    : { getItem: (k: string) => m.get(k) ?? null, setItem: set };
  return { m, writes, kv };
}

describe("KeyValuePendingStorage", () => {
  it("a burst of puts and removes is one write, in order", async () => {
    const { writes, kv } = store();
    const p = new KeyValuePendingStorage(kv);
    await p.load();
    await Promise.all([p.put(rec("a")), p.put(rec("b")), p.put(rec("c")), p.remove("a"), p.put(rec("b"))]);
    expect(writes).toHaveLength(1);
    expect((await p.load()).map((r) => r.mid)).toEqual(["c", "b"]);
  });

  it("with an async store, changes made while a write runs go out together in the next one", async () => {
    const { writes, kv } = store({ async: true });
    const p = new KeyValuePendingStorage(kv);
    const first = p.put(rec("a"));
    await new Promise((r) => setTimeout(r, 1));
    const rest = [p.put(rec("b")), p.put(rec("c")), p.remove("a")];
    await Promise.all([first, ...rest]);
    expect(writes).toHaveLength(2);
    expect((JSON.parse(writes[1]!) as PendingMutationRecord[]).map((r) => r.mid)).toEqual(["b", "c"]);
  });

  it("a failed write rejects its callers and leaves the stored queue as it was", async () => {
    let fail = false;
    const { kv } = store({ fail: () => fail });
    const p = new KeyValuePendingStorage(kv);
    await p.put(rec("a"));
    fail = true;
    const r = [p.put(rec("b")), p.remove("a")];
    for (const x of r) await expect(x).rejects.toThrow("quota");
    fail = false;
    await p.put(rec("c"));
    expect((await p.load()).map((x) => x.mid)).toEqual(["a", "c"]);
  });

  it("a load between two unawaited changes returns what was put before it, not after", async () => {
    for (const async of [false, true]) {
      const { kv, writes } = store({ async });
      const p = new KeyValuePendingStorage(kv);
      const put = p.put(rec("a"));
      const loaded = p.load();
      const removed = p.remove("a");
      expect((await loaded).map((r) => r.mid)).toEqual(["a"]);
      await Promise.all([put, removed]);
      expect((await p.load()).map((r) => r.mid)).toEqual([]);
      expect(writes).toHaveLength(2);
      // with no load in between, changes still go out as one write
      await Promise.all([p.put(rec("b")), p.put(rec("c"))]);
      expect(writes).toHaveLength(3);
    }
  });

  it("a load that starts while an earlier put is being written never replaces it (the put is not lost later)", async () => {
    const m = new Map<string, string>();
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // An async store whose reads see the state when they start, and take a while.
    const kv = {
      getItem: async (k: string) => {
        const v = m.get(k) ?? null;
        await delay(20);
        return v;
      },
      setItem: async (k: string, v: string) => {
        await delay(5);
        m.set(k, v);
      },
    };
    const p = new KeyValuePendingStorage(kv);
    const put = p.put(rec("a")); // a mutation issued while the client starts: before its load()
    await delay(21);
    const loaded = p.load();
    await put;
    expect((await loaded).map((r) => r.mid)).toEqual(["a"]);
    await p.put(rec("b"));
    expect((JSON.parse(m.get("ember:pending")!) as PendingMutationRecord[]).map((r) => r.mid)).toEqual(["a", "b"]);
  });
});
