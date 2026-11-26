// ember.json `limits.cpuMs` / `placement` (Script PUT only, no redundant write) and `ember deploy --preview <branch>`
// (derived environments), against the fake Cloudflare account, counting requests.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { authSettings, envConfig, isDerivedPreview, previewEnvName, projectFrom, resolveEnv, validateConfig, workerName, workerSettings, type EmberConfigFile, type Project } from "../src/config.ts";
import { deploy, planDeploy, settingsChanges, versionMetadata, type DeployOptions } from "../src/deploy/index.ts";
import { indexingQueueName } from "../src/deploy/ai.ts";
import { filesQueueName } from "../src/deploy/files.ts";
import { destroy } from "../src/destroy.ts";
import { envRm, envSet } from "../src/env.ts";
import { withAuthFrom } from "../src/sso.ts";
import { fakeAccount } from "./fake-account.ts";
import { TMP } from "./helpers.ts";

const root = join(TMP, `deploy-settings-${process.pid}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function repo(extra: Partial<EmberConfigFile> = {}): Project {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  const config = validateConfig({ project: "chat", compatibilityDate: "2026-10-01", environments: { prod: {}, preview: { vars: { FLAG: "preview" } } }, ...extra });
  writeFileSync(join(dir, "ember.json"), JSON.stringify(config, null, 2));
  return projectFrom(dir, config);
}

const CODE = "export default { fetch() { return new Response('ok') } }";
const prebuilt: NonNullable<DeployOptions["prebuilt"]> = {
  build: { code: CODE, entry: "entry.mjs", outFile: "index.js", bytes: CODE.length, sha256: "f".repeat(64), auth: null },
  hasCrons: false,
  schemaVersion: "a".repeat(64),
};

const run = (cf: ReturnType<typeof fakeAccount>, project: Project, extra: Partial<DeployOptions> = {}) => {
  const lines: string[] = [];
  return deploy(project, { env: "prod", token: "t", accountId: "acc", fetch: cf.fetchImpl, prebuilt, registry: false, log: (l) => lines.push(l), ...extra }).then((r) => ({ ...r, lines }));
};

/** Requests to one Worker's script (`PUT /workers/scripts/<w>`), versions and deployments since `from`. */
const writes = (cf: ReturnType<typeof fakeAccount>, worker: string, from = 0) => {
  const calls = cf.calls.slice(from);
  return {
    scriptPuts: calls.filter((c) => c.method === "PUT" && c.path === `/workers/scripts/${worker}`),
    versions: calls.filter((c) => c.method === "POST" && c.path === `/workers/scripts/${worker}/versions`),
    deployments: calls.filter((c) => c.method === "POST" && c.path === `/workers/scripts/${worker}/deployments`),
    settingsReads: calls.filter((c) => c.method === "GET" && c.path === `/workers/scripts/${worker}/settings`),
  };
};

describe("ember.json limits.cpuMs and placement", () => {
  it("validates them, at the top level and per environment", () => {
    const base = { project: "x", compatibilityDate: "2026-10-01", environments: { prod: {} } };
    expect(validateConfig({ ...base, limits: { cpuMs: 50 }, placement: "smart" }).limits).toEqual({ cpuMs: 50 });
    for (const limits of [{ cpuMs: 5 }, { cpuMs: 300_001 }, { cpuMs: 1.5 }, { cpuMs: "50" }, { cpu: 50 }, [], "50"]) {
      expect(() => validateConfig({ ...base, limits }), JSON.stringify(limits)).toThrow(/"limits/);
    }
    expect(() => validateConfig({ ...base, placement: "off" })).toThrow(/"placement" must be "smart"/);
    expect(() => validateConfig({ ...base, environments: { prod: { limits: { cpuMs: 0 } } } })).toThrow(/environments\.prod\.limits\.cpuMs/);
    expect(() => validateConfig({ ...base, environments: { prod: { placement: true } } })).toThrow(/environments\.prod\.placement/);
    // An environment overrides the project's values key by key.
    const p = projectFrom("/x", validateConfig({ ...base, limits: { cpuMs: 50 }, environments: { prod: { placement: "smart" }, dev: { limits: { cpuMs: 1000 } } } }));
    expect(workerSettings(p, "prod")).toEqual({ limits: { cpuMs: 50 }, placement: "smart" });
    expect(workerSettings(p, "dev")).toEqual({ limits: { cpuMs: 1000 } });
    expect(workerSettings(projectFrom("/x", validateConfig(base)), "prod")).toEqual({});
  });

  it("settingsChanges: only what differs; unknown current settings count as changes; versions never carry them", () => {
    const m = { limits: { cpu_ms: 50 }, placement: { mode: "smart" as const } };
    expect(settingsChanges(m, { settings: { cpuMs: 50, placement: "smart" } })).toEqual([]);
    expect(settingsChanges(m, { settings: { cpuMs: null, placement: "smart" } })).toEqual(["limits.cpu_ms unset → 50"]);
    expect(settingsChanges(m, {})).toEqual(["limits.cpu_ms unknown → 50", "placement unknown → smart"]);
    expect(settingsChanges({}, {})).toEqual([]);
    const full = { main_module: "index.js", compatibility_date: "2026-10-01", compatibility_flags: [], bindings: [], exports: {}, observability: { enabled: true }, keep_bindings: [], ...m };
    expect(versionMetadata(full)).not.toHaveProperty("limits");
    expect(versionMetadata(full)).not.toHaveProperty("placement");
    // A first deploy (Script PUT) carries them and "changes" nothing.
    const first = planDeploy({ worker: "w", current: { exists: false, provisionedClasses: [], activeVersions: [] }, metadata: full, createdClasses: [], hasCrons: false });
    expect([first.strategy, first.settings]).toEqual(["create", []]);
    const changed = planDeploy({ worker: "w", current: { exists: true, provisionedClasses: [], activeVersions: [{ version_id: "v0", percentage: 100 }], settings: { cpuMs: 30000, placement: null } }, metadata: full, createdClasses: [], hasCrons: false, gradual: 10 });
    expect(changed.strategy).toBe("settings-change");
    expect(changed.steps.map((s) => s.kind)).toContain("upload-script");
    expect(changed.steps.map((s) => s.kind)).not.toContain("upload-version");
    expect(changed.warnings.join("\n")).toMatch(/--gradual ignored: limits\.cpu_ms 30000 → 50, placement unset → smart/);
  });

  it("first deploy: the Script PUT carries limits.cpu_ms and Smart Placement", async () => {
    const cf = fakeAccount({ namespaces: true });
    const r = await run(cf, repo({ limits: { cpuMs: 50 }, placement: "smart" }));
    const w = writes(cf, "ember-chat-prod");
    expect(r.plan.strategy).toBe("create");
    expect(w.scriptPuts).toHaveLength(1);
    expect(w.scriptPuts[0]!.metadata.limits).toEqual({ cpu_ms: 50 });
    expect(w.scriptPuts[0]!.metadata.placement).toEqual({ mode: "smart" });
    expect(r.lines.join("\n")).toMatch(/worker settings: limits\.cpu_ms 50, placement smart/);
  });

  it("redeploy with the same settings: a version upload without them, no Script PUT", async () => {
    const cf = fakeAccount({ namespaces: true });
    const p = repo({ limits: { cpuMs: 50 }, placement: "smart" });
    await run(cf, p);
    const from = cf.calls.length;
    const r = await run(cf, p);
    const w = writes(cf, "ember-chat-prod", from);
    expect(r.plan.strategy).toBe("code-only");
    expect(w.settingsReads).toHaveLength(1);
    expect(w.scriptPuts).toHaveLength(0);
    expect(w.versions).toHaveLength(1);
    expect(w.versions[0]!.metadata).not.toHaveProperty("limits");
    expect(w.versions[0]!.metadata).not.toHaveProperty("placement");
    expect(w.deployments).toHaveLength(1);
    expect(r.lines.join("\n")).toMatch(/worker settings: .*\(unchanged\)/);
  });

  it("a changed cpuMs goes up as one Script PUT (no version upload, no deployment call)", async () => {
    const cf = fakeAccount({ namespaces: true });
    const p = repo({ limits: { cpuMs: 50 } });
    await run(cf, p);
    const from = cf.calls.length;
    p.config.limits = { cpuMs: 120_000 };
    const r = await run(cf, p);
    const w = writes(cf, "ember-chat-prod", from);
    expect(r.plan.strategy).toBe("settings-change");
    expect(r.plan.settings).toEqual(["limits.cpu_ms 50 → 120000"]);
    expect(w.scriptPuts).toHaveLength(1);
    expect(w.scriptPuts[0]!.metadata.limits).toEqual({ cpu_ms: 120_000 });
    expect(w.versions).toHaveLength(0);
    expect(w.deployments).toHaveLength(0);
    expect(r.versionId).toBe("v0");
    // And then nothing more to change.
    const again = cf.calls.length;
    expect((await run(cf, p)).plan.strategy).toBe("code-only");
    expect(writes(cf, "ember-chat-prod", again).scriptPuts).toHaveLength(0);
  });

  it("unreadable settings: applied (Script PUT) rather than assumed", async () => {
    const cf = fakeAccount({ namespaces: true });
    const p = repo({ placement: "smart" });
    await run(cf, p);
    cf.failSettings = true;
    const from = cf.calls.length;
    const r = await run(cf, p);
    expect(r.plan.settings).toEqual(["placement unknown → smart"]);
    expect(writes(cf, "ember-chat-prod", from).scriptPuts).toHaveLength(1);
  });

  it("a dry run reads no settings and reports no settings-change (its plan assumes a Worker that does not exist)", async () => {
    const cf = fakeAccount({ namespaces: true });
    const p = repo({ limits: { cpuMs: 50 }, placement: "smart" });
    await run(cf, p);
    const from = cf.calls.length;
    const dry = await run(cf, p, { dryRun: true });
    expect(dry.plan.strategy).toBe("create");
    expect(dry.plan.settings ?? []).toEqual([]);
    expect(writes(cf, "ember-chat-prod", from).settingsReads).toHaveLength(0);
    expect(dry.lines.join("\n")).not.toMatch(/settings-change|unknown →/);
  });

  it("without limits or placement in ember.json nothing is read or sent", async () => {
    const cf = fakeAccount({ namespaces: true });
    const p = repo();
    await run(cf, p);
    await run(cf, p);
    const w = writes(cf, "ember-chat-prod");
    expect(w.settingsReads).toHaveLength(0);
    expect(w.scriptPuts).toHaveLength(1);
    expect(w.scriptPuts[0]!.metadata).not.toHaveProperty("limits");
    expect(w.scriptPuts[0]!.metadata).not.toHaveProperty("placement");
  });
});

describe("ember deploy --preview <branch>", () => {
  it("previewEnvName: a safe, stable slug that fits the environment and Worker names", () => {
    expect(previewEnvName("chat", "feature/Login-Page")).toBe("preview-feature-login-page");
    expect(previewEnvName("chat", "  fix__#42!! ")).toBe("preview-fix-42");
    expect(previewEnvName("chat", "dependabot/npm_and_yarn/esbuild-0.28")).toBe("preview-dependabot-npm-and-yarn-e-826d80");
    // Branches with the same slug share one preview.
    expect(previewEnvName("chat", "feat/x")).toBe(previewEnvName("chat", "feat-x"));
    const long = "feature/a-very-long-branch-name-that-goes-on-and-on-forever";
    const a = previewEnvName("chat", long);
    const b = previewEnvName("chat", `${long}-2`);
    expect(a).not.toBe(b);
    for (const name of [a, b, previewEnvName("a".repeat(30), long)]) {
      expect(name).toMatch(/^preview-[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(40);
    }
    expect(a).toMatch(/-[0-9a-f]{6}$/);
    // The Worker and every resource named after it (queues -files, -actions, -indexing) fit Cloudflare's 63.
    for (const project of ["chat", "a".repeat(30), "b".repeat(31)]) {
      for (const branch of [long, "b".repeat(80), "x"]) {
        const env = previewEnvName(project, branch);
        const worker = workerName(project, env);
        for (const name of [worker, filesQueueName(project, env), `${worker}-actions`, indexingQueueName(project, env)]) expect(name.length, name).toBeLessThanOrEqual(63);
      }
    }
    // A name that already fit is unchanged (the reserve only cuts slugs that would not have fit their resources).
    expect(previewEnvName("chat", "feature/Login-Page")).toBe("preview-feature-login-page");
    // A project name so long that no cut slug fits: a clear error, never a negative slice.
    expect(previewEnvName("c".repeat(38), "x")).toBe("preview-x");
    expect(() => previewEnvName("c".repeat(38), long)).toThrow(/project name "c{38}" is too long for preview environments/);
    expect(() => previewEnvName("c".repeat(40), "x")).toThrow(/too long for preview environments/);
    // Every derived name passes ember.json's own environment-name rule.
    expect(() => validateConfig({ project: "chat", compatibilityDate: "2026-10-01", environments: { [a]: {} } })).not.toThrow();
    expect(() => previewEnvName("chat", "///")).toThrow(/no letters or digits/);
  });

  it("SSO by name on a preview keeps what it inherits from environments.preview (withAuthFrom)", () => {
    const p = repo({ limits: { cpuMs: 50 }, auth: { url: "https://app.example.com", from: "identity" }, environments: { prod: {}, preview: { vars: { FLAG: "preview" }, limits: { cpuMs: 120_000 }, placement: "smart", account: "acc2" } } });
    const env = previewEnvName("chat", "feat/x");
    const before = { settings: workerSettings(p, env), config: resolveEnv(p, env).config };
    const sso = withAuthFrom(p, env, "https://identity.example.com");
    expect(isDerivedPreview(sso, env)).toBe(true);
    expect(workerSettings(sso, env)).toEqual({ limits: { cpuMs: 120_000 }, placement: "smart" });
    expect(workerSettings(sso, env)).toEqual(before.settings);
    expect(resolveEnv(sso, env).config).toMatchObject({ vars: { FLAG: "preview" }, account: "acc2" });
    // The resolved URL, and still no base auth.url (the preview's issuer is its own workers.dev address).
    expect(authSettings(sso, env)).toEqual({ from: "https://identity.example.com" });
    // ember.json itself and the declared environments are untouched.
    expect(p.config.environments.preview!.auth).toBeUndefined();
    expect(withAuthFrom(p, "prod", "https://i.example.com").config.environments.prod).toEqual({ auth: { from: "https://i.example.com" } });
    expect(before.config).toEqual(resolveEnv(p, env).config);
  });

  it("derives preview-<slug> from environments.preview; declared names win; auth.url is dropped", () => {
    const p = repo({ auth: { url: "https://app.example.com" }, environments: { prod: {}, preview: { vars: { FLAG: "preview" }, auth: { syncShard: "global:x" } } } });
    expect(resolveEnv(p, "preview-feat-x")).toEqual({ name: "preview-feat-x", config: { vars: { FLAG: "preview" }, auth: { syncShard: "global:x" } } });
    expect(isDerivedPreview(p, "preview-feat-x")).toBe(true);
    expect(isDerivedPreview(p, "preview")).toBe(false);
    expect(authSettings(p, "preview-feat-x")).toEqual({ syncShard: "global:x" });
    expect(authSettings(p, "prod")).toEqual({ url: "https://app.example.com" });
    const noBase = repo({ environments: { prod: {} } });
    expect(envConfig(noBase, "preview-feat-x")).toBeUndefined();
    expect(() => resolveEnv(noBase, "preview-feat-x")).toThrow(/derive from "environments.preview"/);
  });

  it("deploys an isolated Worker (own name, EMBER_ENV, inherited vars), idempotently, and --destroy removes only it", async () => {
    const cf = fakeAccount({ namespaces: true });
    const p = repo({ limits: { cpuMs: 50 }, environments: { prod: {}, preview: { vars: { FLAG: "preview" }, placement: "smart" } } });
    await run(cf, p);
    const env = previewEnvName("chat", "feat/x");
    const first = await run(cf, p, { env });
    const worker = "ember-chat-preview-feat-x";
    expect(first.plan.worker).toBe(worker);
    expect(first.plan.strategy).toBe("create");
    const put = writes(cf, worker).scriptPuts[0]!;
    const plain = Object.fromEntries(put.metadata.bindings.filter((b: { type: string }) => b.type === "plain_text").map((b: { name: string; text: string }) => [b.name, b.text]));
    expect(plain).toMatchObject({ EMBER_ENV: "preview-feat-x", EMBER_PROJECT: "chat", FLAG: "preview" });
    expect(put.metadata.limits).toEqual({ cpu_ms: 50 });
    // limits come from the project here; placement from environments.preview (below), both on the first Script PUT.
    expect(put.metadata.placement).toEqual({ mode: "smart" });
    // The deployment is recorded under the derived name (`ember run --env preview-feat-x` finds it).
    expect(JSON.parse(readFileSync(join(p.stateDir, "deployments.json"), "utf8"))[env].worker).toBe(worker);
    // Again for the same branch: the same Worker, a code-only redeploy.
    const second = await run(cf, p, { env });
    expect([second.plan.worker, second.plan.strategy]).toEqual([worker, "code-only"]);
    expect(writes(cf, worker).scriptPuts).toHaveLength(1);
    // Its vars are environments.preview's: `ember env set --var` refuses to invent an entry for it.
    await expect(envSet({ client: cf.client, project: p, env, worker }, "X", "1", { var: true })).rejects.toThrow(/preview environment/);
    // Nor remove an inherited one: it points at environments.preview.
    await expect(envRm({ client: cf.client, project: p, env, worker }, "FLAG")).rejects.toThrow(/set or remove them there/);
    // An environment ember.json does not declare (a typo'd --env) is never added to it.
    const before = readFileSync(p.configPath, "utf8");
    await expect(envSet({ client: cf.client, project: p, env: "prd", worker: "ember-chat-prd" }, "X", "1", { var: true })).rejects.toThrow(/prd is not an environment in ember\.json.*declare it under "environments" first/);
    expect(readFileSync(p.configPath, "utf8")).toBe(before);
    expect(p.config.environments).not.toHaveProperty("prd");
    expect(cf.workers.has(worker)).toBe(true);
    const d = await destroy(p, { env, yes: true, token: "t", accountId: "acc", fetch: cf.fetchImpl, log: () => {} });
    expect(d.deleted).toContain(`worker ${worker}`);
    expect(cf.workers.has(worker)).toBe(false);
    expect(cf.workers.has("ember-chat-prod")).toBe(true);
    // Destroying again is a no-op, not an error.
    const again = await destroy(p, { env, yes: true, token: "t", accountId: "acc", fetch: cf.fetchImpl, log: () => {} });
    expect(again.deleted).not.toContain(`worker ${worker}`);
  });
});

describe("ember destroy --preview / deploy --preview --destroy (the CLI)", () => {
  const cli = (cwd: string, args: string[]) => {
    const env = { ...process.env };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CLOUDFLARE_API_TOKEN;
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/ember.js", import.meta.url)), ...args], { cwd, env, encoding: "utf8" });
    return { code: r.status, stderr: r.stderr };
  };

  it("the destroy alias needs no --yes for a preview (naming the branch is the ask); a declared environment still does", () => {
    const p = repo();
    // Past the confirmation: it stops at the missing account, before any request.
    const alias = cli(p.root, ["destroy", "--preview", "feat/x"]);
    expect([alias.code, alias.stderr]).toEqual([1, expect.stringMatching(/No Cloudflare account/)]);
    expect(alias.stderr).not.toMatch(/--yes/);
    const viaDeploy = cli(p.root, ["deploy", "--preview", "feat/x", "--destroy"]);
    expect(viaDeploy.stderr).toMatch(/No Cloudflare account/);
    const declared = cli(p.root, ["destroy", "--env", "prod"]);
    expect([declared.code, declared.stderr]).toEqual([1, expect.stringMatching(/Re-run with --yes/)]);
  }, 60_000);

  it("--destroy refuses the deploy-only flags it would ignore", () => {
    const p = repo();
    for (const flag of [["--url", "https://x.example"], ["--admin-token", "t"], ["--shard", "global:main"], ["--no-dashboard"]]) {
      const r = cli(p.root, ["deploy", "--preview", "feat/x", "--destroy", ...flag]);
      expect([flag[0], r.code, r.stderr]).toEqual([flag[0], 1, expect.stringContaining(`it does not take ${flag[0]}`)]);
    }
  }, 60_000);
});

