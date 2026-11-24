/**
 * `emberAuthLazy` (what the generated Worker entry uses): Better Auth and the config are loaded only by the Auth DO
 * and `/api/auth/*`; routing, `verify` (all three token kinds), key rotation and the admin calls work without them,
 * and verify exactly like the full `emberAuth`.
 */
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { emberAuthLazy, type EmberAuthLazySettings } from "../src/lazy.ts";
import type { BetterAuthOptions } from "better-auth";
import { defineAuth, resolveAuthConfig } from "../src/index.ts";
import { authStaticSettings } from "../src/settings.ts";
import config from "./auth.config.ts";
import { Client, ORIGIN, rnd } from "./helpers.ts";
import { knownStatic, lazyAuth } from "./worker.ts";

const password = "correct horse battery staple";
const known = knownStatic;

/** A fresh lazy instance (own counters) on the same Auth DO as the test Worker's `x-lazy` route. */
function fresh(staticSettings: typeof known | null = known, extra: Partial<EmberAuthLazySettings> = {}) {
  const loads = { impl: 0, config: 0 };
  const a = emberAuthLazy(
    async () => (loads.config++, { default: config }),
    { project: "acme", binding: "AUTH_LAZY", static: staticSettings, ...extra },
    async () => (loads.impl++, import("../src/worker.ts")),
  );
  return { a, loads };
}

const SITEVERIFY = "https://siteverify.test/turnstile/v0/siteverify";
/** Scripted siteverify (the gate's `fetch`): records the tokens it was asked about. */
function fakeSiteverify(success = true) {
  const seen: Array<{ response: string; remoteip?: string }> = [];
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url !== SITEVERIFY) return real(req);
    seen.push((await req.json()) as { response: string; remoteip?: string });
    return Response.json({ success });
  });
  return { seen, restore: () => spy.mockRestore() };
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers }, body: JSON.stringify(body) });
const turnstileEnv = { ...(env as unknown as Record<string, unknown>), TURNSTILE_SECRET_KEY: "secret" } as never;

describe("emberAuthLazy", () => {
  const alice = new Client();
  const email = `lazy-${rnd()}@vip.test`;
  const lazy = { "x-lazy": "1" };
  let jwt = "";
  let sessionToken = "";

  it("static settings come from the config (value form) and not from the function form", () => {
    expect(known).toEqual({ basePath: "/api/auth", cookieStrategy: "compact", worker: { hasher: "default" } });
    expect(authStaticSettings(defineAuth({ emailAndPassword: { enabled: true } }))).toEqual({ basePath: "/api/auth", cookieStrategy: "compact", worker: { hasher: "default" } });
    expect(authStaticSettings(defineAuth({ basePath: "/auth", baseURL: "https://x.test", session: { cookieCache: { enabled: true, strategy: "jwe" } } }))).toEqual({
      basePath: "/auth",
      baseURL: "https://x.test",
      cookieStrategy: "jwe",
      worker: { hasher: "default" },
    });
    // What the Worker's own /api/auth work needs: the config's password hooks (both, as `userPasswordHooks`) and ipAddress.
    const hooks = { hash: async (p: string) => p, verify: async () => true };
    expect(authStaticSettings(defineAuth({ emailAndPassword: { enabled: true, password: hooks } }))?.worker).toEqual({ hasher: "config" });
    expect(authStaticSettings(defineAuth({ emailAndPassword: { enabled: true, password: { hash: hooks.hash } } }))?.worker).toEqual({ hasher: "default" });
    const ipAddress = { ipAddressHeaders: ["x-real-ip"], ipv6Subnet: 48 as const, trustedProxies: ["10.0.0.0/8"], disableIpTracking: false };
    expect(authStaticSettings(defineAuth({ advanced: { ipAddress } }))?.worker).toEqual({ hasher: "default", ipAddress });
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

  it("auth routes without password work (get-session, token, jwks) are forwarded without loading Better Auth", async () => {
    const { a, loads } = fresh();
    const session = await a.fetch(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: alice.cookieHeader() } }));
    expect(session?.status).toBe(200);
    expect(((await session!.json()) as { user: { email: string } }).user.email).toBe(email);
    const token = await a.fetch(new Request(`${ORIGIN}/api/auth/token`, { headers: { authorization: `Bearer ${sessionToken}` } }));
    expect(((await token!.json()) as { token: string }).token.split(".")).toHaveLength(3);
    const jwks = await a.fetch(new Request(`${ORIGIN}/api/auth/jwks`));
    expect(jwks?.headers.get("cache-control")).toBe("public, max-age=300");
    const keys = ((await jwks!.json()) as { keys: unknown[] }).keys;
    expect(keys.length).toBeGreaterThan(0);
    // The second one comes from the verifier's cache (no other JWKS read), the same set Better Auth publishes.
    await a.fetch(new Request(`${ORIGIN}/api/auth/jwks`));
    expect((await a.verifyDetailed(jwt))?.via).toBe("jwt");
    expect(keys).toEqual((await lazyAuth.stub().getJwks()).keys);
    expect(loads).toEqual({ impl: 0, config: 0 });
  });

  it("password endpoints: scrypt in the Worker (password.ts), without loading Better Auth or the config", async () => {
    const { a, loads } = fresh();
    const before = await lazyAuth.stub().stats();
    const e2 = `lazy-pw-${rnd()}@vip.test`;
    expect((await a.fetch(post("/api/auth/sign-up/email", { email: e2, password, name: "Pw" })))?.status).toBe(200);
    expect((await a.fetch(post("/api/auth/sign-in/email", { email: e2, password })))?.status).toBe(200);
    expect((await a.fetch(post("/api/auth/sign-in/email", { email: e2, password: "wrong password here" })))?.status).toBe(401);
    // strictHashing in the DO: every hash and verify came with the request's plan.
    const after = await lazyAuth.stub().stats();
    expect(after.localHashes).toBe(before.localHashes);
    expect(after.plannedHashes).toBeGreaterThan(before.plannedHashes);
    expect(after.plannedVerifies - before.plannedVerifies).toBe(2);
    expect(loads).toEqual({ impl: 0, config: 0 });
  });

  it("Turnstile: gated in the Worker without loading Better Auth, the token checked once, /jwks never gated", async () => {
    const sv = fakeSiteverify(true);
    try {
      const { a, loads } = fresh(known, { turnstile: { endpoints: ["/**"], siteVerifyURL: SITEVERIFY } });
      const e3 = `lazy-ts-${rnd()}@vip.test`;
      const missing = await a.fetch(post("/api/auth/sign-up/email", { email: e3, password, name: "Ts" }), turnstileEnv);
      expect(missing?.status).toBe(400);
      expect(await missing!.json()).toEqual({ message: "Missing CAPTCHA response", code: "MISSING_RESPONSE" });
      expect((await a.fetch(post("/api/auth/sign-up/email", { email: e3, password, name: "Ts" }, { "x-captcha-response": "tok-1" }), turnstileEnv))?.status).toBe(200);
      expect(sv.seen).toEqual([{ secret: "secret", response: "tok-1", remoteip: "203.0.113.9" }]);
      const jwks = await a.fetch(new Request(`${ORIGIN}/api/auth/jwks`), turnstileEnv);
      expect(jwks?.status).toBe(200);
      expect(sv.seen).toHaveLength(1);
      expect(loads).toEqual({ impl: 0, config: 0 });
    } finally {
      sv.restore();
    }
  });

  it("Turnstile on /**: GET /jwks is never gated, also when the verifier cannot answer and the DO serves the keys", async () => {
    const sv = fakeSiteverify(true);
    try {
      const turnstile = { endpoints: ["/**"], siteVerifyURL: SITEVERIFY };
      // The verifier's env (settings.env): its JWKS fetch fails, so its cache cannot answer and the DO serves the keys.
      const real = (env as unknown as { AUTH_LAZY: DurableObjectNamespace }).AUTH_LAZY;
      const noKeys = { ...(turnstileEnv as object), AUTH_LAZY: { idFromName: (n: string) => real.idFromName(n), get: () => ({ getJwks: async () => Promise.reject(new Error("down")) }) } } as never;
      const { a } = fresh(known, { turnstile, env: noKeys });
      const lazyJwks = await a.fetch(new Request(`${ORIGIN}/api/auth/jwks`), turnstileEnv);
      expect(lazyJwks?.status).toBe(200);
      expect(lazyJwks?.headers.get("cache-control")).not.toBe("public, max-age=300");
      const { emberAuth } = await import("../src/worker.ts");
      const full = emberAuth(config, { project: "acme", binding: "AUTH_LAZY", turnstile, env: noKeys });
      const fullJwks = await full.fetch(new Request(`${ORIGIN}/api/auth/jwks`), turnstileEnv);
      expect(fullJwks?.status).toBe(200);
      expect(sv.seen).toEqual([]);
      // Other routes stay gated.
      expect((await full.fetch(new Request(`${ORIGIN}/api/auth/get-session`), turnstileEnv))?.status).toBe(400);
    } finally {
      sv.restore();
    }
  });

  it("a divergence found while a request awaits the verifier's JWKS sends that request down the full path", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const real = (env as unknown as { AUTH_LAZY: DurableObjectNamespace }).AUTH_LAZY;
      const slowKeys = { ...(env as object), AUTH_LAZY: { idFromName: (n: string) => real.idFromName(n), get: () => ({ getJwks: async () => (await held, Promise.reject(new Error("down"))) }) } } as never;
      const { a } = fresh({ ...known, cookieStrategy: "jwe" }, { turnstile: { siteVerifyURL: SITEVERIFY }, env: slowKeys });
      const pending = a.fetch(new Request(`${ORIGIN}/api/auth/jwks`), turnstileEnv);
      await a.load();
      expect(a.loaded()).toBe(true);
      release();
      expect((await pending)?.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("Turnstile rejects before any password work or DO call", async () => {
    const sv = fakeSiteverify(false);
    try {
      const { a, loads } = fresh(known, { turnstile: { siteVerifyURL: SITEVERIFY } });
      const before = await lazyAuth.stub().stats();
      const r = await a.fetch(post("/api/auth/sign-in/email", { email: "x@vip.test", password }, { "x-captcha-response": "tok-2" }), turnstileEnv);
      expect(r?.status).toBe(403);
      expect(((await r!.json()) as { code: string }).code).toBe("VERIFICATION_FAILED");
      expect(await lazyAuth.stub().stats()).toEqual(before);
      expect(loads).toEqual({ impl: 0, config: 0 });
    } finally {
      sv.restore();
    }
  });

  it("a config with its own password hooks loads the config for password work, behind one gate", async () => {
    const sv = fakeSiteverify(true);
    try {
      // The test config with its own hooks (Better Auth's scrypt underneath, so the DO's hashes still verify).
      const { hashPassword, verifyPassword } = await import("better-auth/crypto");
      const hooks = { hash: 0, verify: 0 };
      const hooked = defineAuth((e) => {
        const base = resolveAuthConfig(config, e) as BetterAuthOptions;
        return {
          ...base,
          emailAndPassword: {
            ...base.emailAndPassword!,
            password: {
              hash: async (p: string) => (hooks.hash++, hashPassword(p)),
              verify: async (o: { hash: string; password: string }) => (hooks.verify++, verifyPassword(o)),
            },
          },
        };
      });
      const loads = { impl: 0, config: 0 };
      const a = emberAuthLazy(
        async () => (loads.config++, { default: hooked }),
        { project: "acme", binding: "AUTH_LAZY", static: { ...known, worker: { hasher: "config" } }, turnstile: { siteVerifyURL: SITEVERIFY } },
        async () => (loads.impl++, import("../src/worker.ts")),
      );
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const r = await a.fetch(post("/api/auth/sign-in/email", { email, password }, { "x-captcha-response": "tok-3" }), turnstileEnv);
      // The build-time settings are what the runtime config resolves to: no divergence.
      expect(spy.mock.calls.some((c) => String(c[0]).includes("resolved differently at runtime"))).toBe(false);
      spy.mockRestore();
      expect(r?.status).toBe(200);
      expect(hooks.verify).toBe(1);
      expect(sv.seen.map((x) => x.response)).toEqual(["tok-3"]);
      expect(loads).toEqual({ impl: 1, config: 1 });
    } finally {
      sv.restore();
    }
  });

  it("settings from an older CLI (no `worker`) load the config for password work, as before", async () => {
    const { worker: _, ...old } = known;
    const { a, loads } = fresh(old);
    expect((await a.fetch(post("/api/auth/sign-in/email", { email, password })))?.status).toBe(200);
    expect(loads).toEqual({ impl: 1, config: 1 });
    // ...and an older CLI's settings are not a divergence.
    expect(a.loaded()).toBe(true);
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

  it("settings that differ from what the config resolves to at runtime are reported, and that isolate switches to the runtime ones", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { a, loads } = fresh({ ...known, cookieStrategy: "jwe" });
    const cookie = () => new Request(`${ORIGIN}/x`, { headers: { cookie: alice.cookieHeader() } });
    // Build-time "jwe" cannot read the compact cookie cache the DO writes.
    expect((await a.verifyRequestDetailed(cookie()))?.via).not.toBe("cookie-cache");
    expect(loads.impl).toBe(0);
    await a.load();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("resolved differently at runtime"))).toBe(true);
    expect((await a.verifyRequestDetailed(cookie()))?.via).toBe("cookie-cache");
    spy.mockRestore();
  });
});
