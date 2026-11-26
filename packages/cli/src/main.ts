import { writeFileSync } from "node:fs";
// `ember` entry: init | codegen | dev | deploy | run | logs.

import { parseArgs } from "node:util";
import { limitWarnings, queryFunctionStats } from "@freecorps/ember-dashboard/metrics-sql";
import { codegen } from "./codegen/index.ts";
import { envConfig, findProjectRoot, loadProject, previewEnvName, resolveEnv, workerName, type Project } from "./config.ts";
import { DEFAULT_DASHBOARD_NAME, deployDashboard } from "./dashboard.ts";
import { deployWithDashboard, destroyDashboard, revealOnce, rotateDashboardToken, type DashboardIo } from "./dashboard-link.ts";
import { interactive, terminalPrompter } from "./prompt.ts";
import { ensureAccessApp } from "./access.ts";
import { CfClient, resolveToken } from "./deploy/cf.ts";
import { DEFAULT_METRICS_DATASET } from "./deploy/plan.ts";
import { addDomain } from "./domains.ts";
import { streamLogs } from "./logs.ts";
import { D1Registry, registryName } from "./registry.ts";
import { deploy, deployExitCode } from "./deploy/index.ts";
import { preflightDeploy } from "./deploy/preflight.ts";
import { runtimeVersion } from "./build.ts";
import { dev } from "./dev.ts";
import { init } from "./init.ts";
import { resolveBaseUrl, run } from "./run.ts";
import { restoreCommand } from "./restore.ts";
import { cancelMigration, exitCode, migrationStatus, runMigration } from "./migrations.ts";
import { importConvex, verifyConvex, type ConvexImportReport } from "./import-convex.ts";
import { importConvexDeltas } from "./import-convex-delta.ts";
import { exportEmber, importEmber } from "./export.ts";
import { rotateKeys, type RotateKind } from "./keys.ts";
import { filesOrphans, parseDuration } from "./files.ts";
import { destroy } from "./destroy.ts";
import { formatShardList, formatShardReport, inspectShard, listShards } from "./shards.ts";
import { checkEnvArgs, DEV_VARS_FILE, envGet, envList, envRm, envSet, loadDevVars, readSecretValue, type EnvTarget } from "./env.ts";

const HELP = `ember <command> [options]

Commands:
  init [dir] [--project name] [--force] [--auth]
                                          Create ember.json and a sample app in ember/ (--auth: auth.config.ts
                                          with email + password and organizations, profile sync, sensitive mutation)
  codegen [--check] [--strict]            Generate ember/_generated (static client types + manifest). --check writes
                                          nothing and fails when the files are out of date (CI); --strict fails on
                                          \`any\`/\`unknown\` results and on errors a function throws without declaring
  types <module:fn>                       Print a function's contract (args, result, errors) as api.d.ts has it
  openapi [--out file] [--url URL]        OpenAPI 3.1 of the public functions (POST /api/<kind>/<fn>) and the typed
                                          routes of ember/http.ts (stdout without --out)
  migrate convex [--src convex] [--out ember | --in-place] [--dry-run] [--force] [--report file.md] [--check] [--verify]
                 [--strict]
                                          Port a Convex functions folder: queries, mutations and their helpers become
                                          synchronous, imports/validators/ConvexError/crons/convex-helpers triggers are
                                          rewritten, and a report lists what needs a decision. --check fails while
                                          manual items remain (CI); --verify runs codegen + tsc --noEmit on the result.
                                          First checks the libraries the functions import (and package.json) against
                                          what runs in an Ember action (workerd + nodejs_compat) and warns; --strict
                                          fails, converting nothing, when a function imports one that does not run
  mcp [--allow-env name ...] [--allow-run name ...]
                                          MCP server on stdio for coding agents: tools schema, functions, types,
                                          codegen (the code on disk), run, data, shards (the running \`ember dev\` by
                                          default), logs, metrics. --allow-env lets the read tools reach a deployed
                                          environment; --allow-run lets run execute there (each mutation/action also
                                          needs confirm: "<env>"). Admin calls use EMBER_ADMIN_TOKEN
  dev [--port 8787] [--no-persist] [--remote [--env dev]]
                                          Run locally (Miniflare/workerd), rebuild on change. --remote binds the
                                          env's real Workers AI, Vectorize, Browser Rendering and Images (AI Search
                                          stays on the local fallback)
                                          (needs wrangler; billed; dev writes reach those indexes)
  deploy --preflight [--env prod | --url URL] [--shard kind:key ...] [--admin-token T] [--allow-schema-rollback]
                                          Upload nothing: ask each live shard (the registry catalog, or --shard)
                                          what its migration planner would do with this schema (steps, staged
                                          backfills, storage conversions), against its data, writing nothing.
                                          Fails when any shard would refuse, cannot be checked, or the deployed
                                          runtime is too old to answer, or on a schema rollback (below)
  deploy [--env prod] [--gradual N] [--dry-run] [--message text]
         [--wait [--shard kind:key ...] [--wait-timeout s] [--url URL]] [--admin-token T]
         [--dashboard | --no-dashboard] [--allow-schema-rollback] [--allow-missing-env]
                                          Deploy ember-<project>-<env> through the Cloudflare API. --wait polls
                                          global:main (+ --shard) until migrated; fails on a refused migration.
                                          Stops before uploading when the app schema is one this env already left
                                          for a newer one (registry deploy history) unless --allow-schema-rollback;
                                          --dry-run reports it and exits 1.
                                          Stops when a var declared in defineApp({ env }) is neither a secret on
                                          the Worker nor a var in ember.json, unless --allow-missing-env
                                          The first deploy in a terminal asks whether to add the Ember Dashboard
                                          and saves the answer ("dashboard" in ember.json); CI never asks.
                                          ember.json "limits": { "cpuMs" } and "placement": "smart" go up with a
                                          Script PUT only when the Worker does not have them yet
  deploy --preview <branch> [--destroy] [options]
                                          Ephemeral environment preview-<slug> (Worker ember-<project>-preview-<slug>)
                                          derived from environments.preview: its vars and settings, its own Durable
                                          Objects, bucket, queues and indexes. Same branch → same environment.
                                          --destroy deletes it. Other commands take --env preview-<slug>
  destroy [--env name | --preview branch] --yes
                                          Delete ember-<project>-<env>: its dashboard link, the Worker and its Durable Object data, this
                                          env's Vectorize indexes / AI Search instances / indexing queue, the files
                                          queue and (if empty) bucket
  run <fn> ['<json args>'] [--shard kind:key] [--env name | --url URL] [--token T] [--query|--mutation|--action]
                                          Call a query, mutation or action over HTTP (dev by default)
  logs [--env name] [--fn module:fn] [--shard kind[:key]] [--errors] [--json]
                                          Stream the Worker's logs (tail API). --fn/--shard filter per execution
                                          (needs the Worker var EMBER_TRACE=1; else they match log text)
  projects ls [--json]                    Projects and environments in the account registry (D1 ember-registry)
  shards ls [--env name] [--kind k] [--json]
                                          The environment's shards from the registry catalog: size, schema version,
                                          last write (what each shard last reported)
  shards inspect <kind:key> [--env name | --url URL] [--json] [--admin-token T]
                                          One shard, live (admin endpoints): size, schema and commit version,
                                          tables with row counts, open jobs, subscriptions, files, outbox. Without
                                          --env/--url: the running \`ember dev\`
  domains add <host> [--env name] [--dry-run]
                                          Attach a Custom Domain after checking the zone's routes, custom domains and
                                          the registry for conflicts
  domains ls                              Domains in the registry
  metrics [--env name] [--hours 24] [--all] [--json]
                                          p50/p95, error rate and rows per function (Analytics Engine SQL)
  restore --shard kind:key --list [--env name]
                                          Bookmarks the shard recorded (per deploy, migration and active hour)
  restore --shard kind:key --mark <label>  Record a bookmark now (e.g. before a risky import)
  restore --shard kind:key --to <bookmark | deploy:<version> | ISO time | -2h> [--yes]
                                          Point-in-time restore (30-day window); prints the undo bookmark
  restore --all --to <deploy:<version> | time> [--yes] [--concurrency 4]
                                          Every shard in the registry catalog back to a deploy point (or time)
  restore ... --discard-newer             Also restore shards refused by RuntimeSchemaTooNew (a newer runtime upgraded
                                          them and the Worker was rolled back) from this runtime: discards everything
                                          written after the bookmark, the newer runtime's writes included (use the
                                          deploy:<version> that brought the newer runtime; undo bookmark printed)
  files orphans [--env name | --url URL] [--grace 24h] [--limit 500] [--delete [--yes]] [--json] [--admin-token T]
                                          Objects of the files bucket that no file row of their shard references
                                          (a failed registration, an upload never confirmed), older than --grace.
                                          Lists them (dry run) unless --delete; pages through the bucket. Exits 1
                                          when a shard could not answer
  import convex <snapshot.zip> [--env name | --url URL] [--admin-token T] [--dry-run] [--strict] [--only t1,t2] [--fresh]
                                          Import a Convex snapshot ZIP keeping its ids, _creationTime and storage ids,
                                          routed into shards by ember/import.config.ts (defineImport). Streams the ZIP,
                                          uploads in batches, resumes from .ember/import/ (--fresh starts over);
                                          --dry-run reads, routes and validates without uploading. Dev by default
  import convex --from-deployment <convex URL> --deploy-key-env VAR [--since cursor] [--watch [--interval 5]]
               [--env name | --url URL] [--strict] [--fresh]
                                          Same import from a live deployment (streaming export API: snapshot, then
                                          deltas with deletes; cursor kept in .ember/import/). --watch keeps tailing
                                          until Ctrl-C (cutover). Documents only: files come from a snapshot ZIP
  import ember <export.zip> [--env name | --url URL] [--strict] [--fresh]
                                          Load an \`ember export\` (refresh staging without Convex)
  export --out <file.zip> (--shard kind:key ... | --all) [--env name | --url URL]
                                          Every document and file of the shards, in Ember's export format
  import verify convex <snapshot.zip> [--env name | --url URL] [--only t1,t2]
                                          Count and hash (order-independent) the documents per table and shard, and
                                          compare with what the shards hold; exits 1 on a difference
  migrations run <name> [--shard kind:key | --all [--kind org]] [--dry-run] [--reset] [--batch-size N]
                 [--wait [--wait-timeout s]] [--concurrency 8] [--env name | --url URL] [--admin-token T]
                                          Start (or resume) a data migration (@freecorps/ember-migrations) on each
                                          shard (default global:main; --all: the registry catalog). --dry-run runs
                                          one batch per shard, rolled back, and shows what would change
  migrations status [name] [--shard kind:key | --all [--kind org]] [--json]
                                          Progress per shard (processed, changed, failed, last error); exits 1
                                          unless done on every shard (gate for making a field required)
  migrations cancel <name> [--shard kind:key | --all [--kind org]]
                                          Stop it after the current batch (run again to resume)
  env list [--env name] [--local] [--json]
                                          Secrets (on the Worker) and vars (ember.json) of an environment; values are
                                          never shown. --local: the names in .dev.vars (what \`ember dev\` loads)
  env set <NAME> [--env name]             Set a secret: value from stdin or a hidden prompt (never argv), or
          [--from-env VAR]                from an environment variable. Live at once (new Worker version); kept
                                          by every deploy
  env set <NAME> (<value> | --from-env VAR) --var [--env name]
                                          Plain var in ember.json (environments.<env>.vars); next deploy
  env get <NAME> [--env name] [--reveal [--url URL] [--admin-token T]]
                                          Whether NAME is set and where; --reveal prints the value (secrets are
                                          read through the Worker's admin endpoint: EMBER_ADMIN_TOKEN)
  env rm <NAME> [--env name] [--var]      Delete a secret (or, with --var / a var name, the ember.json var)
  keys rotate [--env name] [--jwt] [--files] [--auth-secret --yes]
                                          Rotate the JWT signing key (default; no sign-out), the files URL secret,
                                          or the auth secret (signs everyone out); old generations keep verifying
  dashboard deploy [--name ember-dashboard] [--access --access-email you@x.com [--access-domain x.com]
                   [--access-team T.cloudflareaccess.com] [--host H]] | [--access-team T --access-aud A]
                   [--admin you@x.com|@x.com ...]
                                          Deploy the Ember Dashboard into the account (see docs). Access users
                                          are read-only unless --admin lists them (default: --access-email)
  dashboard token                         New dashboard token (the old one stops working), shown once
  dashboard destroy --yes                 Delete the dashboard Worker (registry, audit log and projects stay)

Shared: --registry <name> (or EMBER_REGISTRY_NAME) overrides the registry D1 database (default ember-registry);
--account <id> where no ember.json is at hand.

Environment: CLOUDFLARE_API_TOKEN (else \`npx wrangler auth token\`), CLOUDFLARE_ACCOUNT_ID,
EMBER_ADMIN_TOKEN (uploaded as a Worker secret by deploy; enables GET /api/_ember/status|data|crons and --wait),
EMBER_METRICS_DATASET (default ember_metrics), EMBER_ANALYTICS_TOKEN / EMBER_TAIL_TOKEN / EMBER_DASHBOARD_TOKEN (dashboard deploy).

Credentials and --url: commands that send the admin token (restore, import, export, migrations, keys rotate,
env get --reveal, deploy --wait), \`run --token\` and \`import convex --from-deployment\` only talk to https:// URLs,
or to plain http:// on localhost, 127.0.0.1 and [::1] (\`ember dev\`); any other http:// URL is refused before a request
is made. EMBER_ALLOW_INSECURE_HTTP=1 allows it (a dev runtime on another machine of a trusted network) with a warning.`;

function printImportReport(r: ConvexImportReport): void {
  const rows = Object.entries(r.tables).map(([t, x]) => `  ${t.padEnd(24)} ${String(x.read).padStart(9)} read ${String(x.imported).padStart(9)} ${r.dryRun ? "valid" : "imported"} ${String(x.invalid).padStart(7)} invalid ${String(x.skipped + x.orphans).padStart(7)} skipped  ${Object.keys(x.shards).length} shard(s)`);
  console.log(`${r.dryRun ? "Dry run (nothing uploaded)" : "Import"}: ${r.shards.length} shard(s)\n${rows.join("\n")}`);
  const f = r.files;
  if (f.entries) console.log(`  _storage                 ${String(f.entries).padStart(9)} entries ${String(f.imported).padStart(6)} imported ${f.skipped} unreferenced, ${f.missingBytes} without bytes${f.shaMismatch ? `, ${f.shaMismatch} sha256 mismatches` : ""}`);
  for (const x of r.invalid.slice(0, 10)) console.log(`  invalid ${x.table} ${x.id ?? "?"}${x.shard ? ` (${x.shard})` : ""}: ${x.message}`);
  if (r.invalidFile && Object.values(r.tables).some((t) => t.invalid)) console.log(`  every invalid document: ${r.invalidFile}`);
  if (r.interrupted) console.log("  interrupted: run the same command again to resume");
}

function cliIo(): DashboardIo {
  return { interactive: interactive(), prompter: terminalPrompter, log: (l) => console.log(l), show: (l) => void process.stdout.write(`${l}\n`) };
}

function maybeProject(): Project | null {
  return findProjectRoot() ? loadProject() : null;
}

/** Cloudflare client for the project's (or --account / CLOUDFLARE_ACCOUNT_ID) account. */
function accountClient(project: Project | null, account?: string, env?: string): CfClient {
  const accountId =
    account ?? (project && env ? envConfig(project, env)?.account : undefined) ?? project?.config.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error(`No Cloudflare account: pass --account, set "account" in ember.json or CLOUDFLARE_ACCOUNT_ID.`);
  return new CfClient({ accountId, token: resolveToken() });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case "init": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { project: { type: "string" }, force: { type: "boolean" }, auth: { type: "boolean" } } });
      const r = init({
        ...(positionals[0] ? { dir: positionals[0] } : {}),
        ...(values.project ? { project: values.project } : {}),
        ...(values.force ? { force: true } : {}),
        ...(values.auth ? { auth: true } : {}),
      });
      console.log(
        `Created in ${r.root}:\n${r.created.map((f) => `  ${f}`).join("\n")}\nNext: install @freecorps/ember-server @freecorps/ember-runtime @freecorps/ember-client${values.auth ? " @freecorps/ember-auth" : ""}, then \`ember dev\`.`,
      );
      return 0;
    }
    case "codegen": {
      const { values } = parseArgs({ args: rest, options: { check: { type: "boolean" }, strict: { type: "boolean" } } });
      const project = loadProject();
      const t = Date.now();
      const r = await codegen(project, { ...(values.check ? { check: true } : {}), ...(values.strict ? { strict: true } : {}) });
      for (const w of r.warnings) console.warn(`warning: ${w}`);
      for (const e of r.errors) console.error(`error: ${e}`);
      if (values.check && r.stale.length) {
        console.error(`codegen --check: ${r.stale.join(", ")} out of date in ${project.generatedDir}: run \`ember codegen\``);
        return 1;
      }
      if (r.errors.length) return 1;
      console.log(
        `codegen${values.check ? " --check" : ""}: ${r.manifest.functions.length} functions, ${Object.keys(r.manifest.schema.tables).length} tables${values.check ? " (up to date)" : ` → ${project.generatedDir}`} (${Date.now() - t} ms)`,
      );
      return 0;
    }
    case "openapi": {
      const { values } = parseArgs({ args: rest, options: { out: { type: "string" }, url: { type: "string" } } });
      const project = loadProject();
      const r = await codegen(project, { check: true });
      const { openApi } = await import("./codegen/openapi.ts");
      const doc = JSON.stringify(openApi(r.manifest, { title: project.config.project, ...(values.url ? { url: values.url } : {}) }), null, 2) + "\n";
      if (values.out) {
        writeFileSync(values.out, doc);
        console.log(`openapi: ${values.out}`);
      } else process.stdout.write(doc);
      return 0;
    }
    case "types": {
      const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
      const name = positionals[0];
      if (!name) throw new Error("usage: ember types <module:fn>");
      const project = loadProject();
      const r = await codegen(project, { check: true });
      const fn = r.manifest.functions.find((f) => f.name === name || f.name === name.replace(/\.(?=[^.]*$)/, ":").replace(/\./g, "/"));
      const contract = fn && r.contracts.get(fn.name);
      if (!fn || !contract) throw new Error(`no function ${name} (known: ${r.manifest.functions.map((f) => f.name).join(", ")})`);
      console.log(`${fn.name} (${fn.visibility} ${fn.type}${fn.errors?.length ? `, throws ${fn.errors.join(" | ")}` : ""})\n${contract}`);
      return 0;
    }
    case "mcp": {
      const { values } = parseArgs({ args: rest, options: { "allow-env": { type: "string", multiple: true }, "allow-run": { type: "string", multiple: true } } });
      const project = loadProject();
      // Checked now (a typo fails at startup, not on the agent's first call).
      const allowEnv = (values["allow-env"] ?? []).map((e) => resolveEnv(project, e).name);
      const allowRun = (values["allow-run"] ?? []).map((e) => resolveEnv(project, e).name);
      const { mcpCommand } = await import("./mcp/index.ts");
      await mcpCommand(project, { allowEnv, allowRun });
      return 0;
    }
    case "migrate": {
      const { migrateCommand } = await import("./migrate/command.ts");
      return migrateCommand(rest);
    }
    case "dev": {
      const { values } = parseArgs({ args: rest, options: { port: { type: "string" }, "no-persist": { type: "boolean" }, remote: { type: "boolean" }, env: { type: "string" } } });
      if (values.env && !values.remote) throw new Error("--env only applies with --remote (ember dev is local otherwise)");
      const project = loadProject();
      const server = await dev(project, {
        ...(values.port ? { port: Number(values.port) } : {}),
        persist: !values["no-persist"],
        ...(values.remote ? { remote: { ...(values.env ? { env: values.env } : {}) } } : {}),
      });
      await new Promise<void>((resolve) => {
        const stop = () => void server.close().then(resolve);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    case "deploy": {
      const { values } = parseArgs({
        args: rest,
        options: {
          env: { type: "string" },
          gradual: { type: "string" },
          "dry-run": { type: "boolean" },
          message: { type: "string" },
          wait: { type: "boolean" },
          shard: { type: "string", multiple: true },
          "wait-timeout": { type: "string" },
          url: { type: "string" },
          "admin-token": { type: "string" },
          registry: { type: "string" },
          dashboard: { type: "boolean" },
          "no-dashboard": { type: "boolean" },
          preflight: { type: "boolean" },
          "allow-schema-rollback": { type: "boolean" },
          "allow-missing-env": { type: "boolean" },
          preview: { type: "string" },
          destroy: { type: "boolean" },
        },
      });
      const allowSchemaRollback = !!values["allow-schema-rollback"];
      if (values.destroy && values.preview === undefined) throw new Error("--destroy needs --preview <branch> (`ember destroy --env name --yes` deletes a declared environment)");
      if (values.preview !== undefined) {
        if (values.env) throw new Error("--preview <branch> names the environment itself (preview-<slug>): drop --env");
        if (values.preflight) throw new Error("--preview and --preflight are exclusive");
        const project = loadProject();
        const name = previewOf(project, values.preview);
        if (values.destroy) {
          const clash = (["dry-run", "wait", "gradual", "message", "wait-timeout", "dashboard", "allow-schema-rollback", "allow-missing-env"] as const).filter((k) => values[k] !== undefined);
          if (clash.length) throw new Error(`--destroy deletes the preview: it does not take ${clash.map((k) => `--${k}`).join(", ")}`);
          // --destroy is the explicit ask: a preview's data is disposable by definition (no --yes, CI runs it on branch delete).
          const r = await destroy(project, { env: name, yes: true, ...(values.registry ? { registryName: values.registry } : {}) });
          return r.warnings.length ? 1 : 0;
        }
        console.log(`preview: ${values.preview} → environment ${name} (${workerName(project.config.project, name)}, from environments.preview)`);
        values.env = name;
        // A preview is not linked to the Ember Dashboard unless asked for (one service binding per branch otherwise).
        if (!values.dashboard) values["no-dashboard"] = true;
      }
      if (values.preflight && values["allow-missing-env"]) throw new Error("--preflight uploads nothing: it does not take --allow-missing-env");
      if (values.preflight) {
        const clash = (["dry-run", "wait", "gradual", "message", "wait-timeout", "dashboard", "no-dashboard"] as const).filter((k) => values[k] !== undefined);
        if (clash.length) throw new Error(`--preflight uploads nothing: it does not take ${clash.map((k) => `--${k}`).join(", ")}`);
        const project = loadProject();
        const adminToken = values["admin-token"] ?? process.env.EMBER_ADMIN_TOKEN;
        if (!adminToken) throw new Error("--preflight needs the project's admin token: set EMBER_ADMIN_TOKEN (or pass --admin-token)");
        // --url alone (e.g. `ember dev`) has no registry catalog: global:main and --shard only.
        const env = values.url && !values.env ? null : resolveEnv(project, values.env);
        const url = resolveBaseUrl(project, { ...(values.url ? { url: values.url } : {}), ...(env ? { env: env.name } : {}) });
        // One registry for the catalog and the deploy history, opened on first use.
        let reg: Promise<D1Registry> | undefined;
        const registry = (envName: string) => (reg ??= D1Registry.open(accountClient(project, undefined, envName), registryName(values.registry), { create: false, ddl: false }));
        const gen = await codegen(project);
        for (const w of gen.warnings) console.log(`warning: ${w}`);
        const report = await preflightDeploy({
          url,
          adminToken,
          schema: gen.manifest.schema,
          localRuntime: runtimeVersion(project.dir),
          ...(values.shard?.length ? { shards: values.shard } : {}),
          ...(allowSchemaRollback ? { allowSchemaRollback } : {}),
          ...(env
            ? {
                env: env.name,
                catalog: async () =>
                  (await (await registry(env.name)).exec("SELECT shard FROM shards WHERE project = ? AND env = ? ORDER BY shard", project.config.project, env.name)).map((r) => String(r.shard)),
                history: async () => (await registry(env.name)).deployHistory(project.config.project, env.name),
              }
            : {}),
        });
        return report.exitCode;
      }
      if (values.dashboard && values["no-dashboard"]) throw new Error("--dashboard and --no-dashboard are exclusive");
      let gradual: number | undefined;
      if (values.gradual !== undefined) {
        gradual = Number(values.gradual);
        if (!Number.isInteger(gradual) || gradual < 1 || gradual > 100) throw new Error("--gradual must be an integer percentage 1–100");
      }
      let timeoutMs: number | undefined;
      if (values["wait-timeout"] !== undefined) {
        timeoutMs = Number(values["wait-timeout"]) * 1000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--wait-timeout must be a positive number of seconds");
      }
      if (!values.wait && (values.shard?.length || timeoutMs !== undefined)) throw new Error("--shard and --wait-timeout need --wait (or --preflight for --shard)");
      const project = loadProject();
      const dryRun = !!values["dry-run"];
      // The Ember Dashboard (dashboard-link.ts): decided before the upload, which carries this project's token for it.
      const io = cliIo();
      const result = await deployWithDashboard(project, {
        flag: values.dashboard ? true : values["no-dashboard"] ? false : undefined,
        env: resolveEnv(project, values.env).name,
        dryRun,
        io,
        client: () => accountClient(project, undefined, resolveEnv(project, values.env).name),
        registry: (client) => D1Registry.open(client, registryName(values.registry), { log: io.log }),
        deploy: (dashboardAdminToken) => deploy(project, {
          ...(dashboardAdminToken ? { dashboardAdminToken } : {}),
          ...(values.env ? { env: values.env } : {}),
          ...(gradual !== undefined ? { gradual } : {}),
          ...(values.message ? { message: values.message } : {}),
          ...(values["admin-token"] ? { adminToken: values["admin-token"] } : {}),
          ...(values.registry ? { registryName: values.registry } : {}),
          ...(allowSchemaRollback ? { allowSchemaRollback } : {}),
          ...(values["allow-missing-env"] ? { allowMissingEnv: true } : {}),
          ...(values.wait
            ? {
                wait: {
                  ...(values.shard?.length ? { shards: values.shard } : {}),
                  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                  ...(values.url ? { url: values.url } : {}),
                },
              }
            : {}),
          dryRun,
        }),
      });
      // A dry run prints its whole plan and the finding, then fails like the real deploy would.
      return deployExitCode(result);
    }
    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          shard: { type: "string" },
          env: { type: "string" },
          url: { type: "string" },
          token: { type: "string" },
          query: { type: "boolean" },
          mutation: { type: "boolean" },
          action: { type: "boolean" },
        },
      });
      const [fn, args] = positionals;
      if (!fn) throw new Error("usage: ember run <module:function> ['<json args>']");
      const r = await run(loadProject(), {
        fn,
        ...(args !== undefined ? { args } : {}),
        ...(values.shard ? { shard: values.shard } : {}),
        ...(values.env ? { env: values.env } : {}),
        ...(values.url ? { url: values.url } : {}),
        ...(values.token ? { token: values.token } : {}),
        ...(values.query ? { kind: "query" as const } : values.mutation ? { kind: "mutation" as const } : values.action ? { kind: "action" as const } : {}),
      });
      console.log(JSON.stringify(r.body, null, 2));
      return r.status < 400 ? 0 : 1;
    }
    case "destroy": {
      const { values } = parseArgs({ args: rest, options: { env: { type: "string" }, yes: { type: "boolean" }, registry: { type: "string" }, preview: { type: "string" } } });
      if (values.preview !== undefined && values.env) throw new Error("--preview <branch> names the environment itself: drop --env");
      const project = loadProject();
      const env = values.preview !== undefined ? previewOf(project, values.preview) : values.env;
      const r = await destroy(project, { ...(env ? { env } : {}), ...(values.yes ? { yes: true } : {}), ...(values.registry ? { registryName: values.registry } : {}) });
      return r.warnings.length ? 1 : 0;
    }
    case "logs": {
      const { values } = parseArgs({
        args: rest,
        options: { env: { type: "string" }, fn: { type: "string" }, shard: { type: "string" }, errors: { type: "boolean" }, json: { type: "boolean" }, worker: { type: "string" } },
      });
      const project = loadProject();
      const env = resolveEnv(project, values.env);
      const worker = values.worker ?? workerName(project.config.project, env.name);
      await streamLogs(accountClient(project, undefined, env.name), worker, {
        filters: { ...(values.fn ? { fn: values.fn } : {}), ...(values.shard ? { shard: values.shard } : {}), ...(values.errors ? { errors: true } : {}) },
        ...(values.json ? { json: true } : {}),
      });
      return 0;
    }
    case "projects": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean" }, registry: { type: "string" }, account: { type: "string" } } });
      if ((positionals[0] ?? "ls") !== "ls") throw new Error("usage: ember projects ls");
      const reg = await D1Registry.open(accountClient(maybeProject(), values.account), registryName(values.registry), { create: false });
      const ps = await reg.projects();
      if (values.json) console.log(JSON.stringify(ps, null, 2));
      else if (!ps.length) console.log("No projects in the registry yet.");
      else
        for (const p of ps) {
          console.log(`${p.name}${p.repo ? `  (${p.repo})` : ""}  fingerprint ${p.fingerprint.slice(0, 8)}…`);
          for (const e of p.envs) console.log(`  ${e.env.padEnd(10)} ${e.worker.padEnd(36)} ${e.url ?? "-"}  schema ${e.schemaVersion?.slice(0, 12) ?? "-"}  ${e.lastDeploy ? new Date(e.lastDeploy).toISOString() : ""}`);
        }
      return 0;
    }
    case "shards": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { env: { type: "string" }, url: { type: "string" }, "admin-token": { type: "string" }, kind: { type: "string" }, json: { type: "boolean" }, registry: { type: "string" } },
      });
      const [sub, shard] = positionals;
      const project = loadProject();
      if ((sub ?? "ls") === "ls") {
        if (values.url) throw new Error("shards ls reads the registry catalog of an environment: pass --env, not --url");
        const env = resolveEnv(project, values.env);
        const reg = await D1Registry.open(accountClient(project, undefined, env.name), registryName(values.registry), { create: false, ddl: false });
        const shards = await listShards((sql, ...p) => reg.exec(sql, ...p), project.config.project, env.name, values.kind ? { kind: values.kind } : {});
        console.log(values.json ? JSON.stringify(shards, null, 2) : formatShardList(shards));
        return 0;
      }
      if (sub !== "inspect" || !shard || positionals.length > 2) throw new Error("usage: ember shards ls [--env name] [--kind k] [--json] | ember shards inspect <kind:key> [--env name | --url URL] [--json]");
      const adminToken = values["admin-token"] ?? process.env.EMBER_ADMIN_TOKEN;
      if (!adminToken) throw new Error("shards inspect reads the shard through the admin endpoints: set EMBER_ADMIN_TOKEN (or pass --admin-token)");
      // Without --env and --url: the local `ember dev`.
      const url = resolveBaseUrl(project, { ...(values.url ? { url: values.url } : {}), ...(values.env ? { env: resolveEnv(project, values.env).name } : {}) });
      const r = await inspectShard({ url, adminToken }, shard);
      console.log(values.json ? JSON.stringify(r, null, 2) : formatShardReport(r));
      return 0;
    }
    case "domains": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { env: { type: "string" }, "dry-run": { type: "boolean" }, registry: { type: "string" } },
      });
      const [sub, host] = positionals;
      const project = loadProject();
      const client = accountClient(project);
      if (sub === "ls") {
        const reg = await D1Registry.open(client, registryName(values.registry), { create: false });
        for (const d of await reg.domains()) console.log(`${String(d.host).padEnd(40)} ${d.project}/${d.env} (${d.kind})`);
        return 0;
      }
      if (sub !== "add" || !host) throw new Error("usage: ember domains add <host> [--env name] [--dry-run] | ember domains ls");
      const env = resolveEnv(project, values.env);
      const client2 = accountClient(project, undefined, env.name);
      const reg = await D1Registry.open(client2, registryName(values.registry));
      await addDomain(client2, reg, host, { project: project.config.project, env: env.name, worker: workerName(project.config.project, env.name) }, { dryRun: !!values["dry-run"], log: (l) => console.log(l) });
      return 0;
    }
    case "metrics": {
      const { values } = parseArgs({
        args: rest,
        options: { env: { type: "string" }, hours: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" }, dataset: { type: "string" }, account: { type: "string" } },
      });
      const project = maybeProject();
      const env = project && !values.all ? resolveEnv(project, values.env) : null;
      const client = accountClient(project, values.account, env?.name);
      const stats = await queryFunctionStats({
        accountId: client.accountId,
        token: resolveToken(),
        dataset: values.dataset ?? project?.config.metrics?.dataset ?? process.env.EMBER_METRICS_DATASET ?? DEFAULT_METRICS_DATASET,
        ...(project && env ? { project: project.config.project, env: env.name } : {}),
        sinceHours: values.hours ? Number(values.hours) : 24,
      });
      if (values.json) console.log(JSON.stringify(stats, null, 2));
      else if (!stats.length) console.log("No executions recorded in this window.");
      else {
        console.log(`${"function".padEnd(32)} ${"kind".padEnd(12)} ${"timing".padEnd(7)} ${"calls".padStart(8)} ${"err%".padStart(6)} ${"p50ms".padStart(8)} ${"p95ms".padStart(8)} ${"rows/call".padStart(10)}`);
        for (const f of stats)
          console.log(
            `${(values.all ? `${f.project}/${f.env} ${f.fn}` : f.fn).padEnd(32)} ${f.kind.padEnd(12)} ${(f.timing || "-").padEnd(7)} ${f.calls.toFixed(0).padStart(8)} ${(f.errorRate * 100).toFixed(1).padStart(6)} ${f.p50.toFixed(2).padStart(8)} ${f.p95.toFixed(2).padStart(8)} ${f.avgRowsRead.toFixed(1).padStart(10)}`,
          );
        console.log("\ntiming (wall time; the DO clock stands still during synchronous SQLite): rpc = Worker around the shard RPC, commit = DO receipt → durable write, wall = action, none/- = not measurable in production (0)");
        const label = (f: (typeof stats)[number]) => (values.all ? `${f.project}/${f.env} ${f.fn}` : f.fn);
        const near = stats.flatMap((f) => limitWarnings(f.limitPeaks ?? {}).map((w) => `  ${label(f)}: ${w.message}`));
        if (near.length) console.log(`\nnear a limit (70%+ of a per-transaction limit in one call):\n${[...new Set(near)].join("\n")}`);
      }
      return 0;
    }
    case "restore": {
      const { values } = parseArgs({
        args: rest,
        options: {
          env: { type: "string" },
          shard: { type: "string" },
          all: { type: "boolean" },
          list: { type: "boolean" },
          mark: { type: "string" },
          to: { type: "string" },
          yes: { type: "boolean" },
          "discard-newer": { type: "boolean" },
          json: { type: "boolean" },
          url: { type: "string" },
          "admin-token": { type: "string" },
          registry: { type: "string" },
          concurrency: { type: "string" },
        },
      });
      const project = loadProject();
      const env = resolveEnv(project, values.env);
      const adminToken = values["admin-token"] ?? process.env.EMBER_ADMIN_TOKEN;
      if (!adminToken) throw new Error("restore needs the project's admin token: set EMBER_ADMIN_TOKEN (or pass --admin-token)");
      const url = resolveBaseUrl(project, { ...(values.url ? { url: values.url } : {}), env: env.name });
      let reg: Promise<D1Registry> | null = null;
      const registry = () => (reg ??= D1Registry.open(accountClient(project, undefined, env.name), registryName(values.registry), { create: false }));
      await restoreCommand({
        url,
        adminToken,
        project,
        ...(values.shard ? { shard: values.shard } : {}),
        ...(values.all ? { all: true } : {}),
        ...(values.list ? { list: true } : {}),
        ...(values.mark !== undefined ? { mark: values.mark || (true as const) } : {}),
        ...(values.to ? { to: values.to } : {}),
        ...(values.yes ? { yes: true } : {}),
        ...(values["discard-newer"] ? { discardNewer: true } : {}),
        ...(values.json ? { json: true } : {}),
        ...(values.concurrency ? { concurrency: Math.max(1, Number(values.concurrency) || 4) } : {}),
        catalog: async () =>
          (await (await registry()).exec("SELECT shard FROM shards WHERE project = ? AND env = ? ORDER BY shard", project.config.project, env.name)).map((r) => String(r.shard)),
        deployTime: async (prefix) => {
          const [row] = await (await registry()).exec(
            "SELECT MIN(at) AS at FROM deployments WHERE project = ? AND env = ? AND version_id LIKE ?",
            project.config.project, env.name, `${prefix}%`,
          );
          return row?.at === null || row?.at === undefined ? null : Number(row.at);
        },
      });
      return 0;
    }
    case "files": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          env: { type: "string" },
          url: { type: "string" },
          "admin-token": { type: "string" },
          grace: { type: "string" },
          limit: { type: "string" },
          delete: { type: "boolean" },
          yes: { type: "boolean" },
          json: { type: "boolean" },
        },
      });
      if (positionals[0] !== "orphans" || positionals.length > 1) throw new Error("usage: ember files orphans [--env name | --url URL] [--grace 24h] [--delete [--yes]] [--json]");
      const project = loadProject();
      const env = values.env ? resolveEnv(project, values.env) : null;
      const adminToken = values["admin-token"] ?? process.env.EMBER_ADMIN_TOKEN;
      if (!adminToken) throw new Error("files orphans needs the project's admin token: set EMBER_ADMIN_TOKEN (or pass --admin-token)");
      const url = resolveBaseUrl(project, { ...(values.url ? { url: values.url } : {}), ...(env ? { env: env.name } : {}) });
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new Error("--limit must be an integer in 1..1000");
      // Parsed before the confirmation: a bad --grace fails before anyone is asked to confirm a delete.
      const graceMs = values.grace === undefined ? undefined : parseDuration(values.grace);
      if (values.delete && !values.yes) {
        if (!interactive()) throw new Error("files orphans --delete removes objects for good: pass --yes (run without --delete first to see the list)");
        if (!(await terminalPrompter.yesNo(`Delete every orphan object of ${url} (older than ${values.grace ?? "24h"})? Run without --delete first to see the list.`, false))) return 1;
      }
      const sum = await filesOrphans({
        url,
        adminToken,
        ...(graceMs !== undefined ? { graceMs } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(values.delete ? { delete: true } : {}),
        ...(values.json ? { json: true } : {}),
      });
      return sum.skipped.length ? 1 : 0;
    }
    case "import": {
      const verify = rest[0] === "verify";
      const args = verify ? rest.slice(1) : rest;
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          env: { type: "string" },
          url: { type: "string" },
          "admin-token": { type: "string" },
          "dry-run": { type: "boolean" },
          strict: { type: "boolean" },
          only: { type: "string" },
          fresh: { type: "boolean" },
          json: { type: "boolean" },
          "from-deployment": { type: "string" },
          "deploy-key-env": { type: "string" },
          since: { type: "string" },
          watch: { type: "boolean" },
          interval: { type: "string" },
        },
      });
      const [source, zip] = positionals;
      const project = loadProject();
      const only = values.only ? values.only.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
      const log = (l: string) => console.error(l);
      const target = () => {
        const adminToken = values["admin-token"] ?? process.env.EMBER_ADMIN_TOKEN;
        if (!adminToken) throw new Error("ember import needs the project's admin token: set EMBER_ADMIN_TOKEN (or pass --admin-token; `ember dev` reads EMBER_ADMIN_TOKEN too)");
        return { url: resolveBaseUrl(project, { ...(values.url ? { url: values.url } : {}), ...(values.env ? { env: values.env } : {}) }), adminToken };
      };
      if (!verify && source === "ember") {
        if (!zip) throw new Error("usage: ember import ember <export.zip> [--env name | --url URL]");
        const r = await importEmber({ project, zip, target: target(), ...(values.fresh ? { fresh: true } : {}), ...(values.strict ? { strict: true } : {}), log });
        console.log(JSON.stringify(r, null, 2));
        return 0;
      }
      if (!verify && source === "convex" && values["from-deployment"]) {
        const keyVar = values["deploy-key-env"] ?? "CONVEX_DEPLOY_KEY";
        const deployKey = process.env[keyVar];
        if (!deployKey) throw new Error(`--from-deployment reads the Convex deploy key from the environment variable ${keyVar} (--deploy-key-env names another one); it is never passed on the command line`);
        const ac = new AbortController();
        process.once("SIGINT", () => ac.abort());
        const r = await importConvexDeltas({
          project, target: target(), deployment: values["from-deployment"], deployKey, log, signal: ac.signal,
          ...(values.since ? { since: values.since } : {}), ...(values.watch ? { watch: true } : {}), ...(values.interval ? { intervalMs: Math.max(1, Number(values.interval) || 5) * 1000 } : {}),
          ...(values.strict ? { strict: true } : {}), ...(values.fresh ? { fresh: true } : {}),
        });
        console.log(JSON.stringify(r, null, 2));
        console.error(`next: --since ${r.cursor} (or run the same command again: the cursor is kept in ${r.stateFile})`);
        return 0;
      }
      if (source !== "convex" || !zip) throw new Error(`usage: ember import ${verify ? "verify " : ""}convex <snapshot.zip> [options] (see ember help)`);
      if (verify) {
        const r = await verifyConvex({ project, zip, target: target(), ...(only ? { only } : {}), log });
        if (values.json) console.log(JSON.stringify(r, null, 2));
        return r.ok ? 0 : 1;
      }
      const dryRun = !!values["dry-run"];
      const r = await importConvex({ project, zip, ...(dryRun ? { dryRun } : { target: target() }), ...(values.strict ? { strict: true } : {}), ...(values.fresh ? { fresh: true } : {}), ...(only ? { only } : {}), log });
      if (values.json) console.log(JSON.stringify(r, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
      else printImportReport(r);
      return 0;
    }
    case "migrations": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          env: { type: "string" },
          url: { type: "string" },
          "admin-token": { type: "string" },
          shard: { type: "string" },
          all: { type: "boolean" },
          kind: { type: "string" },
          component: { type: "string" },
          "dry-run": { type: "boolean" },
          reset: { type: "boolean" },
          "batch-size": { type: "string" },
          wait: { type: "boolean" },
          "wait-timeout": { type: "string" },
          concurrency: { type: "string" },
          json: { type: "boolean" },
          registry: { type: "string" },
        },
      });
      const [sub, name] = positionals;
      if (sub !== "run" && sub !== "status" && sub !== "cancel") throw new Error("usage: ember migrations run|status|cancel <name> (see ember --help)");
      if (sub !== "status" && !name) throw new Error(`usage: ember migrations ${sub} <name>`);
      const project = loadProject();
      // Without --env and --url: the local `ember dev`.
      const env = values.env ? resolveEnv(project, values.env) : null;
      const adminToken = values["admin-token"] ?? process.env.EMBER_ADMIN_TOKEN;
      if (!adminToken) throw new Error("migrations needs the project's admin token: set EMBER_ADMIN_TOKEN (or pass --admin-token; for `ember dev`, start it with EMBER_ADMIN_TOKEN set)");
      const url = resolveBaseUrl(project, { ...(values.url ? { url: values.url } : {}), ...(env ? { env: env.name } : {}) });
      let reg: Promise<D1Registry> | null = null;
      const registry = () => (reg ??= D1Registry.open(accountClient(project, undefined, env?.name), registryName(values.registry), { create: false }));
      const o = {
        url,
        adminToken,
        project,
        ...(values.shard ? { shard: values.shard } : {}),
        ...(values.all ? { all: true } : {}),
        ...(values.kind ? { kind: values.kind } : {}),
        ...(values.component ? { component: values.component } : {}),
        ...(values.json ? { json: true } : {}),
        ...(values.concurrency ? { concurrency: Math.max(1, Number(values.concurrency) || 8) } : {}),
        catalog: async () => {
          if (!env) throw new Error("--all needs --env (the registry catalog lists deployed shards)");
          return (await (await registry()).exec("SELECT shard FROM shards WHERE project = ? AND env = ? ORDER BY shard", project.config.project, env.name)).map((r) => String(r.shard));
        },
      };
      if (sub === "cancel") {
        const outs = await cancelMigration(o, name!);
        return outs.some((x) => x.error) ? 1 : 0;
      }
      if (sub === "status") return exitCode(await migrationStatus(o, name), "status");
      const outs = await runMigration(
        {
          ...o,
          ...(values["dry-run"] ? { dryRun: true } : {}),
          ...(values.reset ? { reset: true } : {}),
          ...(values["batch-size"] ? { batchSize: Number(values["batch-size"]) } : {}),
          ...(values.wait ? { wait: true } : {}),
          // Validated by runMigration (a NaN deadline would never pass: it would wait forever).
          ...(values["wait-timeout"] ? { waitTimeoutMs: positiveSeconds(values["wait-timeout"], "--wait-timeout") * 1000 } : {}),
        },
        name!,
      );
      return exitCode(outs, values.wait && !values["dry-run"] ? "wait" : "run");
    }
    case "export": {
      const { values } = parseArgs({
        args: rest,
        options: { out: { type: "string" }, shard: { type: "string", multiple: true }, all: { type: "boolean" }, env: { type: "string" }, url: { type: "string" }, "admin-token": { type: "string" }, registry: { type: "string" } },
      });
      if (!values.out) throw new Error("usage: ember export --out <file.zip> (--shard kind:key ... | --all) [--env name | --url URL]");
      const project = loadProject();
      const adminToken = values["admin-token"] ?? process.env.EMBER_ADMIN_TOKEN;
      if (!adminToken) throw new Error("ember export needs the project's admin token: set EMBER_ADMIN_TOKEN (or pass --admin-token)");
      const url = resolveBaseUrl(project, { ...(values.url ? { url: values.url } : {}), ...(values.env ? { env: values.env } : {}) });
      let shards = values.shard ?? [];
      if (values.all) {
        const env = resolveEnv(project, values.env);
        const reg = await D1Registry.open(accountClient(project, undefined, env.name), registryName(values.registry), { create: false });
        shards = (await reg.exec("SELECT shard FROM shards WHERE project = ? AND env = ? ORDER BY shard", project.config.project, env.name)).map((r) => String(r.shard));
      }
      const m = await exportEmber({ project, target: { url, adminToken }, shards, out: values.out, log: (l) => console.error(l) });
      console.log(`${values.out}: ${m.shards.length} shard(s)`);
      return 0;
    }
    case "env": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          env: { type: "string" },
          var: { type: "boolean" },
          local: { type: "boolean" },
          json: { type: "boolean" },
          reveal: { type: "boolean" },
          url: { type: "string" },
          "admin-token": { type: "string" },
          "from-env": { type: "string" },
        },
      });
      const [sub0, name, value] = positionals;
      const sub = checkEnvArgs(sub0, values, positionals.slice(1));
      const project = loadProject();
      if (sub === "list" && values.local) {
        const d = loadDevVars(project);
        for (const w of d.warnings) console.warn(`warning: ${w}`);
        const names = Object.keys(d.vars).sort();
        if (values.json) console.log(JSON.stringify({ file: d.file, names }, null, 2));
        else if (!d.file) console.log(`No ${DEV_VARS_FILE} next to ember.json (KEY=value lines; gitignored; read by \`ember dev\`).`);
        else for (const n of names) console.log(n);
        return 0;
      }
      const env = resolveEnv(project, values.env);
      const t: EnvTarget = { client: accountClient(project, undefined, env.name), project, env: env.name, worker: workerName(project.config.project, env.name) };
      switch (sub) {
        case "list": {
          const r = await envList(t);
          if (values.json) console.log(JSON.stringify({ worker: t.worker, ...r }, null, 2));
          else {
            if (!r.deployed) console.log(`(${t.worker} is not deployed: no secrets yet)`);
            for (const e of r.entries) console.log(`${e.name.padEnd(32)} ${e.kind}${e.managed ? " (managed by ember)" : ""}`);
            if (!r.entries.length) console.log("Nothing set.");
          }
          return 0;
        }
        case "set": {
          if (!name) throw new Error("usage: ember env set <NAME> [--env name] | ember env set <NAME> <value> --var");
          if (!values.var && value !== undefined) throw new Error("secret values are never taken from the command line (shell history): pipe them on stdin, type them at the prompt, or use --from-env VAR");
          let v: string;
          if (values["from-env"] !== undefined) {
            // Secrets and vars alike (a var from CI's environment, say).
            const x = process.env[values["from-env"]];
            if (x === undefined) throw new Error(`--from-env: ${values["from-env"]} is not set`);
            v = x;
          } else if (values.var) {
            if (value === undefined) throw new Error("usage: ember env set <NAME> <value> --var (or --from-env VAR)");
            v = value;
          } else v = await readSecretValue(name);
          const r = await envSet(t, name, v, { var: !!values.var });
          console.log(r.kind === "secret"
            ? `${name}: secret ${r.created ? "added to" : "updated on"} ${t.worker} (live now; kept across deploys)`
            : `${name}: var ${r.created ? "added to" : "updated in"} ember.json environments.${env.name}.vars (sent by the next \`ember deploy --env ${env.name}\`)`);
          return 0;
        }
        case "get": {
          if (!name) throw new Error("usage: ember env get <NAME> [--env name] [--reveal]");
          const adminToken = values["admin-token"] ?? process.env.EMBER_ADMIN_TOKEN;
          const r = await envGet(t, name, {
            ...(adminToken ? { adminToken } : {}),
            ...(values.reveal ? { reveal: true, url: resolveBaseUrl(project, { ...(values.url ? { url: values.url } : {}), env: env.name }) } : {}),
          });
          if (!r) {
            console.log(`${name}: not set on ${env.name}`);
            return 1;
          }
          if (values.json) console.log(JSON.stringify(r, null, 2));
          else console.log(values.reveal ? r.value : `${name}: ${r.kind} on ${env.name}${r.managed ? " (managed by ember)" : ""} — value hidden (--reveal to print it)`);
          return 0;
        }
        case "rm": {
          if (!name) throw new Error("usage: ember env rm <NAME> [--env name] [--var]");
          const r = await envRm(t, name, { var: !!values.var });
          console.log(r ? `${name}: ${r} removed${r === "var" ? " from ember.json (next deploy)" : ` from ${t.worker}`}` : `${name}: not set on ${env.name}`);
          return r ? 0 : 1;
        }
        default:
          throw new Error("usage: ember env list|set|get|rm ... (ember help)");
      }
    }
    case "keys": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          env: { type: "string" },
          jwt: { type: "boolean" },
          files: { type: "boolean" },
          "auth-secret": { type: "boolean" },
          yes: { type: "boolean" },
          url: { type: "string" },
          "admin-token": { type: "string" },
        },
      });
      if (positionals[0] !== "rotate") throw new Error("usage: ember keys rotate [--env name] [--jwt] [--files] [--auth-secret --yes]");
      const project = loadProject();
      const env = resolveEnv(project, values.env);
      const adminToken = values["admin-token"] ?? process.env.EMBER_ADMIN_TOKEN;
      if (!adminToken) throw new Error("keys rotate needs the project's admin token: set EMBER_ADMIN_TOKEN (or pass --admin-token)");
      const kinds: RotateKind[] = [...(values.jwt ? ["jwt" as const] : []), ...(values.files ? ["files" as const] : []), ...(values["auth-secret"] ? ["auth-secret" as const] : [])];
      const worker = workerName(project.config.project, env.name);
      console.log(`rotating ${kinds.join(", ") || "jwt"} on ${worker}`);
      await rotateKeys({
        client: accountClient(project, undefined, env.name),
        worker,
        url: resolveBaseUrl(project, { ...(values.url ? { url: values.url } : {}), env: env.name }),
        adminToken,
        kinds,
        ...(values.yes ? { yes: true } : {}),
      });
      return 0;
    }
    case "dashboard": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          name: { type: "string" },
          "access-team": { type: "string" },
          "access-aud": { type: "string" },
          access: { type: "boolean" },
          "access-email": { type: "string", multiple: true },
          "access-domain": { type: "string", multiple: true },
          admin: { type: "string", multiple: true },
          host: { type: "string" },
          registry: { type: "string" },
          account: { type: "string" },
          dataset: { type: "string" },
          yes: { type: "boolean" },
        },
      });
      if (positionals[0] === "token") {
        const project = maybeProject();
        await rotateDashboardToken(accountClient(project, values.account), { ...(values.name ? { name: values.name } : {}), io: cliIo(), dir: project?.root ?? process.cwd() });
        return 0;
      }
      if (positionals[0] === "destroy") {
        await destroyDashboard(accountClient(maybeProject(), values.account), { ...(values.name ? { name: values.name } : {}), ...(values.yes ? { yes: true } : {}), log: (l) => console.log(l) });
        return 0;
      }
      if (positionals[0] !== "deploy") throw new Error("usage: ember dashboard deploy [--name ember-dashboard] [--access [--access-email e] [--access-domain d] [--access-team T]] | [--access-team T --access-aud A] [--admin email|@domain ...]");
      const client = accountClient(maybeProject(), values.account);
      const registry = await D1Registry.open(client, registryName(values.registry), { log: (l) => console.log(l) });
      const name = values.name ?? DEFAULT_DASHBOARD_NAME;
      let access: { team: string; aud: string } | null = values["access-team"] && values["access-aud"] ? { team: values["access-team"], aud: values["access-aud"] } : null;
      if (values.access) {
        // The host Access protects: --host (custom domain) or the dashboard's workers.dev address.
        const sub = (await client.call<{ subdomain?: string }>("GET", "/workers/subdomain"))?.subdomain;
        const host = values.host ?? (sub ? `${name}.${sub}.workers.dev` : null);
        if (!host) throw new Error("--access: no workers.dev subdomain on the account; pass --host <dashboard host>");
        const app = await ensureAccessApp(client, {
          host,
          name,
          ...(values["access-email"] ? { emails: values["access-email"] } : {}),
          ...(values["access-domain"] ? { emailDomains: values["access-domain"] } : {}),
          ...(values["access-team"] ? { team: values["access-team"] } : {}),
          log: (l) => console.log(l),
        });
        access = { team: app.team, aud: app.aud };
      }
      // Access users with the admin role: --admin, else the people --access lets in by email.
      const admins = values.admin ?? (values.access ? values["access-email"] : undefined);
      const r = await deployDashboard(client, {
        registry,
        name,
        ...(admins?.length ? { admins } : {}),
        ...(access ? { accessTeam: access.team, accessAud: access.aud } : {}),
        ...(values.dataset ? { dataset: values.dataset } : {}),
      });
      if (r.generatedToken) revealOnce("Dashboard token", r.generatedToken, { io: cliIo(), dir: maybeProject()?.root ?? process.cwd(), file: "dashboard-token" });
      return 0;
    }
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}

/** The preview environment of a branch (`preview-<slug>`), checked: needs `environments.preview`, never a declared name. */
function previewOf(project: Project, branch: string): string {
  if (!project.config.environments.preview) throw new Error(`--preview derives an environment from "environments.preview" in ember.json: add one (it may be {}), with the vars and settings every preview shares`);
  const name = previewEnvName(project.config.project, branch);
  if (Object.hasOwn(project.config.environments, name)) throw new Error(`${name} is declared in ember.json: --preview only deploys derived environments (use --env ${name})`);
  return name;
}

/** A positive number of seconds from a CLI option, or a clear error (`Number("30m")` is NaN). */
function positiveSeconds(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number of seconds, got ${JSON.stringify(raw)}`);
  return n;
}
