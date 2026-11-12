// Typed HTTP routes and the per-function endpoint (docs/design/dx.md §3.11), end to end in workerd.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parse } from "../src/wire.ts";

async function call(method: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`http://ember${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { status: res.status, body: parse(await res.text()) as any };
}

describe("typed routes", () => {
  it("validates params, query (coerced, defaults) and body; returns the value as JSON", async () => {
    expect((await call("POST", "/channels/typed/messages", { body: "one" })).status).toBe(200);
    const big = await call("POST", "/channels/typed/messages", '{"body":"two","big":{"$int64":"9007199254740993"}}');
    expect(big.body.big).toBe(9007199254740993n);
    expect((await call("GET", "/channels/typed/messages")).body).toEqual({ channel: "typed", limit: 10, bodies: ["one", "two"] });
    expect((await call("GET", "/channels/typed/messages?limit=1&desc=true")).body).toEqual({ channel: "typed", limit: 1, bodies: ["two"] });
    const bad = await call("GET", "/channels/typed/messages?limit=0");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "ValidationError", data: { issues: [{ path: "query.limit" }] } });
    const noBody = await call("POST", "/channels/typed/messages", { body: "" });
    expect(noBody.body.error.data.issues).toEqual([{ path: "body.body", message: "Must not be empty" }]);
  });

  it("application errors answer with their status and payload", async () => {
    const r = await call("GET", "/channels/missing/messages");
    expect(r.status).toBe(404);
    expect(r.body.error).toEqual({ code: "NoChannel", message: "No such channel", data: { channel: "missing" }, kind: "app" });
  });

  it("raw routes still work; :params need a typed route", async () => {
    expect((await SELF.fetch("http://ember/hello?key=x")).status).toBe(200);
  });
});

describe("POST /api/<kind>/<fn>", () => {
  it("takes the args as the body and the shard from ?shard= (default global:main)", async () => {
    const shard = "rest:one";
    expect((await call("POST", `/api/mutation/messages:send?shard=${shard}`, { channel: "r", body: "hi" })).status).toBe(200);
    const r = await call("POST", `/api/query/messages:list?shard=${shard}`, { channel: "r" });
    expect(r.body.value.map((m: { body: string }) => m.body)).toEqual(["hi"]);
    expect((await call("POST", `/api/query/messages:list`, { channel: "r" })).body.value).toEqual([]);
    expect((await call("POST", `/api/action/actions:double`, { x: 1 })).body.error.code).toBe("FunctionNotFound");
    expect((await call("GET", `/api/query/messages:list`)).status).toBe(405);
  });
});
