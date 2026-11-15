/**
 * expo: what a React Native client does. No browser `Origin`: the client sends `expo-origin` (its app scheme), the
 * plugin turns it into the origin Better Auth checks against `trustedOrigins`, and the client keeps a bearer token
 * (no cookie jar) that it trades for Ember JWTs. Deep links get the session cookie in the URL.
 */
import { describe, expect, it } from "vitest";
import { APP_SCHEME, magicLinks } from "./auth.config.ts";
import { IDP, idp } from "./fakes.ts";
import { claimsOf, Client, ORIGIN, password, rnd, signedUp, whoami } from "./helpers.ts";
import { worker } from "../helpers.ts";
import { auth } from "./worker.ts";

/** A request as the Expo client sends it: no Origin header, the app scheme in `expo-origin`, a bearer token. */
async function mobile(path: string, o: { body?: unknown; expoOrigin?: string | null; origin?: string; bearer?: string } = {}) {
  const headers = new Headers();
  if (o.expoOrigin !== null) headers.set("expo-origin", o.expoOrigin ?? APP_SCHEME);
  if (o.origin) headers.set("origin", o.origin);
  if (o.bearer) headers.set("authorization", `Bearer ${o.bearer}`);
  if (o.body !== undefined) headers.set("content-type", "application/json");
  const res = await worker.fetch(`${ORIGIN}${path}`, {
    method: o.body !== undefined ? "POST" : "GET",
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : null,
    redirect: "manual",
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

describe("expo", () => {
  it("sign-up and sign-in with the app scheme as origin; bearer token → Ember JWT → ctx.auth", async () => {
    const email = `rn-${rnd()}@example.test`;
    const up = await mobile("/api/auth/sign-up/email", { body: { email, password, name: "Mobile", callbackURL: `${APP_SCHEME}home` } });
    expect(up.status, up.text).toBe(200);
    const bearer = up.headers.get("set-auth-token")!;
    expect(bearer).toBeTruthy();

    // An app scheme that is not trusted is refused (the callback must be one of `trustedOrigins`).
    const evil = await mobile("/api/auth/sign-in/email", { body: { email, password, callbackURL: "evil://steal" }, expoOrigin: "evil://" });
    expect(evil.status).toBe(403);

    const si = await mobile("/api/auth/sign-in/email", { body: { email, password, callbackURL: `${APP_SCHEME}home` } });
    expect(si.status, si.text).toBe(200);
    const token = si.headers.get("set-auth-token")!;
    expect((await mobile("/api/auth/get-session", { bearer: token })).json.user.email).toBe(email);
    const jwt = (await mobile("/api/auth/token", { bearer: token })).json.token as string;
    expect(claimsOf(jwt).email).toBe(email);
    expect((await whoami(jwt))?.claims.email).toBe(email);
  });

  it("a deep link (magic link → app scheme) carries the session cookie for the app to store", async () => {
    const email = `rn-ml-${rnd()}@example.test`;
    expect((await mobile("/api/auth/sign-in/magic-link", { body: { email, callbackURL: `${APP_SCHEME}signed-in` } })).status).toBe(200);
    const link = magicLinks.findLast((m) => m.email === email)!;
    const verify = await mobile(`/api/auth/magic-link/verify?token=${link.token}&callbackURL=${encodeURIComponent(`${APP_SCHEME}signed-in`)}`);
    expect(verify.status).toBe(302);
    const location = new URL(verify.headers.get("location")!);
    expect(location.protocol).toBe("myapp:");
    const cookie = location.searchParams.get("cookie")!;
    expect(cookie).toContain("plug.session_token=");
    // The app replays that cookie: it is a session like any other.
    const sessionCookie = cookie.split(/,\s*(?=plug\.)/).map((c) => c.split(";")[0]).join("; ");
    const gs = await new Client().req("/api/auth/get-session", { headers: { cookie: sessionCookie } });
    expect(gs.json.user.email).toBe(email);
  });

  it("sso from the app: the authorization proxy sends the in-app browser to the IdP it issued the state for", async () => {
    const owner = await signedUp("rn-sso-owner");
    const slug = `rn-${rnd()}`;
    const org = await owner.c.req("/api/auth/organization/create", { body: { name: "RN Corp", slug } });
    const clientId = `rn-client-${rnd()}`;
    idp.clients.set(clientId, "rn-secret");
    const reg = await owner.c.req("/api/auth/sso/register", {
      body: { providerId: `rn-${slug}`, issuer: IDP, domain: `${slug}.test`, organizationId: org.json.id, oidcConfig: { clientId, clientSecret: "rn-secret", pkce: true, discoveryEndpoint: `${IDP}/.well-known/openid-configuration` } },
    });
    expect(reg.status, reg.text).toBe(200);
    const start = await mobile("/api/auth/sign-in/sso", { body: { email: `emp@${slug}.test`, callbackURL: `${APP_SCHEME}home` } });
    expect(start.status, start.text).toBe(200);
    const proxy = await mobile(`/api/auth/expo-authorization-proxy?authorizationURL=${encodeURIComponent(start.json.url)}`);
    expect(proxy.status, proxy.text).toBe(302);
    expect(proxy.headers.get("location")).toBe(start.json.url);
    // Only the IdP origin the sign-in issued is proxied (no open redirect).
    const other = new URL(start.json.url);
    other.host = "attacker.test";
    expect((await mobile(`/api/auth/expo-authorization-proxy?authorizationURL=${encodeURIComponent(other.toString())}`)).status).toBe(400);
  });

  it("with every plugin on, passwords are still hashed in the Worker (strictHashing would have thrown in the DO)", async () => {
    const s = await auth.stub().stats();
    expect(s.localHashes).toBe(0);
    expect(s.plannedHashes).toBeGreaterThan(0);
    expect(s.plannedVerifies).toBeGreaterThan(0);
  });
});
