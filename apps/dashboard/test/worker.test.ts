import { beforeEach, describe, expect, it } from "vitest";
import { functionStatsSql, parseFunctionStats } from "../src/metrics-sql.ts";
import { clearCapabilities, createDashboard, handleApi, verifyAccessJwt, type DashboardEnv } from "../src/worker.ts";
import { registry } from "./helpers.ts";

const get = (path: string, env: DashboardEnv, headers: Record<string, string> = {}, fetchImpl?: typeof fetch) => {
  const url = new URL(`https://dash.example${path}`);
  return handleApi(new Request(url, { headers }), env, url, fetchImpl);
};
const auth = { authorization: "Bearer dash-secret" };

describe("dashboard auth", () => {
  it("locked without Access or a token; token fallback works", async () => {
    expect((await get("/api/me", {})).status).toBe(403);
    const env: DashboardEnv = { DASHBOARD_TOKEN: "dash-secret" };
    expect((await get("/api/me", env)).status).toBe(401);
    expect((await get("/api/me", env, { authorization: "Bearer nope" })).status).toBe(401);
    const ok = await get("/api/me", env, auth);
    expect(await ok.json()).toMatchObject({ ok: true, via: "token", who: null, actor: "token", role: "admin", metrics: false, csrf: null });
  });

  it("verifies Cloudflare Access JWTs (RS256, audience, expiry, team certs)", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
    const b64 = (x: string | Uint8Array) => Buffer.from(x).toString("base64url");
    const sign = async (payload: Record<string, unknown>) => {
      const h = b64(JSON.stringify({ alg: "RS256", kid: "k1" }));
      const p = b64(JSON.stringify(payload));
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`)));
      return `${h}.${p}.${b64(sig)}`;
    };
    let certFetches = 0;
    const fetchImpl = (async (u: string) => {
      expect(String(u)).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/certs");
      certFetches++;
      return new Response(JSON.stringify({ keys: [jwk] }));
    }) as typeof fetch;
    const exp = Math.floor(Date.now() / 1000) + 600;
    const good = await sign({ aud: ["aud1"], exp, iss: "https://team.cloudflareaccess.com", email: "ana@example.com" });
    const o = { teamDomain: "team.cloudflareaccess.com", aud: "aud1", fetch: fetchImpl };
    expect(await verifyAccessJwt(good, o)).toEqual({ email: "ana@example.com" });
    expect(await verifyAccessJwt(await sign({ aud: "other", exp }), o)).toBeNull();
    expect(await verifyAccessJwt(await sign({ aud: "aud1", exp: 1 }), o)).toBeNull();
    expect(await verifyAccessJwt(good.slice(0, -4) + "AAAA", o)).toBeNull();
    const env: DashboardEnv = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud1" };
    const me = await get("/api/me", env, { "cf-access-jwt-assertion": good }, fetchImpl);
    expect(await me.json()).toMatchObject({ via: "access", who: "ana@example.com", role: "read" });
    expect((await get("/api/me", env, {}, fetchImpl)).status).toBe(401);
    expect(certFetches).toBe(1);
  });
});

beforeEach(() => clearCapabilities());

describe("dashboard API", () => {
  it("projects, deployments and the shard catalog from the registry", async () => {
    const env: DashboardEnv = { DASHBOARD_TOKEN: "dash-secret", REGISTRY: registry() };
    const p = (await (await get("/api/projects", env, auth)).json()) as any;
    expect(p.projects).toMatchObject([{ name: "chat", repo: "git@x:chat", envs: [{ env: "dev", worker: "ember-chat-dev", shards: 0 }, { env: "prod", worker: "ember-chat-prod", shards: 1, last_deploy: 5 }] }]);
    const d = (await (await get("/api/deployments?project=chat&env=prod", env, auth)).json()) as any;
    expect(d.deployments).toMatchObject([{ version_id: "v1", strategy: "create" }]);
    const s = (await (await get("/api/shards?project=chat&env=prod", env, auth)).json()) as any;
    expect(s.shards).toMatchObject([{ shard: "org:acme", db_size: 8192 }]);
    expect((await get("/api/shards?project=Bad&env=prod", env, auth)).status).toBe(400);
  });

  it("proxies admin endpoints through a service binding with the project's admin token", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const svc = {
      fetch: async (r: Request | string) => {
        const req = r as Request;
        seen.push({ url: req.url, auth: req.headers.get("authorization") });
        return new Response(JSON.stringify({ ok: true, shards: [{ shard: "org:acme", ready: true }] }), { headers: { "content-type": "application/json" } });
      },
    };
    const env: DashboardEnv = {
      DASHBOARD_TOKEN: "dash-secret",
      REGISTRY: registry(),
      EMBER_ADMIN_TOKENS: JSON.stringify({ "ember-chat-prod": "proj-admin" }),
      EMBER_SERVICES: JSON.stringify({ "ember-chat-prod": "EMBER_SVC_0" }),
      EMBER_SVC_0: svc,
    };
    const s = (await (await get("/api/shards?project=chat&env=prod&status=1", env, auth)).json()) as any;
    expect(s.status.shards[0].ready).toBe(true);
    const data = await get("/api/data?project=chat&env=prod&shard=org:acme&table=messages&cursor=5&evil=1", env, auth);
    expect(data.status).toBe(200);
    expect(seen.map((x) => x.url)).toEqual([
      "https://ember-chat-prod.internal/api/_ember/status?shard=org%3Aacme",
      "https://ember-chat-prod.internal/api/_ember/capabilities",
      "https://ember-chat-prod.internal/api/_ember/data?shard=org%3Aacme&table=messages&cursor=5",
    ]);
    expect(seen.every((x) => x.auth === "Bearer proj-admin")).toBe(true);
    expect((await get("/api/crons?project=chat&env=nope", env, auth)).status).toBe(404);
  });

  it("falls back to the public URL, and explains a missing admin token", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(String(u));
      return Response.json({ ok: true, crons: [] });
    }) as typeof fetch;
    const env: DashboardEnv = { DASHBOARD_TOKEN: "dash-secret", REGISTRY: registry() };
    expect((await get("/api/crons?project=chat&env=prod", env, auth, fetchImpl)).status).toBe(412);
    env.EMBER_ADMIN_TOKEN = "shared";
    expect((await get("/api/crons?project=chat&env=prod", env, auth, fetchImpl)).status).toBe(200);
    expect(urls).toEqual(["https://ember-chat-prod.acme.workers.dev/api/_ember/capabilities", "https://ember-chat-prod.acme.workers.dev/api/_ember/crons"]);
  });

  it("functions: Analytics Engine SQL with the stored API token", async () => {
    let body = "";
    const fetchImpl = (async (u: string, init: RequestInit) => {
      expect(String(u)).toBe("https://api.cloudflare.com/client/v4/accounts/acc/analytics_engine/sql");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer cf");
      body = String(init.body);
      return new Response(JSON.stringify({ data: [{ project: "chat", env: "prod", fn: "m:send", kind: "mutation", timing: "rpc", calls: 10, errors: 1, p50: 2, p95: 9, rows_read: 50, rows_written: 20, bytes_out: 400 }], rows: 1 }));
    }) as typeof fetch;
    const env: DashboardEnv = { DASHBOARD_TOKEN: "dash-secret", REGISTRY: registry() };
    expect((await get("/api/functions?project=chat&env=prod", env, auth, fetchImpl)).status).toBe(412);
    Object.assign(env, { CF_API_TOKEN: "cf", CF_ACCOUNT_ID: "acc", METRICS_DATASET: "ember_spike_metrics" });
    const r = (await (await get("/api/functions?project=chat&env=prod&hours=6", env, auth, fetchImpl)).json()) as any;
    expect(r.functions).toEqual([{ project: "chat", env: "prod", fn: "m:send", kind: "mutation", timing: "rpc", calls: 10, errors: 1, errorRate: 0.1, p50: 2, p95: 9, rowsRead: 50, rowsWritten: 20, avgRowsRead: 5, bytesOut: 400 }]);
    expect(body).toContain("FROM ember_spike_metrics");
    expect(body).toContain("blob1 = 'chat' AND blob2 = 'prod'");
    expect(body).toContain("INTERVAL '6' HOUR");
    // Real AE (platform E2E): IF() branches must share a type (Double), 0 would be refused with 422.
    expect(body).toContain("_sample_interval * double5, 0.0)");
  });

  it("per-function series and errors: bucketed by window, the function name checked", async () => {
    const { functionSeriesSql, functionErrorsSql, parseFunctionSeries, bucketMinutes } = await import("../src/metrics-sql.ts");
    const sql = functionSeriesSql({ dataset: "ember_metrics", project: "chat", env: "prod", fn: "messages:send", sinceHours: 24 });
    expect(sql).toContain("toStartOfInterval(timestamp, INTERVAL '15' MINUTE) AS t");
    expect(sql).toContain("blob4 = 'messages:send'");
    expect([1, 6, 24, 72, 168].map(bucketMinutes)).toEqual([1, 5, 15, 60, 240]);
    expect(() => functionSeriesSql({ dataset: "ember_metrics", project: "chat", env: "prod", fn: "x' OR 1=1 --", sinceHours: 1 })).toThrow();
    expect(functionErrorsSql({ dataset: "ember_metrics", project: "chat", env: "prod", fn: "a:b", sinceHours: 6 })).toContain("blob6 = 'error'");
    expect(parseFunctionSeries({ data: [{ t: "2026-11-14 10:15:00", calls: "3", errors: 1, p50: 2, p95: 9, rows_read: 4, rows_written: 1 }] })).toEqual([
      { t: Date.UTC(2026, 10, 14, 10, 15), calls: 3, errors: 1, p50: 2, p95: 9, rowsRead: 4, rowsWritten: 1 },
    ]);
  });

  it("SQL builder refuses injection in names", () => {
    expect(() => functionStatsSql({ dataset: "x; DROP" })).toThrow();
    expect(() => functionStatsSql({ dataset: "ok", project: "a' OR 1" })).toThrow();
    expect(parseFunctionStats({})).toEqual([]);
  });

  it("serves the SPA with a strict CSP", async () => {
    const app = createDashboard({ html: "<html></html>", js: "console.log(1)", css: "body{}" });
    const html = await app.fetch(new Request("https://dash.example/p/x"), {});
    expect(html.headers.get("content-security-policy")).toContain("default-src 'none'; script-src 'self'; style-src 'self'");
    expect(html.headers.get("content-security-policy")).not.toContain("unsafe");
    expect(await html.text()).toBe("<html></html>");
    expect((await app.fetch(new Request("https://dash.example/app.js"), {})).headers.get("content-type")).toMatch(/javascript/);
    expect((await app.fetch(new Request("https://dash.example/api/projects", { method: "POST" }), {})).status).toBe(405);
    expect((await app.fetch(new Request("https://dash.example/api/projects", { method: "OPTIONS" }), {})).status).toBe(405);
  });
});
