/**
 * sso (OIDC): an organization registers its IdP, an employee signs in through it, and the Auth DO does the
 * discovery, code exchange and id_token check with its own outbound `fetch` (the fake IdP in this isolate).
 */
import { describe, expect, it } from "vitest";
import { deferred, IDP, idp, outbound } from "./fakes.ts";
import SAML_CERT from "./fixtures/saml-idp.crt?raw";
import SAML_KEY from "./fixtures/saml-idp.key?raw";
import { Client, jwtOf, ORIGIN, rnd, signedUp, until, whoami } from "./helpers.ts";

async function orgWithProvider() {
  const owner = await signedUp("sso-owner", "Owner");
  const slug = `corp-${rnd()}`;
  const org = await owner.c.req("/api/auth/organization/create", { body: { name: "Corp", slug } });
  expect(org.status, org.text).toBe(200);
  const clientId = `client-${rnd()}`;
  idp.clients.set(clientId, "idp-client-secret");
  const domain = `${slug}.test`;
  const providerId = `oidc-${slug}`;
  const reg = await owner.c.req("/api/auth/sso/register", {
    body: {
      providerId,
      issuer: IDP,
      domain,
      organizationId: org.json.id,
      oidcConfig: { clientId, clientSecret: "idp-client-secret", pkce: true, discoveryEndpoint: `${IDP}/.well-known/openid-configuration` },
    },
  });
  expect(reg.status, reg.text).toBe(200);
  return { owner, org: org.json as { id: string }, domain, providerId, reg: reg.json };
}

/** The employee's browser: start at Ember, sign in at the IdP, come back to the callback. */
async function signInThroughIdp(domain: string, sub = `idp-${rnd()}`) {
  const browser = new Client();
  const email = `${sub}@${domain}`;
  const start = await browser.req("/api/auth/sign-in/sso", { body: { email, callbackURL: "/home" } });
  expect(start.status, start.text).toBe(200);
  expect(start.json.url).toMatch(new RegExp(`^${IDP}/authorize\\?`));
  const authorize = new URL(start.json.url);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  const back = new URL(await idp.authorize(start.json.url, { sub, email, name: "Employee", email_verified: true }));
  return { browser, email, sub, callback: () => browser.req(back.pathname + back.search) };
}

describe("sso (OIDC)", () => {
  it("registration discovers the IdP from the Auth DO; the secret never comes back in listings", async () => {
    const before = outbound.length;
    const { owner, reg, providerId } = await orgWithProvider();
    expect(outbound.slice(before)).toContain(`GET ${IDP}/.well-known/openid-configuration`);
    expect(reg.oidcConfig).toMatchObject({ tokenEndpoint: `${IDP}/token`, jwksEndpoint: `${IDP}/jwks` });
    const list = await owner.c.req("/api/auth/sso/providers");
    expect(list.status, list.text).toBe(200);
    const mine = (list.json.providers ?? list.json).find((p: { providerId: string }) => p.providerId === providerId);
    expect(JSON.stringify(mine)).not.toContain("idp-client-secret");
  });

  it("sign-in through the IdP: PKCE code exchange + id_token via JWKS, org membership, Ember JWT and ctx.auth", async () => {
    const { org, domain, owner } = await orgWithProvider();
    const { browser, email, callback } = await signInThroughIdp(domain);
    const before = outbound.length;
    const done = await callback();
    expect(done.status, done.text).toBe(302);
    expect(done.headers.get("location")).toMatch(/\/home$/);
    expect(outbound.slice(before)).toEqual(expect.arrayContaining([`POST ${IDP}/token`, `GET ${IDP}/jwks`]));

    const session = (await browser.req("/api/auth/get-session")).json;
    expect(session.user).toMatchObject({ email, emailVerified: true });
    const full = await owner.c.req(`/api/auth/organization/get-full-organization?organizationId=${org.id}`);
    expect(full.json.members.map((m: { user: { email: string }; role: string }) => [m.user.email, m.role])).toContainEqual([email, "member"]);

    // The SSO user is an ordinary Ember identity.
    expect((await browser.req("/api/auth/organization/set-active", { body: { organizationId: org.id } })).status).toBe(200);
    const jwt = await jwtOf(browser);
    expect(await whoami(jwt)).toMatchObject({ subject: session.user.id, claims: { email, org: org.id } });

    // The state is single use: replaying the callback lands on an error, without a new session.
    const replay = await callback();
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toMatch(/error=/);
  });

  it("a slow IdP does not block the Auth DO: other requests are served while the token exchange waits", async () => {
    const { domain } = await orgWithProvider();
    const other = await signedUp("sso-bystander");
    const { browser, email, callback } = await signInThroughIdp(domain);
    const gate = deferred();
    idp.hold = gate.promise;
    try {
      const pending = callback();
      await until(async () => outbound.at(-1), (last) => last === `POST ${IDP}/token`);
      // The exchange is in flight inside the Auth DO; a sign-in and a session read go through meanwhile.
      const t0 = Date.now();
      expect((await other.c.req("/api/auth/get-session?disableCookieCache=true")).json.user.email).toBe(other.email);
      expect((await new Client().req("/api/auth/sign-in/email", { body: { email: other.email, password: "correct horse battery staple" } })).status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2_000);
      gate.resolve();
      expect((await pending).status).toBe(302);
    } finally {
      idp.hold = null;
    }
    expect((await browser.req("/api/auth/get-session")).json.user.email).toBe(email);
  });

  it("an IdP error comes back to the app as a redirect, not a 500", async () => {
    const { domain } = await orgWithProvider();
    const { browser } = await signInThroughIdp(domain);
    // The browser comes back with a code the IdP never issued.
    const start = await browser.req("/api/auth/sign-in/sso", { body: { email: `x-${rnd()}@${domain}`, callbackURL: "/home" } });
    const state = new URL(start.json.url).searchParams.get("state")!;
    const providerId = new URL(new URL(start.json.url).searchParams.get("redirect_uri")!).pathname.split("/").at(-1);
    const bad = await browser.req(`/api/auth/sso/callback/${providerId}?code=forged&state=${state}`);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toMatch(/error=/);
  });
});

describe("sso (SAML 2.0)", () => {
  // A test-only key pair (fixtures/), signing the IdP's assertions; the SP side is the sso plugin in the Auth DO.
  const SAML_IDP = `${IDP}/saml`;
  const entryPoint = `${IDP}/saml/sso`;

  it("SP-initiated sign-in with a signed assertion; a replayed or unsigned response is refused", async () => {
    const mod = await import("samlify");
    const samlify = (mod as unknown as { default?: typeof mod }).default ?? mod;
    const owner = await signedUp("saml-owner", "Owner");
    const slug = `saml-${rnd()}`;
    const org = await owner.c.req("/api/auth/organization/create", { body: { name: "Saml Corp", slug } });
    const providerId = `saml-${slug}`;
    const spEntity = `${ORIGIN}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`;
    const reg = await owner.c.req("/api/auth/sso/register", {
      body: {
        providerId,
        issuer: spEntity,
        domain: `${slug}.test`,
        organizationId: org.json.id,
        samlConfig: { entryPoint, cert: SAML_CERT, idpMetadata: { entityID: SAML_IDP }, wantAssertionsSigned: true },
      },
    });
    expect(reg.status, reg.text).toBe(200);

    const browser = new Client();
    const email = `emp-${rnd()}@${slug}.test`;
    const start = await browser.req("/api/auth/sign-in/sso", { body: { providerId, callbackURL: "/home" } });
    expect(start.status, start.text).toBe(200);
    const url = new URL(start.json.url);
    expect(url.origin + url.pathname).toBe(entryPoint);

    // The IdP: reads the AuthnRequest, answers a signed Response for the request (InResponseTo) to the ACS.
    const acs = `${ORIGIN}/api/auth/sso/saml2/sp/acs/${providerId}`;
    const sp = samlify.ServiceProvider({
      entityID: spEntity,
      assertionConsumerService: [{ Binding: samlify.Constants.namespace.binding.post, Location: acs }],
      wantAssertionsSigned: true,
    });
    const idpEntity = samlify.IdentityProvider({
      entityID: SAML_IDP,
      privateKey: SAML_KEY,
      signingCert: SAML_CERT,
      singleSignOnService: [{ Binding: samlify.Constants.namespace.binding.redirect, Location: entryPoint }],
    });
    const request = await idpEntity.parseLoginRequest(sp, "redirect", { query: Object.fromEntries(url.searchParams) });
    const response = await idpEntity.createLoginResponse(sp, { ...request }, "post", { email }, { relayState: url.searchParams.get("RelayState") ?? "" });
    const body = { SAMLResponse: response.context, RelayState: url.searchParams.get("RelayState") };
    const done = await browser.req(`/api/auth/sso/saml2/sp/acs/${providerId}`, { body });
    expect(done.status, done.text).toBe(302);
    expect(done.headers.get("location")).toMatch(/\/home$/);
    const session = (await browser.req("/api/auth/get-session")).json;
    expect(session.user.email).toBe(email);
    expect(await whoami(await jwtOf(browser))).toMatchObject({ subject: session.user.id, claims: { email } });

    // The same assertion again: replay detected.
    const again = await new Client().req(`/api/auth/sso/saml2/sp/acs/${providerId}`, { body });
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toMatch(/error=/);
    // A response signed with another key does not verify.
    const { privateKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]) as CryptoKeyPair;
    const pkcs8 = btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer)));
    const forger = samlify.IdentityProvider({
      entityID: SAML_IDP,
      privateKey: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`,
      signingCert: SAML_CERT,
      singleSignOnService: [{ Binding: samlify.Constants.namespace.binding.redirect, Location: entryPoint }],
    });
    const start2 = await browser.req("/api/auth/sign-in/sso", { body: { providerId, callbackURL: "/home" } });
    const url2 = new URL(start2.json.url);
    const forged = await forger.createLoginResponse(sp, { ...(await forger.parseLoginRequest(sp, "redirect", { query: Object.fromEntries(url2.searchParams) })) }, "post", { email: `ceo@${slug}.test` });
    const refused = await new Client().req(`/api/auth/sso/saml2/sp/acs/${providerId}`, { body: { SAMLResponse: forged.context, RelayState: url2.searchParams.get("RelayState") } });
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toMatch(/error=/);
  });
});
