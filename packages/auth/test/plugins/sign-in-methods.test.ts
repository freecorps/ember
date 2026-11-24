/**
 * Sign-in methods of `better-auth/plugins` whose third party is faked in this isolate: genericOAuth (an OIDC provider
 * found by discovery, and a plain OAuth 2.0 one), oneTap (a Google ID token checked against Google's keys) and siwe
 * (an Ethereum wallet). Each ends as an ordinary Ember identity; lastLoginMethod records which one was used.
 */
import { env, evictDurableObject } from "cloudflare:test";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import type { AuthRpc } from "../../src/worker.ts";
import { FETCH_TIMEOUT_MS, GENERIC_OAUTH2, GENERIC_OIDC, GOOGLE_CLIENT_ID, logged, SIWE_DOMAIN } from "./auth.config.ts";
import { deferred, GOOGLE_APIS, google, IDP, idp, outbound, Wallet } from "./fakes.ts";
import { Client, jwtOf, ORIGIN, profilesUntil, rnd, signedUp, sleep, until, whoami } from "./helpers.ts";

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

/** A request straight to one Auth DO (a fresh one boots its own Better Auth). */
function call(auth: AuthRpc, path: string, o: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = { origin: ORIGIN, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...o.headers };
  return auth.handle(new Request(`${ORIGIN}${path}`, o.body !== undefined ? { method: "POST", headers, body: JSON.stringify(o.body) } : { headers }));
}
const DISCOVERY = `GET ${IDP}/.well-known/openid-configuration`;
const freshAuth = () => env.AUTH.get(env.AUTH.idFromName(`boot-${rnd()}`)) as unknown as AuthRpc;
const signInOidc = (auth: AuthRpc) => call(auth, "/api/auth/sign-in/social", { body: { provider: GENERIC_OIDC.providerId, callbackURL: "/home" } });
const authorizeOf = async (r: Response) => {
  const url = new URL(((await r.json()) as { url: string }).url);
  return url.origin + url.pathname;
};

describe("genericOAuth: discovery off the boot path", () => {
  it("a freshly booted Auth DO serves every other auth request while its IdP hangs; that provider's sign-in waits for it", async () => {
    const gate = deferred();
    idp.holdDiscovery = gate.promise;
    let pending: Promise<Response> | null = null;
    try {
      const before = outbound.length;
      const fresh = freshAuth();
      const t0 = Date.now();
      expect((await call(fresh, "/api/auth/ok")).status).toBe(200);
      // The boot started the discovery (in the background) and nothing waits on it: an anonymous sign-in, its session
      // and a plain OAuth 2.0 provider (no discovery) are served meanwhile.
      expect(await until(async () => outbound.slice(before), (o) => o.includes(DISCOVERY))).toContain(DISCOVERY);
      const anon = await call(fresh, "/api/auth/sign-in/anonymous", { body: {} });
      expect(anon.status).toBe(200);
      const bearer = { authorization: `Bearer ${anon.headers.get("set-auth-token")}` };
      const session = (await (await call(fresh, "/api/auth/get-session", { headers: bearer })).json()) as { user: { isAnonymous: boolean } };
      expect(session.user.isAnonymous).toBe(true);
      const oauth2 = await call(fresh, "/api/auth/sign-in/social", { body: { provider: GENERIC_OAUTH2.providerId, callbackURL: "/home" } });
      expect(oauth2.status).toBe(200);
      expect(await authorizeOf(oauth2)).toBe(`${IDP}/authorize`);
      expect(Date.now() - t0).toBeLessThan(2_000);

      // The provider behind the hung discovery: its sign-in waits on the plugin's retry, and goes on once the IdP answers.
      let answered = false;
      pending = signInOidc(fresh).then((r) => ((answered = true), r));
      await sleep(300);
      expect(answered).toBe(false);
      gate.resolve();
      const r = await pending;
      expect(r.status).toBe(200);
      expect(await authorizeOf(r)).toBe(`${IDP}/authorize`);
    } finally {
      // Released and settled here too, so a failed assertion above never leaves a request hanging on the fake IdP.
      gate.resolve();
      await pending?.catch(() => null);
      idp.holdDiscovery = null;
    }
  });

  it("a discovery that never answers fails that provider's sign-in with a clear 502 after ember.fetchTimeoutMs; the next sign-in retries it", async () => {
    const gate = deferred();
    idp.holdDiscovery = gate.promise;
    try {
      const fresh = freshAuth();
      const logs = logged.length;
      const t0 = Date.now();
      const r = await signInOidc(fresh);
      const took = Date.now() - t0;
      expect(r.status).toBe(502);
      expect(await r.json()).toMatchObject({ code: "OAUTH_DISCOVERY_FAILED", message: expect.stringContaining(`"${GENERIC_OIDC.providerId}"`) });
      // The retry this request made was cut at `ember.fetchTimeoutMs` (under genericOAuth's own 10 s bound), by the
      // wrapper's own TimeoutError (not just any abort): it names the discovery URL.
      expect(took).toBeGreaterThanOrEqual(FETCH_TIMEOUT_MS - 50);
      expect(took).toBeLessThan(FETCH_TIMEOUT_MS + 3_000);
      expect(logged.slice(logs)).toContainEqual(
        expect.stringContaining(`TimeoutError: auth: ${IDP}/.well-known/openid-configuration did not answer within ${FETCH_TIMEOUT_MS} ms (ember.fetchTimeoutMs)`),
      );
      // The DO was never stuck.
      expect((await call(fresh, "/api/auth/ok")).status).toBe(200);

      // The IdP is back: the next sign-in discovers it and goes through.
      gate.resolve();
      idp.holdDiscovery = null;
      const again = await signInOidc(fresh);
      expect(again.status).toBe(200);
      expect(await authorizeOf(again)).toBe(`${IDP}/authorize`);
    } finally {
      gate.resolve();
      idp.holdDiscovery = null;
    }
  });

  it("after a cold start, get-access-token and sign-out of an account of a provider still in background discovery wait for it (the token, the IdP logout URL); others do not", async () => {
    const stub = env.AUTH.get(env.AUTH.idFromName(`boot-${rnd()}`));
    const auth = stub as unknown as AuthRpc;
    // An account of the OIDC provider on this DO (its IdP answering).
    const start = await signInOidc(auth);
    expect(start.status).toBe(200);
    const stateCookie = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const back = new URL(await idp.authorize(((await start.json()) as { url: string }).url, { sub: `cold-${rnd()}`, email: `cold-${rnd()}@acme.test`, name: "Cold", email_verified: true }));
    const done = await call(auth, back.pathname + back.search, { headers: { cookie: stateCookie } });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toMatch(/\/home$/);
    const session = done.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const accounts = (await (await call(auth, "/api/auth/list-accounts", { headers: { cookie: session } })).json()) as { id: string; providerId: string }[];
    const accountId = accounts.find((a) => a.providerId !== "credential")!.id;

    // The object restarts (a deploy, eviction) while the IdP is slow: the provider is back in background discovery.
    await evictDurableObject(stub as unknown as DurableObjectStub);
    const gate = deferred();
    idp.holdDiscovery = gate.promise;
    let pending: Promise<Response> | null = null;
    try {
      // Someone else's sign-out (no account there) is not held.
      const anon = await call(auth, "/api/auth/sign-in/anonymous", { body: {} });
      const anonCookie = anon.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const t0 = Date.now();
      expect((await call(auth, "/api/auth/sign-out", { body: { disableRedirect: true }, headers: { cookie: anonCookie } })).status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2_000);

      // get-access-token selects the account by id (no provider named): it waits too, then finds the provider.
      let tokenAnswered = false;
      const token = call(auth, "/api/auth/get-access-token", { body: { accountId }, headers: { cookie: session } }).then((r) => ((tokenAnswered = true), r));
      let answered = false;
      pending = call(auth, "/api/auth/sign-out", { body: { disableRedirect: true }, headers: { cookie: session } }).then((r) => ((answered = true), r));
      await sleep(300);
      expect(tokenAnswered).toBe(false);
      expect(answered).toBe(false);
      gate.resolve();
      const tok = await token;
      expect(tok.status, await tok.clone().text()).toBe(200);
      expect(((await tok.json()) as { accessToken?: string }).accessToken).toMatch(/\S/);
      const out = await pending;
      expect(out.status).toBe(200);
      const body = (await out.json()) as { success: boolean; url?: string };
      expect(body.success).toBe(true);
      expect(body.url).toMatch(new RegExp(`^${IDP}/logout\\?`));
    } finally {
      gate.resolve();
      await pending?.catch(() => null);
      idp.holdDiscovery = null;
    }
  });

  it("the callback of a provider still pending is the core's redirect with error=oauth_provider_not_found, not the JSON 502", async () => {
    const gate = deferred();
    idp.holdDiscovery = gate.promise;
    try {
      const fresh = freshAuth();
      // A valid state for this DO (the OAuth 2.0 provider needs no discovery); the IdP sends the browser back to the
      // OIDC provider's callback while that provider's discovery is still hung.
      const start = await call(fresh, "/api/auth/sign-in/social", { body: { provider: GENERIC_OAUTH2.providerId, callbackURL: "/home", errorCallbackURL: "/oops" } });
      expect(start.status).toBe(200);
      const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
      const cookie = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const t0 = Date.now();
      const back = await call(fresh, `/api/auth/callback/${GENERIC_OIDC.providerId}?code=c0de&state=${encodeURIComponent(state)}`, { headers: { cookie } });
      // The plugin's own retry ran (and was cut at ember.fetchTimeoutMs) before the core found no provider.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(FETCH_TIMEOUT_MS - 50);
      expect(back.status).toBe(302);
      const location = new URL(back.headers.get("location")!, ORIGIN);
      expect(location.pathname).toBe("/oops");
      expect(location.searchParams.get("error")).toBe("oauth_provider_not_found");
    } finally {
      gate.resolve();
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
