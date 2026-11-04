// `ember dashboard deploy [--name ember-dashboard]` (PLAN §21): builds the Ember Dashboard (apps/dashboard: SPA bundled
// with esbuild + its Worker, assets inlined in the module — no static-assets upload; the published CLI ships both
// prebuilt in dist/dashboard/) and uploads it into the user's account. Bindings: REGISTRY (D1 account registry), one service binding per registered project Worker (admin
// endpoints without a public hop), CF_ACCOUNT_ID / METRICS_DATASET vars.
// Secrets (only sent when provided; otherwise kept from the previous upload by keep_bindings):
//   DASHBOARD_TOKEN    EMBER_DASHBOARD_TOKEN, else generated on the first deploy and printed once
//   EMBER_ADMIN_TOKEN  EMBER_ADMIN_TOKEN (the projects' admin token)
//   CF_API_TOKEN       EMBER_ANALYTICS_TOKEN (Account Analytics: Read; enables the functions page)
// Cloudflare Access: --access-team <team>.cloudflareaccess.com --access-aud <AUD tag> (recommended in front of it).

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";
import { WORKER_BUILD_OPTIONS } from "./build.ts";
import type { CfClient } from "./deploy/cf.ts";
import { workerForm } from "./deploy/index.ts";
import { DEFAULT_METRICS_DATASET, type Binding, type WorkerMetadata } from "./deploy/plan.ts";
import type { D1Registry } from "./registry.ts";
import { CLI_ROOT, FROM_SOURCE } from "./source.ts";

export const DEFAULT_DASHBOARD_NAME = "ember-dashboard";

export function dashboardDir(): string {
  return dirname(createRequire(import.meta.url).resolve("@freecorps/ember-dashboard/package.json"));
}

/** Prebuilt dashboard shipped in the published CLI (`bun run build` writes it; see scripts/build.ts). */
export const PREBUILT_DASHBOARD_DIR = join(CLI_ROOT, "dist", "dashboard");

export interface DashboardBuild {
  code: string;
  bytes: number;
  assets: { html: number; js: number; css: number };
}

/** The SPA bundle, its stylesheet and the dashboard Worker module that serves them. */
export interface DashboardSources {
  js: string;
  css: string;
  /** Absolute path of the module exporting `createDashboard` (apps/dashboard/src/worker.ts, or its prebuilt JS). */
  worker: string;
}

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ember Dashboard</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;

/** Bundles the SPA from the apps/dashboard sources (monorepo, and the CLI build that prebuilds it). */
export async function dashboardFromSource(dir = dashboardDir()): Promise<DashboardSources> {
  const spa = await esbuild.build({
    entryPoints: [join(dir, "src/app/main.tsx")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    absWorkingDir: dir,
    logLevel: "silent",
  });
  const js = spa.outputFiles[0]!.text;
  const css = readFileSync(join(dir, "src/app/style.css"), "utf8");
  return { js, css, worker: join(dir, "src/worker.ts") };
}

/** Published CLI: the prebuilt SPA and Worker from `dist/dashboard/` (the CLI does not depend on apps/dashboard). */
export function prebuiltDashboard(dir = PREBUILT_DASHBOARD_DIR): DashboardSources | null {
  const worker = join(dir, "worker.js");
  if (!existsSync(worker)) return null;
  const missing = ["app.js", "app.css"].filter((f) => !existsSync(join(dir, f)));
  if (missing.length) throw new Error(`the prebuilt dashboard in ${dir} is incomplete (missing ${missing.join(", ")}); reinstall @freecorps/ember-cli`);
  return { js: readFileSync(join(dir, "app.js"), "utf8"), css: readFileSync(join(dir, "app.css"), "utf8"), worker };
}

/**
 * The dashboard Worker module (SPA inlined; no static-assets upload). `dir` builds from that apps/dashboard checkout;
 * otherwise the sources are used inside the monorepo and the prebuilt copy from the published package.
 */
export async function buildDashboard(dir?: string): Promise<DashboardBuild> {
  const src = (!dir && !FROM_SOURCE ? prebuiltDashboard() : null) ?? (await dashboardFromSource(dir));
  const entry = [
    `import { createDashboard } from ${JSON.stringify(src.worker.split("\\").join("/"))};`,
    `export default createDashboard({ html: ${JSON.stringify(DASHBOARD_HTML)}, js: ${JSON.stringify(src.js)}, css: ${JSON.stringify(src.css)} });`,
  ].join("\n");
  const out = await esbuild.build({
    ...WORKER_BUILD_OPTIONS,
    stdin: { contents: entry, resolveDir: dirname(src.worker), sourcefile: "dashboard-entry.js", loader: "js" },
    write: false,
    minify: true,
    absWorkingDir: dirname(src.worker),
  });
  const code = out.outputFiles[0]!.text;
  return { code, bytes: Buffer.byteLength(code), assets: { html: DASHBOARD_HTML.length, js: src.js.length, css: src.css.length } };
}

export interface DashboardDeployOptions {
  name?: string;
  registry: D1Registry;
  build?: DashboardBuild;
  accessTeam?: string;
  accessAud?: string;
  dataset?: string;
  /** Default: EMBER_DASHBOARD_TOKEN, else generated when the Worker has none. */
  dashboardToken?: string;
  adminToken?: string;
  analyticsToken?: string;
  compatibilityDate?: string;
  log?: (l: string) => void;
}

export interface DashboardDeployResult {
  name: string;
  url: string | null;
  /** Set only when the token was generated by this deploy (show it once). */
  generatedToken: string | null;
  services: string[];
  bytes: number;
}

/** Service binding names for the registry's Workers that exist in the account. */
export async function projectServices(client: CfClient, registry: D1Registry): Promise<Array<{ worker: string; binding: string }>> {
  const scripts = new Set((await client.call<Array<{ id: string }>>("GET", "/workers/scripts")).map((s) => s.id));
  const envs = await registry.exec("SELECT worker FROM environments ORDER BY project, env");
  return envs
    .map((e) => String(e.worker))
    .filter((w) => scripts.has(w))
    .slice(0, 200)
    .map((worker, i) => ({ worker, binding: `EMBER_SVC_${i}` }));
}

export async function deployDashboard(client: CfClient, o: DashboardDeployOptions): Promise<DashboardDeployResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const name = o.name ?? DEFAULT_DASHBOARD_NAME;
  const build = o.build ?? (await buildDashboard());
  const existing = await client.request<Array<{ name: string }>>("GET", `/workers/scripts/${name}/secrets`);
  const secrets = new Set(existing.success ? (existing.result ?? []).map((s) => s.name) : []);

  const services = await projectServices(client, o.registry);
  const sec: Record<string, string> = {};
  let generatedToken: string | null = null;
  const dashToken = o.dashboardToken ?? process.env.EMBER_DASHBOARD_TOKEN;
  if (dashToken) sec.DASHBOARD_TOKEN = dashToken;
  else if (!secrets.has("DASHBOARD_TOKEN")) sec.DASHBOARD_TOKEN = generatedToken = randomBytes(24).toString("base64url");
  const admin = o.adminToken ?? process.env.EMBER_ADMIN_TOKEN;
  if (admin) sec.EMBER_ADMIN_TOKEN = admin;
  const analytics = o.analyticsToken ?? process.env.EMBER_ANALYTICS_TOKEN;
  if (analytics) sec.CF_API_TOKEN = analytics;

  const bindings: Binding[] = [
    { type: "d1", name: "REGISTRY", id: o.registry.databaseId },
    { type: "plain_text", name: "CF_ACCOUNT_ID", text: client.accountId },
    { type: "plain_text", name: "METRICS_DATASET", text: o.dataset ?? process.env.EMBER_METRICS_DATASET ?? DEFAULT_METRICS_DATASET },
    { type: "plain_text", name: "EMBER_SERVICES", text: JSON.stringify(Object.fromEntries(services.map((s) => [s.worker, s.binding]))) },
    ...services.map((s): Binding => ({ type: "service", name: s.binding, service: s.worker })),
    ...(o.accessTeam ? [{ type: "plain_text", name: "ACCESS_TEAM_DOMAIN", text: o.accessTeam } as Binding] : []),
    ...(o.accessAud ? [{ type: "plain_text", name: "ACCESS_AUD", text: o.accessAud } as Binding] : []),
    ...Object.entries(sec).map(([n, text]): Binding => ({ type: "secret_text", name: n, text })),
  ];
  const metadata: WorkerMetadata = {
    main_module: "index.js",
    compatibility_date: o.compatibilityDate ?? "2026-10-01",
    compatibility_flags: [],
    bindings,
    exports: {},
    observability: { enabled: true },
    keep_bindings: ["secret_text"],
  };
  const { exports: _none, ...meta } = metadata;
  await client.call("PUT", `/workers/scripts/${name}`, workerForm(meta as WorkerMetadata, build.code));
  await client.call("POST", `/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: false });
  const sub = await client.request<{ subdomain?: string }>("GET", "/workers/subdomain");
  const url = sub.success && sub.result?.subdomain ? `https://${name}.${sub.result.subdomain}.workers.dev` : null;
  log(`deployed ${name} (${(build.bytes / 1024).toFixed(1)} KiB, ${services.length} project service binding${services.length === 1 ? "" : "s"})${url ? ` → ${url}` : ""}`);
  if (!o.accessTeam) log("  tip: put Cloudflare Access in front of it (Zero Trust → Access → Applications) and pass --access-team/--access-aud");
  if (!analytics && !secrets.has("CF_API_TOKEN")) log("  functions page disabled: set EMBER_ANALYTICS_TOKEN (Account Analytics: Read) and redeploy");
  if (!admin && !secrets.has("EMBER_ADMIN_TOKEN")) log("  shard status/data disabled: set EMBER_ADMIN_TOKEN (the projects' admin token) and redeploy");
  return { name, url, generatedToken, services: services.map((s) => s.worker), bytes: build.bytes };
}
