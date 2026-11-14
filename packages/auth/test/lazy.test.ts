/**
 * `emberAuthLazy` (what the generated Worker entry uses): Better Auth and the config are loaded only by the Auth DO
 * and `/api/auth/*`; routing, `verify` (all three token kinds), key rotation and the admin calls work without them,
 * and verify exactly like the full `emberAuth`.
 */
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { emberAuthLazy } from "../src/lazy.ts";
import { defineAuth } from "../src/index.ts";
import { authStaticSettings } from "../src/settings.ts";
import config from "./auth.config.ts";
import { Client, ORIGIN, rnd } from "./helpers.ts";
import { knownStatic, lazyAuth } from "./worker.ts";

const password = "correct horse battery staple";
const known = knownStatic;

/** A fresh lazy instance (own counters) on the same Auth DO as the test Worker's `x-lazy` route. */
function fresh(staticSettings: typeof known | null = known) {
  const loads = { impl: 0, config: 0 };
  const a = emberAuthLazy(
    async () => (loads.config++, { default: config }),
    { project: "acme", binding: "AUTH_LAZY", static: staticSettings },
    async () => (loads.impl++, import("../src/worker.ts")),
  );
  return { a, loads };
}

describe("emberAuthLazy", () => {
  const alice = new Client();
  const email = `lazy-${rnd()}@vip.test`;
  const lazy = { "x-lazy": "1" };
  let jwt = "";
  let sessionToken = "";

  it("static settings come from the config (value form) and not from the function form", () => {
    expect(known).toEqual({ basePath: "/api/auth", cookieStrategy: "compact" });
    expect(authStaticSettings(defineAuth({ emailAndPassword: { enabled: true } }))).toEqual({ basePath: "/api/auth", cookieStrategy: "compact" });
    expect(authStaticSettings(defineAuth({ basePath: "/auth", baseURL: "https://x.test", session: { cookieCache: { enabled: true, strategy: "jwe" } } }))).toEqual({
      basePath: "/auth",
      baseURL: "https://x.test",
      cookieStrategy: "jwe",
    });
    expect(authStaticSettings(config)).toBeNull();
  });

  it("other paths and bad tokens are answered without loading Better Auth", async () => {
    const { a, loads } = fresh();
    expect(await a.fetch(new Request(`${ORIGIN}/api/query`))).toBeNull();
    expect(await a.fetch(new Request(`${ORIGIN}/api/authx`))).toBeNull();
    expect(await a.verify("not-a-token")).toBeNull();
    expect(loads).toEqual({ impl: 0, config: 0 });
    expect(a.loaded()).toBe(false);
  });

  it("sign-up and sign-in through the lazy path (password work in the Worker, the DO booted first)", async () => {
    const up = await alice.req("/api/auth/sign-up/email", { body: { email, password, name: "Lazy" }, headers: lazy });
    expect(up.status).toBe(200);
    expect([...alice.jar.keys()]).toContain("acme.session_token");
    const r = await alice.req("/api/auth/sign-in/email", { body: { email, password }, headers: lazy });
    expect(r.status).toBe(200);
    sessionToken = r.headers.get("set-auth-token")!;
    jwt = (await alice.req("/api/auth/token", { headers: lazy })).json.token;
    expect(jwt.split(".")).toHaveLength(3);
    // strictHashing: a hash inside the DO would have thrown; the migration ran before the first call.
    const stats = await lazyAuth.stub().stats();
    expect(stats.localHashes).toBe(0);
    expect(stats.plannedHashes).toBeGreaterThan(0);
    expect(lazyAuth.loaded()).toBe(true);
  });

  it("verifies JWT, cookie cache and session token without loading Better Auth", async () => {
    const { a, loads } = fresh();
    const viaJwt = await a.verifyDetailed(jwt);
    expect(viaJwt?.via).toBe("jwt");
    expect(viaJwt?.identity.issuer).toBe(ORIGIN);
    expect(viaJwt?.identity.claims?.email).toBe(email);
    const viaCookie = await a.verifyRequestDetailed(new Request(`${ORIGIN}/x`, { headers: { cookie: alice.cookieHeader() } }));
    expect(viaCookie?.via).toBe("cookie-cache");
    expect(viaCookie?.identity.subject).toBe(viaJwt?.identity.subject);
    const viaSession = await a.verifyDetailed(sessionToken);
    expect(viaSession?.via).toBe("session");
    expect(viaSession?.identity.subject).toBe(viaJwt?.identity.subject);
    expect((await a.verifySensitive(jwt))?.subject).toBe(viaJwt?.identity.subject);
    expect(loads).toEqual({ impl: 0, config: 0 });
  });

  it("the light verifier agrees with the full one", async () => {
    const full = await lazyAuth.load();
    for (const t of [jwt, sessionToken, alice.jar.get("acme.session_data")!, "garbage"]) {
      const { a } = fresh();
      expect(await a.verifyDetailed(t)).toEqual(await full.verifyDetailed(t));
    }
  });

  it("key rotation and admin calls go to the DO without loading Better Auth in the Worker", async () => {
    const { a, loads } = fresh();
    const jwks = await a.rotateKeys();
    expect(jwks.keys.length).toBeGreaterThan(1);
    // Tokens signed before the rotation keep verifying (grace period).
    expect((await a.verify(jwt))?.claims?.email).toBe(email);
    const users = await a.admin.users(env as never, { q: email });
    expect(users.users.map((u) => u.email)).toEqual([email]);
    expect(loads).toEqual({ impl: 0, config: 0 });
  });

  it("without static settings (function form), the first verify loads the config, once", async () => {
    const { a, loads } = fresh(null);
    expect((await a.verify(jwt))?.claims?.email).toBe(email);
    expect(await a.verify("garbage")).toBeNull();
    expect(loads).toEqual({ impl: 1, config: 1 });
  });

  it("settings that differ from what the config resolves to at runtime are reported", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { a } = fresh({ ...known, cookieStrategy: "jwe" });
    await a.load();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("resolved differently at runtime"))).toBe(true);
    spy.mockRestore();
  });
});
