// The Ember Dashboard is optional (PLAN §21; contracts.md "Dashboard", "CLI"). This module is what `ember deploy`
// does about it:
//
//   - whether to: `--dashboard` / `--no-dashboard`, else `"dashboard"` in ember.json, else — only in a terminal that
//     is not CI — a question on the first deploy, whose answer is written to ember.json. Without a terminal it never
//     asks and never creates anything;
//   - linking a project: the dashboard reaches each project with that project's own admin token, generated here,
//     uploaded to the project as EMBER_ADMIN_TOKEN_DASHBOARD (in the deploy's own upload) and to the dashboard as
//     `adminTokenKey(worker)`. It is never printed, logged or written to disk; a new one is generated whenever either
//     side lacks it (secrets cannot be read back);
//   - creating the dashboard (first time, terminal or `--dashboard`): Cloudflare Access when the account has Zero
//     Trust and the user agrees (the people let in become admins, no token is made), else a dashboard token shown
//     once on the terminal (without a terminal: written to .ember/dashboard-token, mode 600);
//   - `ember destroy`: unbinding the environment from the dashboard and deleting its token there.

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adminTokenKey } from "@freecorps/ember-dashboard/projects";
import { ensureAccessApp } from "./access.ts";
import { writeConfigKey, workerName, type Project } from "./config.ts";
import { DEFAULT_DASHBOARD_NAME, deployDashboard, type DashboardDeployResult } from "./dashboard.ts";
import type { CfClient } from "./deploy/cf.ts";
import type { Prompter } from "./prompt.ts";
import type { D1Registry } from "./registry.ts";

export { adminTokenKey };

export interface DashboardIo {
  interactive: boolean;
  prompter: Prompter;
  log: (line: string) => void;
  /** Prints a secret to the terminal (interactive only; never the log). */
  show: (line: string) => void;
}

/** Whether this deploy links the project to the dashboard, and whether it may create the dashboard. */
export async function dashboardChoice(project: Project, flag: boolean | undefined, io: DashboardIo): Promise<{ enabled: boolean; create: boolean }> {
  const saved = project.config.dashboard;
  if (flag === false) {
    if (saved !== false) writeConfigKey(project, "dashboard", false);
    return { enabled: false, create: false };
  }
  if (flag === true) {
    if (saved !== true) writeConfigKey(project, "dashboard", true);
    return { enabled: true, create: true };
  }
  if (saved === true) return { enabled: true, create: io.interactive };
  if (saved === false) return { enabled: false, create: false };
  if (!io.interactive) {
    io.log('  dashboard: not set up (no terminal to ask). `ember deploy --dashboard` adds the Ember Dashboard; `--no-dashboard` or "dashboard": false silences this.');
    return { enabled: false, create: false };
  }
  const yes = await io.prompter.yesNo(
    "Deploy the Ember Dashboard to this Cloudflare account? It runs in your account, behind Cloudflare Access or a token, and shows data, functions, logs and schedules of your projects.",
    true,
  );
  writeConfigKey(project, "dashboard", yes);
  io.log(`  dashboard: ${yes ? "on" : "off"} (saved as "dashboard": ${yes} in ember.json)`);
  return { enabled: yes, create: yes };
}

interface Settings {
  exists: boolean;
  vars: Record<string, string>;
  secrets: Set<string>;
}

async function dashboardSettings(client: CfClient, name: string): Promise<Settings> {
  const s = await client.request<{ bindings?: Array<{ type: string; name: string; text?: string }> }>("GET", `/workers/scripts/${name}/settings`);
  if (!s.success) {
    if (s.status === 404 || s.errors.some((e) => e.code === 10007)) return { exists: false, vars: {}, secrets: new Set() };
    throw new Error(`dashboard: GET /workers/scripts/${name}/settings → ${s.status} ${s.errors.map((e) => e.message).join("; ")}`);
  }
  const vars: Record<string, string> = {};
  for (const b of s.result?.bindings ?? []) if (b.type === "plain_text" && typeof b.text === "string") vars[b.name] = b.text;
  const secrets = new Set((s.result?.bindings ?? []).filter((b) => b.type === "secret_text").map((b) => b.name));
  return { exists: true, vars, secrets };
}

async function secretNames(client: CfClient, worker: string): Promise<Set<string>> {
  const r = await client.request<Array<{ name: string }>>("GET", `/workers/scripts/${worker}/secrets`);
  if (r.success) return new Set((r.result ?? []).map((x) => x.name));
  if (r.status === 404 || r.errors.some((e) => e.code === 10007)) return new Set();
  throw new Error(`dashboard: GET /workers/scripts/${worker}/secrets → ${r.status} ${r.errors.map((e) => e.message).join("; ")}`);
}

export interface DashboardLink {
  name: string;
  worker: string;
  /** The dashboard Worker exists already. */
  exists: boolean;
  /** New admin token for this project (both sides get it), or null: both already have one. */
  token: string | null;
}

/**
 * Before the project's upload: what the deploy must carry (`token` → `dashboardAdminToken`). Null when the dashboard
 * does not exist and may not be created here.
 */
export async function prepareDashboardLink(client: CfClient, worker: string, o: { create: boolean; name?: string; log: (l: string) => void }): Promise<DashboardLink | null> {
  const name = o.name ?? DEFAULT_DASHBOARD_NAME;
  const dash = await dashboardSettings(client, name);
  if (!dash.exists && !o.create) {
    o.log(`  dashboard: ${name} does not exist yet; run \`ember deploy --dashboard\` (or \`ember dashboard deploy\`) from a terminal to create it`);
    return null;
  }
  const project = await secretNames(client, worker);
  const linked = dash.secrets.has(adminTokenKey(worker)) && project.has("EMBER_ADMIN_TOKEN_DASHBOARD");
  return { name, worker, exists: dash.exists, token: linked ? null : randomBytes(32).toString("base64url") };
}

/** Git's user.email, as the default Access admin. */
function gitEmail(cwd: string): string | undefined {
  try {
    const e = execFileSync("git", ["config", "user.email"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim();
    return /^[^\s@]+@[^\s@]+$/.test(e) ? e : undefined;
  } catch {
    return undefined;
  }
}

/** How the new dashboard signs people in: Access (when possible and wanted) or a token. */
async function chooseLogin(client: CfClient, name: string, project: Project | null, io: DashboardIo): Promise<{ access?: { team: string; aud: string }; admins?: string[] }> {
  const org = await client.request<{ auth_domain?: string }>("GET", "/access/organizations");
  const team = org.success ? org.result?.auth_domain : undefined;
  if (!team) {
    io.log("  dashboard: no Cloudflare Zero Trust organization readable in this account: signing in with a dashboard token");
    return {};
  }
  if (!io.interactive) {
    io.log(`  dashboard: Zero Trust found (${team}), but adding Cloudflare Access needs your emails: run \`ember dashboard deploy --access --access-email you@example.com\` from a terminal. Using a dashboard token for now.`);
    return {};
  }
  if (!(await io.prompter.yesNo(`Protect the dashboard with Cloudflare Access (team ${team})? Recommended: sign-in by email, no token to keep.`, true))) return {};
  const fallback = project ? gitEmail(project.root) : undefined;
  const emails = (await io.prompter.line("Emails allowed to sign in, comma-separated (they get the admin role):", fallback))
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const bad = emails.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (!emails.length || bad.length) {
    io.log(`  dashboard: ${bad.length ? `not an email: ${bad.join(", ")}` : "no email given"}; using a dashboard token. Add Access later with \`ember dashboard deploy --access --access-email you@example.com\`.`);
    return {};
  }
  const sub = (await client.request<{ subdomain?: string }>("GET", "/workers/subdomain")).result?.subdomain;
  if (!sub) {
    io.log("  dashboard: the account has no workers.dev subdomain; using a dashboard token (`ember dashboard deploy --access --host <host>` for a custom domain)");
    return {};
  }
  try {
    const app = await ensureAccessApp(client, { host: `${name}.${sub}.workers.dev`, name, emails, team, log: io.log });
    return { access: { team: app.team, aud: app.aud }, admins: emails };
  } catch (e) {
    io.log(`  dashboard: could not set up Cloudflare Access (${(e as Error).message}); using a dashboard token`);
    return {};
  }
}

/**
 * Shows a secret once: on the terminal when interactive; otherwise written to `<dir>/.ember/<file>` (mode 600) and
 * only the path is logged. Never in the log, argv or ember.json.
 */
export function revealOnce(label: string, value: string, o: { io: DashboardIo; dir: string; file: string }): void {
  if (o.io.interactive) {
    o.io.show(`\n${label} (shown once; keep it in your password manager):\n\n  ${value}\n`);
    return;
  }
  const dir = join(o.dir, ".ember");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, o.file);
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  o.io.log(`  ${label}: written to ${path} (mode 600, not printed). Move it to your password manager and delete the file.`);
}

/** After the project's upload: creates the dashboard (login wizard) or updates its bindings and this project's token. */
export async function finishDashboardLink(client: CfClient, link: DashboardLink, registry: D1Registry, o: { io: DashboardIo; project: Project | null; dir: string }): Promise<DashboardDeployResult> {
  const extraSecrets = link.token ? { [adminTokenKey(link.worker)]: link.token } : {};
  if (link.exists) {
    const r = await deployDashboard(client, { registry, name: link.name, extraSecrets, skipUnchanged: true, log: o.io.log });
    o.io.log(r.skipped ? `  dashboard: ${link.name} already up to date` : `  dashboard: ${link.worker} linked`);
    return r;
  }
  const login = await chooseLogin(client, link.name, o.project, o.io);
  const r = await deployDashboard(client, {
    registry,
    name: link.name,
    extraSecrets,
    ...(login.access ? { accessTeam: login.access.team, accessAud: login.access.aud, noToken: true } : {}),
    ...(login.admins ? { admins: login.admins } : {}),
    log: o.io.log,
  });
  if (r.generatedToken) revealOnce("Dashboard token", r.generatedToken, { io: o.io, dir: o.dir, file: "dashboard-token" });
  if (r.url) o.io.log(`  dashboard: open ${r.url}${login.access ? " (Cloudflare Access sign-in)" : ""}`);
  return r;
}

/** `ember dashboard token`: a new DASHBOARD_TOKEN (the old one stops working), shown once. */
export async function rotateDashboardToken(client: CfClient, o: { name?: string; io: DashboardIo; dir: string }): Promise<void> {
  const name = o.name ?? DEFAULT_DASHBOARD_NAME;
  const dash = await dashboardSettings(client, name);
  if (!dash.exists) throw new Error(`${name} does not exist in this account (\`ember dashboard deploy\` creates it)`);
  const token = randomBytes(24).toString("base64url");
  await client.call("PUT", `/workers/scripts/${name}/secrets`, { name: "DASHBOARD_TOKEN", text: token, type: "secret_text" });
  revealOnce("New dashboard token", token, { io: o.io, dir: o.dir, file: "dashboard-token" });
  o.io.log("  the previous dashboard token no longer works");
}

/**
 * `ember destroy`: before the Worker goes, the dashboard stops binding it and forgets its admin token. A no-op when
 * the dashboard does not exist or never knew this Worker.
 */
export async function unlinkDashboard(client: CfClient, worker: string, o: { registry: () => Promise<D1Registry | null>; name?: string; log: (l: string) => void }): Promise<boolean> {
  const name = o.name ?? DEFAULT_DASHBOARD_NAME;
  const dash = await dashboardSettings(client, name);
  if (!dash.exists) return false;
  const key = adminTokenKey(worker);
  let bound = false;
  try {
    bound = Object.prototype.hasOwnProperty.call(JSON.parse(dash.vars.EMBER_SERVICES ?? "{}"), worker);
  } catch {
    bound = false;
  }
  if (!bound && !dash.secrets.has(key)) return false;
  // The registry first: without it the binding cannot be dropped, and nothing is reported as unlinked.
  const registry = bound ? await o.registry() : null;
  if (bound && !registry) throw new Error(`the account registry could not be opened, so ${name} still binds ${worker}; run \`ember dashboard deploy\` after the destroy`);
  if (dash.secrets.has(key)) {
    const d = await client.request("DELETE", `/workers/scripts/${name}/secrets/${key}`);
    if (!d.success && d.status !== 404) throw new Error(`dashboard: could not delete ${key} from ${name}: ${d.errors.map((e) => e.message).join("; ")}`);
  }
  if (registry) await deployDashboard(client, { registry, name, exclude: [worker], log: o.log });
  o.log(`  dashboard: ${worker} unlinked from ${name}`);
  return true;
}

/** `ember dashboard destroy --yes`: deletes the dashboard Worker (registry, audit log and Access application stay). */
export async function destroyDashboard(client: CfClient, o: { name?: string; yes?: boolean; log: (l: string) => void }): Promise<void> {
  const name = o.name ?? DEFAULT_DASHBOARD_NAME;
  if (!o.yes) throw new Error(`ember dashboard destroy deletes the ${name} Worker (projects, their data, the registry and the audit log stay). Re-run with --yes.`);
  const r = await client.request("DELETE", `/workers/scripts/${name}?force=true`);
  if (!r.success && r.status !== 404 && !r.errors.some((e) => e.code === 10007)) throw new Error(`DELETE ${name}: ${r.errors.map((e) => e.message).join("; ")}`);
  o.log(r.success ? `  deleted ${name}` : `  ${name} did not exist`);
  o.log("  kept: the registry (with the audit log), project Workers and their EMBER_ADMIN_TOKEN_DASHBOARD (unused), any Access application. Set \"dashboard\": false in ember.json so deploys stop re-creating it.");
}

/**
 * `ember deploy` with the dashboard: decide (may ask), prepare the project's token, run `deploy` (which uploads it),
 * then create or update the dashboard. A dashboard failure after a successful deploy is a warning: the project is
 * up, and the next deploy links it again (a fresh token on both sides).
 */
export async function deployWithDashboard<T>(
  project: Project,
  o: {
    flag: boolean | undefined;
    env: string;
    dryRun: boolean;
    io: DashboardIo;
    client: () => CfClient;
    registry: (client: CfClient) => Promise<D1Registry>;
    deploy: (dashboardAdminToken: string | undefined) => Promise<T>;
    name?: string;
  },
): Promise<T> {
  let link: DashboardLink | null = null;
  let client: CfClient | null = null;
  if (!o.dryRun) {
    const choice = await dashboardChoice(project, o.flag, o.io);
    if (choice.enabled) {
      client = o.client();
      try {
        link = await prepareDashboardLink(client, workerName(project.config.project, o.env), { create: choice.create, log: o.io.log, ...(o.name ? { name: o.name } : {}) });
      } catch (e) {
        // Optional: the project deploys anyway, unlinked this time.
        o.io.log(`  warning: skipping the Ember Dashboard this time: ${(e as Error).message}`);
      }
    }
  }
  const result = await o.deploy(link?.token ?? undefined);
  if (link && client) {
    try {
      await finishDashboardLink(client, link, await o.registry(client), { io: o.io, project, dir: project.root });
    } catch (e) {
      o.io.log(`  warning: the deploy succeeded but the Ember Dashboard was not updated: ${(e as Error).message}. Run \`ember deploy\` again or \`ember dashboard deploy\`.`);
    }
  }
  return result;
}
