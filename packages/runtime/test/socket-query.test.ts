import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Shard } from "../src/shard.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { connect, hello, is, shardStub, sleep, type Client } from "./helpers.ts";

type QRes = Extract<ServerMessage, { t: "qres" }>;
const query = async (c: Client, qid: string | number, fn = "messages:list", args: Record<string, unknown> = { channel: "x" }) => {
  c.send({ t: "q", qid, fn, args });
  return c.waitFor<QRes>(is("qres", (m) => m.qid === qid));
};
const stateOf = (shard: string) => runInDurableObject(shardStub(shard), (i: Shard, state) => {
  const { driver } = i as unknown as { driver: { rowsRead: number; rowsWritten: number } };
  return { rows: { read: driver.rowsRead, written: driver.rowsWritten }, attachments: state.getWebSockets().map((ws) => ws.deserializeAttachment()) };
});

describe("one-shot socket queries", () => {
  it("negotiates query; cache hits execute zero SQL and misses register nothing or write rows", async () => {
    const shard = "socket:query";
    const c = await connect(shard);
    expect((await hello(c, "a", undefined, ["query", "ident", "future"])).features).toEqual(["ident", "query"]);
    c.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "x", body: "one" } });
    await c.waitFor(is("mres"));
    const beforeMiss = await stateOf(shard);
    expect(await query(c, 1)).toMatchObject({ ok: true, version: 1, value: [expect.objectContaining({ body: "one" })] });
    const afterMiss = await stateOf(shard);
    expect(afterMiss.rows.read).toBeGreaterThan(beforeMiss.rows.read);
    expect(afterMiss.rows.written).toBe(beforeMiss.rows.written);
    expect(afterMiss.attachments).toEqual(beforeMiss.attachments);
    expect(await shardStub(shard).inspect()).toMatchObject({ subs: 0, queries: 0 });
    c.send({ t: "sub", qid: "live", fn: "messages:list", args: { channel: "x" } });
    const snap = await c.waitFor(is("snap"));
    const beforeHit = await stateOf(shard);
    expect(await query(c, "hit")).toMatchObject({ ok: true, version: 1, value: (snap as { value: unknown }).value });
    expect(await stateOf(shard)).toEqual(beforeHit);
    expect(await shardStub(shard).inspect()).toMatchObject({ subs: 1, queries: 1 });
    c.close();
  });

  it("accepts q without negotiation, isolates identities, and runs an errored cache entry directly", async () => {
    const shard = "socket:unnegotiated";
    const c = await connect(shard);
    await hello(c, "anon");
    c.send({ t: "sub", qid: "live", fn: "messages:latest", args: { channel: "x" } });
    await c.waitFor(is("err"));
    expect(await query(c, 1, "messages:latest")).toMatchObject({ ok: false, error: { code: "Error" } });
    expect(await shardStub(shard).inspect()).toMatchObject({ subs: 1, queries: 1 });
    const a = await connect(shard);
    await hello(a, "a", "good:alice");
    a.send({ t: "sub", qid: "who", fn: "auth:whoami", args: {} });
    await a.waitFor(is("snap"));
    expect(await query(c, 2, "auth:whoami", {})).toMatchObject({ ok: true, value: null });
    a.close();
    c.close();
  });

  it("refuses missing/internal functions, mutations, expired and revoked identities", async () => {
    const shard = "socket:refusals";
    const c = await connect(shard);
    await hello(c, "a", "soon:alice:150");
    for (const [fn, code] of [["missing:query", "FunctionNotFound"], ["messages:echo", "FunctionNotFound"], ["messages:send", "InvalidFunction"]] as const) {
      expect(await query(c, fn, fn, {})).toMatchObject({ ok: false, error: { code } });
    }
    await sleep(200);
    expect(await query(c, "expired", "auth:whoami", {})).toMatchObject({ ok: false, error: { code: "auth_expired" } });
    await c.waitFor(is("authExpired"));
    c.send({ t: "auth", token: "sess:alice:s1:1" });
    expect(await query(c, "fresh", "auth:whoami", {})).toMatchObject({ ok: true, value: "alice" });
    await shardStub(shard).revokeSockets(shard, { claim: "sid", value: "s1" });
    await c.waitFor(is("authExpired"));
    expect(await query(c, "revoked", "auth:whoami", {})).toMatchObject({ ok: false, error: { code: "auth_expired" } });
    await c.waitFor(is("authExpired"));
    c.close();
  });
});
