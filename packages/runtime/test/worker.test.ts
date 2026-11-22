import { env, listDurableObjectIds, SELF } from "cloudflare:test";
import { warmWorthIt } from "../src/worker.ts";
import { describe, expect, it } from "vitest";
import { api } from "./helpers.ts";

describe("worker routing", () => {
  it("serves /health and 404", async () => {
    expect(await (await SELF.fetch("http://ember/health")).json()).toEqual({ ok: true });
    expect((await SELF.fetch("http://ember/nope")).status).toBe(404);
  });

  it("validates shard names and upgrades", async () => {
    expect((await SELF.fetch("http://ember/ws?shard=bad", { headers: { Upgrade: "websocket" } })).status).toBe(400);
    expect((await SELF.fetch("http://ember/ws?shard=org:a")).status).toBe(426);
    expect((await SELF.fetch("http://ember/ws?shard=org:a&token=bogus", { headers: { Upgrade: "websocket" } })).status).toBe(401);
    expect((await api("query", { fn: "auth:whoami", args: {}, shard: "nokey" })).status).toBe(400);
  });

  it("runs one-shot HTTP mutation and query with auth", async () => {
    const shard = "chat:http";
    const m = await api("mutation", { fn: "messages:send", args: { channel: "c", body: "hi" }, shard }, "good:alice");
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ ok: true, version: 1 });
    const q = await api("query", { fn: "messages:list", args: { channel: "c" }, shard });
    expect(q.body.value).toMatchObject([{ body: "hi", author: "alice" }]);
    expect((await api("query", { fn: "auth:whoami", args: {}, shard }, "good:bob")).body.value).toBe("bob");
    expect((await api("query", { fn: "auth:whoami", args: {}, shard }, "bad")).status).toBe(401);
    const failed = await api("mutation", { fn: "messages:send", args: { channel: "c", body: "fail" }, shard });
    expect(failed).toMatchObject({ status: 400, body: { ok: false, error: { code: "Error", message: expect.stringContaining("may not be") } } });
    const missing = await api("query", { fn: "nope", args: {}, shard });
    expect(missing.body.error.code).toBe("FunctionNotFound");
  });
});

describe("worker: no DO request a client mistake or a local verify does not need", () => {
  it("warms a shard only for a verify that goes over the network", () => {
    const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJl";
    expect(warmWorthIt(jwt, false)).toBe(false);
    expect(warmWorthIt(jwt, true)).toBe(true);
    expect(warmWorthIt("Abc123SessionTokenXyz", false)).toBe(true);
    expect(warmWorthIt("x", false)).toBe(false);
    expect(warmWorthIt("has spaces in it", false)).toBe(false);
    expect(warmWorthIt("a".repeat(9000), false)).toBe(false);
  });

  it("an unknown or invalid action fails in the Worker, without asking the shard about the identity", async () => {
    const before = (await listDurableObjectIds(env.SHARD)).length;
    const call = (fn: string, args: unknown, shard: string) =>
      SELF.fetch("http://ember/api/action", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer good:alice" }, body: JSON.stringify({ fn, args, shard }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
    expect((await call("nope:missing", {}, "chat:never-woken-1")).body.error.code).toBe("FunctionNotFound");
    expect((await call("messages:send", {}, "chat:never-woken-2")).body.error.code).toMatch(/FunctionNotFound|InvalidFunction/);
    expect((await call("typed:viaAction", { channel: 1 }, "errors:never-woken-3")).body.error.code).toBe("ValidationError");
    expect((await listDurableObjectIds(env.SHARD)).length).toBe(before);
  });
});
