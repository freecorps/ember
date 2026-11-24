/**
 * Plugins of `better-auth/plugins` around sessions and tokens: customSession (the app's public session shape),
 * oneTimeToken, deviceAuthorization (RFC 8628), lastLoginMethod, haveIBeenPwned and openAPI.
 */
import { describe, expect, it } from "vitest";
import { DEVICE_CLIENT, ember } from "./auth.config.ts";
import { PWNED, outbound, pwned } from "./fakes.ts";
import { claimsOf, Client, jwtOf, ORIGIN, password, profilesUntil, query, rnd, signedIn, signedUp, sleep, socket, whoami } from "./helpers.ts";
import { auth } from "./worker.ts";

const unauthenticated = { ok: false, error: { code: "unauthenticated" } };

describe("customSession", () => {
  it("get-session answers the app's shape; set-auth-jwt, the cookie cache and Ember's own lookups are unaffected", async () => {
    const { c, user, email, sessionToken } = await signedUp("custom", "Custom");
    const gs = await c.req("/api/auth/get-session");
    expect(gs.status, gs.text).toBe(200);
    expect(gs.json).toMatchObject({ greeting: "hello Custom", user: { id: user.id, email, plan: "free" } });
    // This app hides the session row's internals from clients.
    expect(Object.keys(gs.json.session).sort()).toEqual(["activeOrganizationId", "expiresAt"]);

    // The JWT that get-session hands out (`set-auth-jwt`, the React Native client's path) is Ember's usual one.
    const headerJwt = gs.headers.get("set-auth-jwt")!;
    expect(claimsOf(headerJwt)).toMatchObject({ sub: user.id, email });
    expect((await whoami(headerJwt))?.subject).toBe(user.id);

    // The cookie cache (verified in the Worker without the DO) still holds Better Auth's session.
    const cache = c.jar.get("plug.session_data")!;
    expect(await auth.verifyDetailed(cache)).toMatchObject({ via: "cookie-cache", identity: { subject: user.id } });

    // Regression: Ember's lookups (bearer session tokens, sensitive checks, the session behind a password check) read
    // the session row, not `/get-session`, which this app reshaped (no session id).
    expect(await auth.verifyDetailed(sessionToken, { sensitive: true })).toMatchObject({ via: "session", identity: { subject: user.id } });
    expect((await whoami(sessionToken))?.subject).toBe(user.id);
    const change = await c.req("/api/auth/change-password", { body: { currentPassword: password, newPassword: "a brand new passphrase" } });
    expect(change.status, change.text).toBe(200);
    expect((await signedIn(email, "a brand new passphrase")).r.status).toBe(200);
  });

  it("regression: a session that ended never mints a new Ember JWT from a still-valid cookie cache", async () => {
    const { c, email } = await signedUp("ended", "Ended");
    const jwt = await jwtOf(c);
    // Sign out of every session from another device: this browser keeps its (5 min) cookie cache.
    const other = await signedIn(email);
    expect((await other.c.req("/api/auth/revoke-sessions", { body: {} })).status).toBe(200);
    expect(c.jar.has("plug.session_data")).toBe(true);
    expect((await c.req("/api/auth/token")).status).toBe(401);
    // get-session (and its `set-auth-jwt`) reads the row too.
    const gs = await c.req("/api/auth/get-session");
    expect(gs.json).toBeNull();
    expect(gs.headers.get("set-auth-jwt")).toBeNull();
    expect((await query("app:whoami", {}, jwt)).body).toMatchObject(unauthenticated);
  });

  it("regression: an app before hook that reads the session from the cookie cache does not revive an ended one for Ember", async () => {
    const { c, email } = await signedUp("audited", "Audited");
    const other = await signedIn(email);
    expect((await other.c.req("/api/auth/revoke-sessions", { body: {} })).status).toBe(200);
    expect(c.jar.has("plug.session_data")).toBe(true);
    ember.readSession = true;
    ember.sessionReads = 0;
    try {
      // The session behind a password check (the Worker asks for the hash before it forwards change-password): Ember
      // asks its own endpoint for a strict read, which an earlier `getSessionFromCtx` in a hook would otherwise answer.
      expect(await auth.stub().credentialHash({ headers: [["cookie", c.cookieHeader()]] })).toBeNull();
      // The endpoints that mint a JWT, whose own hook runs after the app's.
      expect((await c.req("/api/auth/token")).status).toBe(401);
      expect((await c.req("/api/auth/get-session")).headers.get("set-auth-jwt")).toBeNull();
      // A live session still finds its hash, through the same hook.
      const live = await signedIn(email);
      expect(await auth.stub().credentialHash({ headers: [["cookie", live.c.cookieHeader()]] })).toMatch(/\S/);
      expect(ember.sessionReads).toBeGreaterThan(0);
    } finally {
      ember.readSession = false;
    }
  });
});

describe("oneTimeToken", () => {
  it("generate, verify once in another client (session + cookie → Ember JWT), replay refused", async () => {
    const { c, user } = await signedUp("ott", "OTT");
    const gen = await c.req("/api/auth/one-time-token/generate");
    expect(gen.status, gen.text).toBe(200);
    const token = gen.json.token as string;

    const device = new Client();
    const v = await device.req("/api/auth/one-time-token/verify", { body: { token } });
    expect(v.status, v.text).toBe(200);
    expect(v.json.user.id).toBe(user.id);
    expect((await whoami(await jwtOf(device)))?.subject).toBe(user.id);

    expect((await new Client().req("/api/auth/one-time-token/verify", { body: { token } })).status).toBe(400);
    expect((await new Client().req("/api/auth/one-time-token/generate")).status).toBe(401);
  });
});

describe("deviceAuthorization", () => {
  it("device code → user approves → the device's access token is a session token Ember accepts and exchanges for a JWT", async () => {
    const grant = "urn:ietf:params:oauth:grant-type:device_code";
    expect((await new Client().req("/api/auth/device/code", { body: { client_id: "unknown-cli" } })).status).toBe(400);
    const device = new Client();
    const code = await device.req("/api/auth/device/code", { body: { client_id: DEVICE_CLIENT, scope: "openid profile" } });
    expect(code.status, code.text).toBe(200);
    const { device_code, user_code, verification_uri, interval } = code.json as { device_code: string; user_code: string; verification_uri: string; interval: number };
    expect(verification_uri).toBe(`${ORIGIN}/device`);
    expect(interval).toBe(1);
    const poll = () => device.req("/api/auth/device/token", { body: { grant_type: grant, device_code, client_id: DEVICE_CLIENT } });
    const pending = await poll();
    expect(pending.status).toBe(400);
    expect(pending.json).toMatchObject({ error: "authorization_pending" });

    // The user, on another device: opens the verification page (claims the code), approves.
    const { c, user } = await signedUp("device", "Device Owner");
    const page = await c.req(`/api/auth/device?user_code=${encodeURIComponent(user_code)}`);
    expect(page.status, page.text).toBe(200);
    expect(page.json).toMatchObject({ status: "pending", client_id: DEVICE_CLIENT });
    const approve = await c.req("/api/auth/device/approve", { body: { userCode: user_code } });
    expect(approve.status, approve.text).toBe(200);

    await sleep(1100); // the polling interval
    const done = await poll();
    expect(done.status, done.text).toBe(200);
    const accessToken = done.json.access_token as string;
    expect(done.json.token_type).toBe("Bearer");
    // A session token: a bearer for Ember (DO lookup), and `/token` turns it into the usual JWT.
    expect(await auth.verifyDetailed(accessToken)).toMatchObject({ via: "session", identity: { subject: user.id } });
    expect((await whoami(accessToken))?.subject).toBe(user.id);
    const jwt = await jwtOf(new Client(), { authorization: `Bearer ${accessToken}` });
    expect(await whoami(jwt)).toMatchObject({ subject: user.id });
    // The device code is spent.
    await sleep(1100);
    expect((await poll()).status).toBe(400);

    // Signing that device out (revoking its session) ends its socket.
    const ws = await socket(jwt);
    const sessions = (await c.req("/api/auth/list-sessions")).json as { token: string; id: string }[];
    const deviceSession = sessions.find((s) => s.id === claimsOf(jwt).sid)!;
    expect((await c.req("/api/auth/revoke-session", { body: { token: deviceSession.token } })).status).toBe(200);
    await ws.waitFor("authExpired");
    ws.close();
    expect(await auth.verify(accessToken)).toBeNull();
  });
});

describe("lastLoginMethod", () => {
  it("email sign-in: the cookie for the sign-in page and the user field (storeInDatabase) in the profile outbox", async () => {
    const { user, email } = await signedUp("llm", "Last Login");
    const { c, r } = await signedIn(email);
    expect(r.status, r.text).toBe(200);
    expect(c.jar.get("better-auth.last_used_login_method")).toBe("email");
    expect((await c.req("/api/auth/get-session")).json.user.lastLoginMethod).toBe("email");
    await profilesUntil(user.id, (p) => p.some((x) => x.user.lastLoginMethod === "email"));
  });
});

describe("haveIBeenPwned", () => {
  const PWNED_PASSWORD = "correct horse battery pwned";

  it("the Worker hashes the new password, the Auth DO still checks the plaintext (k-anonymity) and refuses a pwned one", async () => {
    await pwned.add(PWNED_PASSWORD);
    const email = `pwned-${rnd()}@example.test`;
    const hashes = auth.workerStats().workerHashes;
    const asked = pwned.asked.length;
    const up = await new Client().req("/api/auth/sign-up/email", { body: { email, password: PWNED_PASSWORD, name: "Pwned" } });
    expect(up.status, up.text).toBe(400);
    expect(up.json).toMatchObject({ code: "PASSWORD_COMPROMISED" });
    // Order: the Worker hashed (the hash is wasted), then the DO's password.hash (wrapped by the plugin) asked the range
    // API before using it. Only the 5-character prefix of the SHA-1 left.
    expect(auth.workerStats().workerHashes).toBe(hashes + 1);
    expect(pwned.asked.slice(asked)).toHaveLength(1);
    // With `Add-Padding: true`, so the response size does not tell which prefix had a hit.
    expect(pwned.padded.slice(asked)).toEqual([true]);
    expect(pwned.asked.at(-1)).toMatch(/^[0-9A-F]{5}$/);
    expect(outbound.at(-1)).toBe(`GET ${PWNED}/range/${pwned.asked.at(-1)}`);
    expect((await signedIn(email, PWNED_PASSWORD)).r.status).toBe(401);

    // A clean password signs up (checked too), and changing it to a pwned one is refused.
    const { c, email: okEmail } = await signedUp("not-pwned", "Clean");
    expect(pwned.asked.length).toBe(asked + 2);
    const change = await c.req("/api/auth/change-password", { body: { currentPassword: password, newPassword: PWNED_PASSWORD } });
    expect(change.status).toBe(400);
    expect(change.json).toMatchObject({ code: "PASSWORD_COMPROMISED" });
    expect((await signedIn(okEmail)).r.status).toBe(200);
  });
});

describe("openAPI", () => {
  it("the reference page and the schema answer, with the plugin routes and without Ember's server-only endpoint", async () => {
    const ref = await new Client().req("/api/auth/reference");
    expect(ref.status).toBe(200);
    expect(ref.headers.get("content-type")).toMatch(/text\/html/);
    expect(ref.text).toContain("api-reference");
    const schema = await new Client().req("/api/auth/open-api/generate-schema");
    expect(schema.status, schema.text.slice(0, 300)).toBe(200);
    const paths = Object.keys(schema.json.paths as Record<string, unknown>);
    expect(paths).toEqual(expect.arrayContaining(["/sign-in/anonymous", "/admin/ban-user", "/multi-session/set-active", "/device/token", "/one-time-token/verify", "/siwe/verify", "/token"]));
    // Server-only endpoints (Ember's session read, jwt's signJWT) are not part of the public API.
    expect(paths.filter((p) => /emberSession|sign-?jwt/i.test(p))).toEqual([]);
  });
});
