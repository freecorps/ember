import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

const action = async (fn: string, args: unknown, shard: string) => {
  const res = await SELF.fetch("http://ember/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
  return (await res.json()) as any;
};

describe("components in a shard", () => {
  it("an app mutation calls the component in the same transaction; failures roll both back", async () => {
    const shard = "comp:tx";
    expect((await api("mutation", { fn: "components:bump", args: { key: "a" }, shard })).body).toMatchObject({ ok: true, value: 1 });
    expect((await api("mutation", { fn: "components:bump", args: { key: "a" }, shard })).body.value).toBe(2);
    const failed = await api("mutation", { fn: "components:bump", args: { key: "a", fail: true }, shard });
    expect(failed.body).toMatchObject({ ok: false, error: { message: "app failed" } });
    expect((await api("query", { fn: "components:count", args: { key: "a" }, shard })).body.value).toBe(2);
    // The component's table is a real table of this shard, under its namespace.
    const browse = await shardStub(shard).browse(shard, null, null);
    expect(browse.ok && browse.tables.map((t: { name: string }) => t.name)).toContain("tally$tallies");
  });

  it("clients cannot call component functions (WS, HTTP query/mutation/action)", async () => {
    const shard = "comp:deny";
    expect((await api("mutation", { fn: "@tally/lib:bump", args: { key: "x", by: 1 }, shard })).body.error.code).toBe("FunctionNotFound");
    expect((await api("query", { fn: "@tally/lib:get", args: { key: "x" }, shard })).body.error.code).toBe("FunctionNotFound");
    expect((await action("@tally/lib:bumpTwice", { key: "x" }, shard)).error.code).toBe("FunctionNotFound");
    const c = await connect(shard);
    await hello(c);
    c.send({ t: "mut", mid: 1, fn: "@tally/lib:bump", args: { key: "x", by: 1 } });
    const r = await c.waitFor(is("mres"));
    expect(r).toMatchObject({ ok: false, error: { code: "FunctionNotFound" } });
    c.close();
  });

  it("subscriptions to app queries reading component tables are patched when the component writes", async () => {
    const shard = "comp:reactive";
    const c = await connect(shard);
    await hello(c);
    c.send({ t: "sub", qid: 1, fn: "components:count", args: { key: "r" } });
    expect(await c.waitFor(is("snap"))).toMatchObject({ value: 0 });
    c.send({ t: "mut", mid: 1, fn: "components:bump", args: { key: "r" } });
    const p = (await c.waitFor(is("patch"))) as any;
    expect(p.changes[0]).toMatchObject({ qid: 1, value: 1 });
    // A write to another key of the component table does not re-run it (exact read set across the boundary).
    c.send({ t: "mut", mid: 2, fn: "components:bump", args: { key: "other" } });
    await c.waitFor(is("mres", (m) => m.mid === 2));
    await sleep(50);
    expect(c.frames.filter((f: any) => f.t === "patch" && f.changes.some((x: any) => x.qid === 1))).toEqual([]);
    c.close();
  });

  it("a component schedules its own internal job; it runs in the component's scope and calls back the app through a handle", async () => {
    const shard = "comp:sched";
    expect((await api("mutation", { fn: "components:later", args: { key: "s", delayMs: 20 }, shard })).body.ok).toBe(true);
    const jobs = (await shardStub(shard).inspect()).jobs;
    expect(jobs.map((j: { fn: string }) => j.fn)).toEqual(["@tally/lib:applyLater"]);
    const count = await until(
      () => api("query", { fn: "components:count", args: { key: "s" }, shard }),
      (r) => r.body.value === 1,
    );
    expect(count.body.value).toBe(1);
    const runs = await until(
      () => api("query", { fn: "runs:list", args: {}, shard }),
      (r) => r.body.value.length === 1,
    );
    expect(runs.body.value.map((r: { label: string }) => r.label)).toEqual(["notified:s:1"]);
  });
});

describe("component actions", () => {
  it("an app action runs a component action; the component's calls resolve inside the component", async () => {
    const shard = "comp:action";
    expect(await action("components:twice", { key: "t" }, shard)).toMatchObject({ ok: true, value: 2 });
    expect((await api("query", { fn: "components:count", args: { key: "t" }, shard })).body.value).toBe(2);
  });

  it("a component cannot reach app functions by name, and the app cannot call a component's internal function", async () => {
    const shard = "comp:action-deny";
    expect(await action("components:reach", {}, shard)).toMatchObject({ ok: false, error: { code: "FunctionNotFound" } });
    expect(await action("components:sneak", {}, shard)).toMatchObject({ ok: false, error: { code: "FunctionNotFound" } });
  });
});

describe("http routes", () => {
  it("serves app routes with optional auth", async () => {
    await api("mutation", { fn: "components:bump", args: { key: "h" }, shard: "global:main" });
    const anon = await SELF.fetch("http://ember/hello?key=h");
    expect(await anon.text()).toBe("hello anon 1");
    const authed = await SELF.fetch("http://ember/hello?key=h", { headers: { authorization: "Bearer good:ada" } });
    expect(await authed.text()).toBe("hello ada 1");
    // Invalid tokens run anonymous (webhooks send their own Authorization headers).
    expect(await (await SELF.fetch("http://ember/hello?key=h", { headers: { authorization: "Bearer junk" } })).text()).toBe("hello anon 1");
  });

  it("serves a component's routes under its prefix, in its scope, on the shard the route picks", async () => {
    const res = await SELF.fetch("http://ember/tally/hit?key=web&shard=comp:http", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 1, label: "tallies", shard: "comp:http" });
    expect((await api("query", { fn: "components:count", args: { key: "web" }, shard: "comp:http" })).body.value).toBe(1);
    expect((await SELF.fetch("http://ember/tally/hit", { method: "GET" })).status).toBe(405);
    expect((await SELF.fetch("http://ember/nope")).status).toBe(404);
    // Ember's own endpoints still win.
    expect((await SELF.fetch("http://ember/health")).status).toBe(200);
  });
});
