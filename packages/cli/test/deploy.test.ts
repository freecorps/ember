import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { projectFrom, validateConfig, type EmberConfigFile } from "../src/config.ts";
import { buildMetadata, deploy, desiredExports, loadDeployments, MigrationRefusedError, MissingEnvError, missingEnv, NEW_MODULE_REGISTRY_DEFAULT_DATE, planDeploy, waitForShards, workerCompatibilityFlags, workerForm, workerObservability, type DeployOptions, type ShardStatus } from "../src/deploy/index.ts";
import { TMP } from "./helpers.ts";

const RUNTIME_VERSION = (JSON.parse(readFileSync(new URL("../../runtime/package.json", import.meta.url), "utf8")) as { version: string }).version;

const root = join(TMP, `deploy-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const config: EmberConfigFile = { project: "chat", account: "acc123", compatibilityDate: "2026-10-01", environments: { prod: {}, dev: {} } };
const project = projectFrom(root, config);
const CODE = "export default { fetch() { return new Response('ok') } }";
const prebuilt: NonNullable<DeployOptions["prebuilt"]> = {
  build: { code: CODE, entry: "entry.mjs", outFile: "index.js", bytes: CODE.length, sha256: "f".repeat(64), auth: null },
  hasCrons: true,
  schemaVersion: "a".repeat(64),
};

type Part = { name: string; type: string; text: string };
/** FormData's entries (the CLI's lib types have no DOM iterables). */
const formEntries = (fd: FormData) => [...(fd as unknown as { entries(): Iterable<[string, File | string]> }).entries()];
type Call = { method: string; path: string; json?: any; metadata?: any; module?: Part; parts?: Record<string, Part> };

/** A fake Cloudflare API. `state` decides what exists; every request is recorded. */
function fakeCloudflare(state: { exists: boolean; classes: string[]; versions?: Array<{ version_id: string; percentage: number }>; secrets?: string[]; subdomain?: { enabled: boolean; previews_enabled: boolean } }) {
  const calls: Call[] = [];
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.href).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acc123\//);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    const path = url.pathname.replace("/client/v4/accounts/acc123", "") + url.search;
    const call: Call = { method: init?.method ?? "GET", path };
    if (init?.body instanceof FormData) {
      call.metadata = JSON.parse(await (init.body.get("metadata") as Blob).text());
      const mod = init.body.get("index.js");
      if (!(mod instanceof File)) throw new Error(`upload without an index.js part: ${formEntries(init.body).map(([k]) => k).join(", ")}`);
      call.module = { name: mod.name, type: mod.type, text: await mod.text() };
      call.parts = {};
      for (const [k, v] of formEntries(init.body)) if (k !== "metadata") call.parts[k] = { name: (v as File).name, type: (v as File).type, text: await (v as File).text() };
    } else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
    calls.push(call);
    const W = "/workers/scripts/ember-chat-prod";
    if (call.method === "GET" && path === `${W}/deployments`) {
      return state.exists
        ? ok({ deployments: [{ id: "d1", versions: state.versions ?? [{ version_id: "old-version", percentage: 100 }] }] })
        : new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }], result: null }), { status: 404 });
    }
    if (call.method === "GET" && path.startsWith("/workers/durable_objects/namespaces"))
      return ok([
        ...state.classes.map((c) => ({ id: `ns-${c}`, name: `ember-chat-prod_${c}`, script: "ember-chat-prod", class: c, use_sqlite: true })),
        { id: "other", name: "other_Shard", script: "someone-else", class: "Shard" },
      ]);
    if (call.method === "GET" && path === `${W}/secrets`) return ok((state.secrets ?? []).map((name) => ({ name, type: "secret_text" })));
    if (call.method === "PUT" && path === `${W}/secrets`) return ok({ name: call.json.name, type: call.json.type });
    if (call.method === "PUT" && path === W) return ok({ id: "ember-chat-prod" });
    if (call.method === "POST" && path === `${W}/versions`) {
      // Like Cloudflare (2026-11-09): a version may not bind a class its `exports` only creates now (100406).
      const created = Object.entries(call.metadata?.exports ?? {}).filter(([, e]: [string, any]) => e.state === "created").map(([k]) => k);
      const bound = (call.metadata?.bindings ?? []).filter((b: any) => b.type === "durable_object_namespace" && created.includes(b.class_name));
      if (bound.length) return { status: 403, json: { success: false, errors: [{ code: 100406, message: `Durable Object binding '${bound[0].name}' references class '${bound[0].class_name}', which is declared in \`exports\` but not yet provisioned.` }], result: null } };
      return ok({ id: "new-version", number: 2 });
    }
    if (call.method === "POST" && path === `${W}/deployments`) return ok({ id: "d2" });
    if (call.method === "PUT" && path === `${W}/schedules`) return ok({ schedules: call.json });
    if (call.method === "POST" && path === `${W}/subdomain`) return ok({ enabled: true });
    if (call.method === "GET" && path === `${W}/subdomain`)
      return state.exists && state.subdomain ? ok(state.subdomain) : new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: "no route" }], result: null }), { status: 404 });
    if (call.method === "GET" && path === "/workers/subdomain") return ok({ subdomain: "acme" });
    return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: `unexpected ${call.method} ${path}` }] }), { status: 400 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const run = (fetchImpl: typeof fetch, extra: Partial<DeployOptions> = {}) =>
  deploy(project, { env: "prod", token: "test-token", fetch: fetchImpl, prebuilt, registry: false, log: () => {}, ...extra });

describe("ember deploy (mocked Cloudflare API)", () => {
  it("workerForm: the minified build's source map goes up as <main_module>.map", async () => {
    const meta = { main_module: "index.js" } as Parameters<typeof workerForm>[0];
    const fd = workerForm(meta, `${CODE}\n//# sourceMappingURL=index.js.map`, '{"version":3}');
    const map = fd.get("index.js.map") as File;
    expect([map.name, map.type, await map.text()]).toEqual(["index.js.map", "application/source-map", '{"version":3}']);
    expect(workerForm(meta, CODE).has("index.js.map")).toBe(false);
  });

  it("workerForm: a split build's chunks go up as ES modules named as the main module imports them, each with its map", async () => {
    const meta = { main_module: "index.js" } as Parameters<typeof workerForm>[0];
    const fd = workerForm(meta, `import("./chunk-AB12.js");\n//# sourceMappingURL=index.js.map`, '{"version":3,"m":1}', [
      { name: "chunk-AB12.js", code: "export const a = 1;\n//# sourceMappingURL=chunk-AB12.js.map", map: '{"version":3,"c":1}' },
      { name: "chunk-CD34.js", code: "export const b = 2;" },
    ]);
    const parts = await Promise.all(formEntries(fd).map(async ([k, v]) => [k, typeof v === "string" ? v : [(v as File).name, (v as File).type, await (v as File).text()]]));
    expect(parts.map(([k]) => k)).toEqual(["metadata", "index.js", "index.js.map", "chunk-AB12.js", "chunk-AB12.js.map", "chunk-CD34.js"]);
    const byName = Object.fromEntries(parts) as Record<string, [string, string, string]>;
    expect(byName["chunk-AB12.js"]).toEqual(["chunk-AB12.js", "application/javascript+module", "export const a = 1;\n//# sourceMappingURL=chunk-AB12.js.map"]);
    expect(byName["chunk-AB12.js.map"]).toEqual(["chunk-AB12.js.map", "application/source-map", '{"version":3,"c":1}']);
    expect(byName["chunk-CD34.js"]![1]).toBe("application/javascript+module");
    expect(byName["index.js"]![1]).toBe("application/javascript+module");
    // A chunk can never replace the main module, its map, or the metadata, nor climb out of the module root.
    for (const name of ["index.js", "index.js.map", "metadata", "../x.js", "/abs.js", "sub/x.js", "x.mjs", ""]) {
      expect(() => workerForm(meta, CODE, "{}", [{ name, code: "" }]), name).toThrow(/workerForm/);
    }
    expect(() => workerForm(meta, CODE, undefined, [{ name: "chunk-A.js", code: "" }, { name: "chunk-A.js", code: "" }])).toThrow(/two parts/);
  });

  it("uploads every module of a split build (Script PUT and version upload)", async () => {
    const chunks = [{ name: "chunk-LAZY1234.js", code: "export const lazy = 1;", map: '{"version":3}' }];
    const split = { ...prebuilt, build: { ...prebuilt.build, code: `${CODE}\nconst l = () => import("./chunk-LAZY1234.js");`, modules: chunks } };
    for (const state of [{ exists: false, classes: [] }, { exists: true, classes: ["Shard", "System"] }]) {
      const cf = fakeCloudflare(state);
      await deploy(project, { env: "prod", token: "test-token", fetch: cf.fetchImpl, prebuilt: split, registry: false, log: () => {} });
      const upload = cf.calls.find((c) => c.parts)!;
      expect(upload.metadata.main_module).toBe("index.js");
      expect(Object.keys(upload.parts!)).toEqual(["index.js", "chunk-LAZY1234.js", "chunk-LAZY1234.js.map"]);
      expect(upload.parts!["chunk-LAZY1234.js"]).toEqual({ name: "chunk-LAZY1234.js", type: "application/javascript+module", text: "export const lazy = 1;" });
      // A split build before 2026-11-17 opts into the new module registry: chunks compile when first imported.
      expect(upload.metadata.compatibility_flags).toEqual(["nodejs_compat", "new_module_registry"]);
    }
  });

  it("new_module_registry: only for a split build dated before its default date, unless ember.json picks a registry", () => {
    const f = (o: Partial<Parameters<typeof workerCompatibilityFlags>[0]>) => workerCompatibilityFlags({ compatibilityDate: "2026-10-01", ...o });
    expect(f({})).toEqual(["nodejs_compat"]);
    expect(f({ splitModules: true })).toEqual(["nodejs_compat", "new_module_registry"]);
    // On and after 2026-11-17 Workers use the new registry by default: no flag.
    expect(f({ splitModules: true, compatibilityDate: NEW_MODULE_REGISTRY_DEFAULT_DATE })).toEqual(["nodejs_compat"]);
    // Compared as dates, not strings: an unpadded or impossible date is an error, never a silently skipped flag.
    expect(f({ splitModules: true, compatibilityDate: "2026-11-07" })).toEqual(["nodejs_compat", "new_module_registry"]);
    expect(f({ splitModules: true, compatibilityDate: "2026-11-18" })).toEqual(["nodejs_compat"]);
    expect(f({ splitModules: true, compatibilityDate: "2027-01-01" })).toEqual(["nodejs_compat"]);
    for (const bad of ["2026-11-7", "2026-1-20", "2026-02-30", "2026-13-01", "nope"]) expect(() => f({ splitModules: true, compatibilityDate: bad })).toThrow(/YYYY-MM-DD/);
    expect(f({ splitModules: true, compatibilityFlags: ["legacy_module_registry"] })).toEqual(["legacy_module_registry"]);
    expect(f({ splitModules: true, compatibilityFlags: ["new_module_registry"] })).toEqual(["new_module_registry"]);
    // The Auth DO still gets nodejs_compat; the input list is not mutated.
    const flags: string[] = [];
    expect(f({ splitModules: true, auth: true, compatibilityFlags: flags })).toEqual(["nodejs_compat", "new_module_registry"]);
    expect(flags).toEqual([]);
    expect(buildMetadata({ project: "p", env: "prod", compatibilityDate: "2026-10-01", provisionedClasses: [], splitModules: true }).metadata.compatibility_flags).toEqual(["nodejs_compat", "new_module_registry"]);
    expect(buildMetadata({ project: "p", env: "prod", compatibilityDate: "2026-10-01", provisionedClasses: [] }).metadata.compatibility_flags).toEqual(["nodejs_compat"]);
  });

  it("first deploy: one Script PUT with the full exports map (no migrations), cron, workers.dev", async () => {
    const cf = fakeCloudflare({ exists: false, classes: [] });
    const r = await run(cf.fetchImpl);
    expect(r.plan.strategy).toBe("create");
    // The current state's reads go out at once (the Worker is not there: only the deployments answer counts).
    expect(cf.calls.slice(0, 4).map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      "GET /workers/durable_objects/namespaces?per_page=1000",
      "GET /workers/scripts/ember-chat-prod/deployments",
      "GET /workers/scripts/ember-chat-prod/secrets",
      "GET /workers/scripts/ember-chat-prod/subdomain",
    ]);
    expect(cf.calls.slice(4).map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /workers/scripts/ember-chat-prod",
      "PUT /workers/scripts/ember-chat-prod/schedules",
      "POST /workers/scripts/ember-chat-prod/subdomain",
      "GET /workers/subdomain",
    ]);
    const put = cf.calls[4]!;
    expect(put.metadata.exports).toEqual({
      Shard: { type: "durable-object", storage: "sqlite", state: "created" },
      System: { type: "durable-object", storage: "sqlite", state: "created" },
    });
    expect(put.metadata).not.toHaveProperty("migrations");
    expect(put.metadata.main_module).toBe("index.js");
    expect(put.metadata.compatibility_date).toBe("2026-10-01");
    expect(put.metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: "durable_object_namespace", name: "SHARD", class_name: "Shard" },
        { type: "durable_object_namespace", name: "SYSTEM", class_name: "System" },
        { type: "plain_text", name: "EMBER_ENV", text: "prod" },
        // The Ember release the Worker runs (here the workspace's runtime).
        { type: "plain_text", name: "EMBER_RUNTIME_VERSION", text: RUNTIME_VERSION },
      ]),
    );
    expect(put.module).toEqual({ name: "index.js", type: "application/javascript+module", text: CODE });
    expect(cf.calls[5]!.json).toEqual([{ cron: "* * * * *" }]);
    expect(cf.calls[6]!.json).toEqual({ enabled: true, previews_enabled: false });
    expect(r.url).toBe("https://ember-chat-prod.acme.workers.dev");
    expect(loadDeployments(project).prod?.url).toBe(r.url);
  });

  it("code-only change: version upload with live exports, then a gradual deployment", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"] });
    const r = await run(cf.fetchImpl, { gradual: 10 });
    expect(r.plan.strategy).toBe("code-only");
    expect(r.plan.warnings).toEqual([]);
    const upload = cf.calls.find((c) => c.path.endsWith("/versions"))!;
    expect(upload.method).toBe("POST");
    expect(upload.metadata.exports).toEqual({
      Shard: { type: "durable-object", storage: "sqlite" },
      System: { type: "durable-object", storage: "sqlite" },
    });
    expect(upload.metadata).not.toHaveProperty("migrations");
    expect(cf.calls.some((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-chat-prod")).toBe(false);
    const dep = cf.calls.find((c) => c.method === "POST" && c.path.endsWith("/deployments"))!;
    expect(dep.json).toMatchObject({
      strategy: "percentage",
      versions: [
        { version_id: "new-version", percentage: 10 },
        { version_id: "old-version", percentage: 90 },
      ],
    });
    expect(r.versionId).toBe("new-version");
  });

  it("code-only redeploy: the current state is read in parallel, and workers.dev already on is not set again", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"], subdomain: { enabled: true, previews_enabled: false } });
    let inFlight = 0;
    let peak = 0;
    const slow: typeof fetch = async (input, init) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await cf.fetchImpl(input, init);
      } finally {
        inFlight--;
      }
    };
    const r = await run(slow);
    expect(r.plan.strategy).toBe("code-only");
    expect(peak).toBe(4); // deployments, DO namespaces, secrets, workers.dev route
    const writes = cf.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual(["POST /workers/scripts/ember-chat-prod/versions", "POST /workers/scripts/ember-chat-prod/deployments", "PUT /workers/scripts/ember-chat-prod/schedules"]);
    expect(r.url).toBe("https://ember-chat-prod.acme.workers.dev");
    // The route off (or unreadable): set as before.
    for (const subdomain of [{ enabled: false, previews_enabled: false }, { enabled: true, previews_enabled: true }, undefined]) {
      const again = fakeCloudflare({ exists: true, classes: ["Shard", "System"], ...(subdomain ? { subdomain } : {}) });
      await run(again.fetchImpl);
      expect(again.calls.filter((c) => c.method === "POST" && c.path.endsWith("/subdomain"))).toHaveLength(1);
    }
  });

  it("declared env vars (defineApp({ env })) must be set: a redeploy stops before uploading, naming the missing ones", async () => {
    const env = [
      { name: "STRIPE_KEY", optional: false },
      { name: "RESEND_KEY", optional: false },
      { name: "SENTRY_DSN", optional: true },
    ];
    const withEnv = { ...prebuilt, env };
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"], secrets: ["STRIPE_KEY"] });
    const err = await run(cf.fetchImpl, { prebuilt: withEnv }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingEnvError);
    expect((err as MissingEnvError).missing).toEqual(["RESEND_KEY"]);
    expect((err as Error).message).toMatch(/RESEND_KEY/);
    expect((err as Error).message).toMatch(/ember env set RESEND_KEY --env prod/);
    expect((err as Error).message).toMatch(/--allow-missing-env/);
    expect((err as Error).message).not.toMatch(/STRIPE_KEY|SENTRY_DSN/);
    expect(cf.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // --allow-missing-env: deploys, and says what is missing.
    const lines: string[] = [];
    const forced = fakeCloudflare({ exists: true, classes: ["Shard", "System"], secrets: ["STRIPE_KEY"] });
    await run(forced.fetchImpl, { prebuilt: withEnv, allowMissingEnv: true, log: (l) => lines.push(l) });
    expect(forced.calls.some((c) => c.path.endsWith("/versions"))).toBe(true);
    expect(lines.join("\n")).toMatch(/warning: RESEND_KEY .*not set on ember-chat-prod \(--allow-missing-env\)/);

    // A var in ember.json counts too.
    const varsProject = projectFrom(root, { ...config, environments: { prod: { vars: { RESEND_KEY: "re_test" } }, dev: {} } });
    const ok = fakeCloudflare({ exists: true, classes: ["Shard", "System"], secrets: ["STRIPE_KEY"] });
    await deploy(varsProject, { env: "prod", token: "test-token", fetch: ok.fetchImpl, prebuilt: withEnv, registry: false, log: () => {} });
    expect(ok.calls.some((c) => c.path.endsWith("/versions"))).toBe(true);

    // A first deploy cannot have secrets yet: it warns and goes on.
    const first: string[] = [];
    const fresh = fakeCloudflare({ exists: false, classes: [] });
    await run(fresh.fetchImpl, { prebuilt: withEnv, log: (l) => first.push(l) });
    expect(fresh.calls.some((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-chat-prod")).toBe(true);
    expect(first.join("\n")).toMatch(/warning: RESEND_KEY, STRIPE_KEY .*first deploy/);

    // The dry run names the ones ember.json does not set.
    const dry: string[] = [];
    await run(fresh.fetchImpl, { prebuilt: withEnv, dryRun: true, log: (l) => dry.push(l) });
    expect(dry.join("\n")).toMatch(/env: RESEND_KEY, STRIPE_KEY/);
    expect(missingEnv(env, ["RESEND_KEY", "STRIPE_KEY"])).toEqual([]);
  });

  it("exports change (new class): one Script PUT at 100% (a version binding the new class is refused), even when --gradual is asked", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard"] });
    const r = await run(cf.fetchImpl, { gradual: 10 });
    expect(r.plan.strategy).toBe("exports-change");
    expect(r.plan.createdClasses).toEqual(["System"]);
    expect(r.plan.warnings[0]).toMatch(/100405/);
    const upload = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-chat-prod")!;
    expect(upload.metadata.exports.System).toEqual({ type: "durable-object", storage: "sqlite", state: "created" });
    expect(upload.metadata.exports.Shard).toEqual({ type: "durable-object", storage: "sqlite" });
    expect(upload.metadata.bindings).toContainEqual({ type: "durable_object_namespace", name: "SYSTEM", class_name: "System" });
    expect(cf.calls.some((c) => c.path.endsWith("/versions") || (c.method === "POST" && c.path.endsWith("/deployments")))).toBe(false);
    expect(r.versionId).toBe("old-version"); // the fake's active version after the PUT
  });

  it("exports change: a failed read-back of the version after the Script PUT does not fail the deploy", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard"] });
    let puts = 0;
    const flaky: typeof fetch = async (input, init) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      if ((init?.method ?? "GET") === "PUT" && u.pathname.endsWith("/workers/scripts/ember-chat-prod")) puts++;
      if (puts && (init?.method ?? "GET") === "GET" && u.pathname.endsWith("/deployments")) return new Response("upstream down", { status: 502 });
      return cf.fetchImpl(input, init);
    };
    const lines: string[] = [];
    const r = await run(flaky, { log: (l: string) => lines.push(l) });
    expect(puts).toBe(1);
    expect(r.versionId).toBeNull();
    expect(lines.join("\n")).toMatch(/at 100% \(version id not read back\)/);
  });

  it("refuses to drop a provisioned class and dry-run makes no API calls", async () => {
    expect(() => desiredExports(["Shard", "System", "Legacy"])).toThrow(/Legacy/);
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"] });
    const lines: string[] = [];
    const r = await run(cf.fetchImpl, { dryRun: true, log: (l) => lines.push(l) });
    expect(r.dryRun).toBe(true);
    expect(cf.calls).toEqual([]);
    expect(lines.join("\n")).toContain("PUT /accounts/:account/workers/scripts/ember-chat-prod");
  });

  it("retries 5xx with backoff", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"] });
    let failed = 0;
    const flaky = (async (input: any, init?: RequestInit) => {
      if (String(input).endsWith("/versions") && failed++ === 0) return new Response("upstream error", { status: 502 });
      return cf.fetchImpl(input, init);
    }) as typeof fetch;
    const r = await run(flaky, { sleep: async () => {} });
    expect(failed).toBe(2);
    expect(r.versionId).toBe("new-version");
  });

  it("uploads EMBER_ADMIN_TOKEN as a secret (redacted in dry runs) and keeps existing secrets", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"] });
    await run(cf.fetchImpl, { adminToken: "s3cret" });
    const upload = cf.calls.find((c) => c.path.endsWith("/versions"))!;
    expect(upload.metadata.bindings).toContainEqual({ type: "secret_text", name: "EMBER_ADMIN_TOKEN", text: "s3cret" });
    expect(upload.metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    const lines: string[] = [];
    await run(cf.fetchImpl, { dryRun: true, adminToken: "s3cret", log: (l) => lines.push(l) });
    expect(lines.join("\n")).not.toContain("s3cret");
    expect(lines.join("\n")).toContain("<redacted>");
  });

  it("--wait polls global:main + --shard until ready; fails loudly on a refused migration", async () => {
    const V = prebuilt.schemaVersion;
    const st = (shard: string, over: Partial<ShardStatus> = {}): ShardStatus => ({
      shard, expectedVersion: V, schemaVersion: V, ready: true, staged: [], migrationError: null, lastMigrationError: null, version: 1, databaseSize: 1, ...over,
    });
    const responses: Array<(shards: string[]) => unknown> = [
      () => ({ ok: true, expectedVersion: "old".padEnd(64, "0"), shards: [] }), // old version still serving
      (s) => ({ ok: true, expectedVersion: V, shards: s.map((x) => st(x, x === "org:a" ? { ready: false, staged: [{ table: "t", index: "i", kind: "db", cursor: 10, until: 50 }] } : {})) }),
      (s) => ({ ok: true, expectedVersion: V, shards: s.map((x) => st(x)) }),
    ];
    const seen: Array<{ url: string; auth: string | null }> = [];
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"] });
    const fetchImpl = (async (input: any, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.hostname.endsWith("workers.dev")) {
        seen.push({ url: u.pathname + u.search, auth: new Headers(init?.headers).get("authorization") });
        const body = responses[Math.min(seen.length - 1, responses.length - 1)]!(u.searchParams.getAll("shard"));
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return cf.fetchImpl(input, init);
    }) as typeof fetch;
    const lines: string[] = [];
    const r = await run(fetchImpl, { adminToken: "tok", wait: { shards: ["org:a"] }, sleep: async () => {}, log: (l) => lines.push(l) });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ url: "/api/_ember/status?shard=global%3Amain&shard=org%3Aa", auth: "Bearer tok" });
    expect(r.shards!.map((s) => s.shard)).toEqual(["global:main", "org:a"]);
    expect(lines.join("\n")).toMatch(/backfilling t\.i \(40 rows left\)/);

    // refused: throws with the shard and the reason
    const refused = (async (input: any, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.hostname.endsWith("workers.dev"))
        return new Response(JSON.stringify({ ok: true, expectedVersion: V, shards: [st("global:main", { ready: false, schemaVersion: "x", migrationError: { at: 1, fromVersion: "x", toVersion: V, code: "MigrationRefused", message: "messages.mandatory: required field added to a table with data" } })] }));
      return cf.fetchImpl(input, init);
    }) as typeof fetch;
    const err = await run(refused, { adminToken: "tok", wait: true, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationRefusedError);
    expect(err.message).toMatch(/global:main: MigrationRefused: messages\.mandatory/);

    await expect(run(cf.fetchImpl, { wait: true, adminToken: "" })).rejects.toThrow(/admin token/);
  });

  it("waitForShards: admin disabled, wrong token and timeout are errors", async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const base = { url: "https://x.workers.dev", adminToken: "t", expectedVersion: "v", sleep: async () => {}, log: () => {} };
    await expect(waitForShards({ ...base, fetch: reply(403, { ok: false, error: { code: "admin_disabled", message: "" } }) })).rejects.toThrow(/no EMBER_ADMIN_TOKEN/);
    await expect(waitForShards({ ...base, fetch: reply(401, { ok: false }) })).rejects.toThrow(/rejected the admin token/);
    let t = 0;
    await expect(waitForShards({ ...base, timeoutMs: 10, now: () => (t += 6), fetch: reply(503, {}) })).rejects.toThrow(/Timed out/);
  });
});

describe("ember deploy with ember/auth.config.ts (mocked Cloudflare API)", () => {
  const authBuild: NonNullable<DeployOptions["prebuilt"]> = { ...prebuilt, build: { ...prebuilt.build, auth: { kind: "local", project: "chat", syncShard: "global:main" } } };
  const JWKS = { keys: [{ kty: "OKP", crv: "Ed25519", x: "abc", kid: "k1", alg: "EdDSA" }] };
  /** The fake API plus the deployed Worker's public /api/auth/jwks (unreachable for the first `down` calls). */
  const withWorker = (cf: ReturnType<typeof fakeCloudflare>, down = 0) => {
    const hits: string[] = [];
    const fetchImpl = (async (input: any, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.hostname.endsWith("workers.dev") || u.hostname === "app.example.com") {
        hits.push(u.href);
        if (hits.length <= down) return new Response("not yet", { status: 404 });
        return new Response(JSON.stringify(JWKS), { status: 200 });
      }
      return cf.fetchImpl(input, init);
    }) as typeof fetch;
    return { fetchImpl, hits };
  };
  const secretPuts = (cf: ReturnType<typeof fakeCloudflare>) => cf.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/secrets"));

  it("first deploy: Auth DO export + AUTH binding, nodejs_compat, generated secret, issuer URL, then the JWKS secret", async () => {
    const cf = fakeCloudflare({ exists: false, classes: [] });
    const w = withWorker(cf, 2);
    const lines: string[] = [];
    const r = await run(w.fetchImpl, { prebuilt: authBuild, sleep: async () => {}, log: (l) => lines.push(l) });
    const put = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-chat-prod")!;
    expect(put.metadata.exports.Auth).toEqual({ type: "durable-object", storage: "sqlite", state: "created" });
    expect(put.metadata.bindings).toContainEqual({ type: "durable_object_namespace", name: "AUTH", class_name: "Auth" });
    expect(put.metadata.compatibility_flags).toContain("nodejs_compat");
    expect(put.metadata.bindings).toContainEqual({ type: "plain_text", name: "EMBER_AUTH_URL", text: "https://ember-chat-prod.acme.workers.dev" });
    const secret = put.metadata.bindings.find((b: any) => b.name === "EMBER_AUTH_SECRET");
    expect(secret.type).toBe("secret_text");
    expect(secret.text.length).toBeGreaterThanOrEqual(40);
    expect(lines.join("\n")).not.toContain(secret.text);
    expect(w.hits).toEqual(Array(3).fill("https://ember-chat-prod.acme.workers.dev/api/auth/jwks"));
    expect(secretPuts(cf).map((c) => c.json)).toEqual([{ name: "EMBER_AUTH_JWKS", text: JSON.stringify(JWKS), type: "secret_text" }]);
    expect(r.auth).toEqual({ url: "https://ember-chat-prod.acme.workers.dev", generatedSecret: true, jwks: "embedded" });
  });

  it("code-only redeploy keeps EMBER_AUTH_SECRET/JWKS (not re-sent; keep_bindings) and skips the JWKS step", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System", "Auth"], secrets: ["EMBER_AUTH_SECRET", "EMBER_AUTH_JWKS", "EMBER_ADMIN_TOKEN"] });
    const w = withWorker(cf);
    const r = await run(w.fetchImpl, { prebuilt: authBuild });
    expect(r.plan.strategy).toBe("code-only");
    const upload = cf.calls.find((c) => c.path.endsWith("/versions"))!;
    expect(upload.metadata.bindings.map((b: any) => b.name)).not.toContain("EMBER_AUTH_SECRET");
    expect(upload.metadata.keep_bindings).toContain("secret_text");
    expect(upload.metadata.exports.Auth).toEqual({ type: "durable-object", storage: "sqlite" });
    expect(secretPuts(cf)).toEqual([]);
    expect(w.hits).toEqual([]);
    expect(r.auth).toEqual({ url: "https://ember-chat-prod.acme.workers.dev", generatedSecret: false, jwks: "kept" });
  });

  it("adding auth to a live project creates the Auth class at 100%; an unreachable JWKS is a warning, retried next deploy", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"], secrets: [] });
    const w = withWorker(cf, Infinity);
    const lines: string[] = [];
    const r = await run(w.fetchImpl, { prebuilt: authBuild, gradual: 10, sleep: async () => {}, jwksTimeoutMs: 0, log: (l) => lines.push(l) });
    expect(r.plan.strategy).toBe("exports-change");
    expect(r.plan.createdClasses).toEqual(["Auth"]);
    expect(r.auth?.jwks).toBe("failed");
    expect(lines.join("\n")).toMatch(/EMBER_AUTH_JWKS not set/);
    expect(secretPuts(cf)).toEqual([]);
  });

  it("auth.url (custom domain) pins the issuer; removing auth.config.ts from a live project is refused", async () => {
    const custom = projectFrom(root, { ...config, auth: { url: "https://app.example.com/" } });
    const cf = fakeCloudflare({ exists: false, classes: [] });
    const w = withWorker(cf);
    const r = await deploy(custom, { env: "prod", token: "test-token", fetch: w.fetchImpl, prebuilt: authBuild, registry: false, log: () => {} });
    const put = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-chat-prod")!;
    expect(put.metadata.bindings).toContainEqual({ type: "plain_text", name: "EMBER_AUTH_URL", text: "https://app.example.com" });
    expect(w.hits).toEqual(["https://app.example.com/api/auth/jwks"]);
    expect(r.auth?.url).toBe("https://app.example.com");

    const live = fakeCloudflare({ exists: true, classes: ["Shard", "System", "Auth"] });
    await expect(run(live.fetchImpl)).rejects.toThrow(/Auth/);
  });
});

describe("component bindings", () => {
  it("a component's Workers AI binding is not repeated when a vectorIndex with embed already binds EMBER_AI", () => {
    const base = { project: "chat", env: "prod", compatibilityDate: "2026-10-01", provisionedClasses: [] as string[], componentBindings: [{ type: "ai" as const, name: "EMBER_AI" }] };
    const ai = (m: ReturnType<typeof buildMetadata>) => m.metadata.bindings.filter((b) => b.type === "ai");
    expect(ai(buildMetadata(base))).toEqual([{ type: "ai", name: "EMBER_AI" }]);
    expect(ai(buildMetadata({ ...base, aiIndexes: { vectorize: [], aiSearch: [], ai: true, queue: null } }))).toEqual([{ type: "ai", name: "EMBER_AI" }]);
  });
});

describe("resources.browser (ctx.browser)", () => {
  it("binds Browser Rendering as EMBER_BROWSER and needs a quick-actions compatibility date", () => {
    const { metadata } = buildMetadata({ project: "pdfs", env: "prod", compatibilityDate: "2026-10-01", provisionedClasses: [], resources: { browser: true } });
    expect(metadata.bindings).toContainEqual({ type: "browser", name: "EMBER_BROWSER" });
    expect(buildMetadata({ project: "pdfs", env: "prod", compatibilityDate: "2026-10-01", provisionedClasses: [] }).metadata.bindings.some((b) => b.type === "browser")).toBe(false);
    const base = { project: "pdfs", environments: { prod: {} } };
    expect(() => validateConfig({ ...base, compatibilityDate: "2026-10-01", resources: { browser: true } })).not.toThrow();
    expect(() => validateConfig({ ...base, compatibilityDate: "2026-01-01", resources: { browser: true } })).toThrow(/>= 2026-03-24/);
    expect(() => validateConfig({ ...base, compatibilityDate: "2026-10-01", resources: { pdf: true } })).toThrow(/resources.pdf" is unknown/);
    expect(() => validateConfig({ ...base, compatibilityDate: "2026-10-01", build: { keepNames: true } })).not.toThrow();
    expect(() => validateConfig({ ...base, compatibilityDate: "2026-10-01", build: { minify: true } })).toThrow(/build.minify" is unknown/);
    expect(() => validateConfig({ ...base, compatibilityDate: "2026-10-01", build: { keepNames: "yes" } })).toThrow(/build.keepNames" must be a boolean/);
  });
});

describe("Cron Trigger derived from the manifest's crons (PR 4A-3)", () => {
  const plan = (input: Partial<Parameters<typeof planDeploy>[0]>) =>
    planDeploy({ worker: "ember-chat-prod", current: { exists: true, provisionedClasses: ["Shard", "System"], activeVersions: [{ version_id: "v1", percentage: 100 }] }, metadata: buildMetadata({ project: "chat", env: "prod", compatibilityDate: "2026-10-01", provisionedClasses: ["Shard", "System"] }).metadata, createdClasses: [], hasCrons: false, now: Date.UTC(2026, 0, 1), ...input });
  const schedules = (p: ReturnType<typeof planDeploy>) => p.steps.find((s) => s.kind === "schedules") as Extract<(typeof p.steps)[number], { kind: "schedules" }>;

  it("a daily cron gets a daily trigger (its minute + the catch-up heartbeat), not every minute", () => {
    expect(schedules(plan({ hasCrons: true, crons: [{ schedule: "0 4 * * *" }] })).body).toEqual([{ cron: "*/10 4 * * *" }]);
    expect(schedules(plan({ hasCrons: true, crons: [{ schedule: "0 9 * * *", tz: "America/New_York" }] })).body).toEqual([{ cron: "*/10 13,14 * * *" }]);
    expect(schedules(plan({ hasCrons: true, crons: [{ schedule: "*/5 * * * *" }, { schedule: "0 4 * * *" }] })).body).toEqual([{ cron: "*/5 * * * *" }]);
  });

  it("no crons: no trigger; crons unknown (an old prebuilt): every minute; an invalid schedule: every minute and a warning", () => {
    expect(schedules(plan({ hasCrons: false })).body).toEqual([]);
    expect(schedules(plan({ hasCrons: true })).body).toEqual([{ cron: "* * * * *" }]);
    const bad = plan({ hasCrons: true, crons: [{ schedule: "nope" }] });
    expect(schedules(bad).body).toEqual([{ cron: "* * * * *" }]);
    expect(bad.warnings.join("\n")).toMatch(/"nope".*invalid/);
  });

  it("deploy PUTs the derived trigger", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"] });
    await run(cf.fetchImpl, { prebuilt: { ...prebuilt, crons: [{ schedule: "0 4 * * *" }] } });
    expect(cf.calls.find((c) => c.method === "PUT" && c.path.endsWith("/schedules"))!.json).toEqual([{ cron: "*/10 4 * * *" }]);
  });
});

describe("ember.json observability (Workers Logs)", () => {
  const base = { project: "logs", compatibilityDate: "2026-10-01", environments: { prod: {} } };
  it("defaults to on, every invocation (as before); false = off; an object sets the head sampling rate", () => {
    expect(workerObservability(undefined)).toEqual({ enabled: true });
    expect(workerObservability(true)).toEqual({ enabled: true });
    expect(workerObservability(false)).toEqual({ enabled: false });
    expect(workerObservability({ head_sampling_rate: 0.1 })).toEqual({ enabled: true, head_sampling_rate: 0.1 });
    expect(workerObservability({ enabled: false, head_sampling_rate: 0.1 })).toEqual({ enabled: false });
    expect(buildMetadata({ project: "logs", env: "prod", compatibilityDate: "2026-10-01", provisionedClasses: [] }).metadata.observability).toEqual({ enabled: true });
    expect(buildMetadata({ project: "logs", env: "prod", compatibilityDate: "2026-10-01", provisionedClasses: [], observability: { enabled: true, head_sampling_rate: 0.05 } }).metadata.observability).toEqual({ enabled: true, head_sampling_rate: 0.05 });
  });

  it("is validated", () => {
    for (const ok of [true, false, {}, { enabled: false }, { head_sampling_rate: 0 }, { enabled: true, head_sampling_rate: 1 }]) expect(() => validateConfig({ ...base, observability: ok }), JSON.stringify(ok)).not.toThrow();
    expect(() => validateConfig({ ...base, observability: "on" })).toThrow(/"observability" must be a boolean or an object/);
    expect(() => validateConfig({ ...base, observability: [] })).toThrow(/"observability" must be a boolean or an object/);
    expect(() => validateConfig({ ...base, observability: { enabled: "yes" } })).toThrow(/observability.enabled" must be a boolean/);
    expect(() => validateConfig({ ...base, observability: { head_sampling_rate: 2 } })).toThrow(/head_sampling_rate" must be a number in \[0, 1\]/);
    expect(() => validateConfig({ ...base, observability: { logs: true } })).toThrow(/observability.logs" is unknown/);
  });

  it("deploy uploads the configured observability", async () => {
    const cf = fakeCloudflare({ exists: true, classes: ["Shard", "System"] });
    const sampled = projectFrom(root, { ...config, observability: { head_sampling_rate: 0.25 } });
    await deploy(sampled, { env: "prod", token: "test-token", fetch: cf.fetchImpl, prebuilt, registry: false, log: () => {} });
    expect(cf.calls.find((c) => c.metadata)!.metadata.observability).toEqual({ enabled: true, head_sampling_rate: 0.25 });
  });
});
