// `{t:"auth"}` with a refreshed token of the same identity and claims (only `exp`/`iat`/`nbf`/`jti` differ): the
// shard swaps the token and runs nothing (no re-run, no snapshot); other claims, another identity, or a socket that
// missed patches while expired still re-evaluate every subscription.
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { api, connect, hello, is, shardStub, sleep, type Client } from "./helpers.ts";

type Snap = Extract<ServerMessage, { t: "snap" }>;
const FEATURES = ["rowdiff", "vdiff", "ident", "query", "ack", "batch"];

let seq = 0;
/** Barrier: every frame the shard sent this socket before now has arrived (one socket's frames run in order). */
async function settle(c: Client) {
  const qid = `b${++seq}`;
  c.send({ t: "q", qid, fn: "auth:whoami", args: {} });
  return c.waitFor<Extract<ServerMessage, { t: "qres" }>>((m) => m.t === "qres" && m.qid === qid, 5000);
}

const rowsRead = async (shard: string) => {
  const sql = (await shardStub(shard).inspect()).sql;
  return (["select", "insert", "update", "delete", "other"] as const).reduce((a, k) => a + sql[k][1]!, 0);
};

async function subscribed(shard: string, token: string) {
  const c = await connect(shard);
  await hello(c, crypto.randomUUID(), token, FEATURES);
  for (let i = 0; i < 5; i++) {
    c.send({ t: "sub", qid: i, fn: "messages:list", args: { channel: `r${i}` } });
    await c.waitFor<Snap>(is("snap", (m) => m.qid === i));
  }
  c.send({ t: "sub", qid: "me", fn: "auth:whoami", args: {} });
  await c.waitFor<Snap>(is("snap", (m) => m.qid === "me"));
  return c;
}

describe("auth renewal on a socket", () => {
  it("same identity and claims (a later iat/exp): no re-run, no snapshot, no rows read; patches keep flowing", async () => {
    const shard = "renew:same";
    const c = await subscribed(shard, "sess:dan:s1:100");
    await settle(c);
    // Baseline: what a barrier alone costs (inspect() reads rows itself).
    let read0 = await rowsRead(shard);
    await settle(c);
    const barrier = (await rowsRead(shard)) - read0;
    const before = await shardStub(shard).inspect();
    read0 = await rowsRead(shard);
    c.send({ t: "auth", token: "sess:dan:s1:200" });
    await settle(c);
    const renewal = (await rowsRead(shard)) - read0;
    const after = await shardStub(shard).inspect();
    expect(c.frames.filter((m) => m.t === "snap" || m.t === "err")).toEqual([]);
    expect(after.stats.authRenewals - before.stats.authRenewals).toBe(1);
    expect(after.stats.reruns - before.stats.reruns).toBe(0);
    expect(after.stats.identityRuns - before.stats.identityRuns).toBe(0);
    // Nothing but the barrier read a row.
    expect(renewal).toBe(barrier);
    // The subscriptions are live under the renewed token.
    expect((await api("mutation", { fn: "messages:send", args: { channel: "r2", body: "after" }, shard })).body.ok).toBe(true);
    expect(await c.waitFor(is("patch"))).toMatchObject({ changes: [{ qid: 2 }] });
    c.close();
  });

  it("an exp-only renewal is a renewal too; its new exp is the one enforced", async () => {
    const shard = "renew:exp";
    const c = await subscribed(shard, "soon:erin:1000");
    c.send({ t: "auth", token: "soon:erin:60000" });
    await settle(c);
    expect(c.frames.filter((m) => m.t === "snap")).toEqual([]);
    await sleep(1100);
    // The first token has expired; the renewed one has not: frames still run.
    expect((await settle(c)).ok).toBe(true);
    c.close();
  });

  it("other claims (another org) or another subject re-evaluate every subscription", async () => {
    const shard = "renew:claims";
    const c = await subscribed(shard, "org:fay:a");
    c.send({ t: "auth", token: "org:fay:b" });
    for (let i = 0; i < 5; i++) await c.waitFor<Snap>(is("snap", (m) => m.qid === i));
    expect(await c.waitFor<Snap>(is("snap", (m) => m.qid === "me"))).toMatchObject({ value: "fay" });
    c.send({ t: "auth", token: "org:gus:b" });
    expect(await c.waitFor<Snap>(is("snap", (m) => m.qid === "me"))).toMatchObject({ value: "gus" });
    c.close();
  });

  it("a socket whose token expired (patches withheld) gets every snapshot again, even with the same claims", async () => {
    const shard = "renew:expired";
    const c = await subscribed(shard, "soon:hal:600");
    await sleep(700);
    // A commit while expired: its patch is withheld and the socket is told `authExpired`.
    expect((await api("mutation", { fn: "messages:send", args: { channel: "r1", body: "missed" }, shard })).body.ok).toBe(true);
    await c.waitFor(is("authExpired"));
    c.send({ t: "auth", token: "soon:hal:60000" });
    const snap = await c.waitFor<Snap>(is("snap", (m) => m.qid === 1));
    expect(((snap as { value?: Array<{ body: string }> }).value ?? []).map((m) => m.body)).toEqual(["missed"]);
    c.close();
  });
});
