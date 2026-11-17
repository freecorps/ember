// Actions, job cancellation, location hints, migration refusal and the admin status endpoint.
import { createExecutionContext, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PREFLIGHT_BODY_MAX } from "../src/admin-api.ts";
import { getEmberConfig, setEmberConfig } from "../src/config.ts";
import { runtimeSchemaAhead } from "../src/shard.ts";
import { locationHintFor } from "../src/stubs.ts";
import { schemaRefused, schemaV2 } from "./app.ts";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";
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
      const c = await connect(shard);
      await hello(c, "query-refused", undefined, ["query"]);
      c.send({ t: "q", qid: "refused", fn: "messages:list", args: { channel: "r" } });
      expect(await c.waitFor(is("qres"))).toMatchObject({ qid: "refused", ok: false, error: { code: "MigrationRefused" } });
      c.close();
      expect((await api("mutation", { fn: "messages:send", args: { channel: "r", body: "x" }, shard })).body.error.code).toBe("MigrationRefused");
    } finally {
      setEmberConfig(config);
      await evictDurableObject(stub);
    }
    const fixed = await stub.status(shard);
    expect(fixed).toMatchObject({ ready: true, migrationError: null, lastMigrationError: { code: "MigrationRefused" } });
    expect((await api("query", { fn: "messages:list", args: { channel: "r" }, shard })).body.value).toHaveLength(1);
  });

  it("a refused migration runs nothing at any entry point; its jobs wait and run after a fixed deploy that does not migrate", async () => {
    const shard = "mig:refused-tail";
    const stub = shardStub(shard);
    const rpc = stub as any;
    const admin = async (path: string, init: { method?: string; raw?: string } = {}) => {
      const res = await SELF.fetch(`http://ember${path}`, { method: init.method ?? "GET", headers: { authorization: "Bearer admin-secret" }, ...(init.raw !== undefined ? { body: init.raw } : {}) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const sql = (q: string) => runInDurableObject(stub, (_i, state) => state.storage.sql.exec(q).toArray());
    const jobRows = () => sql(`SELECT job_id, fn, state FROM _jobs WHERE state NOT IN ('success', 'canceled') ORDER BY id`);
    // A row (so `schemaRefused` refuses), a mutation job and an action job handed to the queue, both due.
    expect((await api("mutation", { fn: "messages:send", args: { channel: "r", body: "row" }, shard })).body.ok).toBe(true);
    const later = Date.now() + 86_400_000;
    const { id: mutJob } = await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "due" }, runAt: later });
    const { id: actJob } = await stub.enqueueJob(shard, { fn: "actions:leased", args: { label: "leased" }, kind: "action", runAt: later });
    await sql(`UPDATE _jobs SET run_at = ${Date.now() - 1000} WHERE job_id = '${mutJob}'`);
    await sql(`UPDATE _jobs SET state = 'dispatched', run_at = ${Date.now() - 1000} WHERE job_id = '${actJob}'`);
    const jobsBefore = await jobRows();
    const refusal = { code: "MigrationRefused" };
    try {
      setEmberConfig({ ...config, schema: schemaRefused });
      await evictDurableObject(stub);
      expect(await stub.status(shard)).toMatchObject({ ready: false, migrationError: refusal });

      // The queue consumer's claim never says `run: true` (it acks; the lease brings the job back).
      expect(await rpc.claimActionJob(shard, actJob)).toEqual({ run: false });
      // An action with a token never starts on a refused shard (401 with the code, as for RuntimeSchemaTooNew).
      expect(await rpc.checkIdentity(shard, { subject: "u", issuer: "t" })).toMatchObject(refusal);

      // The alarm runs nothing, and is armed again (at least REFUSED_ALARM_MS ahead) instead of being lost.
      await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(Date.now()));
      await runDurableObjectAlarm(stub);
      const next = await until(() => runInDurableObject(stub, (_i, state) => state.storage.getAlarm()), (t) => t !== null && t > Date.now() + 60_000);
      expect(next).toBeGreaterThan(Date.now() + 60_000);
      expect(await jobRows()).toEqual(jobsBefore);

      // Admin: the app tables are not decoded with the new schema (409); the list and the internal tables are served.
      expect(await admin(`/api/_ember/data?shard=${shard}&table=messages`)).toMatchObject({ status: 409, body: { ok: false, error: refusal } });
      // A name the deployed schema does not have (a table it dropped is still on this shard) is refused too, not "unknown".
      expect(await admin(`/api/_ember/data?shard=${shard}&table=dropped`)).toMatchObject({ status: 409, body: { ok: false, error: refusal } });
      expect((await admin(`/api/_ember/data?shard=${shard}`)).status).toBe(200);
      expect((await admin(`/api/_ember/data?shard=${shard}&table=_jobs`)).status).toBe(200);
      // Files and import through the admin API: the same 409 as the data calls (they gave 500).
      expect(await admin(`/api/_ember/files/upload?shard=${shard}`, { method: "POST", raw: "bytes" })).toMatchObject({ status: 409, body: { error: refusal } });
      expect(await admin(`/api/_ember/files/delete?shard=${shard}&id=nope`, { method: "POST", raw: "" })).toMatchObject({ status: 409, body: { error: refusal } });
      // Reading a file says the shard is refused, not that the file is missing (it gave 404).
      expect(await admin(`/api/_ember/files/content?shard=${shard}&id=nope`)).toMatchObject({ status: 409, body: { error: refusal } });
      expect(await admin(`/api/_ember/import/meta?shard=${shard}`)).toMatchObject({ status: 409, body: { error: refusal } });
      // An imported file's bytes are not stored for a shard that takes no import (the PUT went through to R2).
      expect(await admin(`/api/_ember/import/blob?shard=${shard}&sha256=${"0".repeat(64)}`, { method: "PUT", raw: "bytes" })).toMatchObject({ status: 409, body: { error: refusal } });
      // What `deploy --preflight` reads still works on the refused shard.
      const pre = await post("/api/_ember/preflight", { shard, schema: config.schema.manifest }, "admin-secret");
      expect(pre).toMatchObject({ status: 200, body: { value: { refused: refusal, result: { status: "ok" } } } });
    } finally {
      // The fix: back to the schema the shard holds. Nothing migrates at boot, so nothing arms the alarm there.
      setEmberConfig(config);
      await evictDurableObject(stub);
    }
    expect((await stub.status(shard)).ready).toBe(true);
    // The alarm kept armed while refused runs both jobs: the mutation, and the action whose lease ran out (in the shard).
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).not.toBeNull();
    await runDurableObjectAlarm(stub);
    const labels = await until(
      async () => ((await api("query", { fn: "runs:list", args: {}, shard })).body.value ?? []).map((r: { label: string }) => r.label) as string[],
      (l) => l.includes("due") && l.includes("leased"),
    );
    expect(labels).toEqual(expect.arrayContaining(["due", "leased"]));
    expect(await rpc.checkIdentity(shard, { subject: "u", issuer: "t" })).toBeNull();
  });

  it("a shard whose storage format is newer than this runtime's is refused, untouched, like a refused migration", async () => {
    const shard = "mig:storage-ahead";
    const stub = shardStub(shard);
    expect((await api("mutation", { fn: "messages:send", args: { channel: "s", body: "row" }, shard })).body.ok).toBe(true);
    const sql = (q: string) => runInDurableObject(stub, (_i, state) => state.storage.sql.exec(q).toArray());
    const marker = async () => (await sql(`SELECT value FROM _ember_meta WHERE key = 'storage'`))[0]?.value;
    // As if a newer runtime had converted this shard and the Worker was then rolled back (and the schema with it).
    await sql(`UPDATE _ember_meta SET value = '3' WHERE key = 'storage'`);
    const tables = await sql(`SELECT name FROM sqlite_master ORDER BY name`);
    try {
      setEmberConfig({ ...config, schema: schemaV2 });
      await evictDurableObject(stub);
      const st = await stub.status(shard);
      expect(st).toMatchObject({
        ready: false,
        schemaVersion: config.schema.manifest.version,
        migrationError: { code: "StorageFormatTooNew", message: expect.stringContaining("newer Ember runtime") },
      });
      expect(st.migrationError?.message).toContain("storage format 3");
      const q = await api("query", { fn: "messages:list", args: { channel: "s" }, shard });
      expect(q.body.error.code).toBe("StorageFormatTooNew");
      expect((await api("mutation", { fn: "messages:send", args: { channel: "s", body: "x" }, shard })).body.error.code).toBe("StorageFormatTooNew");
      expect(await marker()).toBe("3");
      expect(await sql(`SELECT name FROM sqlite_master ORDER BY name`)).toEqual(tables);
    } finally {
      await sql(`UPDATE _ember_meta SET value = '2' WHERE key = 'storage'`);
      setEmberConfig(config);
      await evictDurableObject(stub);
    }
    expect((await api("query", { fn: "messages:list", args: { channel: "s" }, shard })).body.value).toHaveLength(1);
  });

  it("a shard whose runtime tables are newer than this runtime's is refused before anything is touched", async () => {
    expect(runtimeSchemaAhead(null)).toBe(false);
    expect(runtimeSchemaAhead("0")).toBe(false);
    expect(runtimeSchemaAhead("5")).toBe(false);
    expect(runtimeSchemaAhead("10")).toBe(true); // numbers, not strings ("10" < "5")
    expect(runtimeSchemaAhead("5.1")).toBe(true);
    expect(runtimeSchemaAhead("v6")).toBe(true);
    const shard = "mig:runtime-ahead";
    const stub = shardStub(shard);
    expect((await api("mutation", { fn: "messages:send", args: { channel: "r", body: "row" }, shard })).body.ok).toBe(true);
    const sql = (q: string) => runInDurableObject(stub, (_i, state) => state.storage.sql.exec(q).toArray());
    const snapshot = async () => ({
      objects: await sql(`SELECT type, name, sql FROM sqlite_master ORDER BY name`),
      meta: await sql(`SELECT k, v FROM _ember_rt_meta ORDER BY k`),
      migrations: await sql(`SELECT * FROM _ember_migrations ORDER BY id`),
      bookmarks: await sql(`SELECT * FROM _ember_bookmarks ORDER BY rowid`),
    });
    try {
      for (const ahead of ["6", "6a"]) {
        // As if a newer runtime (runtime schema 6) had upgraded this shard and the Worker was then rolled back.
        await sql(`UPDATE _ember_rt_meta SET v = '${ahead}' WHERE k = 'rt_schema'`);
        const before = await snapshot();
        await evictDurableObject(stub);
        const st = await stub.status(shard);
        expect(st).toMatchObject({ ready: false, migrationError: { code: "RuntimeSchemaTooNew", toVersion: config.schema.manifest.version } });
        expect(st.migrationError?.message).toContain(`runtime schema ${ahead}; this runtime understands up to 5`);
        expect(st.lastMigrationError?.code).toBe("RuntimeSchemaTooNew");
        const q = await api("query", { fn: "messages:list", args: { channel: "r" }, shard });
        expect(q.status).not.toBe(200);
        expect(q.body.error.code).toBe("RuntimeSchemaTooNew");
        expect((await api("mutation", { fn: "messages:send", args: { channel: "r", body: "x" }, shard })).body.error.code).toBe("RuntimeSchemaTooNew");
        expect(await snapshot()).toEqual(before);
      }
    } finally {
      await sql(`UPDATE _ember_rt_meta SET v = '5' WHERE k = 'rt_schema'`);
      await evictDurableObject(stub);
    }
    expect((await api("query", { fn: "messages:list", args: { channel: "r" }, shard })).body.value).toHaveLength(1);
    expect((await stub.status(shard)).migrationError).toBeNull();
  });

  it("a shard refused by RuntimeSchemaTooNew writes nothing at any entry point, and serves again once the marker is back", async () => {
    const shard = "mig:ahead-tail";
    const stub = shardStub(shard);
    const rpc = stub as any;
    const admin = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await SELF.fetch(`http://ember${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    // State in every kind of runtime table: a row, a job waiting for the queue (`dispatched`), a revocation, a file row.
    expect((await api("mutation", { fn: "messages:send", args: { channel: "t", body: "row" }, shard })).body.ok).toBe(true);
    const { id: jobId } = await stub.enqueueJob(shard, { fn: "actions:leased", args: { label: "x" }, kind: "action", runAt: Date.now() + 86_400_000 });
    const sql = (q: string) => runInDurableObject(stub, (_i, state) => state.storage.sql.exec(q).toArray());
    await sql(`UPDATE _jobs SET state = 'dispatched' WHERE job_id = '${jobId}'`);
    await rpc.revokeSockets(shard, { subject: "gone" });
    expect((await rpc.fileGenerateUpload(shard, {})).ok).toBe(true);
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    // Every schema object, and every row of every table (runtime and app): what "nothing was touched" means.
    const snapshot = () =>
      runInDurableObject(stub, (_i, state) => {
        const objects = state.storage.sql.exec("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' ORDER BY type, name").toArray();
        const rows: Record<string, string[]> = {};
        for (const o of objects) {
          if (o.type !== "table" || String(o.name).startsWith("sqlite_")) continue;
          rows[String(o.name)] = state.storage.sql
            .exec(`SELECT * FROM "${String(o.name)}"`)
            .toArray()
            .map((r) => JSON.stringify(r, (_k, v) => (v instanceof ArrayBuffer ? hex(v) : v)))
            .sort();
        }
        return { objects, rows };
      });
    const refusal = { code: "RuntimeSchemaTooNew" };
    const rejects = async (p: Promise<unknown>) => {
      const e = await p.then(() => null, (x: unknown) => x);
      expect(e).toMatchObject(refusal);
    };
    try {
      await sql(`UPDATE _ember_rt_meta SET v = '6' WHERE k = 'rt_schema'`);
      const before = await snapshot();
      expect(before.rows._jobs!.some((r) => r.includes('"dispatched"'))).toBe(true);
      expect(before.rows._ember_revoked).toHaveLength(1);
      await evictDurableObject(stub);

      // Data calls and status (what the dashboard and `deploy --wait` show).
      expect((await api("query", { fn: "messages:list", args: { channel: "t" }, shard })).body.error.code).toBe("RuntimeSchemaTooNew");
      expect((await api("mutation", { fn: "messages:send", args: { channel: "t", body: "x" }, shard })).body.error.code).toBe("RuntimeSchemaTooNew");
      expect(await stub.status(shard)).toMatchObject({ ready: false, migrationError: refusal });
      expect(await stub.query(shard, "messages:list", { channel: "t" }, null, true)).toMatchObject({ ok: false, error: refusal });
      expect(await stub.mutation(shard, "messages:send", { channel: "t", body: "x" }, null, true)).toMatchObject({ ok: false, error: refusal });
      expect(await stub.warm(shard)).toBeTruthy();

      // Sockets: told on connect; sub / q / mut refused; unsub, ack and close leave no trace.
      const c = await connect(shard);
      await c.waitFor((m) => m.t === "err" && (m as any).code === "RuntimeSchemaTooNew");
      await hello(c);
      c.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "t" } } as any);
      await c.waitFor((m) => m.t === "err" && (m as any).qid === 1 && (m as any).code === "RuntimeSchemaTooNew");
      c.send({ t: "q", qid: 2, fn: "messages:list", args: { channel: "t" } } as any);
      await c.waitFor((m) => m.t === "qres" && (m as any).qid === 2 && (m as any).error?.code === "RuntimeSchemaTooNew");
      c.send({ t: "mut", mid: 3, fn: "messages:send", args: { channel: "t", body: "x" } } as any);
      await c.waitFor((m) => m.t === "mres" && (m as any).mid === 3 && (m as any).error?.code === "RuntimeSchemaTooNew");
      c.send({ t: "unsub", qid: 1 } as any);
      c.send({ t: "ack", mids: [3] } as any);
      c.send({ t: "q", qid: 4, fn: "messages:list", args: { channel: "t" } } as any);
      await c.waitFor((m) => m.t === "qres" && (m as any).qid === 4);
      c.close();

      // Scheduler: the queue consumer's claim never says `run: true` (it acks); the rest throws the refusal.
      expect(await rpc.claimActionJob(shard, jobId)).toEqual({ run: false });
      await rejects(rpc.settleActionJob(shard, jobId, null));
      await rejects(stub.enqueueJob(shard, { fn: "messages:send", args: { channel: "t", body: "j" } }));
      await rejects(rpc.cancelJob(shard, jobId));
      await rejects(rpc.getScheduled(shard, jobId));
      await rejects(rpc.listScheduled(shard, {}));
      // Catalog and `.replicated()` (this shard standing in for global:main), external indexes, revocations.
      await rejects(rpc.registerShard("org:x", { resync: true }));
      await rejects(rpc.shardDirectory("org", {}));
      await rejects(rpc.replicaResync(null));
      await rejects(rpc.replicaStatus());
      await rejects(rpc.extFetch(shard, "messages", "by_x", ["a"]));
      await rejects(rpc.extAck(shard, "messages", "by_x", [{ id: "a", seq: 1 }]));
      await rejects(rpc.extLocalApply(shard, "messages", "by_x", [{ id: "a", text: "t" }]));
      await rejects(rpc.extLocalSearch(shard, "messages", "by_x", { text: "t", topK: 1 }));
      await rejects(rpc.revokeSockets(shard, { subject: "other" }));
      expect(await rpc.checkIdentity(shard, { subject: "u", issuer: "t" })).toMatchObject(refusal);
      // Files: the `{ ok: false }` / null / [] answers their callers already handle.
      expect(await rpc.fileGenerateUpload(shard, {})).toMatchObject({ ok: false, ...refusal });
      expect(await rpc.fileRegister(shard, { sha256: "0".repeat(64), size: 1, contentType: null, etag: null })).toMatchObject({ ok: false, ...refusal });
      expect(await rpc.fileDelete(shard, "nope")).toMatchObject({ ok: false, ...refusal });
      expect(await rpc.fileReady(shard, "nope", { size: 1, etag: null })).toMatchObject({ ok: false, ...refusal });
      await rpc.fileFail(shard, "nope");
      await rejects(rpc.fileMeta(shard, "nope"));
      expect(await rpc.filesByKey(shard, "k")).toEqual([]);
      await rejects(rpc.fileUrl(shard, "nope", {}));
      // The file admin endpoints map the refusal to 409 (the object an upload wrote stays in R2: not the shard's state).
      const fileAdmin = async (path: string) => {
        const res = await SELF.fetch(`http://ember/api/_ember/${path}`, { method: "POST", headers: { authorization: "Bearer admin-secret" }, body: "bytes" });
        return { status: res.status, body: (await res.json()) as any };
      };
      expect(await fileAdmin(`files/upload?shard=${shard}`)).toMatchObject({ status: 409, body: { ok: false, error: refusal } });
      expect(await fileAdmin(`files/delete?shard=${shard}&id=nope`)).toMatchObject({ status: 409, body: { ok: false, error: refusal } });
      expect(await admin(`/api/_ember/files/content?shard=${shard}&id=nope`)).toMatchObject({ status: 409, body: { ok: false, error: refusal } });
      // Import: `{ ok: false }` over RPC, 409 over the admin API.
      expect(await rpc.importBegin(shard, { tables: ["messages"] })).toMatchObject({ ok: false, ...refusal });
      expect(await rpc.importFinish(shard)).toMatchObject({ ok: false, ...refusal });
      expect(await admin(`/api/_ember/import/meta?shard=${shard}`)).toMatchObject({ status: 409, body: { error: refusal } });

      // Admin: the same 409 as the data calls; inspect and the bookmarks list stay readable.
      expect(await admin(`/api/_ember/data?shard=${shard}`)).toMatchObject({ status: 409, body: { error: refusal } });
      expect(await admin(`/api/_ember/data/list?shard=${shard}&table=messages`)).toMatchObject({ status: 409, body: { error: refusal } });
      // The admin function runner gives the same 409 as the data calls (it gave 400).
      for (const [fn, args] of [["messages:list", { channel: "t" }], ["messages:send", { channel: "t", body: "x" }]] as const) {
        const run = await admin("/api/_ember/run", { method: "POST", body: { shard, fn, args } });
        expect(run).toMatchObject({ status: 409, body: { ok: false, error: refusal } });
      }
      const bookmarked = await admin(`/api/_ember/bookmark`, { method: "POST", body: { shard } });
      expect(bookmarked).toMatchObject({ status: 409, body: { error: refusal } });
      expect(bookmarked.body.error.message).toMatch(/not supported yet/);
      const inspected = await admin(`/api/_ember/inspect?shard=${shard}`);
      expect(inspected).toMatchObject({ status: 200, body: { shard: { jobs: [], bookmarks: 0 } } });
      const listed = await admin(`/api/_ember/bookmarks?shard=${shard}`);
      expect(listed.status).toBe(200);
      expect(listed.body.bookmarks.map((b: { reason: string }) => b.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/^deploy/)]));
      const pre = await post("/api/_ember/preflight", { shard, schema: config.schema.manifest }, "admin-secret");
      expect(pre).toMatchObject({ status: 200, body: { value: { refused: refusal, result: { status: "unchecked", code: "RuntimeSchemaTooNew" } } } });
      expect((await admin(`/api/_ember/reactivity?shard=${shard}`)).status).toBe(200);
      // Restoring a refused shard from this older runtime is not supported yet: refused up front, before the journal and
      // before scheduling (a real bookmark of this shard, so nothing else could refuse it first).
      const journal = () => (env.SYSTEM.get(env.SYSTEM.idFromName("system")) as any).restores().then((rs: { shard: string }[]) => rs.filter((r) => r.shard === shard));
      const target = listed.body.bookmarks[0].bookmark as string;
      const restore = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: target } });
      expect(restore).toMatchObject({ status: 409, body: { ok: false, error: refusal } });
      expect(restore.body.error.message).toMatch(/deploy the newer runtime again/);
      expect(restore.body.error.message).toMatch(/not supported yet/);
      await rejects(rpc.restorePrepare(shard, target, "direct"));
      await rejects(rpc.bookmarkNow(shard, "manual"));
      expect(await journal()).toEqual([]);
      // A finish reaching a refused shard (a restore scheduled while compatible, restore.test.ts) writes nothing.
      const finish = await rpc.restoreFinish(shard, { nonce: "n", instance: "another", rows: [], undo: null, bookmark: "b", label: "l" }).then(() => null, (e: Error) => e);
      expect(finish).toMatchObject(refusal);
      expect(finish.message).toMatch(/^restore_still_ahead/);

      // The alarm that fires (the newer runtime's) is armed again, a little later, without running anything.
      // (Set to now, it fires on its own; `runDurableObjectAlarm` runs it if it has not yet.)
      await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(Date.now()));
      await runDurableObjectAlarm(stub);
      const next = await until(() => runInDurableObject(stub, (_i, state) => state.storage.getAlarm()), (t) => t !== null && t > Date.now() + 60_000);
      expect(next).toBeGreaterThan(Date.now() + 60_000);

      expect(await snapshot()).toEqual(before);
    } finally {
      await sql(`UPDATE _ember_rt_meta SET v = '5' WHERE k = 'rt_schema'`);
      await evictDurableObject(stub);
    }
    // Serving again, with what was there: the row, the job (still claimable), the revocation.
    expect((await api("query", { fn: "messages:list", args: { channel: "t" }, shard })).body.value).toHaveLength(1);
    expect(await rpc.claimActionJob(shard, jobId)).toEqual({ run: true });
    expect(await rpc.checkIdentity(shard, { subject: "gone", issuer: "t", iat: 1 })).toMatchObject({ code: "unauthenticated" });
    expect((await stub.status(shard)).migrationError).toBeNull();
    expect((await admin(`/api/_ember/inspect?shard=${shard}`)).body.shard.jobs.length).toBeGreaterThan(0);
  });
});

describe("migration preflight (POST /api/_ember/preflight)", () => {
  const preflight = (shard: string, schema: unknown, token = "admin-secret") => post("/api/_ember/preflight", { shard, schema }, token);

  it("plans the new schema against the shard's data, writes nothing, and reports refusals", async () => {
    const shard = "pre:flight";
    const stub = shardStub(shard);
    expect((await api("mutation", { fn: "messages:send", args: { channel: "p", body: "row" }, shard })).body.ok).toBe(true);
    const dump = () =>
      runInDurableObject(stub, (_i, state) => ({
        master: state.storage.sql.exec("SELECT type, name, sql FROM sqlite_master ORDER BY name").toArray(),
        meta: state.storage.sql.exec("SELECT key, value FROM _ember_meta ORDER BY key").toArray(),
        rows: state.storage.sql.exec("SELECT * FROM messages ORDER BY _id").toArray(),
        migrations: state.storage.sql.exec("SELECT COUNT(*) AS n FROM _ember_migrations").one().n,
      }));
    const before = await dump();

    expect((await preflight(shard, schemaRefused.manifest, "")).status).toBe(401);
    expect((await preflight(shard, { version: 1 })).body.error.code).toBe("bad_manifest");
    expect((await preflight("not a shard", schemaRefused.manifest)).body.error.code).toBe("bad_shard");
    // Over the body limit: refused by the declared length, and while reading when the body is streamed without one.
    const big = JSON.stringify({ shard, schema: { pad: "x".repeat(PREFLIGHT_BODY_MAX) } });
    const sendBig = (body: string | ReadableStream<Uint8Array>) =>
      SELF.fetch("http://ember/api/_ember/preflight", { method: "POST", headers: { authorization: "Bearer admin-secret" }, body });
    const streamed = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    for (const body of [big, streamed]) {
      const res = await sendBig(body);
      expect(res.status).toBe(413);
      expect(((await res.json()) as any).error.code).toBe("too_large");
    }

    const refused = await preflight(shard, schemaRefused.manifest);
    expect(refused.status).toBe(200);
    expect(refused.body.value).toMatchObject({
      shard,
      schemaVersion: config.schema.manifest.version,
      deployedVersion: config.schema.manifest.version,
      refused: null,
      result: { status: "refused", toVersion: schemaRefused.manifest.version, changed: true },
    });
    expect(refused.body.value.result.steps).toContainEqual(expect.objectContaining({ op: "refuse", table: "messages", field: "mandatory" }));

    const v2 = await preflight(shard, schemaV2.manifest);
    expect(v2.body.value.result).toMatchObject({ status: "ok", changed: true });
    expect(v2.body.value.result.staged.map((x: { index: string }) => x.index)).toEqual(expect.arrayContaining(["by_priority"]));

    const same = await preflight(shard, config.schema.manifest);
    expect(same.body.value.result).toMatchObject({ status: "ok", changed: false, steps: [] });

    const geo = JSON.parse(JSON.stringify(config.schema.manifest));
    geo.tables.messages.indexes.push({ kind: "geo", name: "by_place", fields: ["body"] });
    expect((await preflight(shard, geo)).body.value.result).toMatchObject({ status: "unchecked", code: "UnknownIndexKind" });

    expect(await dump()).toEqual(before);
  });
});
