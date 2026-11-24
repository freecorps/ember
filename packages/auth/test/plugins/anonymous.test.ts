/**
 * anonymous (`better-auth/plugins`): a guest gets an Ember identity at once, and keeps nothing of it after linking a
 * real account (the plugin deletes the anonymous user; its sockets end with its sessions).
 */
import { describe, expect, it } from "vitest";
import { linkedAccounts } from "./auth.config.ts";
import { claimsOf, Client, jwtOf, password, profilesUntil, query, rnd, signedUp, socket, whoami } from "./helpers.ts";
import { auth } from "./worker.ts";

async function guest() {
  const c = new Client();
  const r = await c.req("/api/auth/sign-in/anonymous", { body: {} });
  expect(r.status, r.text).toBe(200);
  const user = r.json.user as { id: string; email: string; isAnonymous: boolean };
  return { c, user };
}

describe("anonymous", () => {
  it("anonymous sign-in → Ember JWT (with the app's `anon` claim) → ctx.auth; a second anonymous sign-in is refused", async () => {
    const { c, user } = await guest();
    expect(user.isAnonymous).toBe(true);
    expect(user.email).toMatch(/^temp-.+@anon\.ember\.test$/);
    const jwt = await jwtOf(c);
    expect(claimsOf(jwt)).toMatchObject({ sub: user.id, anon: true });
    expect(await whoami(jwt)).toMatchObject({ subject: user.id, claims: { anon: true, email: user.email } });
    expect((await c.req("/api/auth/sign-in/anonymous", { body: {} })).status).toBe(400);
    const profiles = await profilesUntil(user.id, (p) => p.some((x) => x.event === "create"));
    expect(profiles[0]!.user).toMatchObject({ isAnonymous: true });
  });

  it("linking by sign-up: onLinkAccount, the anonymous user deleted, its socket revoked, outbox create → delete", async () => {
    const { c, user: anon } = await guest();
    const anonJwt = await jwtOf(c);
    const ws = await socket(anonJwt);
    expect(ws.snap).toMatchObject({ value: { subject: anon.id } });
    await profilesUntil(anon.id, (p) => p.some((x) => x.event === "create"));

    // Same browser (the anonymous session cookie rides along); the Worker hashes the password as for any sign-up.
    const email = `linked-${rnd()}@example.test`;
    const up = await c.req("/api/auth/sign-up/email", { body: { email, password, name: "Was Anonymous" } });
    expect(up.status, up.text).toBe(200);
    const real = up.json.user as { id: string };
    expect(real.id).not.toBe(anon.id);
    expect(linkedAccounts).toContainEqual({ anonymousUserId: anon.id, newUserId: real.id });

    // The anonymous user is gone with its sessions: the session hook revoked its socket, and its JWT is refused.
    expect(await auth.stub().userForSync(anon.id)).toBeNull();
    await ws.waitFor("authExpired");
    expect((await query("app:whoami", {}, anonJwt)).body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    ws.close();

    // The browser now holds the real account's session: a plain JWT, no `anon` claim.
    const jwt = await jwtOf(c);
    expect(claimsOf(jwt).anon).toBeUndefined();
    expect(await whoami(jwt)).toMatchObject({ subject: real.id, claims: { email } });

    // Profiles: the guest was created then deleted; the real account was created.
    const anonProfiles = await profilesUntil(anon.id, (p) => p.some((x) => x.event === "delete"));
    // In write order: created, then stripe's customer id (its own `user.create.after`), then deleted.
    expect(anonProfiles.map((p) => p.event)).toEqual(["create", "update", "delete"]);
    await profilesUntil(real.id, (p) => p.some((x) => x.event === "create" && x.user.isAnonymous === false));
  });

  it("linking by sign-in to an existing account (the Worker verifies the password); delete-anonymous-user", async () => {
    const existing = await signedUp("anon-target", "Existing");
    const { c, user: anon } = await guest();
    const signIn = await c.req("/api/auth/sign-in/email", { body: { email: existing.email, password } });
    expect(signIn.status, signIn.text).toBe(200);
    expect(linkedAccounts).toContainEqual({ anonymousUserId: anon.id, newUserId: existing.user.id });
    expect(await auth.stub().userForSync(anon.id)).toBeNull();
    expect((await whoami(await jwtOf(c)))?.subject).toBe(existing.user.id);

    // A guest who leaves: deletes itself (sessions first, through the hooks: its socket ends).
    const leaving = await guest();
    const ws = await socket(await jwtOf(leaving.c));
    const del = await leaving.c.req("/api/auth/delete-anonymous-user", { body: {} });
    expect(del.status, del.text).toBe(200);
    await ws.waitFor("authExpired");
    ws.close();
    expect(await auth.stub().userForSync(leaving.user.id)).toBeNull();
    await profilesUntil(leaving.user.id, (p) => p.some((x) => x.event === "delete"));
    // A real user cannot use it.
    expect((await existing.c.req("/api/auth/delete-anonymous-user", { body: {} })).status).toBe(403);
  });
});
