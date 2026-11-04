import { SELF } from "cloudflare:test";
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
