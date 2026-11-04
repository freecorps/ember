// Auth integration points of the runtime (with a fake EmberAuthHook; @ember/auth's own suite covers Better Auth):
// /api/auth/* passthrough, `sensitive` mutations/actions over HTTP and WebSocket, and the profile-sync outbox.
import { env, SELF } from "cloudflare:test";
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

    appProbes.syncFailures = 3; // maxAttempts = 3
    await b.change("update", { id: "u3", org: "o3" });
    const parked = await until(() => b.outbox(), (rows) => rows[0]?.dead === 1);
    expect(parked).toMatchObject([{ fn: "users:sync", shard: "org:o3", event: "update", attempts: 3, dead: 1, last_error: expect.stringContaining("sync down") }]);
    expect(await runs("org:o3")).toEqual([]);
    appProbes.syncFailures = 0;
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
