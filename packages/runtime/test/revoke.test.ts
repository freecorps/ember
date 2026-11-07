// Ending an identity's access from the server (Brigade RFC 0016 gap G8): an app's session-end hook reaches the
// sockets of that session at once, and an unexpired token issued before the revocation is refused meanwhile.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";
import worker from "./worker.ts";

const nowS = () => Math.floor(Date.now() / 1000);
const sess = (user: string, sid: string, iat = nowS() - 60) => `sess:${user}:${sid}:${iat}`;

type Revoker = { revokeSockets(shard: string, match: unknown, opts?: unknown): Promise<{ sockets: number }> };
const revoker = (shard: string) => shardStub(shard) as unknown as Revoker;

async function subscribed(shard: string, token: string) {
  const c = await connect(shard);
  await hello(c, crypto.randomUUID(), token);
  c.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "c" } });
  await c.waitFor(is("snap"));
  return c;
}

describe("revokeSockets", () => {
  it("one session's sockets are told authExpired and run nothing; the user's other session is untouched", async () => {
    const shard = "revoke:sid";
    const ended = await subscribed(shard, sess("ana", "s1"));
    const other = await subscribed(shard, sess("ana", "s2"));
    expect(await revoker(shard).revokeSockets(shard, { claim: "sid", value: "s1" })).toEqual({ sockets: 1 });
    await ended.waitFor(is("authExpired"));
    ended.send({ t: "sub", qid: 2, fn: "messages:list", args: { channel: "d" } });
    await ended.waitFor(is("err", (m) => m.code === "auth_expired"));
    // A write the ended socket would have seen reaches only the live one.
    expect((await api("mutation", { fn: "messages:send", args: { channel: "c", body: "after" }, shard }, sess("bia", "b1"))).body.ok).toBe(true);
    await other.waitFor(is("patch"));
    await sleep(50);
    expect(ended.frames.some((f) => f.t === "patch")).toBe(false);
    expect(other.frames.some((f) => f.t === "authExpired")).toBe(false);
    ended.close();
    other.close();
  });

  it("the same unexpired token is refused afterwards, on sockets and over HTTP; a token issued later is not", async () => {
    const shard = "revoke:replay";
    const old = sess("ana", "s1", nowS() - 60);
    const c = await subscribed(shard, old);
    await revoker(shard).revokeSockets(shard, { claim: "sid", value: "s1" });
    await c.waitFor(is("authExpired"));
    c.send({ t: "auth", token: old });
    await c.waitFor(is("err", (m) => m.code === "unauthenticated"));
    const http = await api("query", { fn: "messages:list", args: { channel: "c" }, shard }, old);
    expect(http.body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    // A new sign-in of the same session id, issued after the revocation.
    const fresh = sess("ana", "s1", nowS() + 5);
    c.send({ t: "auth", token: fresh });
    c.send({ t: "sub", qid: 3, fn: "messages:list", args: { channel: "c" } });
    await c.waitFor(is("snap", (m) => m.qid === 3));
    expect((await api("query", { fn: "messages:list", args: { channel: "c" }, shard }, fresh)).body.ok).toBe(true);
    c.close();
  });

  it("a fresh socket upgraded with a revoked token is refused (401); one already open with it cannot subscribe", async () => {
    const shard = "revoke:fresh";
    const old = sess("ana", "s1");
    const open = await subscribed(shard, old);
    await revoker(shard).revokeSockets(shard, { claim: "sid", value: "s1" });
    await open.waitFor(is("authExpired"));
    const res = await SELF.fetch(`http://ember/ws?shard=${shard}&token=${encodeURIComponent(old)}`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
    // hello with the same token on an anonymous socket: refused, and the socket stays anonymous.
    const c = await connect(shard);
    await hello(c, crypto.randomUUID(), old);
    await c.waitFor(is("err", (m) => m.code === "unauthenticated"));
    open.close();
    c.close();
  });

  it("after a { subject } revocation a token without iat (a new sign-in that cannot be dated) is let in; one dated before is not", async () => {
    const shard = "revoke:noiat";
    await revoker(shard).revokeSockets(shard, { subject: "ana" });
    expect((await api("query", { fn: "messages:list", args: { channel: "c" }, shard }, "good:ana")).body.ok).toBe(true);
    expect((await api("query", { fn: "messages:list", args: { channel: "c" }, shard }, sess("ana", "s1"))).body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    // A session's own revocation still refuses a token without iat for that session.
    await revoker(shard).revokeSockets(shard, { claim: "sid", value: "s7" });
    expect((await api("query", { fn: "messages:list", args: { channel: "c" }, shard }, "nosid:bia:s7")).body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  });

  it("forMs: 0 forgets an earlier revocation of the same identity", async () => {
    const shard = "revoke:forget";
    const old = sess("ana", "s1");
    await revoker(shard).revokeSockets(shard, { claim: "sid", value: "s1" });
    expect((await api("query", { fn: "messages:list", args: { channel: "c" }, shard }, old)).body.ok).toBe(false);
    await revoker(shard).revokeSockets(shard, { claim: "sid", value: "s1" }, { forMs: 0 });
    expect((await api("query", { fn: "messages:list", args: { channel: "c" }, shard }, old)).body.ok).toBe(true);
  });

  it("an action with a revoked identity never starts", async () => {
    const shard = "revoke:action";
    await revoker(shard).revokeSockets(shard, { claim: "sid", value: "s1" });
    const res = await SELF.fetch("http://ember/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sess("ana", "s1")}` },
      body: JSON.stringify({ fn: "actions:ping", args: {}, shard }),
    });
    expect(res.status).toBe(401);
    const ok = await SELF.fetch("http://ember/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sess("ana", "s2")}` },
      body: JSON.stringify({ fn: "actions:ping", args: {}, shard }),
    });
    expect(ok.status).toBe(200);
  });

  it("{ subject } reaches every session of the user; close: true closes the sockets; forMs: 0 remembers nothing", async () => {
    const shard = "revoke:subject";
    const a = await subscribed(shard, sess("ana", "s1"));
    const b = await subscribed(shard, sess("ana", "s2"));
    const bia = await subscribed(shard, sess("bia", "b1"));
    const closed: number[] = [];
    for (const c of [a, b]) c.ws.addEventListener("close", (e: CloseEvent) => closed.push(e.code));
    expect(await revoker(shard).revokeSockets(shard, { subject: "ana" }, { close: true, forMs: 0 })).toEqual({ sockets: 2 });
    for (let i = 0; i < 40 && closed.length < 2; i++) await sleep(25);
    expect(closed).toEqual([4401, 4401]);
    expect(bia.frames.some((f) => f.t === "authExpired")).toBe(false);
    // Nothing remembered: the old token works again (forMs: 0).
    expect((await api("query", { fn: "messages:list", args: { channel: "c" }, shard }, sess("ana", "s1"))).body.ok).toBe(true);
    bia.close();
  });

  it("the Worker's revokeSockets reaches the shard; a bad shard or match is refused", async () => {
    const shard = "revoke:worker";
    const c = await subscribed(shard, sess("ana", "s9"));
    expect(await worker.revokeSockets(env as any, shard, { claim: "sid", value: "s9" })).toEqual({ sockets: 1 });
    await c.waitFor(is("authExpired"));
    await expect(worker.revokeSockets(env as any, "no shard", { subject: "x" })).rejects.toThrow(/invalid shard/);
    for (const bad of [null, "ana", { claim: "", value: "x" }, { subject: "" }, { claim: "sid", value: {} }]) {
      await expect(worker.revokeSockets(env as any, shard, bad as any)).rejects.toThrow(/match is/);
    }
    c.close();
  });
});
