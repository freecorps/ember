// Remote auth during a migration (PLAN §22 L14): the shard accepts another backend's JWTs through the real
// `remoteAuth`, and a `sensitive` mutation runs only when that backend's session lookup says the session is alive,
// over HTTP and over a socket. The admin side: `revoke-sockets` without a local Auth DO, `no_local_auth` naming the
// origin.
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_FEATURES, handleAdminApi, noLocalAuth, type AdminDeps } from "../src/admin-api.ts";
import { api, connect, hello, is, sleep } from "./helpers.ts";
import { config, probes, remote, REMOTE_KEY, REMOTE_ORIGIN } from "./worker.ts";

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/** An EdDSA JWT of the origin backend (what its auth would issue after a sign-in). */
async function originJwt(sub: string, sid: string, ttlS = 300): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", REMOTE_KEY, { name: "Ed25519" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "EdDSA", kid: "origin-1", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: REMOTE_ORIGIN, sub, sid, iat: now, exp: now + ttlS }));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const admin = (path: string, body?: unknown) =>
  SELF.fetch(`http://ember/api/_ember/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

afterEach(() => {
  probes.originSessions.clear();
  probes.originLookups.length = 0;
});

describe("remoteAuth with session lookup (L14)", () => {
  it("HTTP: a sensitive mutation with the origin's JWT runs when the origin says active, 401 when it says inactive", async () => {
    const shard = "remote:http";
    const token = await originJwt("ana", "sess-a");
    probes.originSessions.set("sess-a", true);
    const ok = await api("mutation", { fn: "auth:transfer", args: { amount: 7 }, shard }, token);
    expect(ok).toMatchObject({ status: 200, body: { ok: true, value: { who: "ana", amount: 7 } } });
    expect(probes.originLookups).toEqual(["sess-a"]);
    // Plain functions never ask the origin.
    expect((await api("mutation", { fn: "messages:send", args: { channel: "c", body: "x" }, shard }, token)).body.ok).toBe(true);
    expect(probes.originLookups).toEqual(["sess-a"]);

    // Signed out at the origin: the JWT is still valid for 5 minutes, but sensitive calls stop now.
    probes.originSessions.set("sess-a", false);
    const denied = await api("mutation", { fn: "auth:transfer", args: { amount: 7 }, shard }, token);
    expect(denied).toMatchObject({ status: 401, body: { ok: false, error: { code: "unauthenticated" } } });
    expect((await api("query", { fn: "auth:whoami", args: {}, shard }, token)).body.value).toBe("ana");
  });

  it("socket: a sensitive mutation re-checks the session at the origin with the socket's token", async () => {
    const token = await originJwt("bia", "sess-b");
    probes.originSessions.set("sess-b", true);
    const c = await connect("remote:ws");
    await hello(c, crypto.randomUUID(), token);
    c.send({ t: "mut", mid: 1, fn: "auth:transfer", args: { amount: 2 } });
    expect(await c.waitFor(is("mres", (m) => m.mid === 1))).toMatchObject({ ok: true, value: { who: "bia", amount: 2 } });
    probes.originSessions.set("sess-b", false);
    c.send({ t: "mut", mid: 2, fn: "auth:transfer", args: { amount: 2 } });
    expect(await c.waitFor(is("mres", (m) => m.mid === 2))).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    c.send({ t: "mut", mid: 3, fn: "messages:send", args: { channel: "c", body: "still" } });
    expect(await c.waitFor(is("mres", (m) => m.mid === 3))).toMatchObject({ ok: true });
    expect(probes.originLookups.filter((s) => s === "sess-b").length).toBeGreaterThanOrEqual(2);
    c.close();
  });

  it("admin revoke-sockets (no local Auth DO needed): the origin's session-end hook cuts the session's sockets", async () => {
    expect(ADMIN_FEATURES).toContain("auth/revoke-sockets");
    const shard = "remote:revoke";
    const token = await originJwt("caio", "sess-c");
    const c = await connect(shard);
    await hello(c, crypto.randomUUID(), token);
    c.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "c" } });
    await c.waitFor(is("snap"));
    const r = await admin("auth/revoke-sockets", { match: { claim: "sid", value: "sess-c" }, shards: [shard] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, value: { sockets: 1, shards: 1 } });
    await c.waitFor(is("authExpired"));
    // The same unexpired JWT is refused on this shard for a while (it was issued before the revocation).
    await sleep(10);
    const again = await api("query", { fn: "auth:whoami", args: {}, shard }, token);
    expect(again.body).toMatchObject({ ok: false, error: { code: "unauthenticated", message: "access revoked: sign in again" } });
    c.close();

    for (const bad of [{}, { match: { claim: "sid", value: "x" } }, { match: { nope: 1 }, shards: [shard] }, { match: { subject: "u" }, shards: [] }]) {
      expect([JSON.stringify(bad), (await admin("auth/revoke-sockets", bad)).status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect((await admin("auth/revoke-sockets", { match: { subject: "u" }, shards: ["not a shard"] })).status).toBe(400);
    expect((await admin("auth/revoke-sockets")).status).toBe(405);
  });

  it("revoke-sockets answers 502 when no shard answered (partial failure stays 200 with `failed`)", async () => {
    const down = new Set(["remote:a", "remote:b"]);
    const deps = {
      config,
      env: {},
      json: (b: unknown, status = 200) => Response.json(b, { status }),
      error: (status: number, code: string, message: string) => Response.json({ ok: false, error: { code, message } }, { status }),
      validShard: () => true,
      revokeSockets: async (s: string) => {
        if (down.has(s)) throw new Error("unreachable");
        return { sockets: 2 };
      },
    } as unknown as AdminDeps;
    const call = (shards: string[]) => {
      const url = "http://ember/api/_ember/auth/revoke-sockets";
      return handleAdminApi(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ match: { subject: "u" }, shards }) }), new URL(url), deps);
    };
    const all = (await call(["remote:a", "remote:b"]))!;
    expect(all.status).toBe(502);
    expect(((await all.json()) as { error: { code: string } }).error.code).toBe("unreachable");
    const some = (await call(["remote:a", "remote:c"]))!;
    expect(some.status).toBe(200);
    expect(await some.json()).toEqual({ ok: true, value: { sockets: 2, shards: 2, failed: ["remote:a"] } });
  });

  it("no_local_auth names the origin; capabilities carry it as authFrom", async () => {
    // The Worker above has no `remote` on its hook (a fake): the endpoints themselves, with remoteAuth's hook.
    const remoteConfig = { ...config, auth: { verify: remote.verify, remote: remote.remote } };
    const deps = {
      config: remoteConfig,
      env: {},
      json: (b: unknown, status = 200) => Response.json(b, { status }),
      error: (status: number, code: string, message: string) => Response.json({ ok: false, error: { code, message } }, { status }),
    } as unknown as AdminDeps;
    const users = (await handleAdminApi(new Request("http://ember/api/_ember/auth/users"), new URL("http://ember/api/_ember/auth/users"), deps))!;
    expect(users.status).toBe(404);
    expect(((await users.json()) as { error: unknown }).error).toEqual({
      code: "no_local_auth",
      message: "auth is handled by https://origin.test: users, sessions, revocation and key rotation live there (remote auth, no local Auth DO)",
    });
    expect(noLocalAuth(remoteConfig, "nothing to rotate")).toMatch(/^auth is handled by https:\/\/origin\.test/);
    const { auth: _none, ...noAuth } = config;
    expect(noLocalAuth(noAuth, "nothing to rotate")).toBe("this deployment has no local Auth DO (no auth configured): nothing to rotate");
    const caps = (await handleAdminApi(new Request("http://ember/api/_ember/capabilities"), new URL("http://ember/api/_ember/capabilities"), deps))!;
    expect(await caps.json()).toMatchObject({ auth: false, authFrom: REMOTE_ORIGIN });
    // This deployment's own Worker (fake hook, no `remote`): no authFrom.
    expect(await (await admin("capabilities")).json()).not.toHaveProperty("authFrom");
  });
});
