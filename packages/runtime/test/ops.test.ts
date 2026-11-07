// Actions, job cancellation, location hints, migration refusal and the admin status endpoint.
import { createExecutionContext, env, evictDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEmberConfig, setEmberConfig } from "../src/config.ts";
import { locationHintFor } from "../src/stubs.ts";
import { schemaRefused } from "./app.ts";
import { api, shardStub, sleep } from "./helpers.ts";
import worker, { config } from "./worker.ts";

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

async function post(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await SELF.fetch(`http://ember${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

async function status(shards: string[], token = "admin-secret") {
  const qs = new URLSearchParams(shards.map((s) => ["shard", s]));
  const res = await SELF.fetch(`http://ember/api/_ember/status?${qs}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  return { status: res.status, body: (await res.json()) as any };
}

describe("actions", () => {
  it("POST /api/action runs in the Worker with the full ActionCtx", async () => {
    const shard = "act:main";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "elsewhere" }, shard: "act:other" });
    const r = await post("/api/action", { fn: "actions:combo", args: { channel: "c", other: "act:other" }, shard }, "good:ana");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      value: { n: 1, secret: "classified", cancelled: true, cancelledAgain: false, who: "ana", elsewhere: 1, nested: 42, shard },
    });
    expect(r.body.value.job).toMatch(/^job_/);
    const list = await api("query", { fn: "messages:list", args: { channel: "c" }, shard });
    expect(list.body.value).toMatchObject([{ body: "from action", author: "ana" }]);
    expect((await shardStub(shard).inspect()).jobs).toEqual([]);
  });

  it("checks visibility, type and args; propagates shard error codes", async () => {
    const shard = "act:errors";
    expect((await post("/api/action", { fn: "actions:double", args: { x: 1 }, shard })).body.error.code).toBe("FunctionNotFound");
    expect((await post("/api/action", { fn: "messages:list", args: { channel: "c" }, shard })).body.error.code).toBe("InvalidFunction");
    expect((await post("/api/action", { fn: "actions:combo", args: { channel: 1 }, shard })).body.error.code).toBe("ValidationError");
    expect((await post("/api/action", { fn: "actions:broken", args: {}, shard })).body.error.code).toBe("FunctionNotFound");
    expect((await post("/api/action", { fn: "actions:ping", args: {}, shard }, "bad")).status).toBe(401);
    expect((await post("/api/action", { fn: "actions:ping", args: {}, shard: "nokey" })).status).toBe(400);
  });

  it("the queue consumer runs action jobs and retries failures", async () => {
    const shard = "act:queue";
    const acked: string[] = [];
    const retried: string[] = [];
    const msg = (id: string, body: unknown) => ({ id, body, ack: () => acked.push(id), retry: () => retried.push(id) });
    const batch = {
      queue: "ember-actions",
      messages: [
        msg("ok", { shard, jobId: "job_1", fn: "actions:record", args: { label: "from-queue" }, attempt: 1 }),
        msg("bad", { shard, jobId: "job_2", fn: "actions:record", args: { label: 3 }, attempt: 1 }),
        msg("junk", { nope: true }),
      ],
    };
    await worker.queue(batch as any, env as any, createExecutionContext());
    expect(acked.sort()).toEqual(["junk", "ok"]);
    expect(retried).toEqual(["bad"]);
    expect((await api("query", { fn: "runs:list", args: {}, shard })).body.value).toMatchObject([{ label: "from-queue" }]);
  });

  it("without a queue, action jobs run in the shard's alarm", async () => {
    const shard = "act:inproc";
    const stub = shardStub(shard);
    try {
      const { dispatchAction: _, ...noQueue } = config;
      setEmberConfig(noQueue);
      await stub.warm(shard);
      await evictDurableObject(stub);
      await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "in-do" }, kind: "action" });
      const runs = await until(
        () => api("query", { fn: "runs:list", args: {}, shard }),
        (r) => r.body.value?.length === 1,
      );
      expect(runs.body.value).toMatchObject([{ label: "in-do" }]);
      expect((await stub.inspect()).jobs).toEqual([]);
    } finally {
      setEmberConfig(config);
      await evictDurableObject(stub).catch(() => {});
    }
  });
});

describe("scheduler ids", () => {
  it("stores the engine job id; ctx.scheduler.cancel removes the pending job atomically", async () => {
    const shard = "jobs:cancel";
    const stub = shardStub(shard);
    const a = await api("mutation", { fn: "jobs:later", args: { label: "a" }, shard });
    const b = await api("mutation", { fn: "jobs:later", args: { label: "b" }, shard });
    expect(a.body.value).toMatch(/^job_/);
    expect((await stub.inspect()).jobs.map((j) => j.job_id)).toEqual([a.body.value, b.body.value]);
    expect((await api("mutation", { fn: "jobs:cancel", args: { id: a.body.value }, shard })).body.ok).toBe(true);
    expect((await stub.inspect()).jobs.map((j) => j.job_id)).toEqual([b.body.value]);
    // unknown / already cancelled ids are a no-op
    expect((await api("mutation", { fn: "jobs:cancel", args: { id: a.body.value }, shard })).body.ok).toBe(true);
    expect(await stub.cancelJob(shard, b.body.value)).toBe(true);
    expect(await stub.cancelJob(shard, b.body.value)).toBe(false);
    expect((await stub.inspect()).jobs).toEqual([]);
  });
});

describe("location hints", () => {
  it("defineShard locationHint wins over EMBER_LOCATION_HINT; global falls back to the env", () => {
    const manifest = { shards: { org: { key: { kind: "string" }, locationHint: "weur" }, team: { key: { kind: "string" } } } } as any;
    const e = { SHARD: {} } as any;
    expect(locationHintFor(manifest, e, "org:a")).toBe("weur");
    expect(locationHintFor(manifest, e, "team:a")).toBeUndefined();
    const withEnv = { ...e, EMBER_LOCATION_HINT: "enam" };
    expect(locationHintFor(manifest, withEnv, "org:a")).toBe("weur");
    expect(locationHintFor(manifest, withEnv, "team:a")).toBe("enam");
    expect(locationHintFor(manifest, withEnv, "global:main")).toBe("enam");
    expect(locationHintFor({ shards: ["org"] } as any, withEnv, "org:a")).toBe("enam");
  });

  it("a hint read from the key: its last segment when it is a Cloudflare hint, else the fallback, else the env", () => {
    const manifest = {
      shards: {
        probe: { key: { kind: "string" }, locationHint: { fromKey: true } },
        edge: { key: { kind: "string" }, locationHint: { fromKey: true, separator: "@", fallback: "enam" } },
      },
    } as any;
    const e = { SHARD: {}, EMBER_LOCATION_HINT: "weur" } as any;
    expect(locationHintFor(manifest, e, "probe:ws_1:apac")).toBe("apac");
    expect(locationHintFor(manifest, e, "probe:sam")).toBe("sam");
    expect(locationHintFor(manifest, e, "probe:ws_1:mars")).toBe("weur");
    expect(locationHintFor(manifest, e, "edge:ws_1@oc")).toBe("oc");
    expect(locationHintFor(manifest, e, "edge:ws_1:oc")).toBe("enam");
  });

  it("the Worker's locationHint(shard) rule comes first", () => {
    const original = getEmberConfig();
    try {
      setEmberConfig({ ...original, locationHint: (shard) => (shard.endsWith(":br") ? "sam" : undefined) });
      const manifest = { shards: { org: { key: { kind: "string" }, locationHint: "weur" } } } as any;
      expect(locationHintFor(manifest, { SHARD: {} } as any, "org:br")).toBe("sam");
      expect(locationHintFor(manifest, { SHARD: {} } as any, "org:pt")).toBe("weur");
    } finally {
      setEmberConfig(original);
    }
  });
});

describe("migration status", () => {
  it("requires the admin token", async () => {
    expect((await status(["global:main"], "")).status).toBe(401);
    expect((await status(["global:main"], "wrong")).status).toBe(401);
    const ok = await status([]);
    expect(ok.status).toBe(200);
    expect(ok.body.shards.map((s: any) => s.shard)).toEqual(["global:main"]);
    expect(ok.body.shards[0]).toMatchObject({ ready: true, schemaVersion: ok.body.expectedVersion, migrationError: null, staged: [] });
  });

  it("a refused migration is recorded, reported and refuses work until a fixed deploy", async () => {
    const shard = "mig:refused";
    const stub = shardStub(shard);
    expect((await api("mutation", { fn: "messages:send", args: { channel: "r", body: "row" }, shard })).body.ok).toBe(true);
    try {
      setEmberConfig({ ...config, schema: schemaRefused });
      await evictDurableObject(stub);
      const st = await stub.status(shard);
      expect(st).toMatchObject({
        ready: false,
        expectedVersion: schemaRefused.manifest.version,
        schemaVersion: config.schema.manifest.version,
        migrationError: { code: "MigrationRefused", toVersion: schemaRefused.manifest.version, message: expect.stringContaining("mandatory") },
      });
      expect(st.lastMigrationError).toEqual(st.migrationError);
      const q = await api("query", { fn: "messages:list", args: { channel: "r" }, shard });
      expect(q.body.error.code).toBe("MigrationRefused");
      expect((await api("mutation", { fn: "messages:send", args: { channel: "r", body: "x" }, shard })).body.error.code).toBe("MigrationRefused");
    } finally {
      setEmberConfig(config);
      await evictDurableObject(stub);
    }
    const fixed = await stub.status(shard);
    expect(fixed).toMatchObject({ ready: true, migrationError: null, lastMigrationError: { code: "MigrationRefused" } });
    expect((await api("query", { fn: "messages:list", args: { channel: "r" }, shard })).body.value).toHaveLength(1);
  });
});
