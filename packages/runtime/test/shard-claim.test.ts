// `shard: { org: fromAuth("org") }` (PLAN §22 L1, docs/design/dx.md §3.6): the shard key is a claim of the verified
// identity. The Worker routes HTTP calls by it, the engine refuses another shard (`WrongShard`) or no identity
// (`Unauthenticated`), the check runs per caller on sockets (the result stays shared by the org), and jobs run as the
// system on the shard they were scheduled on.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { api, connect, hello, shardStub, sleep } from "./helpers.ts";

/** `POST /api/<kind>/<fn>` (args as the body, the shard from `?shard=`, the routing argument or the claim). */
async function perFn(kind: "query" | "mutation" | "action", fn: string, args: unknown, token?: string, shard?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await SELF.fetch(`http://ember/api/${kind}/${fn}${shard ? `?shard=${encodeURIComponent(shard)}` : ""}`, { method: "POST", headers, body: JSON.stringify(args) });
  return { status: res.status, body: (await res.json()) as any };
}
async function action(body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await SELF.fetch("http://ember/api/action", { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

describe("shard: fromAuth over HTTP", () => {
  it("routes queries and mutations to the shard of the token's claim", async () => {
    const a = "org:ana:claim-a";
    const b = "org:bia:claim-b";
    expect((await api("mutation", { fn: "tenant:add", args: { body: "a1" } }, a)).body).toEqual({ ok: true, value: 1, version: expect.any(Number) });
    expect((await perFn("mutation", "tenant:add", { body: "b1" }, b)).body).toMatchObject({ ok: true, value: 1 });
    expect((await api("query", { fn: "tenant:list", args: {} }, a)).body).toMatchObject({ ok: true, value: ["a1"] });
    expect((await perFn("query", "tenant:list", {}, b)).body).toMatchObject({ ok: true, value: ["b1"] });
    // Each one landed in its own org's shard.
    expect(((await shardStub("org:claim-a").query("org:claim-a", "tenant:list", {}, { subject: "ana", claims: { org: "claim-a" } })) as { value?: unknown }).value).toEqual(["a1"]);
  });

  it("an explicit shard that disagrees with the claim is refused by the function (WrongShard)", async () => {
    const r = await api("query", { fn: "tenant:list", args: {}, shard: "org:claim-x" }, "org:ana:claim-y");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "WrongShard", data: { expected: "org:claim-y", shard: "org:claim-x" } });
    expect((await perFn("mutation", "tenant:add", { body: "x" }, "org:ana:claim-y", "org:claim-x")).body.error).toMatchObject({ code: "WrongShard" });
    // The same shard, named: fine.
    expect((await api("query", { fn: "tenant:list", args: {}, shard: "org:claim-y" }, "org:ana:claim-y")).body).toMatchObject({ ok: true, value: [] });
  });

  it("no token is Unauthenticated, a token without the claim is WrongShard, a bad token 401", async () => {
    expect(await api("query", { fn: "tenant:list", args: {} })).toMatchObject({ status: 400, body: { ok: false, error: { code: "Unauthenticated" } } });
    expect(await perFn("query", "tenant:list", {})).toMatchObject({ status: 400, body: { error: { code: "Unauthenticated" } } });
    expect(await api("query", { fn: "tenant:list", args: {} }, "good:cris")).toMatchObject({ status: 400, body: { error: { code: "WrongShard", data: { expected: "org", shard: null } } } });
    expect((await api("query", { fn: "tenant:list", args: {} }, "bogus")).status).toBe(401);
    // Named explicitly without identity: the shard's own check answers.
    expect((await api("query", { fn: "tenant:list", args: {}, shard: "org:claim-z" })).body.error).toMatchObject({ code: "Unauthenticated" });
  });

  it("actions route by the claim too, and their ctx.runQuery runs there as the caller", async () => {
    const t = "org:ana:claim-act";
    await api("mutation", { fn: "tenant:add", args: { body: "n" } }, t);
    expect((await action({ fn: "tenant:where", args: {} }, t)).body).toEqual({ ok: true, value: { shard: "org:claim-act", notes: 1 } });
    expect((await perFn("action", "tenant:where", {}, t)).body).toEqual({ ok: true, value: { shard: "org:claim-act", notes: 1 } });
    expect((await action({ fn: "tenant:where", args: {}, shard: "org:other" }, t)).body.error).toMatchObject({ code: "WrongShard", data: { expected: "org:claim-act", shard: "org:other" } });
    expect((await action({ fn: "tenant:where", args: {} })).body.error).toMatchObject({ code: "Unauthenticated" });
  });

  it("jobs scheduled by a fromAuth function run as the system on the same shard", async () => {
    const t = "org:ana:claim-jobs";
    await api("mutation", { fn: "tenant:add", args: { body: "j", later: true } }, t);
    let notes: unknown = null;
    for (let i = 0; i < 50; i++) {
      notes = (await api("query", { fn: "tenant:list", args: {} }, t)).body.value;
      if ((notes as string[]).length === 3) break;
      await sleep(50);
    }
    expect([...(notes as string[])].sort()).toEqual(["j", "j (action job)", "j (job)"]);
  });
});

describe("shard: fromAuth over sockets", () => {
  async function sock(shard: string, token?: string) {
    const c = await connect(shard);
    await hello(c, crypto.randomUUID(), token, ["ident"]);
    return c;
  }
  const answer = (c: Awaited<ReturnType<typeof sock>>, qid: string) =>
    c.waitFor<ServerMessage>((m) => (m.t === "snap" || m.t === "err") && "qid" in m && m.qid === qid, 5000);

  it("checks each subscriber's claim, and shares one result between the org's members", async () => {
    const shard = "org:claim-ws";
    await api("mutation", { fn: "tenant:add", args: { body: "hello" } }, "org:ana:claim-ws");
    const ana = await sock(shard, "org:ana:claim-ws");
    const bia = await sock(shard, "org:bia:claim-ws");
    const eve = await sock(shard, "org:eve:claim-other");
    const anon = await sock(shard);
    for (const c of [ana, bia, eve, anon]) c.send({ t: "sub", qid: "l", fn: "tenant:list", args: {} });
    expect(await answer(ana, "l")).toMatchObject({ t: "snap", value: ["hello"] });
    expect(await answer(bia, "l")).toMatchObject({ t: "snap", value: ["hello"] });
    expect(await answer(eve, "l")).toMatchObject({ t: "err", code: "WrongShard" });
    expect(await answer(anon, "l")).toMatchObject({ t: "err", code: "Unauthenticated" });
    expect(await shardStub(shard).inspect()).toMatchObject({ shared: 1 });

    // Same subject, another active org (a new token): the subscription is checked again and refused.
    ana.send({ t: "auth", token: "org:ana:claim-elsewhere" });
    expect(await answer(ana, "l")).toMatchObject({ t: "err", code: "WrongShard" });
    // Back to this org: admitted again.
    ana.send({ t: "auth", token: "org:ana:claim-ws" });
    expect(await answer(ana, "l")).toMatchObject({ t: "snap", value: ["hello"] });
    // A one-shot query by a caller of another org never reads the shared result.
    expect(((await shardStub(shard).query(shard, "tenant:list", {}, { subject: "bia", claims: { org: "claim-other" } })) as { error?: unknown }).error).toMatchObject({ code: "WrongShard" });
    for (const c of [ana, bia, eve, anon]) c.close();
  });
});
