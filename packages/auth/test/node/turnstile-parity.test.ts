/**
 * The Worker's Turnstile gate (`src/turnstile.ts`) against what it replaces: Better Auth's `captcha()` plugin
 * (provider `cloudflare-turnstile`) behind the wrapper Ember used until 0.8 (copied below as `pluginGate`). Both run
 * against the same scripted siteverify (`globalThis.fetch` replaced), and must answer the same responses after sending
 * the same requests: paths and wildcards, the `remoteip` Better Auth derives, every way siteverify can answer.
 */
import { getIP } from "@better-auth/core/utils/ip";
import { captcha } from "better-auth/plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIP, turnstileGate, wildcardMatch, type TurnstileGateOptions, type TurnstileSettings } from "../../src/turnstile.ts";

const SITEVERIFY = "https://siteverify.test/turnstile/v0/siteverify";

/** The pre-0.8.2 gate: Better Auth's plugin, as `src/turnstile.ts` ran it. */
function pluginGate(settings: TurnstileSettings | true, options: TurnstileGateOptions) {
  const s: TurnstileSettings = settings === true ? {} : settings;
  const secretEnv = s.secretEnv ?? "TURNSTILE_SECRET_KEY";
  const ctxOptions = {
    basePath: options.basePath,
    advanced: { ...options.advanced, ipAddress: { ...options.advanced?.ipAddress, ipAddressHeaders: options.advanced?.ipAddress?.ipAddressHeaders ?? ["cf-connecting-ip", "x-forwarded-for"] } },
  };
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
  return async (request: Request, env: Record<string, unknown>): Promise<Response | null> => {
    if (request.method === "OPTIONS") return null;
    const secretKey = typeof env[secretEnv] === "string" ? (env[secretEnv] as string) : "";
    const plugin = captcha({
      provider: "cloudflare-turnstile",
      secretKey,
      ...(s.endpoints ? { endpoints: s.endpoints } : {}),
      ...(s.expectedAction ? { expectedAction: s.expectedAction } : {}),
      ...(s.allowedHostnames ? { allowedHostnames: s.allowedHostnames } : {}),
      ...(s.siteVerifyURL ? { siteVerifyURLOverride: s.siteVerifyURL } : {}),
    });
    if (!secretKey) {
      const probe = await plugin.onRequest!(request, { options: ctxOptions, logger } as never);
      if (!probe) return null;
      return new Response(JSON.stringify({ code: "CAPTCHA_NOT_CONFIGURED", message: "Captcha is not configured on this server" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    const out = (await plugin.onRequest!(request, { options: ctxOptions, logger } as never)) as { response?: Response } | undefined;
    return out?.response ?? null;
  };
}

type Answer = { status?: number; body?: string; type?: string | null } | "network-error";
let answer: Answer = { body: JSON.stringify({ success: true }) };
let calls: Array<{ url: string; method: string; contentType: string | null; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    calls.push({ url: req.url, method: req.method, contentType: req.headers.get("content-type"), body: JSON.parse(await req.text()) });
    if (answer === "network-error") throw new TypeError("fetch failed");
    const headers = answer.type === null ? undefined : { "content-type": answer.type ?? "application/json" };
    return new Response(answer.body ?? "", { status: answer.status ?? 200, ...(headers ? { headers } : {}) });
  });
});
afterEach(() => vi.restoreAllMocks());

const ENV = { TURNSTILE_SECRET_KEY: "s3cret" };

async function both(o: { settings?: TurnstileSettings | true; options?: TurnstileGateOptions; path?: string; method?: string; headers?: Record<string, string>; env?: Record<string, unknown> }) {
  const settings = o.settings ?? { siteVerifyURL: SITEVERIFY };
  const options = o.options ?? { basePath: "/api/auth" };
  const run = async (gate: ReturnType<typeof turnstileGate>) => {
    calls = [];
    const request = new Request(`https://app.test${o.path ?? "/api/auth/sign-up/email"}`, {
      method: o.method ?? "POST",
      headers: { "x-captcha-response": "tok", "cf-connecting-ip": "203.0.113.7", ...o.headers },
      ...((o.method ?? "POST") === "POST" ? { body: "{}" } : {}),
    });
    const res = await gate(request, o.env ?? ENV);
    return { res: res && { status: res.status, body: await res.text(), type: res.headers.get("content-type") }, calls };
  };
  const before = await run(pluginGate(settings, options));
  const after = await run(turnstileGate(settings, options));
  expect(after).toEqual(before);
  return after;
}

describe("Turnstile gate: parity with Better Auth's captcha plugin", () => {
  it("passes, rejects and fails closed as the plugin does for every siteverify answer", async () => {
    const answers: Answer[] = [
      { body: JSON.stringify({ success: true, hostname: "app.test", action: "login" }) },
      { body: JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }) },
      { body: JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"], hostname: "app.test", action: "x" }) },
      { body: JSON.stringify({ success: "yes" }) },
      { body: JSON.stringify({}) },
      { body: "null" },
      { body: "0" },
      { body: "" },
      { body: "<html>oops</html>", type: "text/html" },
      { body: "not json", type: null },
      { body: JSON.stringify({ success: true }), type: "application/octet-stream" },
      { body: JSON.stringify({ success: true }), type: "application/problem+json; charset=utf-8" },
      { status: 500, body: JSON.stringify({ success: true }) },
      { status: 429, body: "slow down", type: "text/plain" },
      "network-error",
    ];
    const statuses: Array<number | null> = [];
    for (answer of answers) statuses.push((await both({})).res?.status ?? null);
    expect(statuses).toEqual([null, 403, 403, null, 403, 500, 500, 500, 403, 403, 403, null, 500, 500, 500]);
  });

  it("sends the same siteverify request (secret, response, remoteip) once", async () => {
    answer = { body: JSON.stringify({ success: true }) };
    const r = await both({});
    expect(r.calls).toEqual([{ url: SITEVERIFY, method: "POST", contentType: "application/json", body: { secret: "s3cret", response: "tok", remoteip: "203.0.113.7" } }]);
  });

  it("expectedAction and allowedHostnames", async () => {
    answer = { body: JSON.stringify({ success: true, hostname: "app.test", action: "login" }) };
    for (const settings of [
      { expectedAction: "login" },
      { expectedAction: "signup" },
      { allowedHostnames: ["app.test"] },
      { allowedHostnames: ["other.test"] },
      { allowedHostnames: [] },
      { expectedAction: "login", allowedHostnames: ["other.test", "app.test"] },
    ]) {
      await both({ settings: { siteVerifyURL: SITEVERIFY, ...settings } });
    }
    answer = { body: JSON.stringify({ success: true }) };
    expect((await both({ settings: { siteVerifyURL: SITEVERIFY, allowedHostnames: ["app.test"] } })).res?.status).toBe(403);
  });

  it("gates the same paths (defaults, custom endpoints, wildcards, base path, slashes, methods)", async () => {
    answer = { body: JSON.stringify({ success: false }) };
    const paths = [
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/email",
      "/api/auth/request-password-reset",
      "/api/auth/sign-in/email/",
      "/api/auth//sign-in//email",
      "/api/auth/sign-in/social",
      "/api/auth/get-session",
      "/api/auth",
      "/api/authsign-in/email",
      "/elsewhere/sign-in/email",
      "/sign-in/email",
    ];
    const endpointSets = [undefined, [], ["/sign-in/*"], ["/**"], ["/sign-*/email"], ["/two-factor/**", "/get-session"], ["/sign-in/emai?"], ["*"], ["/a.b+(c)"]];
    for (const endpoints of endpointSets) {
      for (const path of paths) {
        for (const method of ["POST", "GET", "OPTIONS"]) {
          await both({ settings: { siteVerifyURL: SITEVERIFY, ...(endpoints ? { endpoints } : {}) }, path, method });
        }
      }
    }
    await both({ options: { basePath: "/auth" }, path: "/auth/sign-in/email" });
    await both({ options: {}, path: "/api/auth/sign-in/email" });
  });

  it("missing token, missing secret", async () => {
    expect((await both({ headers: { "x-captcha-response": "" } })).res).toMatchObject({ status: 400 });
    expect((await both({ env: {} })).res).toMatchObject({ status: 500 });
    expect((await both({ env: {}, path: "/api/auth/get-session" })).res).toBeNull();
    expect((await both({ env: { MY_KEY: "k" }, settings: { siteVerifyURL: SITEVERIFY, secretEnv: "MY_KEY" } })).calls).toHaveLength(1);
  });

  it("derives the same remoteip from the request headers and ipAddress options", async () => {
    answer = { body: JSON.stringify({ success: true }) };
    const ips = ["203.0.113.7", "2001:db8:abcd:12:1:2:3:4", "2001:DB8::1", "::ffff:192.0.2.1", "::ffff:c000:0201", "0:0:0:0:0:ffff:c000:0201", "1.2.3.4, 5.6.7.8", " 9.9.9.9 ", "999.1.1.1", "not-an-ip", "::1", "fe80::1%eth0", "::@1\\", ""];
    const optionSets: TurnstileGateOptions[] = [
      { basePath: "/api/auth" },
      { basePath: "/api/auth", advanced: { ipAddress: { ipv6Subnet: 128 } } },
      { basePath: "/api/auth", advanced: { ipAddress: { ipv6Subnet: 48 } } },
      { basePath: "/api/auth", advanced: { ipAddress: { disableIpTracking: true } } },
      { basePath: "/api/auth", advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } } },
      { basePath: "/api/auth", advanced: { ipAddress: { ipAddressHeaders: [] } } },
      { basePath: "/api/auth", advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: ["5.6.7.0/24", "bogus"] } } },
      { basePath: "/api/auth", advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: ["2001:db8::/32"] } } },
    ];
    for (const options of optionSets) {
      for (const ip of ips) {
        await both({ options, headers: { "cf-connecting-ip": ip, "x-forwarded-for": ip, "x-real-ip": ip } });
        await both({ options, headers: { "cf-connecting-ip": "", "x-forwarded-for": `1.1.1.1, ${ip}` } });
      }
    }
  });

  it("clientIP is Better Auth's getIP", () => {
    const values = ["10.0.0.1", "2001:db8::8a2e:370:7334", "::ffff:10.0.0.1", "a, b", "10.0.0.1, 10.0.0.2", "::", "1:2:3:4:5:6:7:8", "1::2::3", "12345::", "::ffff:1.2.3"];
    for (const v of values) {
      for (const ipAddress of [{}, { ipv6Subnet: 64 }, { trustedProxies: ["10.0.0.2"] }, { ipAddressHeaders: ["x-ip"] }]) {
        const headers = new Headers({ "x-forwarded-for": v, "x-ip": v });
        expect(clientIP(headers, ipAddress)).toBe(getIP(headers, { advanced: { ipAddress } } as never));
      }
    }
  });

  it("wildcardMatch is Better Auth's", async () => {
    const { wildcardMatch: theirs } = (await import("../../node_modules/better-auth/dist/utils/wildcard.mjs" as string)) as { wildcardMatch: (p: string) => (s: string) => boolean };
    const patterns = ["/sign-in/*", "/**", "**", "/a/**/b", "/a/*/b", "/x?", "*", "/a\\*b", "/a.b", "/sign-*/email", "/trail/"];
    const samples = ["/sign-in/email", "/sign-in/a/b", "/a/b", "/a/x/b", "/a/x/y/b", "/x1", "/x12", "/a*b", "/axb", "/a.b", "/aXb", "/sign-up/email", "/trail", "/trail/", ""];
    for (const p of patterns) for (const s of samples) expect([p, s, wildcardMatch(p)(s)]).toEqual([p, s, theirs(p)(s)]);
  });
});
