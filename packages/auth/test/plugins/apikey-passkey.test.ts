/**
 * apiKey and passkey through the Ember Worker (`/api/auth/*` → Auth DO), and what Ember's `ctx.auth` makes of them.
 */
import { describe, expect, it } from "vitest";
import { Authenticator } from "./fakes.ts";
import { claimsOf, Client, jwtOf, ORIGIN, query, signedUp, socket, whoami } from "./helpers.ts";
import { auth } from "./worker.ts";

describe("apiKey", () => {
  it("create, verify, use as a session, exchange for an Ember JWT, revoke", async () => {
    const { c, user, sessionToken } = await signedUp("ak");
    const created = await c.req("/api/auth/api-key/create", { body: { name: "ci" } });
    expect(created.status, created.text).toBe(200);
    const key = created.json.key as string;
    const keyId = created.json.id as string;

    // Server-side verification (what an app's own endpoint would call).
    expect(await auth.api("verifyApiKey", { body: { key } })).toMatchObject({ ok: true, value: { valid: true, key: { id: keyId } } });
    expect(await auth.api("verifyApiKey", { body: { key: key + "x" } })).toMatchObject({ ok: true, value: { valid: false } });

    // `enableSessionForAPIKeys`: Better Auth answers a session for the `x-api-key` header.
    const gs = await new Client().req("/api/auth/get-session", { headers: { "x-api-key": key } });
    expect(gs.json?.user?.id).toBe(user.id);

    // Ember's identity: the key is exchanged for the usual 5 min JWT, which `ctx.auth` verifies locally.
    const jwt = await jwtOf(new Client(), { "x-api-key": key });
    expect(claimsOf(jwt).sub).toBe(user.id);
    expect((await whoami(jwt))?.subject).toBe(user.id);
    // With `emberAuth(..., { apiKeys: true })` the key itself is accepted as a bearer token, looked up in the Auth DO
    // on every call; a `sensitive` check of the minted JWT (its `sid` is the key id) finds the key.
    expect(claimsOf(jwt).sid).toBe(keyId);
    expect(await auth.verifyDetailed(jwt, { sensitive: true })).toMatchObject({ via: "session", identity: { subject: user.id } });
    expect(await auth.verifyDetailed(key, { sensitive: true })).toMatchObject({ via: "session", identity: { subject: user.id } });
    const direct = await auth.verifyDetailed(key);
    expect(direct).toMatchObject({ via: "session", identity: { subject: user.id } });
    expect((await whoami(key))?.subject).toBe(user.id);
    expect(await whoami(key + "x")).toBeNull();
    // Session tokens still go to the bearer plugin (one lookup per bearer, routed by shape): signed, as
    // `set-auth-token` hands them out, and raw. A miss of either shape is not retried as the other.
    const rawSession = sessionToken.split(".")[0]!;
    expect(rawSession).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(key).not.toMatch(/^[A-Za-z0-9]{32}(?:$|[.%])/);
    expect(await auth.verifyDetailed(sessionToken, { sensitive: true })).toMatchObject({ via: "session", identity: { subject: user.id } });
    expect(await auth.verifyDetailed(rawSession, { sensitive: true })).toMatchObject({ via: "session", identity: { subject: user.id } });
    expect(await auth.verify(rawSession.replace(/.$/, (ch) => (ch === "a" ? "b" : "a")))).toBeNull();
    expect(await auth.verify(key.slice(0, 32))).toBeNull();

    // Revoke: the key stops working at once, as a session and as a bearer; a JWT minted from it lives until exp.
    expect((await c.req("/api/auth/api-key/delete", { body: { keyId } })).status).toBe(200);
    expect((await new Client().req("/api/auth/get-session", { headers: { "x-api-key": key } })).json?.user).toBeUndefined();
    expect(await auth.verify(key)).toBeNull();
    expect(await whoami(key)).toBeNull();
    expect((await whoami(jwt))?.subject).toBe(user.id);
    expect(await auth.verify(jwt, { sensitive: true })).toBeNull();
  });
});

describe("passkey", () => {
  it("registration and authentication ceremonies with a software ES256 authenticator; the session gets an Ember JWT", async () => {
    const { c, user, email } = await signedUp("pk", "Passkey User");
    const authenticator = new Authenticator(ORIGIN, "localhost");

    const regOpts = await c.req("/api/auth/passkey/generate-register-options");
    expect(regOpts.status, regOpts.text).toBe(200);
    expect(regOpts.json.rp).toMatchObject({ id: "localhost" });
    const registration = await authenticator.register(regOpts.json);
    const reg = await c.req("/api/auth/passkey/verify-registration", { body: { response: registration, name: "laptop" } });
    expect(reg.status, reg.text).toBe(200);
    const list = await c.req("/api/auth/passkey/list-user-passkeys");
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ name: "laptop", userId: user.id });

    // A fresh device: no cookie, no password.
    const device = new Client();
    const authOpts = await device.req("/api/auth/passkey/generate-authenticate-options");
    expect(authOpts.status, authOpts.text).toBe(200);
    const assertion = await authenticator.authenticate(authOpts.json);
    const signedIn = await device.req("/api/auth/passkey/verify-authentication", { body: { response: assertion } });
    expect(signedIn.status, signedIn.text).toBe(200);
    expect((await device.req("/api/auth/get-session")).json.user.email).toBe(email);
    const jwt = await jwtOf(device);
    expect(await whoami(jwt)).toMatchObject({ subject: user.id, claims: { email } });

    // A replayed assertion (same challenge, same counter) is refused.
    const replay = await new Client().req("/api/auth/passkey/verify-authentication", { body: { response: assertion } });
    expect(replay.status).toBeGreaterThanOrEqual(400);

    // Signing out of that device: the app's session hook revokes the session's sockets on the shard (authExpired),
    // and the same JWT is refused there afterwards.
    const ws = await socket(jwt);
    expect(ws.snap).toMatchObject({ value: { subject: user.id } });
    expect((await device.req("/api/auth/sign-out", { body: {} })).status).toBe(200);
    await ws.waitFor("authExpired");
    expect((await query("app:whoami", {}, jwt)).body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    ws.close();
  });
});
