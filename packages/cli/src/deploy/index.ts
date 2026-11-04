// `ember deploy [--env] [--gradual N] [--dry-run]`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorker, type WorkerBuild } from "../build.ts";
import { codegen } from "../codegen/index.ts";
import { resolveEnv, workerName, type Project } from "../config.ts";
import { CfClient, CloudflareApiError, resolveToken } from "./cf.ts";
import { buildMetadata, NEW_VERSION, planDeploy, type CurrentState, type DeployPlan, type WorkerMetadata } from "./plan.ts";

export * from "./plan.ts";
export { CfClient, CloudflareApiError, resolveToken } from "./cf.ts";

/**
 * Account registry (PLAN §21: D1 `ember-registry` with projects, environments, domains, routes). Stub: the
 * default implementation does nothing; the D1-backed one lands with the dashboard.
 */
export interface ProjectRegistry {
  recordDeploy(info: { project: string; env: string; worker: string; url: string | null; versionId: string | null; schemaVersion: string }): Promise<void>;
}
export const noopRegistry: ProjectRegistry = { recordDeploy: async () => {} };

export interface DeployOptions {
  env?: string;
  dryRun?: boolean;
  gradual?: number;
  message?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  token?: string;
  accountId?: string;
  registry?: ProjectRegistry;
  log?: (line: string) => void;
  /** Skip codegen + bundling (tests). */
  prebuilt?: { build: WorkerBuild; hasCrons: boolean; schemaVersion: string };
  sleep?: (ms: number) => Promise<void>;
}

export interface DeployResult {
  plan: DeployPlan;
  versionId: string | null;
  url: string | null;
  dryRun: boolean;
}

export function workerForm(metadata: WorkerMetadata, code: string): FormData {
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  fd.append(metadata.main_module, new Blob([code], { type: "application/javascript+module" }), metadata.main_module);
  return fd;
}

export async function fetchCurrentState(client: CfClient, worker: string): Promise<CurrentState> {
  const d = await client.request<{ deployments: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(
    "GET",
    `/workers/scripts/${worker}/deployments`,
  );
  if (d.status === 404 || d.errors.some((e) => e.code === 10007)) return { exists: false, provisionedClasses: [], activeVersions: [] };
  if (!d.success) throw new CloudflareApiError(`GET /workers/scripts/${worker}/deployments`, d.status, d.errors);
  const ns = await client.call<Array<{ script?: string; class?: string }>>("GET", "/workers/durable_objects/namespaces?per_page=1000");
  const provisionedClasses = (ns ?? []).filter((n) => n.script === worker && n.class).map((n) => n.class!);
  return { exists: true, provisionedClasses, activeVersions: d.result?.deployments?.[0]?.versions ?? [] };
}

export async function deploy(project: Project, opts: DeployOptions = {}): Promise<DeployResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const env = resolveEnv(project, opts.env);
  const c = project.config;
  const worker = workerName(c.project, env.name);

  let prepared = opts.prebuilt;
  if (!prepared) {
    const gen = await codegen(project);
    for (const w of gen.warnings) log(`warning: ${w}`);
    const build = await buildWorker(project, { outDir: join(project.stateDir, "build", env.name) });
    prepared = { build, hasCrons: gen.manifest.crons.length > 0, schemaVersion: gen.manifest.schema.version };
  }
  const { build, hasCrons, schemaVersion } = prepared;
  const message = opts.message ?? `ember deploy (schema ${schemaVersion.slice(0, 12)})`;
  const metaInput = {
    project: c.project,
    env: env.name,
    compatibilityDate: c.compatibilityDate,
    ...(c.compatibilityFlags ? { compatibilityFlags: c.compatibilityFlags } : {}),
    ...(c.locationHint ? { locationHint: c.locationHint } : {}),
    ...(env.config.vars ? { vars: env.config.vars } : {}),
    ...(c.resources ? { resources: c.resources } : {}),
  };

  if (opts.dryRun) {
    // No API calls: the plan assumes the Worker does not exist yet (the real run fetches the current state).
    const { metadata, createdClasses } = buildMetadata({ ...metaInput, provisionedClasses: [] });
    const plan = planDeploy({ worker, current: { exists: false, provisionedClasses: [], activeVersions: [] }, metadata, createdClasses, hasCrons, ...(opts.gradual !== undefined ? { gradual: opts.gradual } : {}) });
    printPlan(plan, build, log, true);
    return { plan, versionId: null, url: null, dryRun: true };
  }

  const accountId = opts.accountId ?? env.config.account ?? c.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error(`No Cloudflare account: set "account" in ember.json or CLOUDFLARE_ACCOUNT_ID.`);
  const client = new CfClient({
    accountId,
    token: opts.token ?? resolveToken(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });

  const current = await fetchCurrentState(client, worker);
  const { metadata, createdClasses } = buildMetadata({ ...metaInput, provisionedClasses: current.provisionedClasses });
  const plan = planDeploy({ worker, current, metadata, createdClasses, hasCrons, ...(opts.gradual !== undefined ? { gradual: opts.gradual } : {}) });
  printPlan(plan, build, log, false);

  let versionId: string | null = null;
  let url: string | null = null;
  for (const step of plan.steps) {
    switch (step.kind) {
      case "upload-script": {
        await client.call(step.method, step.path, workerForm(metadata, build.code));
        log(`  uploaded ${worker} (created ${createdClasses.join(", ") || "no classes"})`);
        break;
      }
      case "upload-version": {
        // Annotations are proven on version uploads (R2); the Script PUT path does not send them.
        const meta = { ...metadata, annotations: { "workers/message": message.slice(0, 100) } };
        const r = await client.call<{ id: string; number?: number }>(step.method, step.path, workerForm(meta, build.code));
        versionId = r.id;
        log(`  uploaded version ${r.id}${r.number !== undefined ? ` (#${r.number})` : ""}`);
        break;
      }
      case "deploy": {
        if (!versionId) throw new Error("internal: no version to deploy");
        const versions = step.versions.map((v) => ({ ...v, version_id: v.version_id === NEW_VERSION ? versionId! : v.version_id }));
        await client.call(step.method, step.path, { strategy: "percentage", versions, annotations: { "workers/message": message.slice(0, 100) } });
        log(`  deployed ${versions.map((v) => `${v.version_id.slice(0, 8)}@${v.percentage}%`).join(" + ")}`);
        break;
      }
      case "schedules":
        await client.call(step.method, step.path, step.body);
        log(`  cron triggers: ${step.body.map((s) => s.cron).join(", ") || "none"}`);
        break;
      case "subdomain": {
        await client.call(step.method, step.path, step.body);
        const sub = await client.request<{ subdomain?: string }>("GET", "/workers/subdomain");
        if (sub.success && sub.result?.subdomain) url = `https://${worker}.${sub.result.subdomain}.workers.dev`;
        break;
      }
      case "registry":
        await (opts.registry ?? noopRegistry).recordDeploy({ project: c.project, env: env.name, worker, url, versionId, schemaVersion });
        break;
    }
  }
  if (url) log(`\n${worker} → ${url}`);
  saveDeployment(project, env.name, { worker, url, versionId, at: new Date().toISOString() });
  return { plan, versionId, url, dryRun: false };
}

function printPlan(plan: DeployPlan, build: WorkerBuild, log: (l: string) => void, dry: boolean) {
  log(`${dry ? "[dry run] " : ""}deploy ${plan.worker}: ${plan.strategy}${plan.createdClasses.length ? ` (new DO classes: ${plan.createdClasses.join(", ")})` : ""}`);
  log(`  bundle ${(build.bytes / 1024).toFixed(1)} KiB sha256 ${build.sha256.slice(0, 12)}`);
  for (const w of plan.warnings) log(`  warning: ${w}`);
  if (dry) {
    log(`  (dry run makes no API calls: it assumes a first deploy; a real run fetches the current deployment and DO namespaces)`);
    log(`  metadata: ${JSON.stringify(plan.metadata, null, 2).split("\n").join("\n  ")}`);
    for (const s of plan.steps) {
      if (s.kind === "registry") log(`  - ${s.note}`);
      else log(`  - ${s.method} /accounts/:account${s.path}${"body" in s ? ` ${JSON.stringify(s.body)}` : ""}${"versions" in s ? ` ${JSON.stringify(s.versions)}` : ""}`);
    }
  }
}

export interface DeploymentRecord {
  worker: string;
  url: string | null;
  versionId: string | null;
  at: string;
}

const deploymentsFile = (project: Project) => join(project.stateDir, "deployments.json");

export function loadDeployments(project: Project): Record<string, DeploymentRecord> {
  const p = deploymentsFile(project);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function saveDeployment(project: Project, env: string, rec: DeploymentRecord) {
  mkdirSync(project.stateDir, { recursive: true });
  const all = loadDeployments(project);
  all[env] = rec;
  writeFileSync(deploymentsFile(project), JSON.stringify(all, null, 2) + "\n");
}
