// Feature "batch" (protocol v1.3): a client frame may be a JSON array of messages, handled in order; what the shard
// sends a batching socket in one turn goes out as one array frame. Without the feature nothing changes.
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { connect, hello, is } from "./helpers.ts";

type Mres = Extract<ServerMessage, { t: "mres" }>;

const mut = (mid: string, body: string) => ({ t: "mut", mid, fn: "messages:send", args: { channel: "b", body } });

describe("batch frames", () => {
  it("negotiates the feature", async () => {
    const c = await connect("chat:batch-ready");
    expect((await hello(c, "dev", undefined, ["batch"])).features).toEqual(["batch"]);
    c.close();
  });

  it("a batch of mutations commits together and its replies come back as one frame, in order", async () => {
    const c = await connect("chat:batch-muts");
    await hello(c, "dev-1", "good:dan", ["batch", "ack"]);
    c.send({ t: "sub", qid: "list", fn: "messages:list", args: { channel: "b" } });
    await c.waitFor(is("snap"));
    c.send(JSON.stringify([...Array.from({ length: 10 }, (_, i) => mut(`m${i}`, `b${i}`)), { t: "q", qid: "count", fn: "messages:list", args: { channel: "b" } }]));
    const outcomes = await Promise.all(Array.from({ length: 10 }, (_, i) => c.waitFor<Mres>(is("mres", (m) => m.mid === `m${i}`))));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    // One commit: every mutation sees the same version.
    expect(new Set(outcomes.map((o) => (o as { version: number }).version)).size).toBe(1);
    // The patch, then the ten mres, travelled in one frame.
    expect(Math.max(...c.batches)).toBeGreaterThanOrEqual(11);
    const q = await c.waitFor<Extract<ServerMessage, { t: "qres" }>>(is("qres"));
    expect(q).toMatchObject({ qid: "count", ok: true });
    c.close();
  });

  it("an invalid element is refused on its own; hello is never batched", async () => {
    const c = await connect("chat:batch-bad");
    await hello(c, "dev-1", "good:dan", ["batch"]);
    c.send(JSON.stringify([mut("ok1", "x"), { t: "nope" }, { t: "hello", clientId: "x", protocol: 1 }, mut("ok2", "y")]));
    const errs = [await c.waitFor(is("err")), await c.waitFor(is("err"))];
    expect(errs.map((e) => (e as { code: string }).code)).toEqual(["bad_frame", "bad_frame"]);
    expect(await c.waitFor<Mres>(is("mres", (m) => m.mid === "ok1"))).toMatchObject({ ok: true });
    expect(await c.waitFor<Mres>(is("mres", (m) => m.mid === "ok2"))).toMatchObject({ ok: true });
    c.send("[]");
    expect(await c.waitFor(is("err"))).toMatchObject({ code: "bad_frame" });
    c.close();
  });

  it("without the feature, replies are one frame each", async () => {
    const c = await connect("chat:batch-off");
    await hello(c, "dev-1", "good:dan", ["ack"]);
    for (let i = 0; i < 5; i++) c.send(mut(`n${i}`, `x${i}`) as never);
    for (let i = 0; i < 5; i++) await c.waitFor<Mres>(is("mres", (m) => m.mid === `n${i}`));
    expect(c.batches).toEqual([]);
    c.close();
  });
});
