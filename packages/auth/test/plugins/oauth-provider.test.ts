/**
 * oauthProvider: the Ember project as an OAuth 2.1 / OpenID Connect provider for a third-party app. The tokens it
 * issues are signed with the same keys as Ember's own JWTs (the jwt plugin Ember injects), so the test also pins
 * that an OAuth token handed to a third party is not an Ember session.
 */
import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { b64url } from "./fakes.ts";
import { Client, claimsOf, ORIGIN, rnd, signedUp, whoami } from "./helpers.ts";
import { worker } from "../helpers.ts";
import { auth } from "./worker.ts";

const REDIRECT = "https://client.test/callback";

const form = async (path: string, params: Record<string, string>, headers: Record<string, string> = {}) => {
  const res = await worker.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

describe("oauthProvider", () => {
  it("register a client, authorization code + PKCE, consent, token, userinfo, JWKS; refresh", async () => {
    const dev = await signedUp("oauth-dev", "Developer");
    const created = await dev.c.req("/api/auth/oauth2/create-client", {
      body: {
        client_name: "Third party",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    });
    expect(created.status, created.text).toBe(201);
    const { client_id: clientId, client_secret: clientSecret } = created.json as { client_id: string; client_secret: string };
    expect(clientSecret).toBeTruthy();
    const basic = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;

    // Discovery at the issuer (the origin): Ember routes these two paths to the Auth DO when the plugin is on.
    const discovery = await new Client().req("/.well-known/openid-configuration");
    expect(discovery.status, discovery.text).toBe(200);
    expect(discovery.json).toMatchObject({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`, token_endpoint: `${ORIGIN}/api/auth/oauth2/token`, jwks_uri: `${ORIGIN}/api/auth/jwks` });
    expect((await new Client().req("/.well-known/oauth-authorization-server")).json).toMatchObject({ issuer: ORIGIN });
    expect(auth.staticSettings.issuerMetadata).toBe(true);

    // The user, signed in at the provider, is sent to the consent page, accepts, and goes back to the client.
    const user = await signedUp("oauth-user", "Resource Owner");
    const { verifier, challenge } = await pkce();
    const state = rnd();
    const nonce = rnd();
    const authorize = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "openid email profile offline_access",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const toConsent = await user.c.req(`/api/auth/oauth2/authorize?${authorize}`);
    expect(toConsent.status, toConsent.text).toBe(302);
    const consentUrl = new URL(toConsent.headers.get("location")!, ORIGIN);
    expect(consentUrl.pathname).toBe("/consent");
    const consent = await user.c.req("/api/auth/oauth2/consent", { body: { accept: true, oauth_query: consentUrl.search.slice(1) } });
    expect(consent.status, consent.text).toBe(200);
    const back = new URL(consent.json.url ?? consent.json.redirect_uri);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe(state);
    const code = back.searchParams.get("code")!;

    // The client's backend: PKCE + client secret.
    const v2 = verifier;
    const token = await form("/api/auth/oauth2/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: v2 }, { authorization: basic });
    expect(token.status, JSON.stringify(token.json)).toBe(200);
    expect(token.json).toMatchObject({ token_type: expect.stringMatching(/bearer/i), access_token: expect.any(String), id_token: expect.any(String), refresh_token: expect.any(String) });

    // Consent is remembered: a second authorization goes straight back with a code, which a wrong PKCE verifier
    // cannot redeem.
    const p2 = await pkce();
    authorize.set("code_challenge", p2.challenge);
    const again = await user.c.req(`/api/auth/oauth2/authorize?${authorize}`);
    expect(again.status, again.text).toBe(302);
    const code2 = new URL(again.headers.get("location")!).searchParams.get("code")!;
    expect(code2).toBeTruthy();
    expect((await form("/api/auth/oauth2/token", { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: verifier }, { authorization: basic })).status).toBe(400);

    // The id_token verifies against the provider's JWKS (the same keys Ember signs its own JWTs with).
    const jwks = (await new Client().req("/api/auth/jwks")).json;
    const { payload } = await jwtVerify(token.json.id_token, createLocalJWKSet(jwks), { issuer: ORIGIN, audience: clientId });
    expect(payload).toMatchObject({ sub: user.user.id, nonce, aud: clientId });

    const info = await new Client().req("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${token.json.access_token}` } });
    expect(info.status, info.text).toBe(200);
    expect(info.json).toMatchObject({ sub: user.user.id, email: user.email });

    const refreshed = await form("/api/auth/oauth2/token", { grant_type: "refresh_token", refresh_token: token.json.refresh_token }, { authorization: basic });
    expect(refreshed.status, JSON.stringify(refreshed.json)).toBe(200);
    expect(refreshed.json.access_token).not.toBe(token.json.access_token);

    // The code is single use (a replay revokes what it issued, per OAuth 2.1).
    expect((await form("/api/auth/oauth2/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: v2 }, { authorization: basic })).status).toBe(400);
    expect((await new Client().req("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${token.json.access_token}` } })).status).toBe(401);
    // What the third party holds is not an Ember session: neither token opens `ctx.auth`.
    expect(await auth.verify(token.json.id_token)).toBeNull();
    expect(await auth.verify(token.json.access_token)).toBeNull();
    expect(await whoami(token.json.id_token)).toBeNull();
    expect(await whoami(token.json.access_token)).toBeNull();
    if (token.json.access_token.split(".").length === 3) expect(claimsOf(token.json.access_token).aud).not.toBe(ORIGIN);
  });
});
