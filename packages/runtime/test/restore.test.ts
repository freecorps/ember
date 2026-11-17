// Point-in-time recovery plumbing (restore.ts): bookmark rows per deploy / migration / on demand, the admin
// endpoints, and the restore flow up to what local workerd supports.
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AHEAD_MARKER_KEY, aheadFinishDecision } from "../src/restore.ts";
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

  // Seen on a real restore (Cloudflare, #116): the list lost the very bookmark that was restored to.
  it("a bookmark row whose id went to another row in the restored database is kept, not dropped", async () => {
    const shard = "pitr:rows";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "x" }, shard });
    await fakeSchedule(shard);
    const prepared = await shardStub(shard).restorePrepare(shard, (await shardStub(shard).bookmarks(shard))[0]!.bookmark, "r1");
    await simulateApplied(shard);
    // A row recorded after the restored point: in the restored database its id belongs to another row (here the last
    // one; on a real restore, the `deploy:<v>` row the boot after the restore records).
    const taken = (await shardStub(shard).bookmarks(shard)).at(-1)!;
    const lost = { id: taken.id, at: 5, bookmark: "bookmark-of-the-lost-row", reason: "manual:lost" };
    await shardStub(shard).restoreFinish(shard, { nonce: prepared.nonce, instance: prepared.instance, rows: [...prepared.rows, lost], undo: prepared.undo, bookmark: prepared.rows[0]!.bookmark, label: "r1" });
    const rows = await shardStub(shard).bookmarks(shard);
    expect(rows.find((r) => r.reason === "manual:lost")).toMatchObject({ at: 5, bookmark: "bookmark-of-the-lost-row" });
    expect(rows.find((r) => r.id === taken.id)).toMatchObject({ reason: taken.reason, bookmark: taken.bookmark });
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    // Oldest first by time, whatever id a kept row got.
    expect(rows[0]!.reason).toBe("manual:lost");
    expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort((a, b) => a - b));
    // Rows that were already there are not doubled.
    expect(rows.filter((r) => r.reason === "pre-restore:r1").length).toBe(1);
  });

  // The second name holds another outcome token: the matchers are anchored, so it is not read as "not scheduled".
  it.each(["pitr:ahead", "pitr:restore_not_scheduled"])("a restore that lands on runtime tables of a newer runtime stays journaled, with its undo bookmark, until one finishes it (%s)", async (shard) => {
    // Review on #108 (R1): the journal entry was settled (deleted) on `restore_still_ahead`, though it is the only copy of
    // the rows to re-import and of the undo bookmark. Local workerd has no PITR, so the "restore" is simulated: the
    // scheduling stub turns the live database into what restoring a bookmark of a newer runtime leaves (no
    // `restore_pending` marker, `rt_schema` 6). The real `onNextSessionRestoreBookmark` and the platform restart onto
    // that bookmark are not exercised; the HTTP endpoint, the abort, the refused boot, `restoreFinish`, the System
    // journal and alarm, and `GET /api/_ember/status` are.
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "keep" }, shard });
    const before = await shardStub(shard).inspect();
    await runInDurableObject(shardStub(shard), (_i: Shard, state) => {
      (state.storage as { onNextSessionRestoreBookmark: (b: string) => Promise<string> }).onNextSessionRestoreBookmark = async () => {
        state.storage.sql.exec("DELETE FROM _ember_rt_meta WHERE k = 'restore_pending'");
        state.storage.sql.exec("UPDATE _ember_rt_meta SET v = '6' WHERE k = 'rt_schema'");
        return UNDO;
      };
    });
    const [row] = await shardStub(shard).bookmarks(shard);
    const r = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: row!.bookmark, label: "ahead" } });
    expect(r).toMatchObject({ status: 409, body: { ok: false, error: { code: "restore_still_ahead" }, shard, restoredTo: row!.bookmark, undo: UNDO, pending: true } });
    expect(r.body.error.message).toMatch(/stays pending/);
    expect(r.body.error.message).toContain(UNDO);
    const mine = async () => (await system().restores()).filter((j) => j.shard === shard);
    const [entry] = await mine();
    expect(entry).toMatchObject({ shard, label: "ahead", bookmark: row!.bookmark, undo: UNDO });
    // The operator sees it in `status`, next to the refusal.
    const st = await admin(`/api/_ember/status?shard=${shard}`);
    expect(st.body.shards[0].migrationError).toMatchObject({ code: "RuntimeSchemaTooNew" });
    expect(st.body.restores).toEqual([expect.objectContaining({ nonce: entry!.nonce, shard, undo: UNDO })]);

    // The System alarm keeps the entry (backoff, the error recorded) and writes nothing into the refused shard.
    const dump = () =>
      runInDurableObject(shardStub(shard), (_i: Shard, state) => {
        const out: Record<string, unknown[]> = {};
        for (const t of state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray()) {
          out[String(t.name)] = state.storage.sql.exec(`SELECT * FROM "${String(t.name)}"`).toArray().map((x) => JSON.stringify(x, (_k, v) => (v instanceof ArrayBuffer ? [...new Uint8Array(v)] : v)));
        }
        return out;
      });
    const frozen = await dump();
    const due = () =>
      runInDurableObject(system(), (_i, state) => {
        state.storage.sql.exec("UPDATE _ember_restores SET next_at = 0 WHERE nonce = ?", entry!.nonce);
      });
    await due();
    await runDurableObjectAlarm(system());
    const [kept] = await mine();
    expect(kept).toMatchObject({ nonce: entry!.nonce, undo: UNDO, last_error: expect.stringMatching(/^restore_still_ahead/) });
    expect(kept!.attempts).toBeGreaterThan(entry!.attempts);
    expect(kept!.next_at).toBeGreaterThan(Date.now());
    expect(await dump()).toEqual(frozen);

    // A runtime that understands the tables (this one, once the marker is back where it can read it, stands in for the
    // newer runtime) finishes it: the restore applied, so the rows come back with the undo row and a new epoch.
    await runInDurableObject(shardStub(shard), (_i: Shard, state) => {
      state.storage.sql.exec("UPDATE _ember_rt_meta SET v = '5' WHERE k = 'rt_schema'");
    });
    await evictDurableObject(shardStub(shard));
    await due();
    await runDurableObjectAlarm(system());
    expect(await mine()).toEqual([]);
    expect((await shardStub(shard).inspect()).epoch).not.toBe(before.epoch);
    const reasons = (await shardStub(shard).bookmarks(shard)).map((b) => b.reason);
    expect(reasons.filter((x) => /:ahead$/.test(x))).toEqual(["pre-restore:ahead", "undo:ahead", "restore:ahead"]);
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

// ------------------------------------------------------------------ restore from a shard refused by RuntimeSchemaTooNew
//
// Local workerd has no PITR (`onNextSessionRestoreBookmark` throws), so these tests fake it: scheduling records the
// bookmark and returns an undo bookmark, and the restart (`ctx.abort`) applies `restored` to the database first, the way
// the platform swaps in the database of the bookmark before the next session. What `restored` does stands for that
// bookmark's state; the key-value marker is part of the database, so a real restore rolls it back too (the procedure
// in the PR verifies that on Cloudflare).

interface FakePitr {
  scheduled: string[];
  /** The SQL tables when scheduling ran (after prepare wrote whatever it writes). */
  atSchedule: Record<string, string[]> | null;
}

/** Every SQL table and row of a shard (what "nothing written" means), without the key-value storage. */
const sqlDump = (shard: string) =>
  runInDurableObject(shardStub(shard), (_i: Shard, state) => {
    const out: Record<string, string[]> = {};
    for (const t of state.storage.sql.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray()) {
      out[`${String(t.name)} ${String(t.sql)}`] = state.storage.sql
        .exec(`SELECT * FROM "${String(t.name)}"`)
        .toArray()
        .map((x) => JSON.stringify(x, (_k, v) => (v instanceof ArrayBuffer ? [...new Uint8Array(v)] : v)))
        .sort();
    }
    return out;
  });
const kvMarker = (shard: string) => runInDurableObject(shardStub(shard), (_i: Shard, state) => state.storage.get(AHEAD_MARKER_KEY));

/** Fake PITR on the live instance: `fail` makes scheduling throw; `restored` runs on the restart (null: none applies). */
async function fakePitr(shard: string, o: { fail?: boolean; restored?: ((sql: SqlStorage) => void) | null; keepMarker?: boolean } = {}): Promise<FakePitr> {
  const fake: FakePitr = { scheduled: [], atSchedule: null };
  await runInDurableObject(shardStub(shard), (_i: Shard, state) => {
    const storage = state.storage as unknown as { onNextSessionRestoreBookmark: (b: string) => Promise<string>; get: (k: string) => Promise<unknown>; delete: (k: string) => Promise<boolean> };
    storage.onNextSessionRestoreBookmark = async (b: string) => {
      if (o.fail) throw new Error("boom: scheduling failed");
      fake.scheduled.push(b);
      return UNDO;
    };
    if (o.restored) {
      const restored = o.restored;
      const s = state as unknown as { abort: (reason?: string) => void };
      const abort = s.abort.bind(state);
      s.abort = (reason?: string) => {
        if (!fake.scheduled.length) return abort(reason);
        // Durably before the restart (writes of a turn that aborts are dropped), as the platform's swap would be.
        void (async () => {
          restored(state.storage.sql);
          // The marker is newer than the bookmark: the restored database does not have it.
          if (!o.keepMarker) await storage.delete(AHEAD_MARKER_KEY);
          await state.storage.sync();
          abort(reason);
        })();
      };
    }
  });
  return fake;
}

/** A shard upgraded by a "newer runtime" (runtime schema 6, plus a row of its own), then booted by this one: refused. */
async function aheadShard(shard: string): Promise<string> {
  await api("mutation", { fn: "messages:send", args: { channel: "c", body: "kept" }, shard });
  const target = (await shardStub(shard).bookmarks(shard)).find((b) => b.reason.startsWith("deploy:"))!.bookmark;
  await runInDurableObject(shardStub(shard), (_i: Shard, state) => {
    state.storage.sql.exec("UPDATE _ember_rt_meta SET v = '6' WHERE k = 'rt_schema'");
    state.storage.sql.exec("INSERT INTO _ember_rt_meta(k, v) VALUES ('written_by_newer', 'x')");
  });
  await evictDurableObject(shardStub(shard));
  expect((await shardStub(shard).status(shard)).migrationError).toMatchObject({ code: "RuntimeSchemaTooNew" });
  return target;
}

/** What restoring the `deploy:` bookmark taken before the newer runtime's first boot brings back. */
const toDeployBookmark = (sql: SqlStorage) => {
  sql.exec("UPDATE _ember_rt_meta SET v = '5' WHERE k = 'rt_schema'");
  sql.exec("DELETE FROM _ember_rt_meta WHERE k = 'written_by_newer'");
};

describe("restore of a shard refused by RuntimeSchemaTooNew, from the older runtime", () => {
  const mine = async (shard: string) => (await system().restores()).filter((j) => j.shard === shard);

  it("aheadFinishDecision: the key-value marker tells not scheduled / not restarted / restarted without it / still ahead", () => {
    const info = { nonce: "n1", instance: "i1" };
    expect(aheadFinishDecision({ nonce: "n1", stage: "failed" }, info, "i2")).toBe("not_scheduled");
    expect(aheadFinishDecision({ nonce: "n1", stage: "pending" }, info, "i1")).toBe("not_applied");
    expect(aheadFinishDecision({ nonce: "n1", stage: "pending" }, info, "i2")).toBe("failed");
    expect(aheadFinishDecision(null, info, "i2")).toBe("still_ahead");
    // Another restore's marker (an undo restored with the data, an older attempt): not this nonce's.
    expect(aheadFinishDecision({ nonce: "n0", stage: "pending" }, info, "i1")).toBe("still_ahead");
    expect(aheadFinishDecision({ nonce: "n0", stage: "failed" }, info, "i2")).toBe("still_ahead");
  });

  it("needs discardNewer; with it, restores the deploy bookmark writing nothing into the newer runtime's tables, and the shard serves", async () => {
    const shard = "pitr:ahead-ok";
    const target = await aheadShard(shard);
    const before = await sqlDump(shard);
    const epoch = (await shardStub(shard).inspect()).epoch;

    // Without the flag: refused up front, nothing written, nothing journaled, no marker.
    const refused = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: target, label: "noflag" } });
    expect(refused).toMatchObject({ status: 409, body: { ok: false, error: { code: "RuntimeSchemaTooNew" } } });
    expect(refused.body.error.message).toMatch(/--discard-newer/);
    expect(await mine(shard)).toEqual([]);
    expect(await kvMarker(shard)).toBeUndefined();

    const fake = await fakePitr(shard, { restored: toDeployBookmark });
    const r = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: target, label: "back", discardNewer: true } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, shard, restoredTo: target, undo: UNDO } });
    expect(fake.scheduled).toEqual([target]);
    // Back on runtime tables this runtime understands: serving, the newer runtime's row gone, the marker gone.
    const st = await shardStub(shard).status(shard);
    expect(st).toMatchObject({ ready: true, migrationError: null });
    expect((await api("query", { fn: "messages:list", args: { channel: "c" }, shard })).body.value.map((m: { body: string }) => m.body)).toEqual(["kept"]);
    expect(await kvMarker(shard)).toBeUndefined();
    expect(await mine(shard)).toEqual([]);
    expect((await shardStub(shard).inspect()).epoch).not.toBe(epoch);
    const reasons = (await shardStub(shard).bookmarks(shard)).map((b) => b.reason);
    // No `pre-restore` row (it would have been written into the newer runtime's table): the undo bookmark is that state.
    expect(reasons.filter((x) => /:back$/.test(x))).toEqual(["undo:back", "restore:back"]);
    expect(await runInDurableObject(shardStub(shard), (_i: Shard, state) => state.storage.sql.exec("SELECT v FROM _ember_rt_meta WHERE k = 'written_by_newer'").toArray())).toEqual([]);
    expect(before).toBeTruthy();
  });

  it("a shard no longer ahead after the restart is restored, even if the platform kept the key-value marker", async () => {
    const shard = "pitr:ahead-kv-kept";
    const target = await aheadShard(shard);
    await fakePitr(shard, { restored: toDeployBookmark, keepMarker: true });
    const r = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: target, label: "kept", discardNewer: true } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, undo: UNDO } });
    // Spent: removed by the finish.
    expect(await kvMarker(shard)).toBeUndefined();
    expect(await shardStub(shard).status(shard)).toMatchObject({ ready: true });
  });

  it("prepare writes nothing into the SQL tables; a restart without the restore is a failure, for every later finish", async () => {
    const shard = "pitr:ahead-unapplied";
    const target = await aheadShard(shard);
    const before = await sqlDump(shard);
    // Scheduling "succeeds" but nothing is applied: the abort restarts the object on the same (still ahead) data.
    await fakePitr(shard, { restored: null });
    const r = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: target, label: "noop", discardNewer: true } });
    expect(r).toMatchObject({ status: 500, body: { ok: false, error: { code: "restore_failed", message: expect.stringMatching(/restore_not_scheduled/) } } });
    expect(await sqlDump(shard)).toEqual(before);
    const marker = (await kvMarker(shard)) as { nonce: string; stage: string };
    expect(marker).toMatchObject({ stage: "failed" });
    expect(await mine(shard)).toEqual([]);
    // A late finish of the same nonce (System alarm, Worker retry) keeps failing, and still writes nothing.
    const info = { nonce: marker.nonce, instance: "old", rows: [], undo: UNDO, bookmark: target, label: "noop" };
    expect(await failure(shardStub(shard).restoreFinish(shard, info))).toMatch(/^restore_not_scheduled/);
    expect(await sqlDump(shard)).toEqual(before);
    expect((await shardStub(shard).status(shard)).migrationError).toMatchObject({ code: "RuntimeSchemaTooNew" });
  });

  it("a finish on the instance that scheduled it says not restarted yet", async () => {
    const shard = "pitr:ahead-same";
    const target = await aheadShard(shard);
    await fakePitr(shard, { restored: toDeployBookmark });
    const prepared = await shardStub(shard).restorePrepare(shard, target, "same", { discardNewer: true });
    expect(prepared).toMatchObject({ undo: UNDO });
    expect(prepared.rows.map((b) => b.bookmark)).toContain(target);
    const info = { nonce: prepared.nonce, instance: prepared.instance, rows: prepared.rows, undo: prepared.undo, bookmark: target, label: "same" };
    expect(await failure(shardStub(shard).restoreFinish(shard, info))).toMatch(/^restore_not_applied/);
    expect(await failure(shardStub(shard).restorePrepare(shard, target, "again", { discardNewer: true }))).toMatch(/restore_in_progress/);
    // The System alarm restarts it and finishes: the restore applies.
    await runInDurableObject(system(), (_i, state) => {
      state.storage.sql.exec("UPDATE _ember_restores SET next_at = 0 WHERE nonce = ?", prepared.nonce);
    });
    await runDurableObjectAlarm(system());
    await runInDurableObject(system(), (_i, state) => {
      state.storage.sql.exec("UPDATE _ember_restores SET next_at = 0 WHERE nonce = ?", prepared.nonce);
    });
    await runDurableObjectAlarm(system());
    expect(await mine(shard)).toEqual([]);
    expect((await shardStub(shard).status(shard))).toMatchObject({ ready: true, migrationError: null });
  });

  it("a restore that lands on a bookmark still ahead stays journaled (restore_still_ahead), nothing written", async () => {
    const shard = "pitr:ahead-still";
    const target = await aheadShard(shard);
    const before = await sqlDump(shard);
    // The bookmark was taken under the newer runtime (an `hourly` of it): the restored database is still ahead.
    await fakePitr(shard, { restored: () => {} });
    const r = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: target, label: "still", discardNewer: true } });
    expect(r).toMatchObject({ status: 409, body: { ok: false, error: { code: "restore_still_ahead" }, undo: UNDO, pending: true } });
    expect(await mine(shard)).toEqual([expect.objectContaining({ shard, undo: UNDO, label: "still" })]);
    expect(await sqlDump(shard)).toEqual(before);
  });

  it("a scheduling failure leaves nothing but a failed marker", async () => {
    const shard = "pitr:ahead-boom";
    const target = await aheadShard(shard);
    const before = await sqlDump(shard);
    await fakePitr(shard, { fail: true });
    const r = await admin("/api/_ember/restore", { method: "POST", body: { shard, bookmark: target, label: "boom", discardNewer: true } });
    expect(r).toMatchObject({ status: 500, body: { error: { code: "restore_failed", message: expect.stringMatching(/boom/) } } });
    expect(await kvMarker(shard)).toMatchObject({ stage: "failed" });
    expect(await mine(shard)).toEqual([]);
    expect(await sqlDump(shard)).toEqual(before);
    // `bookmarkNow` stays refused on such a shard.
    expect(await admin("/api/_ember/bookmark", { method: "POST", body: { shard } })).toMatchObject({ status: 409, body: { error: { code: "RuntimeSchemaTooNew" } } });
  });
});
