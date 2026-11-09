/**
 * Guarantees kept by the rows-written reductions (docs/spikes/rows-written.md): mutation dedup in generation tables,
 * subscriptions in socket attachments, the change-log ring and the "ident" resume tag.
 */
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { DEDUP_RETENTION_MS, type Shard } from "../src/shard.ts";
import { api, connect, hello, is, shardStub, sleep, type Client } from "./helpers.ts";

type MRes = Extract<ServerMessage, { t: "mres" }> & { value?: any };
type Snap = Extract<ServerMessage, { t: "snap" }> & { value?: any; ik?: string };

const sqlOf = (shard: string, q: string, ...p: (string | number)[]) =>
  runInDurableObject(shardStub(shard), (_i: Shard, state) => state.storage.sql.exec(q, ...p).toArray() as Array<Record<string, unknown>>);

const internals = (i: Shard) => i as unknown as { rotateDedup(now: number): boolean; dedupTables: string[] };

async function mut(c: Client, mid: string, fn: string, args: Record<string, unknown>): Promise<MRes> {
  c.send({ t: "mut", mid, fn, args });
  return c.waitFor<MRes>(is("mres", (m) => m.mid === mid));
}

async function session(shard: string, clientId: string, token?: string, features?: string[]) {
  const c = await connect(shard);
  const ready = await hello(c, clientId, token, features);
  return { c, ready };
}

const runsCount = async (shard: string) => ((await api("query", { fn: "runs:list", args: {}, shard })).body.value as unknown[]).length;

describe("mutation dedup (generation tables)", () => {
  it("a retried mid returns the stored outcome across a restart, without a second effect", async () => {
    const shard = "inv:dedup-restart";
    const a = await session(shard, "client-r");
    const first = await mut(a.c, "m1", "runs:add", { label: "once" });
    expect(first.ok).toBe(true);
    a.c.close();
    await evictDurableObject(shardStub(shard));
    const b = await session(shard, "client-r");
    const again = await mut(b.c, "m1", "runs:add", { label: "once" });
    expect(again).toMatchObject({ ok: true, value: first.value });
    expect(await runsCount(shard)).toBe(1);
    // One row per outcome, in the newest generation; no `at` index.
    const tables = await sqlOf(shard, "SELECT name, type FROM sqlite_master WHERE name LIKE '_ember_dedup%' ORDER BY name");
    expect(tables).toEqual([{ name: "_ember_dedup_1", type: "table" }]);
    b.c.close();
  });

  it("an outcome survives one rotation (≥ the retention window) and is dropped by the next", async () => {
    const shard = "inv:dedup-rotate";
    const a = await session(shard, "client-x");
    const first = await mut(a.c, "m1", "runs:add", { label: "x" });
    const stub = shardStub(shard);
    // The outcome rides in its commit's change-log row until the slot is reused (test worker: 5 versions); never
    // acknowledged, it then moves to the newest dedup generation, where this test follows it.
    for (let i = 0; i < 6; i++) expect((await api("mutation", { fn: "messages:send", args: { channel: "filler", body: `t${i}` }, shard })).body.ok).toBe(true);
    // Too early: nothing rotates.
    expect(await runInDurableObject(stub, (i: Shard) => internals(i).rotateDedup(Date.now() + 1000))).toBe(false);
    expect(await runInDurableObject(stub, (i: Shard) => internals(i).rotateDedup(Date.now() + DEDUP_RETENTION_MS + 1))).toBe(true);
    expect(await runInDurableObject(stub, (i: Shard) => internals(i).dedupTables)).toEqual(["_ember_dedup_2", "_ember_dedup_1"]);
    // Still deduplicated (previous generation), also after a restart.
    expect(await mut(a.c, "m1", "runs:add", { label: "x" })).toMatchObject({ ok: true, value: first.value });
    a.c.close();
    await evictDurableObject(stub);
    const b = await session(shard, "client-x");
    expect(await mut(b.c, "m1", "runs:add", { label: "x" })).toMatchObject({ ok: true, value: first.value });
    expect(await runsCount(shard)).toBe(1);
    // A second rotation (another full window later) drops generation 1 with a DROP TABLE.
    const w0 = (await stub.inspect()).rows.written;
    expect(await runInDurableObject(stub, (i: Shard) => internals(i).rotateDedup(Date.now() + 3 * DEDUP_RETENTION_MS))).toBe(true);
    const names = (await sqlOf(shard, "SELECT name FROM sqlite_master WHERE name LIKE '_ember_dedup%' ORDER BY name")).map((r) => r.name);
    expect(names).toEqual(["_ember_dedup_2", "_ember_dedup_3"]);
    // Rotation writes only the new table's schema rows and two meta rows, whatever the number of expired outcomes.
    expect((await stub.inspect()).rows.written - w0).toBeLessThanOrEqual(6);
    // Past the window the mid is new again (the documented contract: retries within the window).
    const late = await mut(b.c, "m1", "runs:add", { label: "x" });
    expect(late.ok).toBe(true);
    expect(late.value).not.toBe(first.value);
    b.c.close();
  });

  it("rows of the legacy _ember_dedup table (runtime < 3) are still honoured", async () => {
    const shard = "inv:dedup-legacy";
    const stub = shardStub(shard);
    await stub.warm(shard);
    const stored = JSON.stringify({ ok: true, value: "from-legacy", version: 7 });
    await runInDurableObject(stub, (_i: Shard, state) => {
      state.storage.sql.exec(
        "CREATE TABLE _ember_dedup (identity TEXT NOT NULL, client_id TEXT NOT NULL, mid TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY (identity, client_id, mid)) STRICT, WITHOUT ROWID",
      );
      state.storage.sql.exec("INSERT INTO _ember_dedup VALUES ('anon', 'old-client', '\"m9\"', ?, ?)", Date.now(), stored);
    });
    await evictDurableObject(stub);
    const a = await session(shard, "old-client");
    expect(await mut(a.c, "m9", "runs:add", { label: "never" })).toMatchObject({ ok: true, value: "from-legacy" });
    expect(await runsCount(shard)).toBe(0);
    a.c.close();
  });

  it("the auth-outbox dedupKey (RPC) is exactly-once across a restart", async () => {
    const shard = "inv:dedup-rpc";
    const stub = shardStub(shard);
    const r1 = await stub.mutation(shard, "jobs:record", { label: "k" }, null, true, { dedupKey: "evt-1" });
    await evictDurableObject(stub);
    const r2 = await shardStub(shard).mutation(shard, "jobs:record", { label: "k" }, null, true, { dedupKey: "evt-1" });
    expect(r2).toEqual(r1);
    expect(await runsCount(shard)).toBe(1);
  });
});

describe("version without the per-commit meta row", () => {
  it("the version survives a restart (newest change-log slot) and the ring stays bounded", async () => {
    const shard = "inv:version";
    for (let i = 0; i < 5; i++) expect((await api("mutation", { fn: "runs:add", args: { label: `v${i}` }, shard })).body.ok).toBe(true);
    const before = (await shardStub(shard).inspect()).version;
    expect(before).toBe(5);
    await evictDurableObject(shardStub(shard));
    expect((await shardStub(shard).inspect()).version).toBe(5);
    const meta = await sqlOf(shard, "SELECT v FROM _ember_rt_meta WHERE k = 'version'");
    expect(meta).toEqual([]);
    const slots = await sqlOf(shard, "SELECT slot, version FROM _ember_changes ORDER BY version");
    expect(slots.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it("upgrades a runtime-2 shard: change log copied into the ring, _jobs rebuilt with a partial dedup index", async () => {
    const shard = "inv:upgrade";
    const stub = shardStub(shard);
    await stub.warm(shard);
    // Recreate the runtime-2 layout with history: 3 versions in the old change log, meta version, one keyed job.
    await runInDurableObject(stub, (_i: Shard, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE _ember_changes");
      sql.exec("DROP TABLE _jobs");
      sql.exec("CREATE TABLE _ember_changelog (version INTEGER PRIMARY KEY, at INTEGER NOT NULL, changes TEXT NOT NULL) STRICT");
      for (const v of [8, 9, 10]) sql.exec("INSERT INTO _ember_changelog VALUES (?, ?, '[]')", v, Date.now());
      sql.exec(`CREATE TABLE _jobs (
        id INTEGER PRIMARY KEY, run_at INTEGER NOT NULL, fn TEXT NOT NULL, args TEXT NOT NULL,
        kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL, last_error TEXT, dedup_key TEXT UNIQUE,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, job_id TEXT) STRICT`);
      sql.exec("CREATE INDEX _jobs_due ON _jobs(state, run_at)");
      sql.exec("INSERT INTO _jobs(run_at, fn, args, kind, max_attempts, dedup_key, created_at, updated_at, job_id) VALUES (?, 'jobs:record', '{}', 'mutation', 5, 'cron:x:1', 0, 0, 'job_old')", Date.now() + 3_600_000);
      sql.exec("INSERT INTO _ember_rt_meta(k, v) VALUES ('rt_schema', '2') ON CONFLICT(k) DO UPDATE SET v = excluded.v");
      sql.exec("INSERT INTO _ember_rt_meta(k, v) VALUES ('version', '10') ON CONFLICT(k) DO UPDATE SET v = excluded.v");
    });
    // restoreAbort restarts the object and forgets the per-isolate schema check (like a new deploy).
    await stub.restoreAbort().catch(() => undefined);
    const fresh = shardStub(shard);
    expect((await fresh.inspect()).version).toBe(10);
    const tables = (await sqlOf(shard, "SELECT name FROM sqlite_master WHERE name IN ('_ember_changelog', '_ember_changes', '_jobs_v3')")).map((r) => r.name);
    expect(tables).toEqual(["_ember_changes"]);
    expect((await sqlOf(shard, "SELECT version FROM _ember_changes ORDER BY version")).map((r) => r.version)).toEqual([8, 9, 10]);
    const jobsSql = String((await sqlOf(shard, "SELECT sql FROM sqlite_master WHERE name = '_jobs'"))[0]?.sql);
    expect(jobsSql).not.toMatch(/UNIQUE/i);
    // The kept job, the dedup key still unique.
    expect((await fresh.inspect()).jobs.map((j) => j.job_id)).toEqual(["job_old"]);
    expect(await fresh.enqueueJob(shard, { fn: "jobs:record", args: { label: "dup" }, dedupKey: "cron:x:1" })).toEqual({ id: null });
    expect((await fresh.enqueueJob(shard, { fn: "jobs:record", args: { label: "a" }, runAt: Date.now() + 3_600_000 })).id).toBeTruthy();
    expect((await fresh.enqueueJob(shard, { fn: "jobs:record", args: { label: "b" }, runAt: Date.now() + 3_600_000 })).id).toBeTruthy();
    // Resume across the upgrade still sees the old versions.
    const { c, ready } = await session(shard, "up");
    expect(ready.version).toBe(10);
    c.close();
  });
});

describe("subscriptions in socket attachments", () => {
  it("survive hibernation without _ember_subs rows; a subscription too large for the attachment spills to the table", async () => {
    const shard = "inv:subs-attach";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a, "a", "good:amy", ["ident"]);
    await hello(b);
    a.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "h" } });
    await a.waitFor(is("snap"));
    // ~20 KB of args: more than the attachment holds.
    const big = "x".repeat(20_000);
    a.send({ t: "sub", qid: 2, fn: "messages:search", args: { q: big, channel: "h" } });
    await a.waitFor(is("snap", (m) => m.qid === 2));
    const rows = await sqlOf(shard, "SELECT sock, qid FROM _ember_subs");
    expect(rows.map((r) => r.qid)).toEqual(["2"]);
    expect(await sqlOf(shard, "SELECT * FROM _ember_sub_ident")).toEqual([]);
    const stub = shardStub(shard);
    await evictDurableObject(stub);
    b.send({ t: "mut", mid: "w1", fn: "messages:send", args: { channel: "h", body: "after wake" } });
    const patch = await a.waitFor<Extract<ServerMessage, { t: "patch" }>>(is("patch"));
    expect(patch.changes).toEqual([{ qid: 1, value: [expect.objectContaining({ body: "after wake" })] }]);
    const after = await stub.inspect();
    expect(after.stats.rebuiltSubs).toBe(2);
    expect(after.subs).toBe(2);
    // Unsubscribing removes from the attachment and from the table.
    a.send({ t: "unsub", qid: 1 });
    a.send({ t: "unsub", qid: 2 });
    await sleep(50);
    expect(await sqlOf(shard, "SELECT * FROM _ember_subs")).toEqual([]);
    await evictDurableObject(stub);
    b.send({ t: "mut", mid: "w2", fn: "messages:send", args: { channel: "h", body: "again" } });
    await b.waitFor(is("mres"));
    expect((await stub.inspect()).stats.rebuiltSubs).toBe(0);
    expect(a.frames.filter((f) => f.t === "patch")).toEqual([]);
    a.close();
    b.close();
  });

  it("one store per qid: moving between the table (overflow) and the attachment leaves no row behind", async () => {
    const shard = "inv:subs-move";
    const stub = shardStub(shard);
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a, "mv", "good:amy", ["ident"]);
    await hello(b);
    const big = "x".repeat(20_000);
    const qidsInTable = async () => (await sqlOf(shard, "SELECT qid FROM _ember_subs ORDER BY qid")).map((r) => r.qid);
    // Errored subscriptions stay registered, so the same qid can be subscribed again with other args.
    a.send({ t: "sub", qid: "q", fn: "messages:latest", args: { channel: "empty" } });
    await a.waitFor(is("err", (m) => m.qid === "q"));
    expect(await qidsInTable()).toEqual([]); // in the attachment
    a.send({ t: "sub", qid: "q", fn: "messages:latest", args: { channel: big } });
    await a.waitFor(is("err", (m) => m.qid === "q")); // the first err was consumed above
    expect(await qidsInTable()).toEqual(['"q"']); // too large: moved to the table
    a.send({ t: "sub", qid: "q", fn: "messages:list", args: { channel: "h" } });
    await a.waitFor(is("snap", (m) => m.qid === "q"));
    expect(await qidsInTable()).toEqual([]); // back in the attachment: the row is gone
    await evictDurableObject(stub);
    b.send({ t: "mut", mid: "w1", fn: "messages:send", args: { channel: "h", body: "after wake" } });
    const patch = await a.waitFor<Extract<ServerMessage, { t: "patch" }>>(is("patch"));
    expect(patch.changes).toEqual([{ qid: "q", value: [expect.objectContaining({ body: "after wake" })] }]);
    expect((await stub.inspect()).stats.rebuiltSubs).toBe(1);
    a.send({ t: "unsub", qid: "q" });
    await sleep(50);
    await evictDurableObject(stub);
    b.send({ t: "mut", mid: "w2", fn: "messages:send", args: { channel: "h", body: "again" } });
    await b.waitFor(is("mres"));
    expect((await stub.inspect()).stats.rebuiltSubs).toBe(0);
    expect(a.frames.filter((f) => f.t === "patch")).toEqual([]); // the one above was consumed
    a.close();
    b.close();
  });

  it("upgrade: _ember_subs rows of an older runtime are honoured once, then never resurrect a qid", async () => {
    const shard = "inv:subs-legacy";
    const stub = shardStub(shard);
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a, "lg", "good:amy", ["ident"]);
    await hello(b);
    a.send({ t: "sub", qid: "both", fn: "messages:list", args: { channel: "h" } });
    await a.waitFor(is("snap", (m) => m.qid === "both"));
    // Rows as an older runtime left them (every subscription in the table): one for a qid only there, one stale
    // duplicate (other fn/args) of a qid the attachment holds.
    await runInDurableObject(stub, (_i: Shard, state) => {
      const ws = state.getWebSockets().find((w) => (w.deserializeAttachment() as { clientId?: string }).clientId === "lg")!;
      const sid = (ws.deserializeAttachment() as { sid: string }).sid;
      const ins = "INSERT INTO _ember_subs(sock, qid, fn, args) VALUES (?, ?, ?, ?)";
      state.storage.sql.exec(ins, sid, '"old"', "messages:latest", JSON.stringify({ channel: "empty" }));
      state.storage.sql.exec(ins, sid, '"both"', "messages:latest", JSON.stringify({ channel: "empty" }));
    });
    await evictDurableObject(stub);
    b.send({ t: "mut", mid: "w1", fn: "messages:send", args: { channel: "h", body: "one" } });
    const patch = await a.waitFor<Extract<ServerMessage, { t: "patch" }>>(is("patch"));
    // The attachment wins for "both" (the stale row is dropped); "old" is restored from its row.
    expect(patch.changes).toEqual([{ qid: "both", value: [expect.objectContaining({ body: "one" })] }]);
    expect((await stub.inspect()).subs).toBe(2);
    expect((await sqlOf(shard, "SELECT qid FROM _ember_subs")).map((r) => r.qid)).toEqual(['"old"']);
    // Re-subscribing the errored legacy qid moves it into the attachment; unsubscribing then leaves nothing.
    a.send({ t: "sub", qid: "old", fn: "messages:list", args: { channel: "h" } });
    await a.waitFor(is("snap", (m) => m.qid === "old"));
    expect(await sqlOf(shard, "SELECT qid FROM _ember_subs")).toEqual([]);
    a.send({ t: "unsub", qid: "old" });
    a.send({ t: "unsub", qid: "both" });
    await sleep(50);
    await evictDurableObject(stub);
    b.send({ t: "mut", mid: "w2", fn: "messages:send", args: { channel: "h", body: "two" } });
    await b.waitFor(is("mres", (m) => m.mid === "w2"));
    expect((await stub.inspect()).stats.rebuiltSubs).toBe(0);
    expect(a.frames.filter((f) => f.t === "patch")).toEqual([]); // the one above was consumed
    a.close();
    b.close();
  });

  it("an auth frame keeps the socket's subscriptions across hibernation", async () => {
    const shard = "inv:subs-auth";
    const a = await connect(shard);
    await hello(a, "a2", "good:amy", ["ident"]);
    a.send({ t: "sub", qid: "w", fn: "auth:whoami", args: {} });
    expect(await a.waitFor<Snap>(is("snap"))).toMatchObject({ value: "amy" });
    a.send({ t: "auth", token: "good:zed" });
    expect(await a.waitFor<Snap>(is("snap"))).toMatchObject({ value: "zed" });
    await evictDurableObject(shardStub(shard));
    expect((await shardStub(shard).inspect()).subs).toBe(1);
    a.close();
  });
});

describe('resume with feature "ident"', () => {
  it("unchanged only when the echoed tag is the socket identity's; no _ember_sub_ident rows", async () => {
    const shard = "inv:ident";
    const s1 = await session(shard, "cid", "good:amy", ["ident"]);
    expect(s1.ready.features).toEqual(["ident"]);
    s1.c.send({ t: "sub", qid: "w", fn: "auth:whoami", args: {} });
    const snap = await s1.c.waitFor<Snap>(is("snap"));
    expect(snap.value).toBe("amy");
    expect(typeof snap.ik).toBe("string");
    s1.c.close();
    const resume = (ik?: string) => ({ version: s1.ready.version, epoch: s1.ready.epoch, ...(ik ? { ik } : {}) });
    const again = async (token: string, ik?: string) => {
      const s = await session(shard, "cid", token, ["ident"]);
      s.c.send({ t: "sub", qid: "w", fn: "auth:whoami", args: {}, resume: resume(ik) });
      const r = await s.c.waitFor<Snap>(is("snap"));
      s.c.close();
      return r;
    };
    expect(await again("good:amy", snap.ik)).toMatchObject({ unchanged: true });
    // Another identity echoing amy's tag (account switch on the same client): full snapshot under the new one.
    const bob = await again("good:bob", snap.ik);
    expect(bob).toMatchObject({ value: "bob" });
    expect(bob.ik).not.toBe(snap.ik);
    // No tag: full snapshot.
    expect(await again("good:amy")).toMatchObject({ value: "amy" });
    expect(await sqlOf(shard, "SELECT * FROM _ember_sub_ident")).toEqual([]);
  });
});
