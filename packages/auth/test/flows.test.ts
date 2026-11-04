/**
 * End-to-end flows through the Worker (`auth.fetch`) → Auth DO, plus `verify()` paths.
 * The test Worker runs with `strictHashing: true`: any scrypt call inside the DO throws, so every
 * passing password flow below proves the hash/verify happened in the Worker.
 */
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { describe, expect, it } from "vitest";
import { createVerifier, remoteAuth } from "../src/worker.ts";
import { takeMail } from "./auth.config.ts";
import { Client, ORIGIN, rnd, worker } from "./helpers.ts";
import { auth, userEvents } from "./worker.ts";

const password = "correct horse battery staple";
const stats = () => auth.stub().stats();
const signUp = (c: Client, email: string, name = "User", pw = password) => c.req("/api/auth/sign-up/email", { body: { email, password: pw, name } });
const signIn = (c: Client, email: string, pw = password) => c.req("/api/auth/sign-in/email", { body: { email, password: pw } });
const verifyEmail = async (c: Client, email: string) => {
  expect((await c.req("/api/auth/send-verification-email", { body: { email } })).status).toBe(200);
  const mail = takeMail("verify", email);
  expect((await c.req(`/api/auth/verify-email?token=${mail.token}`)).status).toBeLessThan(400);
  // Refresh the cookie cache (it still says emailVerified: false until maxAge).
  expect((await c.req("/api/auth/get-session?disableCookieCache=true")).json.user.emailVerified).toBe(true);
};

describe("email + password, sessions, tokens", () => {
  const alice = new Client();
  const aliceEmail = `alice-${rnd()}@vip.test`;
  let sessionToken = "";
  let jwt = "";

  it("sign-up hashes in the Worker; cookies use the project prefix; profile hook fires", async () => {
    const before = await stats();
    const w0 = auth.workerStats();
    const r = await signUp(alice, aliceEmail, "Alice");
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(aliceEmail);
    sessionToken = r.headers.get("set-auth-token") ?? "";
    expect(sessionToken).not.toBe("");
    expect([...alice.jar.keys()]).toContain("acme.session_token");
    expect([...alice.jar.keys()]).toContain("acme.session_data");
    const after = await stats();
    expect(after.plannedHashes - before.plannedHashes).toBe(1);
    expect(after.localHashes).toBe(0);
    expect(auth.workerStats().workerHashes - w0.workerHashes).toBe(1);
    expect(userEvents).toContainEqual({ event: "create", email: aliceEmail });
  });

  it("sign-in: Worker fetches the hash over RPC and verifies; wrong password and unknown user are 401", async () => {
    const before = await stats();
    expect((await signIn(new Client(), aliceEmail, "wrong-password-123")).status).toBe(401);
    expect((await signIn(new Client(), `nobody-${rnd()}@x.test`)).status).toBe(401);
    const r = await signIn(alice, aliceEmail);
    expect(r.status).toBe(200);
    sessionToken = r.headers.get("set-auth-token")!;
    const after = await stats();
    expect(after.plannedVerifies - before.plannedVerifies).toBe(2); // wrong + right
    expect(after.plannedHashes - before.plannedHashes).toBe(1); // dummy hash for the unknown user
    expect(after.localHashes).toBe(0);
  });

  it("get-session via cookie and via bearer token", async () => {
    expect((await alice.req("/api/auth/get-session")).json.user.email).toBe(aliceEmail);
    const b = await new Client().req("/api/auth/get-session", { headers: { authorization: `Bearer ${sessionToken}` } });
    expect(b.json.user.email).toBe(aliceEmail);
  });

  it("jwt plugin: /token (5 min EdDSA) and /jwks", async () => {
    const r = await alice.req("/api/auth/token");
    expect(r.status).toBe(200);
    jwt = r.json.token;
    const [h, p] = jwt.split(".").slice(0, 2).map((s) => JSON.parse(atob(s.replaceAll("-", "+").replaceAll("_", "/"))));
    expect(h.alg).toBe("EdDSA");
    expect(p.exp - p.iat).toBe(300);
    expect(p.iss).toBe(ORIGIN);
    expect(p.sid).toBeTruthy();
    expect(p.plan).toBe("vip");
    const jwks = await new Client().req("/api/auth/jwks");
    expect(jwks.json.keys.length).toBeGreaterThan(0);
    expect((await alice.req("/api/auth/get-session")).headers.get("set-auth-jwt")?.split(".")).toHaveLength(3);
  });

  it("verify: (a) JWT locally with one JWKS fetch, (b) cookie cache locally, (c) session token in the DO", async () => {
    auth.verifier().reset();
    const a = await auth.verifyDetailed(jwt);
    expect(a?.via).toBe("jwt");
    expect(a?.identity.issuer).toBe(ORIGIN);
    expect(a?.identity.claims?.email).toBe(aliceEmail);
    for (let i = 0; i < 50; i++) expect((await auth.verify(jwt))?.subject).toBe(a?.identity.subject);
    expect(auth.verifier().stats().jwksFetches).toBe(1);

    const cookieValue = alice.jar.get("acme.session_data")!;
    const b = await auth.verifyDetailed(cookieValue);
    expect(b?.via).toBe("cookie-cache");
    expect(b?.identity.subject).toBe(a?.identity.subject);
    const viaReq = await auth.verifyRequestDetailed(new Request(`${ORIGIN}/x`, { headers: { cookie: alice.cookieHeader() } }));
    expect(viaReq?.via).toBe("cookie-cache");

    const c = await auth.verifyDetailed(sessionToken);
    expect(c?.via).toBe("session");
    expect(c?.identity.subject).toBe(a?.identity.subject);
    expect(c?.identity.claims?.sid).toBe(a?.identity.claims?.sid);

    // Session cookie only (no cookie cache) → DO lookup.
    const onlyToken = `acme.session_token=${alice.jar.get("acme.session_token")}`;
    expect((await auth.verifyRequestDetailed(new Request(`${ORIGIN}/x`, { headers: { cookie: onlyToken } })))?.via).toBe("session");

    // Through the Worker route too.
    const who = await new Client().req("/whoami", { headers: { authorization: `Bearer ${jwt}` } });
    expect(who.json.via).toBe("jwt");

    // Tampered / garbage tokens.
    const bad = jwt.slice(0, -4) + (jwt.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await auth.verify(bad)).toBeNull();
    expect(await auth.verify(cookieValue.slice(0, -3) + "xyz")).toBeNull();
    expect(await auth.verify("not-a-session")).toBeNull();
  });

  it("verify: sensitive mode always asks the DO", async () => {
    expect((await auth.verifyDetailed(jwt, { sensitive: true }))?.via).toBe("session");
    expect((await auth.verifyDetailed(alice.jar.get("acme.session_data")!, { sensitive: true }))?.via).toBe("session");
    expect((await auth.verifySensitive(sessionToken))?.subject).toBeTruthy();
  });

  it("verify: static JWKS embedded at deploy needs no fetch; unknown kid triggers one refresh", async () => {
    const keys = (await new Client().req("/api/auth/jwks")).json;
    let fetches = 0;
    const v = createVerifier({
      issuer: ORIGIN,
      jwks: { static: keys, fetch: async () => (fetches++, keys) },
      lookup: async () => null,
    });
    expect((await v.verifyDetailed(jwt))?.via).toBe("jwt");
    expect(fetches).toBe(0);
    const stale = createVerifier({
      jwks: { static: { keys: [{ ...keys.keys[0], kid: "old-key" }] }, fetch: async () => (fetches++, keys), cooldownMs: 0 },
      lookup: async () => null,
    });
    expect((await stale.verifyDetailed(jwt))?.via).toBe("jwt");
    expect(fetches).toBe(1);
  });

  it("SSO: another project verifies via the identity project's remote JWKS", async () => {
    const sso = remoteAuth({ from: ORIGIN, fetch: (input, init) => worker.fetch(input as string, init) });
    const r = await sso.verifyDetailed(jwt);
    expect(r?.via).toBe("jwt");
    expect(r?.identity.claims?.email).toBe(aliceEmail);
    expect((await sso.verifyDetailed(sessionToken))?.via).toBe("session");
    expect(await sso.verify(jwt, { sensitive: true })).toBeNull(); // fails closed
    const wrongIssuer = remoteAuth({ from: "https://id.other.test", fetch: (input, init) => worker.fetch(String(input).replace("https://id.other.test", ORIGIN), init) });
    expect(await wrongIssuer.verify(jwt)).toBeNull();
  });

  it("profile sync hook fires on update", async () => {
    expect((await alice.req("/api/auth/update-user", { body: { name: "Alice B" } })).status).toBe(200);
    expect(userEvents).toContainEqual({ event: "update", email: aliceEmail });
  });

  it("revocation: after sign-out the DO path rejects; JWT/cookie cache stay valid until exp unless sensitive", async () => {
    const cookieValue = alice.jar.get("acme.session_data")!;
    expect((await alice.req("/api/auth/sign-out", { body: {} })).status).toBe(200);
    expect(await auth.verify(sessionToken)).toBeNull();
    expect((await auth.verifyDetailed(jwt))?.via).toBe("jwt");
    expect((await auth.verifyDetailed(cookieValue))?.via).toBe("cookie-cache");
    expect(await auth.verify(jwt, { sensitive: true })).toBeNull();
    expect(await auth.verify(cookieValue, { sensitive: true })).toBeNull();
    expect(await new Client().req("/whoami?sensitive", { headers: { authorization: `Bearer ${jwt}` } }).then((r) => r.status)).toBe(401);
  });
});

describe("password changes (Worker-side hash + verify)", () => {
  it("change-password verifies the current password and hashes the new one in the Worker", async () => {
    const c = new Client();
    const email = `carol-${rnd()}@x.test`;
    expect((await signUp(c, email)).status).toBe(200);
    const bad = await c.req("/api/auth/change-password", { body: { currentPassword: "not-it-123", newPassword: "brand new password" } });
    expect(bad.status).toBe(400);
    const ok = await c.req("/api/auth/change-password", { body: { currentPassword: password, newPassword: "brand new password" } });
    expect(ok.status).toBe(200);
    expect((await signIn(new Client(), email)).status).toBe(401);
    expect((await signIn(new Client(), email, "brand new password")).status).toBe(200);
  });

  it("reset-password via emailed token", async () => {
    const c = new Client();
    const email = `dave-${rnd()}@x.test`;
    expect((await signUp(c, email)).status).toBe(200);
    expect((await c.req("/api/auth/request-password-reset", { body: { email, redirectTo: "/reset" } })).status).toBe(200);
    const { token } = takeMail("reset", email);
    expect((await c.req("/api/auth/reset-password", { body: { token, newPassword: "reset password 456" } })).status).toBe(200);
    expect((await signIn(new Client(), email, "reset password 456")).status).toBe(200);
  });
});

describe("plugins", () => {
  it("organization: create, invite, verify email, accept, roles", async () => {
    const owner = new Client();
    const member = new Client();
    const ownerEmail = `owner-${rnd()}@x.test`;
    const memberEmail = `member-${rnd()}@x.test`;
    expect((await signUp(owner, ownerEmail)).status).toBe(200);
    expect((await signUp(member, memberEmail)).status).toBe(200);
    const slug = `acme-${rnd()}`;
    const org = await owner.req("/api/auth/organization/create", { body: { name: "Acme", slug } });
    expect(org.status).toBe(200);
    expect((await owner.req("/api/auth/organization/invite-member", { body: { email: memberEmail, role: "member", organizationId: org.json.id } })).status).toBe(200);
    takeMail("invite", memberEmail);
    await verifyEmail(member, memberEmail);
    const list = await member.req("/api/auth/organization/list-user-invitations");
    expect(list.json, JSON.stringify(list.json)).toHaveLength(1);
    expect((await member.req("/api/auth/organization/accept-invitation", { body: { invitationId: list.json[0].id } })).status).toBe(200);
    const full = await owner.req(`/api/auth/organization/get-full-organization?organizationId=${org.json.id}`);
    const roles = Object.fromEntries(full.json.members.map((m: any) => [m.user.email, m.role]));
    expect(roles).toEqual({ [ownerEmail]: "owner", [memberEmail]: "member" });
    // Active org flows into the JWT `org` claim.
    expect((await owner.req("/api/auth/organization/set-active", { body: { organizationId: org.json.id } })).status).toBe(200);
    const token = (await owner.req("/api/auth/token")).json.token;
    expect((await auth.verify(token))?.claims?.org).toBe(org.json.id);
  });

  it("two-factor TOTP: enable (password checked in the Worker), sign-in requires TOTP", async () => {
    const c = new Client();
    const email = `tf-${rnd()}@x.test`;
    expect((await signUp(c, email)).status).toBe(200);
    expect((await c.req("/api/auth/two-factor/enable", { body: { password: "wrong-password-1" } })).status).toBe(400);
    const en = await c.req("/api/auth/two-factor/enable", { body: { password } });
    expect(en.status).toBe(200);
    const otp = createOTP(base32.decode(new URL(en.json.totpURI).searchParams.get("secret")!));
    expect((await c.req("/api/auth/two-factor/verify-totp", { body: { code: await otp.totp() } })).status).toBe(200);
    const fresh = new Client();
    const si = await signIn(fresh, email);
    expect(si.json.twoFactorRedirect).toBe(true);
    expect((await fresh.req("/api/auth/two-factor/verify-totp", { body: { code: await otp.totp() } })).status).toBe(200);
    const gs = await fresh.req("/api/auth/get-session");
    expect(gs.json.user.twoFactorEnabled).toBe(true);
  });

  it("magic link (captured sender)", async () => {
    const c = new Client();
    const email = `ml-${rnd()}@x.test`;
    expect((await c.req("/api/auth/sign-in/magic-link", { body: { email, callbackURL: "/" } })).status).toBe(200);
    const { token } = takeMail("magic-link", email);
    const v = await c.req(`/api/auth/magic-link/verify?token=${token}&callbackURL=/`);
    expect(v.status).toBeLessThan(400);
    expect((await c.req("/api/auth/get-session")).json.user.email).toBe(email);
    expect(userEvents).toContainEqual({ event: "create", email });
  });

  it("email OTP sign-in (captured sender)", async () => {
    const c = new Client();
    const email = `otp-${rnd()}@x.test`;
    expect((await c.req("/api/auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" } })).status).toBe(200);
    const { token: otp } = takeMail("otp", email);
    expect((await c.req("/api/auth/sign-in/email-otp", { body: { email, otp: "000000" === otp ? "111111" : "000000" } })).status).toBe(400);
    const ok = await c.req("/api/auth/sign-in/email-otp", { body: { email, otp } });
    expect(ok.status).toBe(200);
    expect((await c.req("/api/auth/get-session")).json.user.email).toBe(email);
  });

  it("api-key: create a key and use it as a session", async () => {
    const c = new Client();
    const email = `ak-${rnd()}@x.test`;
    expect((await signUp(c, email)).status).toBe(200);
    const created = await c.req("/api/auth/api-key/create", { body: { name: "ci" } });
    expect(created.status).toBe(200);
    const key = created.json.key as string;
    const gs = await new Client().req("/api/auth/get-session", { headers: { "x-api-key": key } });
    expect(gs.json?.user?.email).toBe(email);
    expect((await new Client().req("/api/auth/get-session", { headers: { "x-api-key": key + "x" } })).json?.user).toBeUndefined();
  });

  it("delete-user verifies the password in the Worker and fires the profile hook", async () => {
    const c = new Client();
    const email = `del-${rnd()}@x.test`;
    expect((await signUp(c, email)).status).toBe(200);
    expect((await c.req("/api/auth/delete-user", { body: { password: "nope-nope-nope" } })).status).toBe(400);
    expect((await c.req("/api/auth/delete-user", { body: { password } })).status).toBe(200);
    expect(userEvents).toContainEqual({ event: "delete", email });
  });

  it("the DO never hashed a password (strictHashing would have thrown)", async () => {
    const s = await stats();
    expect(s.localHashes).toBe(0);
    expect(s.plannedHashes).toBeGreaterThan(5);
    expect(s.plannedVerifies).toBeGreaterThan(5);
  });
});
