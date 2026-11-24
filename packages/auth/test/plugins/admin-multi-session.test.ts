/**
 * admin and multiSession (`better-auth/plugins`) through the Ember Worker: what an admin does to a user reaches the
 * user's Ember identity (bans end the sockets, impersonation is an Ember JWT of the user with the admin in `act`),
 * and the active account of a multi-account browser is the one `/token` signs.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authTablesManifest } from "../../src/codegen.ts";
import config from "./auth.config.ts";
import { claimsOf, Client, jwtOf, ORIGIN, password, profilesUntil, query, rnd, signedIn, signedUp, socket, whoami } from "./helpers.ts";
import { auth } from "./worker.ts";

const userTable = authTablesManifest(config, { project: "plug" }).find((t) => t.model === "user")!;
const roleColumn = userTable.fields.find((f) => f.name === "role")!.column;

/** An admin's browser. The first admin of an app is set in the database (here: straight in the Auth DO's SQLite). */
async function adminBrowser() {
  const { user, email } = await signedUp("admin", "Admin");
  await runInDurableObject(env.AUTH.get(env.AUTH.idFromName("auth")), (_o, state) => {
    state.storage.sql.exec(`UPDATE "${userTable.table}" SET "${roleColumn}" = 'admin' WHERE "id" = ?`, user.id);
  });
  // A new session: the old one's cookie cache still says "user".
  const { c, r } = await signedIn(email);
  expect(r.status, r.text).toBe(200);
  return { c, user };
}

const unauthenticated = { ok: false, error: { code: "unauthenticated" } };

describe("admin", () => {
  it("list users; ban (sessions and sockets end, sign-in refused after the Worker checked the password), unban", async () => {
    const admin = await adminBrowser();
    const target = await signedUp("banned", "Target");

    const list = await admin.c.req(`/api/auth/admin/list-users?searchField=email&searchValue=${encodeURIComponent(target.email)}`);
    expect(list.status, list.text).toBe(200);
    expect(list.json.users.map((u: { id: string }) => u.id)).toEqual([target.user.id]);
    // Not for regular users.
    expect((await target.c.req("/api/auth/admin/list-users")).status).toBe(403);

    const jwt = await jwtOf(target.c);
    const ws = await socket(jwt);
    expect(ws.snap).toMatchObject({ value: { subject: target.user.id } });
    const ban = await admin.c.req("/api/auth/admin/ban-user", { body: { userId: target.user.id, banReason: "spam" } });
    expect(ban.status, ban.text).toBe(200);
    // Every session of the user is deleted through the hooks: the app's session hook revokes each `sid`.
    await ws.waitFor("authExpired");
    ws.close();
    expect((await query("app:whoami", {}, jwt)).body).toMatchObject(unauthenticated);
    expect((await target.c.req("/api/auth/token")).status).toBe(401);

    const before = auth.workerStats().workerVerifies;
    const refused = await signedIn(target.email);
    expect(refused.r.status).toBe(403);
    expect(refused.r.json).toMatchObject({ code: "BANNED_USER" });
    expect(auth.workerStats().workerVerifies).toBe(before + 1);
    await profilesUntil(target.user.id, (p) => p.some((x) => x.event === "update" && x.user.banned === true && x.user.banReason === "spam"));

    expect((await admin.c.req("/api/auth/admin/unban-user", { body: { userId: target.user.id } })).status).toBe(200);
    const back = await signedIn(target.email);
    expect(back.r.status, back.r.text).toBe(200);
    expect((await whoami(await jwtOf(back.c)))?.subject).toBe(target.user.id);
  });

  it("impersonate → an Ember JWT of the user with the admin as `act`; stop impersonating ends that session", async () => {
    const admin = await adminBrowser();
    const target = await signedUp("impersonated", "Target");

    const imp = await admin.c.req("/api/auth/admin/impersonate-user", { body: { userId: target.user.id } });
    expect(imp.status, imp.text).toBe(200);
    expect(imp.json.session.impersonatedBy).toBe(admin.user.id);
    const jwt = await jwtOf(admin.c);
    expect(claimsOf(jwt)).toMatchObject({ sub: target.user.id, act: { sub: admin.user.id } });
    expect(await whoami(jwt)).toMatchObject({ subject: target.user.id, claims: { act: { sub: admin.user.id }, email: target.email } });
    // The impersonation session is hidden from the user's own session list.
    const own = await target.c.req("/api/auth/list-sessions");
    expect(own.json.some((s: { impersonatedBy?: string }) => s.impersonatedBy)).toBe(false);

    const ws = await socket(jwt);
    const stop = await admin.c.req("/api/auth/admin/stop-impersonating", { body: {} });
    expect(stop.status, stop.text).toBe(200);
    await ws.waitFor("authExpired");
    ws.close();
    expect((await query("app:whoami", {}, jwt)).body).toMatchObject(unauthenticated);
    const mine = await jwtOf(admin.c);
    expect(claimsOf(mine).act).toBeUndefined();
    expect((await whoami(mine))?.subject).toBe(admin.user.id);
  });

  it("set role and remove user reach the profile outbox; a removed user's sockets end", async () => {
    const admin = await adminBrowser();
    const target = await signedUp("removed", "Target");
    const role = await admin.c.req("/api/auth/admin/set-role", { body: { userId: target.user.id, role: "admin" } });
    expect(role.status, role.text).toBe(200);
    await profilesUntil(target.user.id, (p) => p.some((x) => x.event === "update" && x.user.role === "admin"));

    const ws = await socket(await jwtOf(target.c));
    const rm = await admin.c.req("/api/auth/admin/remove-user", { body: { userId: target.user.id } });
    expect(rm.status, rm.text).toBe(200);
    await ws.waitFor("authExpired");
    ws.close();
    expect(await auth.stub().userForSync(target.user.id)).toBeNull();
    await profilesUntil(target.user.id, (p) => p.at(-1)?.event === "delete");
    expect((await signedIn(target.email)).r.status).toBe(401);
  });

  it("create-user and set-user-password over HTTP are hashed in the Worker (strictHashing)", async () => {
    const admin = await adminBrowser();
    const email = `created-${rnd()}@example.test`;
    const hashes = auth.workerStats().workerHashes;
    const created = await admin.c.req("/api/auth/admin/create-user", { body: { email, password, name: "Created", role: "user" } });
    expect(created.status, created.text).toBe(200);
    const id = created.json.user.id as string;
    const reset = await admin.c.req("/api/auth/admin/set-user-password", { body: { userId: id, newPassword: "another long passphrase" } });
    expect(reset.status, reset.text).toBe(200);
    expect(auth.workerStats().workerHashes).toBe(hashes + 2);
    expect((await signedIn(email, "another long passphrase")).r.status).toBe(200);
  });
});

describe("multiSession", () => {
  it("two accounts in one browser: list, set active → /token signs the active one, revoke one", async () => {
    const browser = new Client();
    const accounts: { id: string; email: string }[] = [];
    for (const name of ["Alice", "Bob"]) {
      const email = `multi-${name.toLowerCase()}-${rnd()}@example.test`;
      const r = await browser.req("/api/auth/sign-up/email", { body: { email, password, name } });
      expect(r.status, r.text).toBe(200);
      accounts.push({ id: r.json.user.id, email });
    }
    const [alice, bob] = accounts as [{ id: string; email: string }, { id: string; email: string }];
    expect([...browser.jar.keys()].filter((k) => k.startsWith("plug.session_token_multi-"))).toHaveLength(2);

    const list = await browser.req("/api/auth/multi-session/list-device-sessions");
    expect(list.status, list.text).toBe(200);
    const sessions = list.json as { session: { token: string }; user: { id: string } }[];
    expect(sessions.map((s) => s.user.id).sort()).toEqual([alice.id, bob.id].sort());
    const tokenOf = (id: string) => sessions.find((s) => s.user.id === id)!.session.token;

    // The last sign-up is active.
    expect((await whoami(await jwtOf(browser)))?.subject).toBe(bob.id);
    const bobJwt = await jwtOf(browser);

    const active = await browser.req("/api/auth/multi-session/set-active", { body: { sessionToken: tokenOf(alice.id) } });
    expect(active.status, active.text).toBe(200);
    const aliceJwt = await jwtOf(browser);
    expect(await whoami(aliceJwt)).toMatchObject({ subject: alice.id, claims: { email: alice.email } });
    // The Worker's own view of the browser (the cookie cache set-active rewrote, then the session cookie) agrees.
    const cookieOnly = new Request(`${ORIGIN}/`, { headers: { cookie: browser.cookieHeader() } });
    expect(await auth.verifyRequestDetailed(cookieOnly)).toMatchObject({ via: "cookie-cache", identity: { subject: alice.id } });
    const noCache = new Request(`${ORIGIN}/`, { headers: { cookie: browser.cookieHeader().replace(/plug\.session_data=[^;]*(; )?/, "") } });
    expect(await auth.verifyRequestDetailed(noCache)).toMatchObject({ via: "session", identity: { subject: alice.id } });

    // Revoke Alice's session: her socket ends; the browser falls back to Bob.
    const ws = await socket(aliceJwt);
    const revoke = await browser.req("/api/auth/multi-session/revoke", { body: { sessionToken: tokenOf(alice.id) } });
    expect(revoke.status, revoke.text).toBe(200);
    await ws.waitFor("authExpired");
    ws.close();
    expect((await query("app:whoami", {}, aliceJwt)).body).toMatchObject(unauthenticated);
    expect((await whoami(await jwtOf(browser)))?.subject).toBe(bob.id);
    expect((await whoami(bobJwt))?.subject).toBe(bob.id);
    const after = await browser.req("/api/auth/multi-session/list-device-sessions");
    expect(after.json.map((s: { user: { id: string } }) => s.user.id)).toEqual([bob.id]);
  });
});
