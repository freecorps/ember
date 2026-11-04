// End to end with the real @freecorps/ember-server engine and the app in ./app.ts (schema + functions), over WS and HTTP.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setEmberConfig } from "../src/config.ts";
import type { ServerMessage } from "../src/protocol.ts";
import type { Shard } from "../src/shard.ts";
import { functionsV2, schemaV2 } from "./app.ts";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";
import { config } from "./worker.ts";

type Snap = Extract<ServerMessage, { t: "snap" }> & { value?: any };
type Patch = Extract<ServerMessage, { t: "patch" }>;
type Mres = Extract<ServerMessage, { t: "mres" }>;
type Err = Extract<ServerMessage, { t: "err" }>;

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

describe("real engine end to end", () => {
  it("patch carries the socket's own mids before their mres; other sockets get mids: []", async () => {
    const shard = "e2e:mids";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a, "a", "good:amy");
    await hello(b);
    a.send({ t: "sub", qid: "l", fn: "messages:list", args: { channel: "x" } });
    b.send({ t: "sub", qid: "l", fn: "messages:list", args: { channel: "x" } });
    await a.waitFor(is("snap"));
    await b.waitFor(is("snap"));
    a.send({ t: "mut", mid: "m1", fn: "messages:send", args: { channel: "x", body: "one" } });
    a.send({ t: "mut", mid: "m2", fn: "messages:send", args: { channel: "x", body: "two" } });
    a.send({ t: "mut", mid: "bad", fn: "messages:send", args: { channel: "x", body: "fail" } });
    await a.waitFor(is("mres", (m) => m.mid === "bad"));
    await a.waitFor(is("mres", (m) => m.mid === "m2"));
    const patches = a.raw.filter((r) => r.includes('"t":"patch"')).map((r) => JSON.parse(r) as Patch);
    expect(patches.flatMap((p) => p.mids)).toEqual(["m1", "m2"]);
    // each patch precedes the mres of the mids it lists
    for (const p of patches) {
      const pi = a.raw.findIndex((r) => r.includes('"t":"patch"') && JSON.parse(r).version === p.version);
      for (const mid of p.mids) expect(pi).toBeLessThan(a.raw.findIndex((r) => r.includes('"t":"mres"') && JSON.parse(r).mid === mid));
    }
    const bp = await b.waitFor<Patch>(is("patch", (p) => p.version === patches.at(-1)!.version));
    expect(bp.mids).toEqual([]);
    expect((bp.changes[0]!.value as any[]).map((m: any) => [m.body, m.author])).toEqual([["one", "amy"], ["two", "amy"]]);
    a.close();
    b.close();
  });

  it("search subscriptions update on matching writes only", async () => {
    const shard = "e2e:search";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a);
    await hello(b);
    a.send({ t: "sub", qid: "s", fn: "messages:search", args: { q: "brav" } });
    expect(await a.waitFor<Snap>(is("snap"))).toMatchObject({ value: [] });
    b.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "c", body: "hello brave world" } });
    expect((await a.waitFor<Patch>(is("patch"))).changes).toEqual([{ qid: "s", value: ["hello brave world"] }]);
    b.send({ t: "mut", mid: 2, fn: "messages:send", args: { channel: "c", body: "goodbye" } });
    await b.waitFor(is("mres", (m) => m.mid === 2));
    b.send({ t: "mut", mid: 3, fn: "messages:send", args: { channel: "d", body: "Bravo team" } });
    const p = await a.waitFor<Patch>(is("patch"));
    expect(p.version).toBe(3); // nothing for v2 ("goodbye")
    expect([...(p.changes[0]!.value as string[])].sort()).toEqual(["Bravo team", "hello brave world"]);
    a.close();
    b.close();
  });

  it("a scheduled internal mutation runs via the alarm and patches subscribers", async () => {
    const shard = "e2e:sched";
    const c = await connect(shard);
    await hello(c);
    c.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "e" } });
    await c.waitFor(is("snap"));
    c.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "e", body: "echo hi" } });
    await c.waitFor(is("mres"));
    const p = await c.waitFor<Patch>(is("patch", (m) => (m.changes[0]!.value as unknown[]).length === 2));
    expect((p.changes[0]!.value as any[]).map((m) => [m.body, m.author ?? null])).toEqual([["echo hi", null], ["hi", "echo-bot"]]);
    expect(p.mids).toEqual([]); // the job's commit is not a client mutation
    expect((await shardStub(shard).inspect()).jobs).toEqual([]);
    c.close();
  });

  it("internal functions and wrong function types are rejected from clients (WS + HTTP)", async () => {
    const shard = "e2e:internal";
    const c = await connect(shard);
    await hello(c);
    c.send({ t: "sub", qid: 1, fn: "messages:secret", args: {} });
    expect(await c.waitFor<Err>(is("err"))).toMatchObject({ qid: 1, code: "FunctionNotFound" });
    c.send({ t: "mut", mid: 1, fn: "messages:echo", args: { channel: "i", body: "x" } });
    expect(await c.waitFor<Mres>(is("mres"))).toMatchObject({ mid: 1, ok: false, error: { code: "FunctionNotFound" } });
    c.send({ t: "mut", mid: 2, fn: "messages:list", args: { channel: "i" } });
    expect(await c.waitFor<Mres>(is("mres"))).toMatchObject({ mid: 2, ok: false, error: { code: "InvalidFunction" } });
    c.send({ t: "sub", qid: 2, fn: "messages:send", args: { channel: "i", body: "x" } });
    expect(await c.waitFor<Err>(is("err"))).toMatchObject({ qid: 2, code: "InvalidFunction" });
    expect(await api("query", { fn: "messages:secret", args: {}, shard })).toMatchObject({ status: 400, body: { error: { code: "FunctionNotFound" } } });
    expect(await api("mutation", { fn: "jobs:record", args: { label: "x" }, shard })).toMatchObject({ status: 400, body: { error: { code: "FunctionNotFound" } } });
    expect((await api("query", { fn: "runs:list", args: {}, shard })).body.value).toEqual([]);
    expect((await api("query", { fn: "messages:list", args: { channel: "i" }, shard })).body.value).toEqual([]);
    expect((await shardStub(shard).inspect()).version).toBe(0);
    c.close();
  });

  it("bigint and bytes round-trip over WS and HTTP as $int64 / $bytes", async () => {
    const shard = "e2e:values";
    const c = await connect(shard);
    await hello(c);
    c.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "v" } });
    await c.waitFor(is("snap"));
    const n = 2n ** 63n - 1n;
    const blob = new Uint8Array([0, 255, 1, 128]);
    c.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "v", body: "values", n, blob } });
    const p = await c.waitFor<Patch>(is("patch"));
    const doc = (p.changes[0]!.value as any[])[0];
    expect(doc.n).toBe(n);
    expect(doc.blob).toEqual(blob);
    expect(c.raw.find((r) => r.includes('"t":"patch"'))).toContain('"n":{"$int64":"9223372036854775807"},"blob":{"$bytes":"AP8BgA=="}');
    const res = await api("query", { fn: "messages:list", args: { channel: "v" }, shard });
    expect(res.body.value[0]).toMatchObject({ n: { $int64: "9223372036854775807" }, blob: { $bytes: "AP8BgA==" } });
    // tagged args over HTTP
    const m = await api("mutation", { fn: "messages:send", args: { channel: "v", body: "http", n: { $int64: "-5" } }, shard });
    expect(m.body.ok).toBe(true);
    const p2 = await c.waitFor<Patch>(is("patch"));
    expect((p2.changes[0]!.value as any[])[1].n).toBe(-5n);
    c.close();
  });

  it("frames after token expiry are refused (never run anonymously); auth refreshes; token null signs out", async () => {
    const shard = "e2e:expiry";
    const c = await connect(shard);
    await hello(c, "dev-x", "soon:xena:150");
    c.send({ t: "sub", qid: 1, fn: "auth:whoami", args: {} });
    expect(await c.waitFor<Snap>(is("snap"))).toMatchObject({ value: "xena" });
    await sleep(200);
    c.send({ t: "mut", mid: "late", fn: "messages:send", args: { channel: "z", body: "late" } });
    await c.waitFor(is("authExpired"));
    expect(await c.waitFor<Mres>(is("mres"))).toMatchObject({ mid: "late", ok: false, error: { code: "auth_expired" } });
    c.send({ t: "sub", qid: 2, fn: "auth:whoami", args: {} });
    await c.waitFor(is("authExpired"));
    expect(await c.waitFor<Err>(is("err"))).toMatchObject({ qid: 2, code: "auth_expired" });
    expect((await api("query", { fn: "messages:list", args: { channel: "z" }, shard })).body.value).toEqual([]);
    c.send({ t: "auth", token: "good:xena" });
    expect(await c.waitFor<Snap>(is("snap"))).toMatchObject({ qid: 1, value: "xena" });
    c.send({ t: "sub", qid: 2, fn: "auth:whoami", args: {} });
    expect(await c.waitFor<Snap>(is("snap"))).toMatchObject({ qid: 2, value: "xena" });
    // sign out: every subscription is re-evaluated anonymously
    c.send({ t: "auth", token: null });
    const snaps = [await c.waitFor<Snap>(is("snap")), await c.waitFor<Snap>(is("snap"))];
    expect(snaps.map((s) => [s.qid, s.value]).sort()).toEqual([[1, null], [2, null]]);
    c.send({ t: "mut", mid: "anon", fn: "messages:send", args: { channel: "z", body: "anon" } });
    expect(await c.waitFor<Mres>(is("mres"))).toMatchObject({ mid: "anon", ok: true });
    c.close();
  });

  it("a failing subscription stays registered: re-run after a matching commit, re-sub allowed", async () => {
    const shard = "e2e:errored";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a);
    await hello(b);
    a.send({ t: "sub", qid: "l", fn: "messages:latest", args: { channel: "q" } });
    expect(await a.waitFor<Err>(is("err"))).toMatchObject({ qid: "l", code: "Error", message: expect.stringContaining("empty") });
    // re-sub of an errored qid is not a duplicate
    a.send({ t: "sub", qid: "l", fn: "messages:latest", args: { channel: "q" } });
    expect(await a.waitFor<Err>(is("err"))).toMatchObject({ qid: "l", code: "Error" });
    expect(await shardStub(shard).inspect()).toMatchObject({ subs: 1, queries: 1 });
    b.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "q", body: "first!" } });
    expect((await a.waitFor<Patch>(is("patch"))).changes).toEqual([{ qid: "l", value: "first!" }]);
    // now healthy: a re-sub is a duplicate
    a.send({ t: "sub", qid: "l", fn: "messages:latest", args: { channel: "q" } });
    expect(await a.waitFor<Err>(is("err"))).toMatchObject({ code: "duplicate_qid" });
    a.close();
    b.close();
  });

  it("resume is only honoured for the identity the client's snapshot was computed under", async () => {
    const shard = "e2e:resume-id";
    const session = async (token: string, resume?: { version: number; epoch: string }) => {
      const c = await connect(shard);
      const ready = await hello(c, "dev-r", token);
      c.send(resume ? { t: "sub", qid: "w", fn: "auth:whoami", args: {}, resume } : { t: "sub", qid: "w", fn: "auth:whoami", args: {} });
      const snap = await c.waitFor<Snap>(is("snap"));
      c.close();
      return { snap, ready };
    };
    const first = await session("good:amy");
    expect(first.snap.value).toBe("amy");
    const resume = { version: first.ready.version, epoch: first.ready.epoch };
    expect((await session("good:amy", resume)).snap).toMatchObject({ unchanged: true });
    expect((await session("good:bob", resume)).snap).toMatchObject({ value: "bob" });
    // the client's cached value is now bob's: amy must get a full snap again
    expect((await session("good:amy", resume)).snap).toMatchObject({ value: "amy" });
    expect((await session("good:amy", resume)).snap).toMatchObject({ unchanged: true });
  });

  it("deploying a v2 schema migrates on wake: optional field + staged index backfilled by the alarm in chunks", async () => {
    const shard = "e2e:migrate";
    const stub = shardStub(shard);
    for (let i = 0; i < 9; i++) {
      expect((await api("mutation", { fn: "messages:send", args: { channel: "m", body: `m${i}` }, shard })).body.ok).toBe(true);
    }
    // v1 does not know the v2 functions
    expect((await api("query", { fn: "messages:byPriority", args: { min: 0 }, shard })).body.error.code).toBe("FunctionNotFound");
    try {
      setEmberConfig({ ...config, schema: schemaV2, functions: functionsV2 });
      await evictDurableObject(stub);
      const staged = await runInDurableObject(stub, (instance: Shard) => {
        const engine = (instance as unknown as { engine: import("../src/engine-types.ts").Engine }).engine;
        let code = "";
        try {
          engine.runQuery("messages:byPriority", { min: 0 });
        } catch (e) {
          code = (e as { code: string }).code;
        }
        return { code, version: engine.planMigration().fromVersion };
      });
      expect(staged).toEqual({ code: "IndexNotReady", version: schemaV2.manifest.version });

      const c = await connect(shard);
      await hello(c);
      c.send({ t: "sub", qid: "p", fn: "messages:byPriority", args: { min: 0 } });
      const done = await until(() => stub.inspect(), (i) => !i.backfilling);
      expect(done.backfilling).toBe(false);
      expect(done.stats.migrated).toBe(1);
      // 9 rows, 2 per alarm turn
      expect(done.stats.backfillSteps).toBeGreaterThanOrEqual(5);
      const ids = (await api("query", { fn: "messages:list", args: { channel: "m" }, shard })).body.value.map((m: any) => m._id);
      expect((await api("query", { fn: "messages:byPriority", args: { min: 0 }, shard })).body.value).toEqual([]);
      for (const [id, priority] of [[ids[3], 5], [ids[7], 1]] as const) {
        expect((await api("mutation", { fn: "messages:setPriority", args: { id, priority }, shard })).body.ok).toBe(true);
      }
      expect((await api("query", { fn: "messages:byPriority", args: { min: 0 }, shard })).body.value).toEqual(["m7", "m3"]);
      // the subscription (errored or empty while staged) converges to the indexed result
      await until(
        async () => c.frames,
        (fs) => fs.some((f) => f.t === "patch" && f.changes.some((x) => x.qid === "p" && JSON.stringify(x.value) === '["m7","m3"]')),
      );
      expect(c.frames.some((f) => f.t === "patch" && f.changes.some((x) => x.qid === "p" && JSON.stringify(x.value) === '["m7","m3"]'))).toBe(true);
      // old documents are still readable; the new optional field round-trips
      const list = (await api("query", { fn: "messages:list", args: { channel: "m" }, shard })).body.value;
      expect(list).toHaveLength(9);
      expect(list[3].priority).toBe(5);
      expect(list[0].priority).toBeUndefined();
      c.close();
    } finally {
      setEmberConfig(config);
    }
  });
});
