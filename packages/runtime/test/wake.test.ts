// Hibernation wake without re-running every subscription in the boot (PLAN §4): restored subscriptions are dormant
// until a background chunk, their socket's own message, or anything that can change results (a commit) runs them.
// No update may be lost, and the first patch after the wake still diffs from the value the client holds.
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { connect, hello, is, shardStub, sleep } from "./helpers.ts";

type Patch = Extract<ServerMessage, { t: "patch" }>;

describe("wake", () => {
  it("restores subscriptions dormant; a commit runs them all first and patches every one with a row diff", async () => {
    const shard = "wake:lazy";
    const w = await connect(shard);
    await hello(w);
    for (let i = 0; i < 3; i++) {
      w.send({ t: "mut", mid: `seed${i}`, fn: "shared:put", args: { room: `r${i}`, body: `first ${i}` } });
      await w.waitFor(is("mres", (m) => m.mid === `seed${i}`));
    }
    w.send({ t: "mut", mid: "join", fn: "shared:join", args: { room: "r0", user: "a" } });
    await w.waitFor(is("mres", (m) => m.mid === "join"));
    const a = await connect(shard);
    await hello(a, "a", "good:a", ["rowdiff", "ident"]);
    // A list per room, a gated list (a is a member), one refused (not a member) and one failing.
    for (let i = 0; i < 3; i++) a.send({ t: "sub", qid: i, fn: "shared:list", args: { room: `r${i}` } });
    a.send({ t: "sub", qid: "g", fn: "shared:gated", args: { room: "r0" } });
    a.send({ t: "sub", qid: "no", fn: "shared:gated", args: { room: "r1" } });
    for (let i = 0; i < 3; i++) await a.waitFor(is("snap", (m) => m.qid === i));
    await a.waitFor(is("snap", (m) => m.qid === "g"));
    await a.waitFor(is("err", (m) => m.qid === "no"));
    const stub = shardStub(shard);
    await evictDurableObject(stub);
    // The first frame after the wake: a commit touching every list (the dormant ones run before it).
    for (let i = 0; i < 3; i++) w.send({ t: "mut", mid: `after${i}`, fn: "shared:put", args: { room: `r${i}`, body: `second ${i}` } });
    for (let i = 0; i < 3; i++) await w.waitFor(is("mres", (m) => m.mid === `after${i}`));
    const got = new Map<string, Patch["changes"][number]>();
    while (got.size < 4) {
      const p = await a.waitFor<Patch>(is("patch"));
      for (const c of p.changes) got.set(String(c.qid), c);
    }
    for (const q of ["0", "1", "2", "g"]) expect(got.get(q), q).toMatchObject({ diff: { remove: [], upsert: [expect.objectContaining({ body: expect.stringMatching(/^second/) })] } });
    expect(got.has("no")).toBe(false);
    const info = await stub.inspect();
    expect(info.stats.rebuiltSubs).toBe(5);
    expect(info.stats.warmed).toBe(5);
    expect(info.dormant).toBe(0);
    a.close();
    w.close();
  });

  it("dormant subscriptions run in the background; unsub, a duplicate sub and auth on a dormant socket behave as before", async () => {
    const shard = "wake:bg";
    const a = await connect(shard);
    await hello(a, "a", "good:a");
    a.send({ t: "sub", qid: 1, fn: "shared:list", args: { room: "x" } });
    a.send({ t: "sub", qid: 2, fn: "shared:list", args: { room: "y" } });
    await a.waitFor(is("snap", (m) => m.qid === 2));
    const stub = shardStub(shard);
    await evictDurableObject(stub);
    // Unsubscribing a dormant one forgets it; a duplicate of a live one is refused as before the wake.
    a.send({ t: "unsub", qid: 1 });
    a.send({ t: "sub", qid: 2, fn: "shared:list", args: { room: "y" } });
    expect(await a.waitFor(is("err"))).toMatchObject({ code: "duplicate_qid", qid: 2 });
    await sleep(50);
    const info = await stub.inspect();
    expect(info).toMatchObject({ subs: 1, dormant: 0 });
    expect(info.stats.warmed).toBe(1);
    // A socket that switches identity after a wake gets its subscriptions re-run under the new one.
    await evictDurableObject(stub);
    a.send({ t: "auth", token: "good:b" });
    expect(await a.waitFor(is("snap", (m) => m.qid === 2))).toMatchObject({ value: [] });
    a.close();
  });
});
