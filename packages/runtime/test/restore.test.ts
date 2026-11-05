// Point-in-time recovery plumbing (restore.ts): bookmark rows per deploy / migration / on demand, the admin
// endpoints, and the restore flow up to what local workerd supports.
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Shard } from "../src/shard.ts";
import { api, shardStub } from "./helpers.ts";

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
    expect(first.body.bookmarks.map((b: any) => b.reason)).toEqual(["migrate"]);
    expect(first.body.bookmarks[0].bookmark).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]+$/);

    const made = await admin("/api/_ember/bookmark", { method: "POST", body: { shard, label: "before-import" } });
    expect(made.status).toBe(200);
    expect(made.body.bookmark).toMatchObject({ reason: "manual:before-import" });
    const after = await admin(`/api/_ember/bookmarks?shard=${shard}`);
    expect(after.body.bookmarks.map((b: any) => b.reason)).toEqual(["migrate", "manual:before-import"]);

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
    expect(rows.map((r) => r.reason)).toEqual(["migrate", "deploy:test-version-1"]);
    // Same version again: nothing new.
    await evictDurableObject(shardStub(shard));
    expect((await shardStub(shard).bookmarks(shard)).length).toBe(2);
  });

  it("restoreFinish re-imports rolled-back rows, records the undo bookmark and starts a new epoch", async () => {
    const shard = "pitr:finish";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "x" }, shard });
    const stub = shardStub(shard);
    const before = await stub.inspect();
    const rows = await stub.bookmarks(shard);
    const later = { id: rows[0]!.id + 10, at: Date.now(), bookmark: rows[0]!.bookmark, reason: "hourly" };
    const undo = "00000001-ffffffff-00005119-0123456789abcdef0123456789abcdef";
    const out = await stub.restoreFinish(shard, { rows: [...rows, later], undo, bookmark: rows[0]!.bookmark, label: "t1" });
    expect(out.epoch).not.toBe(before.epoch);
    const reasons = (await stub.bookmarks(shard)).map((r) => r.reason);
    expect(reasons.slice(0, 2)).toEqual(["migrate", "hourly"]);
    expect(reasons).toContain("undo:t1");
    expect(reasons[reasons.length - 1]).toBe("restore:t1");
    expect((await stub.bookmarks(shard)).find((r) => r.reason === "undo:t1")?.bookmark).toBe(undo);
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
