// Point-in-time recovery plumbing (restore.ts): bookmark rows per deploy / migration / on demand, the admin
// endpoints, and the restore flow up to what local workerd supports.
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Shard } from "../src/shard.ts";
import type { System } from "../src/system.ts";
import { api, connect, hello, shardStub } from "./helpers.ts";

const UNDO = "00000001-ffffffff-00005119-0123456789abcdef0123456789abcdef";
const failure = (p: Promise<unknown>) => p.then(() => "resolved", (e: Error) => String(e?.message ?? e));
const system = () => env.SYSTEM.get(env.SYSTEM.idFromName("system")) as unknown as DurableObjectStub<System>;

/** Local workerd has no PITR: make scheduling "succeed" on the live instance (nothing is really scheduled). */
async function fakeSchedule(shard: string) {
  await runInDurableObject(shardStub(shard), (_i: Shard, state) => {
    (state.storage as { onNextSessionRestoreBookmark: (b: string) => Promise<string> }).onNextSessionRestoreBookmark = async () => UNDO;
  });
}

/** What a real restore leaves: a new instance on a database older than the `restore_pending` marker. */
async function simulateApplied(shard: string) {
  await runInDurableObject(shardStub(shard), (_i: Shard, state) => {
    state.storage.sql.exec("DELETE FROM _ember_rt_meta WHERE k = 'restore_pending'");
  });
  await evictDurableObject(shardStub(shard));
}

async function admin(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await SELF.fetch(`http://ember${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${init.token ?? "admin-secret"}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("PITR bookmarks", () => {
  it("lists the migration bookmark, records manual ones, and needs the admin token", async () => {
    const shard = "pitr:list";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "one" }, shard });
    expect((await admin(`/api/_ember/bookmarks?shard=${shard}`, { token: "wrong" })).status).toBe(401);
    const first = await admin(`/api/_ember/bookmarks?shard=${shard}`);
    expect(first.status).toBe(200);
    expect(first.body.retentionMs).toBe(30 * 24 * 3_600_000);
    expect(first.body.bookmarks.map((b: any) => b.reason)).toEqual(["deploy:test-version-1", "migrate"]);
    expect(first.body.bookmarks[0].bookmark).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]+$/);

    const made = await admin("/api/_ember/bookmark", { method: "POST", body: { shard, label: "before-import" } });
    expect(made.status).toBe(200);
    expect(made.body.bookmark).toMatchObject({ reason: "manual:before-import" });
    const after = await admin(`/api/_ember/bookmarks?shard=${shard}`);
    expect(after.body.bookmarks.map((b: any) => b.reason)).toEqual(["deploy:test-version-1", "migrate", "manual:before-import"]);

    expect((await admin("/api/_ember/bookmark", { method: "GET" })).status).toBe(405);
    expect((await admin("/api/_ember/bookmark", { method: "POST", body: { shard: "nokey" } })).status).toBe(400);
    expect((await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: "nope" } })).body.error.code).toBe("bad_bookmark");
  });

  it("the first boot under a new Worker version records deploy:<version> before migrating", async () => {
    const shard = "pitr:deploy";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "v0" }, shard });
    const stub = shardStub(shard);
    // Pretend the shard last ran under another version, then restart it (a deploy restarts every object).
    await runInDurableObject(stub, (_i: Shard, state) => {
      state.storage.sql.exec("UPDATE _ember_rt_meta SET v = 'previous-version' WHERE k = 'deploy_version'");
    });
    await evictDurableObject(stub);
    const rows = await shardStub(shard).bookmarks(shard);
    expect(rows.map((r) => r.reason)).toEqual(["deploy:test-version-1", "migrate", "deploy:test-version-1"]);
    // Same version again: nothing new.
    await evictDurableObject(shardStub(shard));
    expect((await shardStub(shard).bookmarks(shard)).length).toBe(3);
  });

  it("a brand-new shard records deploy:<version> on its first boot, before its first migration", async () => {
    // Bugbot on #6: without it, `--all --to deploy:<v>` found no deploy:<v> row on a shard created under v and
    // kept everything it wrote under v.
    const shard = "pitr:fresh";
    const rows = await shardStub(shard).bookmarks(shard);
    expect(rows.map((r) => r.reason)).toEqual(["deploy:test-version-1", "migrate"]);
    expect(rows[0]!.bookmark).not.toBe("");
  });

  it("a deploy bookmark that cannot be taken leaves a deploy-missed row instead of a silent gap", async () => {
    const shard = "pitr:missed";
    await shardStub(shard).warm(shard);
    await runInDurableObject(shardStub(shard), async (instance: Shard, state) => {
      state.storage.sql.exec("UPDATE _ember_rt_meta SET v = 'previous-version' WHERE k = 'deploy_version'");
      (state.storage as { getCurrentBookmark: () => Promise<string> }).getCurrentBookmark = () => Promise.reject(new Error("no PITR"));
      await (instance as unknown as { boot(): Promise<void> }).boot();
    });
    const rows = await shardStub(shard).bookmarks(shard);
    expect(rows.slice(-1)).toMatchObject([{ reason: "deploy-missed:test-version-1", bookmark: "" }]);
  });

  it("restore state machine: finish refuses until the restore applied, then completes once per nonce", async () => {
    const shard = "pitr:finish";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "x" }, shard });
    const before = await shardStub(shard).inspect();
    await fakeSchedule(shard);
    const prepared = await shardStub(shard).restorePrepare(shard, (await shardStub(shard).bookmarks(shard))[0]!.bookmark, "t1");
    expect(prepared).toMatchObject({ undo: UNDO, nonce: expect.any(String), instance: expect.any(String) });
    const info = { nonce: prepared.nonce, instance: prepared.instance, rows: prepared.rows, undo: prepared.undo, bookmark: prepared.rows[0]!.bookmark, label: "t1" };
    // A second restore while this one is pending is refused.
    expect(await failure(shardStub(shard).restorePrepare(shard, prepared.rows[0]!.bookmark, "t2"))).toMatch(/restore_in_progress/);
    // Bugbot on #6: the abort did not happen (same live instance): finish must not report success.
    expect(await failure(shardStub(shard).restoreFinish(shard, info))).toMatch(/restore_not_applied/);
    expect((await shardStub(shard).inspect()).epoch).toBe(before.epoch);
    // The journal knows the scheduled restore and its undo bookmark.
    expect(await system().restores()).toEqual(expect.arrayContaining([expect.objectContaining({ nonce: prepared.nonce, shard, undo: UNDO })]));

    // The restore applies (simulated: the restored database predates the marker), with a client connected in between.
    await simulateApplied(shard);
    const c = await connect(shard);
    await hello(c);
    const closed = new Promise<number>((r) => c.ws.addEventListener("close", (e) => r(e.code)));
    // The Worker died before finishing: the System DO's alarm completes it.
    await runInDurableObject(env.SYSTEM.get(env.SYSTEM.idFromName("system")), (_i, state) => {
      state.storage.sql.exec("UPDATE _ember_restores SET next_at = 0");
    });
    await runDurableObjectAlarm(env.SYSTEM.get(env.SYSTEM.idFromName("system")));
    expect((await system().restores()).filter((r) => r.nonce === prepared.nonce)).toEqual([]);
    expect(await closed).toBe(1012);
    const after = await shardStub(shard).inspect();
    expect(after.epoch).not.toBe(before.epoch);
    const reasons = (await shardStub(shard).bookmarks(shard)).map((r) => r.reason);
    expect(reasons.filter((r) => /:t1$/.test(r))).toEqual(["pre-restore:t1", "undo:t1", "restore:t1"]);
    // Finishing again (the Worker's own finish arriving late) changes nothing.
    expect(await shardStub(shard).restoreFinish(shard, info)).toMatchObject({ epoch: after.epoch });
    expect((await shardStub(shard).bookmarks(shard)).length).toBe(reasons.length);
  });

  it("a restart that did not apply the restore is reported as a failure, never as a restore", async () => {
    // Bugbot on #6: the restore endpoint swallowed abort errors and reported success from whatever instance answered.
    const shard = "pitr:unapplied";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "keep" }, shard });
    const [row] = await shardStub(shard).bookmarks(shard);
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "after" }, shard });
    // Scheduling "succeeds" but nothing is really scheduled: the abort restarts the object on the same data.
    await fakeSchedule(shard);
    const r = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: row!.bookmark, label: "noop" } });
    expect(r).toMatchObject({ status: 500, body: { ok: false, error: { code: "restore_failed", message: expect.stringMatching(/restore_not_scheduled/) } } });
    const list = await api("query", { fn: "messages:list", args: { channel: "c" }, shard });
    expect(list.body.value.map((m: any) => m.body)).toEqual(["keep", "after"]);
    expect((await shardStub(shard).bookmarks(shard)).map((b) => b.reason)).not.toContain("restore:noop");
    expect((await system().restores()).filter((j) => j.shard === shard)).toEqual([]);
  });

  it("a restore that restarted without applying stays failed for every later finish of its nonce", async () => {
    // Bugbot on #6: restore_not_scheduled deleted the marker, and a second finish of the same nonce (Worker retry,
    // or the System alarm when the journal settle failed) read the missing marker as "applied" and reported success.
    const shard = "pitr:failed-twice";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "keep" }, shard });
    const before = await shardStub(shard).inspect();
    await fakeSchedule(shard);
    const prepared = await shardStub(shard).restorePrepare(shard, (await shardStub(shard).bookmarks(shard))[0]!.bookmark, "f1");
    const info = { nonce: prepared.nonce, instance: prepared.instance, rows: prepared.rows, undo: prepared.undo, bookmark: prepared.rows[0]!.bookmark, label: "f1" };
    await evictDurableObject(shardStub(shard)); // restarts on the same data: the restore was never really scheduled
    expect(await failure(shardStub(shard).restoreFinish(shard, info))).toMatch(/restore_not_scheduled/);
    expect(await failure(shardStub(shard).restoreFinish(shard, info))).toMatch(/restore_not_scheduled/);
    // The journal entry outlived the failure (its settle is best effort): the alarm finishes it as failed too.
    await runInDurableObject(system(), (_i, state) => {
      state.storage.sql.exec("UPDATE _ember_restores SET next_at = 0 WHERE nonce = ?", prepared.nonce);
    });
    await runDurableObjectAlarm(system());
    expect((await system().restores()).filter((r) => r.nonce === prepared.nonce)).toEqual([]);
    expect(await failure(shardStub(shard).restoreFinish(shard, info))).toMatch(/restore_not_scheduled/);
    expect((await shardStub(shard).inspect()).epoch).toBe(before.epoch);
    const reasons = (await shardStub(shard).bookmarks(shard)).map((r) => r.reason);
    expect(reasons.filter((r) => /:f1$/.test(r))).toEqual(["pre-restore:f1"]);
  });

  it("a restore whose scheduling failed is never completed by a late finish", async () => {
    const shard = "pitr:prepare-failed";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "keep" }, shard });
    const before = await shardStub(shard).inspect();
    let nonce = "";
    await runInDurableObject(shardStub(shard), (_i: Shard, state) => {
      (state.storage as { onNextSessionRestoreBookmark: (b: string) => Promise<string> }).onNextSessionRestoreBookmark = () => {
        nonce = String(state.storage.sql.exec("SELECT v FROM _ember_rt_meta WHERE k = 'restore_pending'").one().v);
        return Promise.reject(new Error("boom"));
      };
    });
    const rows = await shardStub(shard).bookmarks(shard);
    expect(await failure(shardStub(shard).restorePrepare(shard, rows[0]!.bookmark, "p1"))).toMatch(/boom/);
    expect(nonce).not.toBe("");
    const info = { nonce, instance: "old", rows, undo: null, bookmark: rows[0]!.bookmark, label: "p1" };
    expect(await failure(shardStub(shard).restoreFinish(shard, info))).toMatch(/restore_not_scheduled/);
    await evictDurableObject(shardStub(shard));
    expect(await failure(shardStub(shard).restoreFinish(shard, info))).toMatch(/restore_not_scheduled/);
    expect((await shardStub(shard).inspect()).epoch).toBe(before.epoch);
  });

  it("a finish that dies after its transaction is completed by the retry (sockets, restore: row)", async () => {
    // Bugbot on #6: the nonce was recorded in the transaction and a retry returned at once, skipping the socket
    // close, the restore: bookmark and the re-arm that the first attempt never reached.
    const shard = "pitr:finish-crash";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "x" }, shard });
    await fakeSchedule(shard);
    const prepared = await shardStub(shard).restorePrepare(shard, (await shardStub(shard).bookmarks(shard))[0]!.bookmark, "c1");
    const info = { nonce: prepared.nonce, instance: prepared.instance, rows: prepared.rows, undo: prepared.undo, bookmark: prepared.rows[0]!.bookmark, label: "c1" };
    await simulateApplied(shard);
    const c = await connect(shard);
    await hello(c);
    const closed = new Promise<number>((r) => c.ws.addEventListener("close", (e) => r(e.code)));
    // The first attempt dies right after its transaction committed.
    await runInDurableObject(shardStub(shard), (_i: Shard, state) => {
      const s = state as unknown as { getWebSockets: () => WebSocket[] };
      const real = s.getWebSockets.bind(state);
      s.getWebSockets = () => {
        s.getWebSockets = real;
        throw new Error("crash after commit");
      };
    });
    expect(await failure(shardStub(shard).restoreFinish(shard, info))).toMatch(/crash after commit/);
    const epoch = (await shardStub(shard).inspect()).epoch;
    // The retry (Worker loop or System alarm) does the rest, without a second epoch or undo row.
    expect(await shardStub(shard).restoreFinish(shard, info)).toMatchObject({ epoch });
    expect(await Promise.race([closed, new Promise((r) => setTimeout(() => r("still open"), 2_000))])).toBe(1012);
    const reasons = (await shardStub(shard).bookmarks(shard)).map((r) => r.reason);
    expect(reasons.filter((r) => /:c1$/.test(r))).toEqual(["pre-restore:c1", "undo:c1", "restore:c1"]);
    // Done: finishing again changes nothing.
    expect(await shardStub(shard).restoreFinish(shard, info)).toMatchObject({ epoch });
    expect((await shardStub(shard).bookmarks(shard)).length).toBe(reasons.length);
  });

  it("POST /api/_ember/restore against local workerd: restores or reports PITR as unavailable", async () => {
    const shard = "pitr:local";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "keep" }, shard });
    const [row] = await shardStub(shard).bookmarks(shard);
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "after" }, shard });
    const r = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: row!.bookmark, label: "local" } });
    if (r.status === 200) {
      // Real PITR (if this workerd supports it): the later write is gone and the undo bookmark is recorded.
      expect(r.body.undo).toMatch(/^[0-9a-f]{8}-/);
      const list = await api("query", { fn: "messages:list", args: { channel: "c" }, shard });
      expect(list.body.value.map((m: any) => m.body)).toEqual(["keep"]);
    } else {
      expect(r).toMatchObject({ status: 501, body: { error: { code: "pitr_unavailable" } } });
    }
  });
});
