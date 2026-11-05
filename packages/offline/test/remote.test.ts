// remote.ts across a leader handover: a call in flight is settled only by the server it was last sent to, and a
// stopped (leaving) server answers nothing more, so its calls are resent to the next one instead of failing.
import { describe, expect, it, vi } from "vitest";
import { MemoryPendingStorage, stableStringify } from "@freecorps/ember-client";
import { RemoteStorage, serveStorage, type Endpoint, type ServableStorage } from "../src/remote.ts";

/** A BroadcastChannel stand-in: every message reaches every other endpoint, asynchronously, in order. */
function bus() {
  const ends = new Set<{ listeners: Set<(e: { data: unknown }) => void> }>();
  return (): Endpoint & { sent: unknown[] } => {
    const me = { listeners: new Set<(e: { data: unknown }) => void>() };
    ends.add(me);
    const sent: unknown[] = [];
    return {
      sent,
      postMessage(data) {
        sent.push(data);
        const copy = structuredClone(data);
        for (const e of ends) if (e !== me) for (const l of [...e.listeners]) setTimeout(() => l({ data: copy }), 0);
      },
      addEventListener: (_t, l) => void me.listeners.add(l),
      removeEventListener: (_t, l) => void me.listeners.delete(l),
    };
  };
}

const req = { shard: "s", fn: "messages:list", args: {}, argsJson: stableStringify({}), identity: null };

/** A storage whose runQueryLocally waits until released (then answers `value`, or fails with `error`). */
function storage(value: unknown) {
  const calls: Array<{ resolve(): void; reject(e: Error): void }> = [];
  const s: ServableStorage = {
    load: async () => ({ identity: null }),
    applyPatch: async () => {},
    runQueryLocally: () =>
      new Promise((resolve, reject) => calls.push({ resolve: () => resolve({ value, source: "local" }), reject })),
    persistPending: new MemoryPendingStorage(),
  };
  return { s, calls };
}

const until = (cond: () => unknown) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout: 2000, interval: 2 },
  );

describe("remote storage across a leader handover", () => {
  it("a call the leaving leader was running is resent to the next one, not failed with its closing error", async () => {
    const endpoint = bus();
    const old = storage("old");
    const oldServer = serveStorage(old.s, endpoint(), { address: "leader" });
    const follower = new RemoteStorage(endpoint(), { to: "leader" });
    const result = follower.runQueryLocally(req);
    await until(() => old.calls.length === 1);

    // The old leader leaves: it stops serving, then closing its store fails what it was still running.
    oldServer.stop();
    old.calls[0]!.reject(new Error("database is closing"));
    await new Promise((r) => setTimeout(r, 10));

    const next = storage("new");
    const nextServer = serveStorage(next.s, endpoint(), { address: "leader" });
    nextServer.announce("tab-2");
    await until(() => next.calls.length === 1);
    next.calls[0]!.resolve();
    await expect(result).resolves.toEqual({ value: "new", source: "local" });
    nextServer.stop();
    follower.close();
  });

  it("a late answer to a call's previous request id does not settle the resent call", async () => {
    const endpoint = bus();
    const old = storage("old");
    const oldEnd = endpoint();
    serveStorage(old.s, oldEnd, { address: "leader" });
    const followerEnd = endpoint();
    const follower = new RemoteStorage(followerEnd, { to: "leader" });
    const result = follower.runQueryLocally(req);
    await until(() => old.calls.length === 1);
    const first = followerEnd.sent.find((m) => (m as { op?: string }).op === "runQueryLocally") as { id: number };

    const next = storage("new");
    const nextServer = serveStorage(next.s, endpoint(), { address: "leader" });
    nextServer.announce("tab-2");
    await until(() => next.calls.length === 1);
    // The previous server (it never saw the handover) answers the old request id late, with an error.
    oldEnd.postMessage({ ember: "offline/1", k: "res", id: first.id, to: follower.id, ok: false, e: { name: "Error", message: "stale" } });
    await new Promise((r) => setTimeout(r, 10));
    next.calls[0]!.resolve();
    await expect(result).resolves.toEqual({ value: "new", source: "local" });
    nextServer.stop();
    follower.close();
  });
});
