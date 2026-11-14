import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { loadProject, type EmberConfigFile } from "../src/config.ts";
import { addDomain, routeMatchesHost } from "../src/domains.ts";
import { deploy, type DeployOptions } from "../src/deploy/index.ts";
import { CfClient } from "../src/deploy/cf.ts";
import { formatTailEvent, streamLogs } from "../src/logs.ts";
import { buildDashboard, deployDashboard } from "../src/dashboard.ts";
import { D1Registry, RegistryConflictError, SHARDS_TABLE_DDL } from "../src/registry.ts";
import { TMP } from "./helpers.ts";

const root = join(TMP, `registry-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
const fail = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });

/**
 * Fake Cloudflare account: D1 REST API backed by node:sqlite, a Workers API good enough for `deploy`, zones,
 * custom domains and routes. Every call is recorded.
 */
function fakeAccount() {
  const dbs = new Map<string, { name: string; db: DatabaseSync }>();
  const calls: Array<{ method: string; path: string; json?: any; metadata?: any }> = [];
  const workers = new Set<string>();
  const settings = new Map<string, any>();
  const state = { failSettings: false };
  const customDomains: Array<{ hostname: string; service: string; zone_id: string }> = [{ hostname: "taken.example.com", service: "someone-else", zone_id: "z1" }];
  const routes = [{ pattern: "*.legacy.example.com/*", script: "old-worker" }];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "").replace("/accounts/acc", "");
    const method = init?.method ?? "GET";
    const call: (typeof calls)[number] = { method, path: path + url.search };
    if (init?.body instanceof FormData) call.metadata = JSON.parse(await (init.body.get("metadata") as Blob).text());
    else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
    calls.push(call);
    if (method === "GET" && path === "/d1/database") return ok([...dbs].filter(([, d]) => d.name === url.searchParams.get("name")).map(([uuid, d]) => ({ uuid, name: d.name })));
    if (method === "POST" && path === "/d1/database") {
      const uuid = `db-${dbs.size + 1}`;
      dbs.set(uuid, { name: call.json.name, db: new DatabaseSync(":memory:") });
      return ok({ uuid, name: call.json.name });
    }
    const q = path.match(/^\/d1\/database\/([^/]+)\/query$/);
    if (method === "POST" && q) {
      const d = dbs.get(q[1]!);
      if (!d) return fail(404, 7404, "no such database");
      const { sql, params } = call.json as { sql: string; params: any[] };
      try {
        if (!params.length && sql.includes(";")) {
          d.db.exec(sql);
          return ok([{ results: [], success: true }]);
        }
        const results = d.db.prepare(sql).all(...params);
        return ok([{ results, success: true }]);
      } catch (e) {
        return fail(400, 7500, (e as Error).message);
      }
    }
    const W = path.match(/^\/workers\/scripts\/([^/]+)(\/.*)?$/);
    if (W) {
      const [, name, rest = ""] = W;
      if (method === "GET" && rest === "/deployments") return workers.has(name!) ? ok({ deployments: [{ versions: [{ version_id: "v0", percentage: 100 }] }] }) : fail(404, 10007, "no worker");
      if (method === "GET" && rest === "/secrets") return ok([]);
      if (method === "GET" && rest === "/settings" && state.failSettings) return fail(403, 10000, "Authentication error");
      if (method === "GET" && rest === "/settings") return workers.has(name!) ? ok({ bindings: settings.get(name!)?.bindings ?? [] }) : fail(404, 10007, "no worker");
      if (method === "PUT" && rest === "") {
        workers.add(name!);
        settings.set(name!, call.metadata);
        return ok({ id: name });
      }
      if (method === "PUT" && rest === "/schedules") return ok({});
      if (method === "POST" && rest === "/subdomain") return ok({});
      if (method === "POST" && rest === "/versions") return ok({ id: "v1" });
      if (method === "POST" && rest === "/deployments") return ok({});
      if (method === "POST" && rest === "/tails") return ok({ id: "tail-1", url: "wss://tail.example/1", expires_at: "x" });
      if (method === "DELETE" && rest === "/tails/tail-1") return ok(null);
    }
    if (method === "GET" && path === "/workers/scripts") return ok([...workers].map((id) => ({ id })));
    if (method === "GET" && path.startsWith("/workers/durable_objects/namespaces")) return ok([]);
    if (method === "GET" && path === "/workers/subdomain") return ok({ subdomain: "acme" });
    if (method === "GET" && path === "/zones") return ok(url.searchParams.get("name") === "example.com" ? [{ id: "z1", name: "example.com" }] : []);
    if (method === "GET" && path === "/workers/domains") return ok(customDomains.filter((d) => d.zone_id === url.searchParams.get("zone_id")));
    if (method === "PUT" && path === "/workers/domains") {
      customDomains.push(call.json);
      return ok({ id: "cd1", ...call.json });
    }
    if (method === "GET" && path === "/zones/z1/workers/routes") return ok(routes);
    return fail(400, 1, `unexpected ${method} ${path}`);
  }) as typeof fetch;
  const client = new CfClient({ accountId: "acc", token: "t", fetch: fetchImpl, sleep: async () => {} });
  return {
    client, calls, dbs, workers, customDomains, fetchImpl,
    get failSettings() { return state.failSettings; },
    set failSettings(v: boolean) { state.failSettings = v; },
  };
}

const CODE = "export default {}";
const prebuilt: NonNullable<DeployOptions["prebuilt"]> = {
  build: { code: CODE, entry: "e", outFile: "index.js", bytes: CODE.length, sha256: "f".repeat(64), auth: null },
  hasCrons: false,
  schemaVersion: "b".repeat(64),
};

function repo(name: string, config: Partial<EmberConfigFile> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ember.json"), JSON.stringify({ project: "chat", account: "acc", compatibilityDate: "2026-10-01", environments: { prod: {} }, ...config }, null, 2));
  return loadProject(dir);
}

describe("account registry (D1 over the REST API)", () => {
  it("creates ember-registry idempotently with every table", async () => {
    const cf = fakeAccount();
    const a = await D1Registry.open(cf.client, "ember-spike-registry");
    expect(a.created).toBe(true);
    const b = await D1Registry.open(cf.client, "ember-spike-registry");
    expect(b.created).toBe(false);
    expect(b.databaseId).toBe(a.databaseId);
    expect(cf.calls.filter((c) => c.method === "POST" && c.path === "/d1/database")).toHaveLength(1);
    const tables = (await a.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["auth_links", "deployments", "domains", "environments", "inbound_addresses", "projects", "shards"]));
    await expect(D1Registry.open(cf.client, "missing", { create: false })).rejects.toThrow(/not found/);
  });

  it("the shards DDL matches the runtime's (catalog writes from Workers)", () => {
    const runtime = readFileSync(new URL("../../runtime/src/metrics.ts", import.meta.url), "utf8");
    const m = runtime.match(/SHARDS_TABLE_DDL =\s*([\s\S]+?);\n/)![1]!;
    const value = m.split(/\s*\+\s*/).map((p) => JSON.parse(p.trim())).join("");
    expect(value).toBe(SHARDS_TABLE_DDL);
  });

  it("deploy: writes a fingerprint, binds EMBER_REGISTRY + EMBER_METRICS, records the deployment", async () => {
    const cf = fakeAccount();
    const p = repo("one", { metrics: { sample: 0.5 } });
    const r = await deploy(p, { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt, registryName: "ember-spike-registry", log: () => {}, sleep: async () => {} });
    expect(r.url).toBe("https://ember-chat-prod.acme.workers.dev");
    const saved = JSON.parse(readFileSync(p.configPath, "utf8"));
    expect(saved.fingerprint).toMatch(/^[0-9a-f-]{36}$/);
    const put = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-chat-prod")!;
    expect(put.metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: "d1", name: "EMBER_REGISTRY", id: "db-1" },
        { type: "analytics_engine", name: "EMBER_METRICS", dataset: "ember_metrics" },
        { type: "plain_text", name: "EMBER_METRICS_SAMPLE", text: "0.5" },
      ]),
    );
    const reg = await D1Registry.open(cf.client, "ember-spike-registry");
    const [proj] = await reg.projects();
    expect(proj).toMatchObject({ name: "chat", fingerprint: saved.fingerprint, envs: [{ env: "prod", worker: "ember-chat-prod", url: r.url, schemaVersion: "b".repeat(64) }] });
    const deps = await reg.exec("SELECT * FROM deployments");
    expect(deps).toMatchObject([{ project: "chat", env: "prod", strategy: "create", schema_version: "b".repeat(64) }]);
    // Same repo again: fine (code-only), second deployment row.
    await deploy(loadProject(p.root), { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt, registryName: "ember-spike-registry", log: () => {} });
    expect(await reg.exec("SELECT COUNT(*) AS n FROM deployments")).toEqual([{ n: 2 }]);
  });

  it("refuses the same project name from another repo before uploading anything", async () => {
    const cf = fakeAccount();
    await deploy(repo("owner"), { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt, registryName: "r", log: () => {} });
    const before = cf.calls.length;
    await expect(deploy(repo("intruder"), { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt, registryName: "r", log: () => {} })).rejects.toThrow(RegistryConflictError);
    expect(cf.calls.slice(before).some((c) => c.path.startsWith("/workers/scripts/"))).toBe(false);
  });

  it("refuses Worker-name collisions across projects (ember-a-b + c vs ember-a + b-c)", async () => {
    const cf = fakeAccount();
    await deploy(repo("ab", { project: "a-b", environments: { c: {} } }), { env: "c", token: "t", fetch: cf.fetchImpl, prebuilt, registryName: "r", log: () => {} });
    await expect(deploy(repo("a", { project: "a", environments: { "b-c": {} } }), { env: "b-c", token: "t", fetch: cf.fetchImpl, prebuilt, registryName: "r", log: () => {} })).rejects.toThrow(/already used by project "a-b"/);
  });

  it("metrics can be turned off", async () => {
    const cf = fakeAccount();
    await deploy(repo("nometrics", { metrics: { enabled: false } }), { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt, registry: false, log: () => {} });
    const put = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-chat-prod")!;
    expect(put.metadata.bindings.some((b: any) => b.type === "analytics_engine" || b.type === "d1")).toBe(false);
  });
});

describe("ember domains add", () => {
  const owner = { project: "chat", env: "prod", worker: "ember-chat-prod" };

  it("route patterns", () => {
    expect(routeMatchesHost("*.legacy.example.com/*", "api.legacy.example.com")).toBe(true);
    expect(routeMatchesHost("*example.com/*", "example.com")).toBe(true);
    expect(routeMatchesHost("api.example.com/v1*", "api.example.com")).toBe(true);
    expect(routeMatchesHost("api.example.com/*", "www.example.com")).toBe(false);
  });

  it("refuses hosts used by another Worker's custom domain, a route or another project", async () => {
    const cf = fakeAccount();
    const reg = await D1Registry.open(cf.client, "r");
    await expect(addDomain(cf.client, reg, "taken.example.com", owner)).rejects.toThrow(/Custom Domain of Worker someone-else/);
    await expect(addDomain(cf.client, reg, "x.legacy.example.com", owner)).rejects.toThrow(/route \*\.legacy\.example\.com\/\* → Worker old-worker/);
    await expect(addDomain(cf.client, reg, "app.nozone.dev", owner)).rejects.toThrow(/no zone/);
    await expect(addDomain(cf.client, reg, "bad_host", owner)).rejects.toThrow(/invalid hostname/);
    const dry = await addDomain(cf.client, reg, "chat.example.com", owner, { dryRun: true });
    expect(dry.action).toBe("dry-run");
    expect(cf.customDomains.some((d) => d.hostname === "chat.example.com")).toBe(false);
    const r = await addDomain(cf.client, reg, "Chat.Example.com", owner);
    expect(r.action).toBe("attached");
    expect(cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/domains")!.json).toEqual({ hostname: "chat.example.com", service: "ember-chat-prod", zone_id: "z1", environment: "production" });
    expect((await addDomain(cf.client, reg, "chat.example.com", owner)).action).toBe("already-attached");
    // Another project may not take it, even if the custom domain were moved by hand.
    await expect(addDomain(cf.client, reg, "chat.example.com", { project: "blog", env: "prod", worker: "ember-chat-prod" })).rejects.toThrow(/registered to chat\/prod/);
  });
});

describe("ember logs", () => {
  const exec = (o: Record<string, unknown>) => `ember:exec ${JSON.stringify({ project: "chat", env: "prod", shard: "org:acme", fn: "messages:send", kind: "mutation", status: "ok", errorCode: "", durationMs: 1.5, rowsRead: 2, rowsWritten: 3, bytesOut: 40, ...o })}`;
  const ev = {
    outcome: "ok",
    eventTimestamp: 0,
    event: { request: { url: "https://x.workers.dev/api/mutation", method: "POST" } },
    logs: [
      { message: [exec({})], level: "log", timestamp: 0 },
      { message: [exec({ fn: "messages:list", kind: "query", shard: "org:other", status: "error", errorCode: "Boom" })], level: "log", timestamp: 0 },
      { message: ["hello", { a: 1 }], level: "log", timestamp: 0 },
    ],
    exceptions: [],
  };

  it("pretty-prints executions and filters by fn, shard and errors", () => {
    const all = formatTailEvent(ev);
    expect(all[0]).toMatch(/ok POST \/api\/mutation$/);
    expect(all.join("\n")).toMatch(/mutation\s+messages:send org:acme ok 1.5ms r2\/w3 40B/);
    expect(all.join("\n")).toContain('hello {"a":1}');
    const byFn = formatTailEvent(ev, { fn: "messages:list" });
    expect(byFn).toHaveLength(2);
    expect(byFn[1]).toMatch(/messages:list org:other error Boom/);
    expect(formatTailEvent(ev, { shard: "org:acme" })).toHaveLength(2);
    expect(formatTailEvent(ev, { shard: "org" })).toHaveLength(3);
    expect(formatTailEvent(ev, { errors: true })).toHaveLength(2);
    expect(formatTailEvent(ev, { fn: "nope:nope" })).toEqual([]);
  });

  it("creates a tail session, reads the trace-v1 socket and deletes the session", async () => {
    const cf = fakeAccount();
    const lines: string[] = [];
    let stop!: () => void;
    const until = new Promise<void>((r) => (stop = r));
    class FakeWs {
      static last: FakeWs;
      sent: string[] = [];
      handlers: Record<string, Array<(e: any) => void>> = {};
      url: string;
      protocol: string;
      constructor(url: string, protocol: string) {
        this.url = url;
        this.protocol = protocol;
        FakeWs.last = this;
        queueMicrotask(() => {
          this.emit("open", {});
          this.emit("message", { data: JSON.stringify(ev) });
          queueMicrotask(stop);
        });
      }
      addEventListener(t: string, f: (e: any) => void) {
        (this.handlers[t] ??= []).push(f);
      }
      emit(t: string, e: any) {
        for (const f of this.handlers[t] ?? []) f(e);
      }
      send(d: string) {
        this.sent.push(d);
      }
      close() {
        this.emit("close", {});
      }
    }
    const r = await streamLogs(cf.client, "ember-chat-prod", { WebSocket: FakeWs as any, until, print: (l) => lines.push(l), color: false, filters: { fn: "messages:send" } });
    expect(r.events).toBe(1);
    expect(FakeWs.last.url).toBe("wss://tail.example/1");
    expect(FakeWs.last.protocol).toBe("trace-v1");
    expect(lines.join("\n")).toMatch(/messages:send/);
    expect(lines.join("\n")).not.toMatch(/messages:list/);
    expect(cf.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /workers/scripts/ember-chat-prod/tails", "DELETE /workers/scripts/ember-chat-prod/tails/tail-1"]);
  });
});

describe("ember dashboard deploy", () => {
  it("bundles the SPA + Worker and uploads it with the registry, project services and secrets", async () => {
    const build = await buildDashboard();
    expect(build.bytes).toBeGreaterThan(50_000);
    expect(build.bytes).toBeLessThan(600_000);
    expect(build.code).toContain("/api/_ember/status");
    const cf = fakeAccount();
    await deploy(repo("dash"), { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt, registryName: "r", log: () => {} });
    const reg = await D1Registry.open(cf.client, "r");
    const r = await deployDashboard(cf.client, { registry: reg, name: "ember-spike-dashboard", build, adminToken: "adm", analyticsToken: "cf", log: () => {} });
    expect(r.url).toBe("https://ember-spike-dashboard.acme.workers.dev");
    expect(r.generatedToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(r.services).toEqual(["ember-chat-prod"]);
    const put = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-spike-dashboard")!;
    const names = put.metadata.bindings.map((b: any) => `${b.type}:${b.name}`);
    expect(names).toEqual(expect.arrayContaining(["d1:REGISTRY", "service:EMBER_SVC_0", "plain_text:EMBER_SERVICES", "secret_text:DASHBOARD_TOKEN", "secret_text:EMBER_ADMIN_TOKEN", "secret_text:CF_API_TOKEN"]));
    expect(put.metadata.bindings.find((b: any) => b.name === "EMBER_SVC_0")).toEqual({ type: "service", name: "EMBER_SVC_0", service: "ember-chat-prod" });
    expect(put.metadata).not.toHaveProperty("exports");
    expect(put.metadata.keep_bindings).toEqual(["secret_text"]);
    // The registry has the dashboard's audit tables.
    expect((await reg.exec("SELECT name FROM sqlite_master WHERE name IN ('audit_log', 'dashboard_meta') ORDER BY name")).map((r) => r.name)).toEqual(["audit_log", "dashboard_meta"]);

    // Access + admins; a later deploy that passes neither keeps both (never silently drops Access or an admin).
    const vars = () => {
      const last = cf.calls.filter((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-spike-dashboard").pop()!;
      return Object.fromEntries(last.metadata.bindings.filter((b: any) => b.type === "plain_text" && /^(ACCESS_|DASHBOARD_)/.test(b.name)).map((b: any) => [b.name, b.text]));
    };
    await deployDashboard(cf.client, { registry: reg, name: "ember-spike-dashboard", build, accessTeam: "acme.cloudflareaccess.com", accessAud: "aud1", admins: ["ana@acme.test", "@ops.acme.test"], log: () => {} });
    expect(vars()).toEqual({ ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: "aud1", DASHBOARD_ADMINS: "ana@acme.test,@ops.acme.test" });
    await deployDashboard(cf.client, { registry: reg, name: "ember-spike-dashboard", build, protectedEnvs: ["prod", "staging"], log: () => {} });
    expect(vars()).toEqual({ ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: "aud1", DASHBOARD_ADMINS: "ana@acme.test,@ops.acme.test", DASHBOARD_PROTECTED_ENVS: "prod,staging" });
    // An explicit empty list clears: no Access admins; no protected environment (kept as "" on the next deploy).
    await deployDashboard(cf.client, { registry: reg, name: "ember-spike-dashboard", build, admins: [], protectedEnvs: [], log: () => {} });
    expect(vars()).toEqual({ ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: "aud1", DASHBOARD_PROTECTED_ENVS: "" });
    await deployDashboard(cf.client, { registry: reg, name: "ember-spike-dashboard", build, log: () => {} });
    expect(vars()).toEqual({ ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: "aud1", DASHBOARD_PROTECTED_ENVS: "" });
    // A settings read that fails for another reason than "no such Worker" aborts before the upload.
    cf.failSettings = true;
    const puts = cf.calls.filter((c) => c.method === "PUT").length;
    await expect(deployDashboard(cf.client, { registry: reg, name: "ember-spike-dashboard", build, log: () => {} })).rejects.toThrow(/settings/);
    expect(cf.calls.filter((c) => c.method === "PUT").length).toBe(puts);
  }, 60_000);
});
