// Auth integration points of the runtime (with a fake EmberAuthHook; @freecorps/ember-auth's own suite covers Better Auth):
// /api/auth/* passthrough, `sensitive` mutations/actions over HTTP and WebSocket, and the profile-sync outbox.
import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";
import { probes as appProbes } from "./app.ts";
import { probes } from "./worker.ts";

const action = async (body: unknown, token?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await SELF.fetch("http://ember/api/action", { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

describe("auth hook", () => {
  it("serves /api/auth/* through auth.fetch before the 404", async () => {
    expect(await (await SELF.fetch("http://ember/api/auth/get-session")).json()).toEqual({ auth: "get-session" });
    expect((await SELF.fetch("http://ember/api/other")).status).toBe(404);
  });

  it("verify gets the request's waitUntil, in the Worker (HTTP) and in the Shard (hello)", async () => {
    probes.verifyWaitUntil.length = 0;
    expect((await api("query", { fn: "auth:whoami", args: {}, shard: "org:wait-until" }, "good:wu-http")).body.value).toBe("wu-http");
    const c = await connect("org:wait-until");
    try {
      await hello(c, undefined, "good:wu-ws");
    } finally {
      c.close();
    }
    expect(probes.verifyWaitUntil.filter((v) => v.token.startsWith("good:wu-"))).toEqual([
      { token: "good:wu-http", waitUntil: true },
      { token: "good:wu-ws", waitUntil: true },
    ]);
  });

  it("sensitive mutations verify with { sensitive: true }; plain ones do not", async () => {
    const shard = "org:sensitive-http";
    probes.sensitiveVerifies.length = 0;
    const ok = await api("mutation", { fn: "auth:transfer", args: { amount: 5 }, shard }, "good:carol");
    expect(ok).toMatchObject({ status: 200, body: { ok: true, value: { who: "carol", amount: 5 } } });
    expect(probes.sensitiveVerifies).toEqual(["good:carol"]);
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "x" }, shard }, "good:carol");
    expect(probes.sensitiveVerifies).toEqual(["good:carol"]);

    // Signed out: the token still verifies locally (JWT), but the session is gone.
    probes.revoked.add("carol");
    try {
      expect((await api("query", { fn: "auth:whoami", args: {}, shard }, "good:carol")).body.value).toBe("carol");
      const denied = await api("mutation", { fn: "auth:transfer", args: { amount: 5 }, shard }, "good:carol");
      expect(denied).toMatchObject({ status: 401, body: { ok: false, error: { code: "unauthenticated" } } });
      expect((await action({ fn: "auth:wipe", args: {}, shard }, "good:carol")).status).toBe(401);
      // Anonymous callers run the function anonymously (it decides what to allow).
      expect((await api("mutation", { fn: "auth:transfer", args: { amount: 1 }, shard })).body.value).toEqual({ who: null, amount: 1 });
    } finally {
      probes.revoked.delete("carol");
    }
    expect(await action({ fn: "auth:wipe", args: {}, shard }, "good:carol")).toMatchObject({ status: 200, body: { value: "carol" } });
  });

  it("sensitive mutations over a socket re-check the session with the socket's token", async () => {
    const c = await connect("org:sensitive-ws", { token: "good:dave" });
    await hello(c);
    c.send({ t: "mut", mid: 1, fn: "auth:transfer", args: { amount: 2 } });
    expect(await c.waitFor(is("mres", (m) => m.mid === 1))).toMatchObject({ ok: true, value: { who: "dave", amount: 2 } });

    probes.revoked.add("dave");
    try {
      c.send({ t: "mut", mid: 2, fn: "auth:transfer", args: { amount: 2 } });
      expect(await c.waitFor(is("mres", (m) => m.mid === 2))).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
      // Non-sensitive mutations keep working until the JWT expires.
      c.send({ t: "mut", mid: 3, fn: "messages:send", args: { channel: "c", body: "still" } });
      expect(await c.waitFor(is("mres", (m) => m.mid === 3))).toMatchObject({ ok: true });
      // A fresh token for another (live) user via `auth` replaces the stored one.
      c.send({ t: "auth", token: "good:erin" });
      await sleep(20);
      c.send({ t: "mut", mid: 4, fn: "auth:transfer", args: { amount: 3 } });
      expect(await c.waitFor(is("mres", (m) => m.mid === 4))).toMatchObject({ ok: true, value: { who: "erin", amount: 3 } });
    } finally {
      probes.revoked.delete("dave");
      c.close();
    }
  });
});

/** `runInDurableObject` without its stub typing (too deep for these stubs). */
const inDO = runInDurableObject as unknown as <R>(stub: unknown, f: (instance: any, state: DurableObjectState) => R | Promise<R>) => Promise<R>;

describe("auth outbox (internal.users.sync)", () => {
  const box = (name: string) => env.OUTBOX.get(env.OUTBOX.idFromName(name));
  const runs = async (shard: string) =>
    ((await api("query", { fn: "runs:list", args: {}, shard })).body.value as Array<{ label: string }>).map((r) => r.label);

  async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await f();
      if (ok(v) || Date.now() > end) return v;
      await sleep(25);
    }
  }

  it("records changes in the DO and delivers them in order to the target shard", async () => {
    const b = box("in-order");
    await b.change("create", { id: "u1", email: "a@x.test", createdAt: new Date(5), password: "never", org: "o1" });
    await b.change("update", { id: "u1", email: "b@x.test", org: "o1" });
    const labels = await until(() => runs("org:o1"), (l) => l.length === 2);
    expect(labels).toEqual(["create:u1", "update:u1"]);
    expect(await b.outbox()).toEqual([]);
  });

  it("retries with backoff, holds later rows back, then parks a row after maxAttempts", async () => {
    const b = box("retry");
    appProbes.syncFailures = 2;
    await b.change("create", { id: "u2", org: "o2" });
    await b.change("delete", { id: "u2", org: "o2" });
    expect(await until(() => runs("org:o2"), (l) => l.length === 2)).toEqual(["create:u2", "delete:u2"]);
    // One alarm per attempt (fail, fail, deliver both), plus at most one queued by the second change. The delete row
    // waiting behind the failing create used to schedule the alarm in the past, so it spun until the backoff expired.
    expect(probes.outboxAlarms.get("retry")).toBeLessThanOrEqual(4);

    appProbes.syncFailures = 3; // maxAttempts = 3
    await b.change("update", { id: "u3", org: "o3" });
    const parked = await until(() => b.outbox(), (rows) => rows[0]?.dead === 1);
    expect(parked).toMatchObject([{ fn: "users:sync", shard: "org:o3", event: "update", attempts: 3, dead: 1, last_error: expect.stringContaining("sync down") }]);
    expect(await runs("org:o3")).toEqual([]);
    appProbes.syncFailures = 0;
  });

  it("crash gap: a journaled user write whose hook never ran is recovered by the alarm", async () => {
    const b = box("journal") as any;
    // Normal path: the hook consumes the trigger's journal row in the same transaction as the outbox insert.
    await b.writeUser("create", { id: "u7", email: "a@x.test", org: "o7" });
    expect(await until(() => runs("org:o7"), (l) => l.length === 1)).toEqual(["create:u7"]);
    expect(await b.journal()).toEqual([]);
    // Crash between the committed write and the after-hook: only the journal knows.
    await b.writeUser("update", { id: "u7", email: "b@x.test", org: "o7" }, false);
    await b.writeUser("create", { id: "u8", email: "c@x.test", org: "o7" }, false);
    expect((await b.journal()).length).toBe(2);
    // The crash restarts the object; its next activation (in production: any auth request) arms the alarm, and after
    // the grace period the rows become outbox rows carrying the current state.
    await evictDurableObject(b);
    expect((await (box("journal") as any).journal()).length).toBe(2);
    const labels = await until(() => runs("org:o7"), (l) => l.length === 3, 15_000);
    expect(labels).toEqual(["create:u7", "update:u7", "create:u8"]);
    expect(await (box("journal") as any).journal()).toEqual([]);
    // A recovered delete carries just the id.
    await b.writeUser("delete", { id: "u8", org: "o7" }, false);
    await evictDurableObject(box("journal"));
    await (box("journal") as any).journal();
    expect(await until(() => runs("org:o7"), (l) => l.length === 4, 15_000)).toEqual(["create:u7", "update:u7", "create:u8", "delete:u8"]);
  });

  it("profile sync off (the app has no sync function): the journal is dropped and no alarm spins on it", async () => {
    const name = "no-sync";
    const off = () => env.NO_SYNC_BOX.get(env.NO_SYNC_BOX.idFromName(name)) as any;
    // The hook runs and has nothing to send: the trigger's journal row goes with it.
    await off().writeUser("create", { id: "n1", email: "a@x.test" });
    expect(await off().journal()).toEqual([]);
    expect(await off().outbox()).toEqual([]);
    // A write around the hook leaves a row; the next activation arms the alarm for it (the crash-gap path).
    await off().writeUser("update", { id: "n1", email: "b@x.test" }, false);
    expect((await off().journal()).length).toBe(1);
    await evictDurableObject(off());
    expect(await until(() => off().journal(), (rows: unknown[]) => rows.length === 0, 15_000)).toEqual([]);
    // That alarm was the last one: nothing is left to come back for.
    const alarms = probes.outboxAlarms.get(name) ?? 0;
    expect(alarms).toBeGreaterThanOrEqual(1);
    await sleep(500);
    expect(probes.outboxAlarms.get(name)).toBe(alarms);
    expect(await off().outbox()).toEqual([]);
  });

  it("the outbox table exists when the object starts: the hook runs no DDL", async () => {
    const b = box("no-ddl");
    const statements = await inDO(b, async (instance, state): Promise<string[]> => {
      const sql = state.storage.sql as unknown as { exec: (q: string, ...a: unknown[]) => { toArray(): unknown[] } };
      expect(sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_ember_outbox'`).toArray()).toHaveLength(1);
      const exec = sql.exec;
      const seen: string[] = [];
      sql.exec = function (this: unknown, q: string, ...a: unknown[]) {
        seen.push(q);
        return exec.call(this, q, ...a);
      };
      try {
        await instance.change("create", { id: "d1", org: "ddl" });
      } finally {
        sql.exec = exec;
      }
      return seen;
    });
    expect(statements.some((q) => /^\s*CREATE/i.test(q))).toBe(false);
    expect(statements.some((q) => q.startsWith("INSERT INTO _ember_outbox"))).toBe(true);
    expect(await until(() => runs("org:ddl"), (l) => l.length === 1)).toEqual(["create:d1"]);
  });

  it("an outbox table with the old UNIQUE index on key is rebuilt without it once, rows kept", async () => {
    const name = "legacy-unique";
    const b = box(name);
    const index = (s: DurableObjectStorage): unknown[] => s.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '_ember_outbox'`).toArray();
    expect(await inDO(b, (_i, state) => index(state.storage))).toEqual([]);
    // What an older runtime created: `key TEXT NOT NULL UNIQUE`, with a parked row in it.
    await inDO(b, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE _ember_outbox");
      sql.exec(`CREATE TABLE _ember_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, fn TEXT NOT NULL, shard TEXT NOT NULL,
        event TEXT NOT NULL, args TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        dead INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL)`);
      sql.exec(`INSERT INTO _ember_outbox (seq, key, fn, shard, event, args, attempts, next_at, dead, last_error, created_at) VALUES (7, 'k', 'users:sync', 'org:x', 'create', '{}', 10, 0, 1, 'down', 1)`);
      expect(index(state.storage)).toHaveLength(1);
    });
    await evictDurableObject(b);
    const after = box(name);
    expect(await inDO(after, (_i, state) => index(state.storage))).toEqual([]);
    expect(await (after as any).outbox()).toEqual([{ seq: 7, key: "k", fn: "users:sync", shard: "org:x", event: "create", attempts: 10, next_at: 0, dead: 1, last_error: "down" }]);
  });

  it("a redelivered row (same key) is applied once by the shard", async () => {
    const shard = "org:dedup";
    const s = shardStub(shard);
    const args = { event: "create", user: { id: "u4" }, key: "create:u4:k" };
    const first = await s.mutation(shard, "users:sync", args, null, true, { dedupKey: args.key });
    const again = await s.mutation(shard, "users:sync", args, null, true, { dedupKey: args.key });
    expect(again).toEqual(first);
    expect(await runs(shard)).toEqual(["create:u4"]);
    // A failed attempt is not remembered: the retry runs again.
    appProbes.syncFailures = 1;
    const k2 = { ...args, key: "update:u4:k", event: "update" };
    expect((await s.mutation(shard, "users:sync", k2, null, true, { dedupKey: k2.key })).ok).toBe(false);
    expect((await s.mutation(shard, "users:sync", k2, null, true, { dedupKey: k2.key })).ok).toBe(true);
    expect(await runs(shard)).toEqual(["create:u4", "update:u4"]);
  });
});
