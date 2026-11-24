/**
 * Sign-in methods of `better-auth/plugins` whose third party is faked in this isolate: genericOAuth (an OIDC provider
 * found by discovery, and a plain OAuth 2.0 one), oneTap (a Google ID token checked against Google's keys) and siwe
 * (an Ethereum wallet). Each ends as an ordinary Ember identity; lastLoginMethod records which one was used.
 */
import { env } from "cloudflare:test";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import type { AuthRpc } from "../../src/worker.ts";
import { GENERIC_OAUTH2, GENERIC_OIDC, GOOGLE_CLIENT_ID, SIWE_DOMAIN } from "./auth.config.ts";
import { deferred, GOOGLE_APIS, google, IDP, idp, outbound, Wallet } from "./fakes.ts";
import { Client, jwtOf, ORIGIN, profilesUntil, rnd, signedUp, sleep, whoami } from "./helpers.ts";

const LAST_METHOD = "better-auth.last_used_login_method";

/** The browser's round trip through the IdP: start at Ember, sign in there, come back with the code. */
async function throughIdp(browser: Client, start: { status: number; text: string; json: any }, user: { sub: string; email: string; name: string }) {
  expect(start.status, start.text).toBe(200);
  const authorize = new URL(start.json.url);
  expect(authorize.origin + authorize.pathname).toBe(`${IDP}/authorize`);
  const back = new URL(await idp.authorize(start.json.url, { ...user, email_verified: true }));
  return { authorize, back, callback: (url: URL = back) => browser.req(url.pathname + url.search) };
}

describe("genericOAuth", () => {
  it("OIDC by discovery: PKCE + nonce, code exchange, id_token through the JWKS → Ember JWT; replay and a forged state refused", async () => {
    const browser = new Client();
    const sub = `acme-${rnd()}`;
    const email = `${sub}@acme.test`;
    const start = await browser.req("/api/auth/sign-in/social", { body: { provider: GENERIC_OIDC.providerId, callbackURL: "/home" } });
    const { authorize, callback } = await throughIdp(browser, start, { sub, email, name: "Acme User" });
    expect(authorize.searchParams.get("client_id")).toBe(GENERIC_OIDC.clientId);
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("nonce")).toBeTruthy();
    expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email", "profile"]));
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/${GENERIC_OIDC.providerId}`);

    const before = outbound.length;
    const done = await callback();
    expect(done.status, done.text).toBe(302);
    expect(done.headers.get("location")).toMatch(/\/home$/);
    // The token endpoint checked the PKCE verifier (it answers invalid_grant otherwise); the id_token was verified
    // against the IdP's keys.
    expect(outbound.slice(before)).toEqual(expect.arrayContaining([`POST ${IDP}/token`, `GET ${IDP}/jwks`]));

    const session = (await browser.req("/api/auth/get-session")).json;
    expect(session.user).toMatchObject({ email, emailVerified: true, lastLoginMethod: GENERIC_OIDC.providerId });
    expect(browser.jar.get(LAST_METHOD)).toBe(GENERIC_OIDC.providerId);
    const accounts = (await browser.req("/api/auth/list-accounts")).json as { providerId: string; accountId: string }[];
    expect(accounts).toContainEqual(expect.objectContaining({ providerId: GENERIC_OIDC.providerId, accountId: sub }));
    expect(await whoami(await jwtOf(browser))).toMatchObject({ subject: session.user.id, claims: { email } });
    await profilesUntil(session.user.id, (p) => p.some((x) => x.event === "create"));

    // The state is single use.
    const replay = await callback();
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toMatch(/error=/);

    // A callback whose state is not the one this browser started with.
    const other = new Client();
    const flow = await throughIdp(other, await other.req("/api/auth/sign-in/social", { body: { provider: GENERIC_OIDC.providerId, callbackURL: "/home" } }), { sub: `acme-${rnd()}`, email: `x-${rnd()}@acme.test`, name: "X" });
    const forged = new URL(flow.back);
    forged.searchParams.set("state", "forged-state-value");
    const bad = await flow.callback(forged);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toMatch(/error=/);
    expect([...other.jar.keys()].some((k) => k.startsWith("plug.session_token"))).toBe(false);
  });

  it("plain OAuth 2.0 (userinfo, no id_token): link to the signed-in account, then sign in with it", async () => {
    const { c, user, email } = await signedUp("acme-link", "Linker");
    const sub = `oauth2-${rnd()}`;
    const link = await c.req("/api/auth/link-social", { body: { provider: GENERIC_OAUTH2.providerId, callbackURL: "/settings" } });
    const { authorize, callback } = await throughIdp(c, link, { sub, email, name: "Linker" });
    expect(authorize.searchParams.get("scope")?.split(" ")).not.toContain("openid");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    const before = outbound.length;
    const done = await callback();
    expect(done.status, done.text).toBe(302);
    expect(done.headers.get("location")).toMatch(/\/settings$/);
    expect(outbound.slice(before)).toEqual([`POST ${IDP}/token`, `GET ${IDP}/userinfo`]);
    const accounts = (await c.req("/api/auth/list-accounts")).json as { providerId: string; accountId: string }[];
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["acme-oauth2", "credential"]);

    // A new browser signs in through the provider: the same user.
    const fresh = new Client();
    const start = await fresh.req("/api/auth/sign-in/social", { body: { provider: GENERIC_OAUTH2.providerId, callbackURL: "/home" } });
    const flow = await throughIdp(fresh, start, { sub, email, name: "Linker" });
    expect((await flow.callback()).status).toBe(302);
    expect((await whoami(await jwtOf(fresh)))?.subject).toBe(user.id);
    expect(fresh.jar.get(LAST_METHOD)).toBe(GENERIC_OAUTH2.providerId);
  });
});

describe("genericOAuth: discovery at boot", () => {
  it("discovery runs in Better Auth's init: a freshly booted Auth DO answers no auth request until the IdP does", async () => {
    const gate = deferred();
    idp.holdDiscovery = gate.promise;
    let ok: Promise<number> | null = null;
    try {
      const fresh = env.AUTH.get(env.AUTH.idFromName(`boot-${rnd()}`)) as unknown as AuthRpc;
      let answered = false;
      ok = fresh.handle(new Request(`${ORIGIN}/api/auth/ok`)).then((r) => ((answered = true), r.status));
      await sleep(300);
      // Held on the discovery request itself (sent by the new instance's init), not on anything else of the boot.
      expect(outbound.at(-1)).toBe(`GET ${IDP}/.well-known/openid-configuration`);
      expect(answered).toBe(false);
      gate.resolve();
      expect(await ok).toBe(200);
    } finally {
      // Released and settled here too, so a failed assertion above never leaves the boot hanging on the fake IdP.
      gate.resolve();
      await ok?.catch(() => null);
      idp.holdDiscovery = null;
    }
  });
});

describe("oneTap", () => {
  it("a Google ID token checked against Google's keys from the Auth DO → Ember JWT; forged or for another client refused", async () => {
    const browser = new Client();
    const email = `onetap-${rnd()}@gmail.test`;
    const idToken = await google.idToken({ aud: GOOGLE_CLIENT_ID, sub: `g-${rnd()}`, email, name: "One Tap" });
    const before = outbound.length;
    const r = await browser.req("/api/auth/one-tap/callback", { body: { idToken } });
    expect(r.status, r.text).toBe(200);
    expect(outbound.slice(before)).toContain(`GET ${GOOGLE_APIS}/oauth2/v3/certs`);
    expect(r.json.user).toMatchObject({ email, emailVerified: true });
    expect(browser.jar.get(LAST_METHOD)).toBe("google");
    expect(await whoami(await jwtOf(browser))).toMatchObject({ subject: r.json.user.id, claims: { email } });

    const forgedKey = (await generateKeyPair("RS256")).privateKey as CryptoKey;
    const forged = await google.idToken({ aud: GOOGLE_CLIENT_ID, sub: `g-${rnd()}`, email: `f-${rnd()}@gmail.test`, name: "F", key: forgedKey });
    expect((await new Client().req("/api/auth/one-tap/callback", { body: { idToken: forged } })).status).toBe(400);
    const otherAud = await google.idToken({ aud: "someone-else.apps.googleusercontent.com", sub: `g-${rnd()}`, email: `o-${rnd()}@gmail.test`, name: "O" });
    expect((await new Client().req("/api/auth/one-tap/callback", { body: { idToken: otherAud } })).status).toBe(400);
  });
});

describe("siwe", () => {
  it("nonce, signed EIP-4361 message → wallet user → Ember JWT; replayed nonce, bad signature and wrong domain refused", async () => {
    const wallet = new Wallet();
    const browser = new Client();
    const sign = async (o: { domain?: string } = {}) => {
      const n = await browser.req("/api/auth/siwe/nonce", { body: {} });
      expect(n.status, n.text).toBe(200);
      const message = wallet.message({ domain: o.domain ?? SIWE_DOMAIN, uri: ORIGIN, nonce: n.json.nonce });
      return { message, signature: await wallet.sign(message) };
    };
    const signed = await sign();
    const r = await browser.req("/api/auth/siwe/verify", { body: signed });
    expect(r.status, r.text).toBe(200);
    const userId = r.json.user.id as string;
    expect(browser.jar.get(LAST_METHOD)).toBe("siwe");
    const me = await whoami(await jwtOf(browser));
    expect(me?.subject).toBe(userId);
    expect(String(me?.claims.email)).toMatch(/@/);
    await profilesUntil(userId, (p) => p.some((x) => x.event === "create"));

    // The nonce is single use.
    expect((await new Client().req("/api/auth/siwe/verify", { body: signed })).status).toBe(401);
    const s2 = await sign();
    expect((await new Client().req("/api/auth/siwe/verify", { body: { ...s2, signature: s2.signature.replace(/.$/, (ch) => (ch === "0" ? "1" : "0")) } })).status).toBe(401);
    expect((await new Client().req("/api/auth/siwe/verify", { body: await sign({ domain: "evil.test" }) })).status).toBe(401);

    // Signing in again with the same wallet: the same user.
    const again = new Client();
    const n = await again.req("/api/auth/siwe/nonce", { body: {} });
    const message = wallet.message({ domain: SIWE_DOMAIN, uri: ORIGIN, nonce: n.json.nonce });
    const second = await again.req("/api/auth/siwe/verify", { body: { message, signature: await wallet.sign(message) } });
    expect(second.status, second.text).toBe(200);
    expect(second.json.user.id).toBe(userId);

    // Another wallet: another user, and another JWT subject.
    const otherWallet = new Wallet();
    const third = new Client();
    const n3 = await third.req("/api/auth/siwe/nonce", { body: {} });
    const m3 = otherWallet.message({ domain: SIWE_DOMAIN, uri: ORIGIN, nonce: n3.json.nonce });
    const other = await third.req("/api/auth/siwe/verify", { body: { message: m3, signature: await otherWallet.sign(m3) } });
    expect(other.status, other.text).toBe(200);
    expect(other.json.user.id).not.toBe(userId);
    expect((await whoami(await jwtOf(third)))?.subject).toBe(other.json.user.id);
  });
});
