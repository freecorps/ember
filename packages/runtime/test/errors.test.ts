// Application errors end to end (docs/design/dx.md §3.2): thrown with `defineErrors`, they leave the engine, the shard,
// actions and the Worker with `kind: "app"` and their validated payload, over WebSocket and HTTP. Nothing they did is
// committed.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parse as decodeJson } from "../src/wire.ts";
import { api, connect, hello, is } from "./helpers.ts";

async function post(path: string, body: unknown) {
  const res = await SELF.fetch(`http://ember${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: decodeJson(await res.text()) as any };
}

describe("application errors", () => {
  it("a mutation's error carries kind and data over HTTP, and rolls back its writes", async () => {
    const shard = "errors:http";
    const r = await api("mutation", { fn: "typed:quota", args: { channel: "q" }, shard });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "Quota", kind: "app", message: "Over quota" });
    expect(decodeJson(JSON.stringify(r.body.error.data))).toEqual({ limit: 3, used: 4n });
    expect((await api("query", { fn: "typed:count", args: { channel: "q" }, shard })).body.value).toBe(0);
  });

  it("over the socket (mres)", async () => {
    const c = await connect("errors:ws");
    await hello(c);
    c.send({ t: "mut", mid: "m1", fn: "typed:quota", args: { channel: "w" } } as never);
    const m = (await c.waitFor(is("mres", (x) => x.mid === "m1"))) as unknown as { ok: boolean; error: { code: string; kind?: string; data?: unknown } };
    expect(m.ok).toBe(false);
    expect(m.error).toMatchObject({ code: "Quota", kind: "app" });
    expect(m.error.data).toMatchObject({ limit: 3 });
    c.close();
  });

  it("system errors stay system errors (no kind)", async () => {
    const r = await api("query", { fn: "typed:me", args: {}, shard: "errors:sys" });
    expect(r.body.error).toEqual({ code: "Unauthenticated", message: "Not signed in" });
  });

  it("actions: their own errors and a callee's keep kind and data", async () => {
    const own = await post("/api/action", { fn: "typed:guarded", args: {}, shard: "errors:act" });
    expect(own.body.error).toEqual({ code: "NotSignedIn", message: "NotSignedIn", kind: "app" });
    const failing = await post("/api/action", { fn: "typed:failing", args: {}, shard: "errors:act" });
    expect(failing.body.error).toMatchObject({ code: "Quota", kind: "app", data: { limit: 1, used: 2n } });
    const via = await post("/api/action", { fn: "typed:viaAction", args: { channel: "a" }, shard: "errors:act" });
    expect(via.body.error).toMatchObject({ code: "Quota", kind: "app", data: { limit: 3, used: 4n } });
  });
});
