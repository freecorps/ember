// Phase 1 hardening of the shard's reactivity: read-set index, failing subscriptions, search debounce, token expiry.
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { connect, hello, is, shardStub, sleep } from "./helpers.ts";

type Patch = Extract<ServerMessage, { t: "patch" }>;
type Err = Extract<ServerMessage, { t: "err" }>;
type Snap = Extract<ServerMessage, { t: "snap" }> & { value?: any };

describe("reactivity", () => {
  it("only subscriptions whose ranges a commit touches are re-run", async () => {
    const shard = "rx:index";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a);
    await hello(b);
    for (const ch of ["x", "y", "z"]) a.send({ t: "sub", qid: ch, fn: "messages:list", args: { channel: ch } });
    for (let i = 0; i < 3; i++) await a.waitFor(is("snap"));
    const stub = shardStub(shard);
    const r0 = (await stub.inspect()).stats.reruns;
    b.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "y", body: "hi" } });
    const p = await a.waitFor<Patch>(is("patch"));
    expect(p.changes.map((c) => c.qid)).toEqual(["y"]);
    expect((await stub.inspect()).stats.reruns - r0).toBe(1);
    a.close();
    b.close();
  });

  it("a failing subscription is re-run only on commits to tables it is known to read", async () => {
    const shard = "rx:failing";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a);
    await hello(b);
    a.send({ t: "sub", qid: "l", fn: "messages:latest", args: { channel: "q" } });
    expect(await a.waitFor<Err>(is("err"))).toMatchObject({ qid: "l" });
    const stub = shardStub(shard);
    const r0 = (await stub.inspect()).stats.reruns;
    // `runs` is not read by messages:latest: no re-run
    b.send({ t: "mut", mid: 1, fn: "runs:add", args: { label: "x" } });
    b.send({ t: "mut", mid: 2, fn: "runs:add", args: { label: "y" } });
    expect(await b.waitFor(is("mres", (m) => m.mid === 2))).toMatchObject({ ok: true });
    expect((await stub.inspect()).stats.reruns).toBe(r0);
    // a write to `messages` (another channel) re-runs it (table-level), still failing: no new frame
    b.send({ t: "mut", mid: 3, fn: "messages:send", args: { channel: "other", body: "x" } });
    await b.waitFor(is("mres", (m) => m.mid === 3));
    expect((await stub.inspect()).stats.reruns).toBe(r0 + 1);
    b.send({ t: "mut", mid: 4, fn: "messages:send", args: { channel: "q", body: "first" } });
    expect((await a.waitFor<Patch>(is("patch"))).changes).toEqual([{ qid: "l", value: "first" }]);
    a.close();
    b.close();
  });

  it("search: set changes re-run at once; other writes to the table re-run once, debounced", async () => {
    const shard = "rx:search";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a);
    await hello(b);
    a.send({ t: "sub", qid: "s", fn: "messages:search", args: { q: "brav" } });
    expect(await a.waitFor<Snap>(is("snap"))).toMatchObject({ value: [] });
    const stub = shardStub(shard);
    // exact: a result-set change is patched by an immediate re-run, not through the debounce window (150 ms in
    // tests). Checked with the shard's counters rather than wall time, which is unreliable on loaded CI runners.
    const before = (await stub.inspect()).stats;
    b.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "c", body: "brave" } });
    expect((await a.waitFor<Patch>(is("patch"))).changes).toEqual([{ qid: "s", value: ["brave"] }]);
    const after = (await stub.inspect()).stats;
    expect(after.debouncedReruns).toBe(before.debouncedReruns);
    expect(after.reruns).toBeGreaterThan(before.reruns);
    const base = (await stub.inspect()).stats;
    // loose: unrelated writes, coalesced into one debounced re-run
    for (const mid of [2, 3, 4]) b.send({ t: "mut", mid, fn: "messages:send", args: { channel: "c", body: `goodbye ${mid}` } });
    await b.waitFor(is("mres", (m) => m.mid === 4));
    let s = (await stub.inspect()).stats;
    expect(s.debouncedReruns).toBe(base.debouncedReruns);
    expect(s.reruns).toBe(base.reruns);
    await sleep(300);
    s = (await stub.inspect()).stats;
    expect(s.debouncedReruns).toBe(base.debouncedReruns + 1);
    // same results: no patch for the debounced re-run
    expect(a.frames.filter((f) => f.t === "patch")).toEqual([]);
    a.close();
    b.close();
  });

  it("an expired identity stops receiving patches; authExpired is sent once; auth resumes with a snap", async () => {
    const shard = "rx:expired";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a, "dev-e", "soon:eve:150");
    await hello(b);
    a.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "e" } });
    await a.waitFor(is("snap"));
    b.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "e", body: "before" } });
    await a.waitFor(is("patch"));
    await sleep(200);
    b.send({ t: "mut", mid: 2, fn: "messages:send", args: { channel: "e", body: "after 1" } });
    await a.waitFor(is("authExpired"));
    b.send({ t: "mut", mid: 3, fn: "messages:send", args: { channel: "e", body: "after 2" } });
    await b.waitFor(is("mres", (m) => m.mid === 3));
    await sleep(50);
    expect(a.frames.filter((f) => f.t === "patch" || f.t === "authExpired")).toEqual([]);
    a.send({ t: "auth", token: "good:eve" });
    const snap = await a.waitFor<Snap>(is("snap"));
    expect((snap.value as Array<{ body: string }>).map((m) => m.body)).toEqual(["before", "after 1", "after 2"]);
    b.send({ t: "mut", mid: 4, fn: "messages:send", args: { channel: "e", body: "fresh" } });
    expect(((await a.waitFor<Patch>(is("patch"))).changes[0]!.value as unknown[]).length).toBe(4);
    a.close();
    b.close();
  });
});
