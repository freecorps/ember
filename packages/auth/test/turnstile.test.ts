/**
 * Turnstile on the auth routes (ember.json `auth.turnstile`), against Cloudflare's real siteverify with the
 * documented test secrets (https://developers.cloudflare.com/turnstile/troubleshooting/testing/): test secrets
 * accept only the dummy token `XXXX.DUMMY.TOKEN.XXXX`.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { emberAuth } from "../src/worker.ts";
import config from "./auth.config.ts";
import { ORIGIN, rnd } from "./helpers.ts";

const PASS = "1x0000000000000000000000000000000AA";
const FAIL = "2x0000000000000000000000000000000AA";
const SPENT = "3x0000000000000000000000000000000AA";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const password = "correct horse battery staple";

// Worker side only: the Auth DO behind the AUTH binding is the test Worker's (the gate never reaches it on rejection).
const gated = (secret: string | null, turnstile: Parameters<typeof emberAuth>[1]["turnstile"] = true) => {
  const e = { ...(env as unknown as Record<string, unknown>), ...(secret ? { TURNSTILE_SECRET_KEY: secret } : {}) };
  const auth = emberAuth(config, { project: "acme", turnstile, env: e });
  const call = async (path: string, body?: unknown, token?: string) => {
    const headers = new Headers({ origin: ORIGIN, "cf-connecting-ip": "203.0.113.7" });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (token) headers.set("x-captcha-response", token);
    const res = (await auth.fetch(new Request(`${ORIGIN}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), e))!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  };
  return { auth, call };
};

describe("auth.turnstile (Better Auth captcha, provider cloudflare-turnstile)", () => {
  it("sign-up without a token is 400 MISSING_RESPONSE and costs no password hash", async () => {
    const { auth, call } = gated(PASS);
    const r = await call("/api/auth/sign-up/email", { email: `t-${rnd()}@vip.test`, password, name: "T" });
    expect(r).toMatchObject({ status: 400, json: { code: "MISSING_RESPONSE" } });
    expect(auth.workerStats().workerHashes).toBe(0);
  });

  it("the always-pass test secret lets sign-up and sign-in through with the dummy token", async () => {
    const { call } = gated(PASS);
    const email = `t-${rnd()}@vip.test`;
    const up = await call("/api/auth/sign-up/email", { email, password, name: "T" }, TOKEN);
    expect(up.status).toBe(200);
    expect(up.json.user.email).toBe(email);
    expect((await call("/api/auth/sign-in/email", { email, password })).json.code).toBe("MISSING_RESPONSE");
    const inn = await call("/api/auth/sign-in/email", { email, password }, TOKEN);
    expect(inn.status).toBe(200);
  });

  it("the always-fail and token-spent test secrets are 403 VERIFICATION_FAILED", async () => {
    for (const secret of [FAIL, SPENT]) {
      const { auth, call } = gated(secret);
      const r = await call("/api/auth/sign-up/email", { email: `t-${rnd()}@vip.test`, password, name: "T" }, TOKEN);
      expect(r).toMatchObject({ status: 403, json: { code: "VERIFICATION_FAILED" } });
      expect((await call("/api/auth/sign-in/email", { email: "a@b.test", password }, TOKEN)).status).toBe(403);
      expect(auth.workerStats()).toEqual({ workerHashes: 0, workerVerifies: 0 });
    }
  });

  it("other routes are not gated; custom endpoints replace the defaults", async () => {
    const { call } = gated(FAIL);
    expect((await call("/api/auth/get-session")).status).toBe(200);
    const custom = gated(FAIL, { endpoints: ["/sign-in/email"] });
    expect((await custom.call("/api/auth/sign-up/email", { email: `t-${rnd()}@vip.test`, password, name: "T" })).status).toBe(200);
    expect((await custom.call("/api/auth/sign-in/email", { email: "a@b.test", password }, TOKEN)).status).toBe(403);
  });

  it("an expectedAction the token was not minted for is rejected", async () => {
    const { call } = gated(PASS, { expectedAction: "signup" });
    expect((await call("/api/auth/sign-up/email", { email: `t-${rnd()}@vip.test`, password, name: "T" }, TOKEN)).status).toBe(403);
  });

  it("without TURNSTILE_SECRET_KEY the protected routes fail closed (500 CAPTCHA_NOT_CONFIGURED)", async () => {
    const { call } = gated(null);
    expect(await call("/api/auth/sign-up/email", { email: `t-${rnd()}@vip.test`, password, name: "T" }, TOKEN)).toMatchObject({ status: 500, json: { code: "CAPTCHA_NOT_CONFIGURED" } });
    expect((await call("/api/auth/get-session")).status).toBe(200);
  });

  it("refuses a captcha() plugin in auth.config.ts next to auth.turnstile", () => {
    const withPlugin = { ...config, plugins: [...(config.plugins ?? []), { id: "captcha" }] } as typeof config;
    expect(() => emberAuth(withPlugin, { project: "acme", turnstile: true })).toThrow(/mutually exclusive/);
  });
});
