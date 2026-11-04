/**
 * End-to-end flows through the Worker -> auth DO, using real HTTP requests
 * (same shape a browser/client SDK would send).
 */
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { resolveAuth, jwksStats, resetJwksCache, authShard } from "../src/index";

const ORIGIN = "http://localhost:8787";
const worker = (exports as any).default as Fetcher;

/** Tiny cookie jar per "browser". */
class Client {
  jar = new Map<string, string>();
  lastHeaders = new Headers();
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers = new Headers({ origin: ORIGIN, ...init.headers });
    if (this.jar.size) headers.set("cookie", this.cookieHeader());
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const t = performance.now();
    const res = await worker.fetch(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const ms = performance.now() - t;
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "";
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    this.lastHeaders = res.headers;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, ms, headers: res.headers };
  }
}

const results: Record<string, unknown> = {};
const rnd = () => Math.random().toString(36).slice(2, 8);

describe("better-auth on DO SQLite: core flows", () => {
  const alice = new Client();
  const bob = new Client();
  const aliceEmail = `alice-${rnd()}@example.com`;
  const bobEmail = `bob-${rnd()}@example.com`;
  const password = "correct horse battery staple";
  let aliceSessionToken = "";
  let aliceJwt = "";
  let orgId = "";

  it("sign up (email+password, scrypt in the DO)", async () => {
    const r = await alice.req("/api/auth/sign-up/email", { body: { email: aliceEmail, password, name: "Alice" } });
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(aliceEmail);
    aliceSessionToken = r.headers.get("set-auth-token") ?? ""; // bearer plugin
    expect(aliceSessionToken).not.toBe("");
    results.signUpMs = r.ms;
    const b = await bob.req("/api/auth/sign-up/email", { body: { email: bobEmail, password, name: "Bob" } });
    expect(b.status).toBe(200);
  });

  it("sign in + wrong password rejected", async () => {
    const bad = await new Client().req("/api/auth/sign-in/email", { body: { email: aliceEmail, password: "nope-nope-nope" } });
    expect(bad.status).toBe(401);
    results.signInBadMs = bad.ms;
    const r = await alice.req("/api/auth/sign-in/email", { body: { email: aliceEmail, password } });
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(aliceEmail);
    aliceSessionToken = r.headers.get("set-auth-token")!;
    results.signInMs = r.ms;
  });

  it("get session (cookie)", async () => {
    const r = await alice.req("/api/auth/get-session");
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(aliceEmail);
    results.getSessionMs = r.ms;
  });

  it("get session via bearer plugin (Authorization: Bearer <session token>)", async () => {
    const r = await new Client().req("/api/auth/get-session", { headers: { authorization: `Bearer ${aliceSessionToken}` } });
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(aliceEmail);
  });

  it("jwt plugin: /token issues a JWT, /jwks publishes keys", async () => {
    const r = await alice.req("/api/auth/token");
    expect(r.status).toBe(200);
    aliceJwt = r.json.token;
    expect(aliceJwt.split(".")).toHaveLength(3);
    const jwks = await new Client().req("/api/auth/jwks");
    expect(jwks.json.keys.length).toBeGreaterThan(0);
    results.jwksAlg = jwks.json.keys[0].alg ?? jwks.json.keys[0].kty;
    // get-session also returns the JWT in a header (set-auth-jwt)
    const gs = await alice.req("/api/auth/get-session");
    expect(gs.headers.get("set-auth-jwt")?.split(".")).toHaveLength(3);
  });

  it("ctx.auth resolution: JWT (local verify), cookie cache (local verify), session lookup (DO)", async () => {
    resetJwksCache();
    const viaJwt = (n: number) =>
      Promise.all(
        Array.from({ length: n }, () =>
          resolveAuth(new Request(`${ORIGIN}/x`, { headers: { authorization: `Bearer ${aliceJwt}` } }), env as any),
        ),
      );
    const first = await viaJwt(1);
    expect(first[0]?.via).toBe("jwt");
    expect(first[0]?.subject).toBeTruthy();
    const t = performance.now();
    await viaJwt(200);
    results.jwtVerifyAvgMs = (performance.now() - t) / 200;
    expect(jwksStats().jwksFetches).toBe(1); // JWKS fetched once, then cached

    const cookieReq = new Request(`${ORIGIN}/x`, { headers: { cookie: alice.cookieHeader() } });
    const viaCookie = await resolveAuth(cookieReq, env as any);
    expect(viaCookie?.via).toBe("cookie-cache");
    expect(viaCookie?.email).toBe(aliceEmail);

    const tokenReq = new Request(`${ORIGIN}/x`, { headers: { authorization: `Bearer ${aliceSessionToken}` } });
    const t2 = performance.now();
    const viaSession = await resolveAuth(tokenReq, env as any);
    results.sessionLookupMs = performance.now() - t2;
    expect(viaSession?.via).toBe("session-lookup");
    expect(viaSession?.email).toBe(aliceEmail);

    // tampered JWT is rejected
    const bad = aliceJwt.slice(0, -4) + (aliceJwt.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await resolveAuth(new Request(`${ORIGIN}/x`, { headers: { authorization: `Bearer ${bad}` } }), env as any)).toBeNull();
  });

  it("organization: create org, invite member, accept, list members", async () => {
    const slug = `acme-${rnd()}`;
    const c = await alice.req("/api/auth/organization/create", { body: { name: "Acme", slug } });
    expect(c.status).toBe(200);
    orgId = c.json.id;
    expect(c.json.slug).toBe(slug);

    const inv = await alice.req("/api/auth/organization/invite-member", {
      body: { email: bobEmail, role: "member", organizationId: orgId },
    });
    expect(inv.status).toBe(200);
    const sent = await authShard(env as any).takeInvitations();
    expect(sent.find((i) => i.email === bobEmail)).toBeTruthy();

    // Better Auth requires a verified email to see/accept invitations:
    // go through the real verification flow for Bob.
    const sendV = await bob.req("/api/auth/send-verification-email", { body: { email: bobEmail } });
    expect(sendV.status).toBe(200);
    const mail = (await authShard(env as any).takeVerificationEmails()).find((m) => m.email === bobEmail)!;
    const ver = await bob.req(`/api/auth/verify-email?token=${mail.token}`);
    expect(ver.status).toBe(200);
    expect((await bob.req("/api/auth/get-session?disableCookieCache=true")).json.user.emailVerified).toBe(true);

    const list = await bob.req("/api/auth/organization/list-user-invitations");
    expect(list.status).toBe(200);
    const invitationId = list.json[0].id;

    const acc = await bob.req("/api/auth/organization/accept-invitation", { body: { invitationId } });
    expect(acc.status).toBe(200);

    const full = await alice.req(`/api/auth/organization/get-full-organization?organizationId=${orgId}`);
    expect(full.status).toBe(200);
    const emails = full.json.members.map((m: any) => m.user.email).sort();
    expect(emails).toEqual([aliceEmail, bobEmail].sort());
    const roles = Object.fromEntries(full.json.members.map((m: any) => [m.user.email, m.role]));
    expect(roles[aliceEmail]).toBe("owner");
    expect(roles[bobEmail]).toBe("member");

    const active = await alice.req("/api/auth/organization/set-active", { body: { organizationId: orgId } });
    expect(active.status).toBe(200);
  });

  it("two-factor: enable TOTP, verify, sign-in requires 2FA, complete with TOTP", async () => {
    const en = await alice.req("/api/auth/two-factor/enable", { body: { password } });
    expect(en.status).toBe(200);
    expect(en.json.backupCodes.length).toBeGreaterThan(0);
    const secretB32 = new URL(en.json.totpURI).searchParams.get("secret")!;
    const otp = createOTP(base32.decode(secretB32));
    const v = await alice.req("/api/auth/two-factor/verify-totp", { body: { code: await otp.totp() } });
    expect(v.status).toBe(200);

    const fresh = new Client();
    const si = await fresh.req("/api/auth/sign-in/email", { body: { email: aliceEmail, password } });
    expect(si.status).toBe(200);
    expect(si.json.twoFactorRedirect).toBe(true);
    const v2 = await fresh.req("/api/auth/two-factor/verify-totp", { body: { code: await otp.totp() } });
    expect(v2.status).toBe(200);
    const gs = await fresh.req("/api/auth/get-session");
    expect(gs.json.user.email).toBe(aliceEmail);
    expect(gs.json.user.twoFactorEnabled).toBe(true);
  });

  it("revocation semantics after sign-out", async () => {
    const tokenBefore = aliceSessionToken;
    const cookiesBefore = alice.cookieHeader();
    const so = await alice.req("/api/auth/sign-out", { body: {} });
    expect(so.status).toBe(200);
    // authoritative lookup: revoked immediately
    const s = await resolveAuth(new Request(`${ORIGIN}/x`, { headers: { authorization: `Bearer ${tokenBefore}` } }), env as any);
    expect(s).toBeNull();
    // stateless JWT: still valid until exp (15m) -> documented trade-off
    const j = await resolveAuth(new Request(`${ORIGIN}/x`, { headers: { authorization: `Bearer ${aliceJwt}` } }), env as any);
    expect(j?.via).toBe("jwt");
    // a stolen copy of the cookie-cache cookie also stays valid until maxAge
    const c = await resolveAuth(new Request(`${ORIGIN}/x`, { headers: { cookie: cookiesBefore } }), env as any);
    results.cookieCacheAfterSignOut = c?.via ?? null;
  });

  it("report", () => {
    console.log("[flow-results]", JSON.stringify(results));
  });
});
