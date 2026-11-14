// The optional Ember Dashboard in `ember deploy` / `ember destroy` (dashboard-link.ts): the first-deploy question
// and its answer in ember.json, flags, never asking (nor creating) without a terminal, the login wizard (Access or a
// token shown once), each project's own admin token on both sides, and unlinking on destroy.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadProject, validateConfig, type EmberConfigFile, type Project } from "../src/config.ts";
import { adminTokenKey, deployWithDashboard, rotateDashboardToken, type DashboardIo } from "../src/dashboard-link.ts";
import { deploy, type DeployOptions } from "../src/deploy/index.ts";
import { destroy } from "../src/destroy.ts";
import { interactive, type Prompter } from "../src/prompt.ts";
import { D1Registry } from "../src/registry.ts";
import { fakeAccount } from "./fake-account.ts";
import { TMP } from "./helpers.ts";

const root = join(TMP, `dashboard-link-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CODE = "export default {}";
const prebuilt: NonNullable<DeployOptions["prebuilt"]> = {
  build: { code: CODE, entry: "e", outFile: "index.js", bytes: CODE.length, sha256: "f".repeat(64), auth: null },
  hasCrons: false,
  schemaVersion: "b".repeat(64),
};

let n = 0;
function repo(config: Partial<EmberConfigFile> = {}): Project {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ember.json"), JSON.stringify({ project: "chat", account: "acc", compatibilityDate: "2026-10-01", environments: { prod: {} }, ...config }, null, 2));
  return loadProject(dir);
}

/** Scripted prompts and captured output. `secrets` collects what `show` printed (the terminal), apart from the log. */
function io(o: { interactive: boolean; answers?: Array<boolean | string> }): DashboardIo & { lines: string[]; shown: string[]; asked: string[] } {
  const answers = [...(o.answers ?? [])];
  const asked: string[] = [];
  const prompter: Prompter = {
    yesNo: async (q) => {
      asked.push(q);
      const a = answers.shift();
      if (typeof a !== "boolean") throw new Error(`unexpected yes/no question: ${q}`);
      return a;
    },
    line: async (q) => {
      asked.push(q);
      const a = answers.shift();
      if (typeof a !== "string") throw new Error(`unexpected question: ${q}`);
      return a;
    },
  };
  const lines: string[] = [];
  const shown: string[] = [];
  return { interactive: o.interactive, prompter, log: (l) => lines.push(l), show: (l) => shown.push(l), lines, shown, asked };
}

async function run(cf: ReturnType<typeof fakeAccount>, project: Project, flag: boolean | undefined, out: ReturnType<typeof io>) {
  return deployWithDashboard(project, {
    flag,
    env: "prod",
    dryRun: false,
    io: out,
    client: () => cf.client,
    registry: (client) => D1Registry.open(client, "r"),
    deploy: (dashboardAdminToken) => deploy(project, { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt, registryName: "r", log: () => {}, ...(dashboardAdminToken ? { dashboardAdminToken } : {}) }),
  });
}

const KEY = adminTokenKey("ember-chat-prod");

describe("whether to deploy the dashboard", () => {
  it("never asks without a terminal (or in CI), creates nothing and writes nothing", async () => {
    expect(interactive({ CI: "true" }, { isTTY: true }, { isTTY: true })).toBe(false);
    expect(interactive({}, { isTTY: true }, { isTTY: false })).toBe(false);
    expect(interactive({ CI: "false" }, { isTTY: true }, { isTTY: true })).toBe(true);
    const cf = fakeAccount();
    const p = repo();
    const out = io({ interactive: false });
    await run(cf, p, undefined, out);
    expect(out.asked).toEqual([]);
    expect(cf.workers.has("ember-dashboard")).toBe(false);
    expect(JSON.parse(readFileSync(p.configPath, "utf8")).dashboard).toBeUndefined();
    expect(cf.secretsOf("ember-chat-prod").has("EMBER_ADMIN_TOKEN_DASHBOARD")).toBe(false);
    expect(out.lines.join("\n")).toMatch(/--dashboard/);
  }, 60_000);

  it("asks on the first deploy in a terminal and saves the answer; --no-dashboard saves false", async () => {
    const cf = fakeAccount();
    const p = repo();
    const no = io({ interactive: true, answers: [false] });
    await run(cf, p, undefined, no);
    expect(no.asked).toHaveLength(1);
    expect(JSON.parse(readFileSync(p.configPath, "utf8")).dashboard).toBe(false);
    // Saved: the next deploy does not ask again.
    const again = io({ interactive: true });
    await run(cf, loadProject(p.root), undefined, again);
    expect(again.asked).toEqual([]);
    const p2 = repo({ project: "other", dashboard: true });
    await run(cf, p2, false, io({ interactive: false }));
    expect(JSON.parse(readFileSync(p2.configPath, "utf8")).dashboard).toBe(false);
    expect(cf.workers.has("ember-dashboard")).toBe(false);
    expect(() => validateConfig({ project: "x", compatibilityDate: "2026-10-01", environments: { prod: {} }, dashboard: "yes" })).toThrow(/dashboard/);
  }, 60_000);

  it('"dashboard": true without a terminal updates an existing dashboard but never creates one', async () => {
    const cf = fakeAccount();
    const p = repo({ dashboard: true });
    const out = io({ interactive: false });
    await run(cf, p, undefined, out);
    expect(cf.workers.has("ember-dashboard")).toBe(false);
    expect(out.lines.join("\n")).toMatch(/does not exist yet/);
  }, 60_000);
});

describe("creating and linking", () => {
  it("--dashboard without a terminal: token login, the token goes to a mode-600 file (never the log); each side gets the project's admin token", async () => {
    const cf = fakeAccount();
    const p = repo();
    const out = io({ interactive: false });
    await run(cf, p, true, out);
    expect(JSON.parse(readFileSync(p.configPath, "utf8")).dashboard).toBe(true);
    expect(cf.workers.has("ember-dashboard")).toBe(true);
    const projectToken = cf.secretsOf("ember-chat-prod").get("EMBER_ADMIN_TOKEN_DASHBOARD");
    expect(projectToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cf.secretsOf("ember-dashboard").get(KEY)).toBe(projectToken);
    const dashToken = cf.secretsOf("ember-dashboard").get("DASHBOARD_TOKEN")!;
    const file = join(p.root, ".ember", "dashboard-token");
    expect(readFileSync(file, "utf8").trim()).toBe(dashToken);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const logged = out.lines.join("\n");
    for (const secret of [dashToken, projectToken!]) expect(logged).not.toContain(secret);
    expect(out.shown).toEqual([]);
    // The project's token travelled in the project's own upload (not a separate secrets call).
    const projectPut = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-chat-prod")!;
    expect(projectPut.metadata.bindings.map((b: { name: string }) => b.name)).toContain("EMBER_ADMIN_TOKEN_DASHBOARD");
    const dashPut = cf.calls.filter((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-dashboard").pop()!;
    expect(dashPut.metadata.bindings).toEqual(expect.arrayContaining([{ type: "service", name: "EMBER_SVC_0", service: "ember-chat-prod" }]));

    // Next deploy: both sides already have the token → none generated, and the dashboard upload is skipped.
    const puts = () => cf.calls.filter((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-dashboard").length;
    const before = puts();
    const next = io({ interactive: false });
    await run(cf, loadProject(p.root), undefined, next);
    expect(cf.secretsOf("ember-chat-prod").get("EMBER_ADMIN_TOKEN_DASHBOARD")).toBe(projectToken);
    expect(puts()).toBe(before);
    expect(next.lines.join("\n")).toMatch(/already up to date/);

    // A side that lost its secret gets a fresh token on both.
    cf.secretsOf("ember-dashboard").delete(KEY);
    await run(cf, loadProject(p.root), undefined, io({ interactive: false }));
    const fresh = cf.secretsOf("ember-chat-prod").get("EMBER_ADMIN_TOKEN_DASHBOARD");
    expect(fresh).not.toBe(projectToken);
    expect(cf.secretsOf("ember-dashboard").get(KEY)).toBe(fresh);
  }, 60_000);

  it("a dashboard API failure never blocks the project deploy", async () => {
    const cf = fakeAccount();
    const p = repo({ dashboard: true });
    cf.failSettings = true;
    const out = io({ interactive: true });
    await run(cf, p, undefined, out);
    expect(cf.workers.has("ember-chat-prod")).toBe(true);
    expect(cf.workers.has("ember-dashboard")).toBe(false);
    expect(out.lines.join("\n")).toMatch(/skipping the Ember Dashboard/);
  }, 60_000);

  it("terminal + Zero Trust: Access with the given emails as admins, no dashboard token at all", async () => {
    const cf = fakeAccount();
    cf.access.team = "acme.cloudflareaccess.com";
    const p = repo();
    const out = io({ interactive: true, answers: [true, true, "ana@acme.test, bob@acme.test"] });
    await run(cf, p, undefined, out);
    expect(out.asked).toHaveLength(3);
    expect(cf.access.apps).toMatchObject([{ domain: "ember-dashboard.acme.workers.dev", name: "ember-dashboard" }]);
    const dashPut = cf.calls.filter((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-dashboard").pop()!;
    const vars = Object.fromEntries(dashPut.metadata.bindings.filter((b: { type: string }) => b.type === "plain_text").map((b: { name: string; text: string }) => [b.name, b.text]));
    expect(vars).toMatchObject({ ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: "aud-1", DASHBOARD_ADMINS: "ana@acme.test,bob@acme.test" });
    expect(cf.secretsOf("ember-dashboard").has("DASHBOARD_TOKEN")).toBe(false);
    expect(out.shown).toEqual([]);

    // Later uploads of an Access-only dashboard (a re-link, a destroy) never mint a login token nobody is shown.
    cf.secretsOf("ember-chat-prod").delete("EMBER_ADMIN_TOKEN_DASHBOARD");
    await run(cf, loadProject(p.root), undefined, io({ interactive: false }));
    expect(cf.secretsOf("ember-dashboard").has(KEY)).toBe(true);
    expect(cf.secretsOf("ember-dashboard").has("DASHBOARD_TOKEN")).toBe(false);
    await destroy(loadProject(p.root), { env: "prod", yes: true, token: "t", fetch: cf.fetchImpl, registryName: "r", log: () => {} });
    expect(cf.secretsOf("ember-dashboard").has("DASHBOARD_TOKEN")).toBe(false);
  }, 60_000);

  it("terminal without Zero Trust: token login, shown once on the terminal and not logged", async () => {
    const cf = fakeAccount();
    const p = repo();
    const out = io({ interactive: true, answers: [true] });
    await run(cf, p, undefined, out);
    const token = cf.secretsOf("ember-dashboard").get("DASHBOARD_TOKEN")!;
    expect(out.shown.join("\n")).toContain(token);
    expect(out.lines.join("\n")).not.toContain(token);

    // `ember dashboard token`: a new one replaces it, shown once.
    const rot = io({ interactive: true });
    await rotateDashboardToken(cf.client, { io: rot, dir: p.root });
    const next = cf.secretsOf("ember-dashboard").get("DASHBOARD_TOKEN")!;
    expect(next).not.toBe(token);
    expect(rot.shown.join("\n")).toContain(next);
    expect(rot.lines.join("\n")).not.toContain(next);
  }, 60_000);
});

describe("ember destroy", () => {
  it("unbinds the environment from the dashboard and deletes its admin token there", async () => {
    const cf = fakeAccount();
    const p = repo();
    await run(cf, p, true, io({ interactive: false }));
    expect(cf.secretsOf("ember-dashboard").has(KEY)).toBe(true);
    const r = await destroy(loadProject(p.root), { env: "prod", yes: true, token: "t", fetch: cf.fetchImpl, registryName: "r", log: () => {} });
    expect(r.deleted).toContain("dashboard link ember-chat-prod");
    expect(cf.secretsOf("ember-dashboard").has(KEY)).toBe(false);
    const dashPut = cf.calls.filter((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-dashboard").pop()!;
    expect(dashPut.metadata.bindings.filter((b: { type: string }) => b.type === "service")).toEqual([]);
    // The unbinding happened before the Worker was deleted.
    const order = cf.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.lastIndexOf("PUT /workers/scripts/ember-dashboard")).toBeLessThan(order.indexOf("DELETE /workers/scripts/ember-chat-prod?force=true"));
    expect(cf.workers.has("ember-chat-prod")).toBe(false);
  }, 60_000);

  it("without the registry the link is not reported as removed, and the destroy goes on", async () => {
    const cf = fakeAccount();
    const p = repo();
    await run(cf, p, true, io({ interactive: false }));
    const lines: string[] = [];
    const r = await destroy(loadProject(p.root), { env: "prod", yes: true, token: "t", fetch: cf.fetchImpl, registryName: "not-there", log: (l) => lines.push(l) });
    expect(r.deleted).not.toContain("dashboard link ember-chat-prod");
    expect(lines.join("\n")).toMatch(/still binds ember-chat-prod/);
    expect(cf.workers.has("ember-chat-prod")).toBe(false);
  }, 60_000);
});
