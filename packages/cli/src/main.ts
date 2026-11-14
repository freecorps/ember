import { writeFileSync } from "node:fs";
// `ember` entry: init | codegen | dev | deploy | run | logs.

import { parseArgs } from "node:util";
import { queryFunctionStats } from "@freecorps/ember-dashboard/metrics-sql";
import { codegen } from "./codegen/index.ts";
import { findProjectRoot, loadProject, resolveEnv, workerName, type Project } from "./config.ts";
import { DEFAULT_DASHBOARD_NAME, deployDashboard } from "./dashboard.ts";
import { ensureAccessApp } from "./access.ts";
import { CfClient, resolveToken } from "./deploy/cf.ts";
import { DEFAULT_METRICS_DATASET } from "./deploy/plan.ts";
import { addDomain } from "./domains.ts";
import { streamLogs } from "./logs.ts";
import { D1Registry, registryName } from "./registry.ts";
import { deploy } from "./deploy/index.ts";
import { dev } from "./dev.ts";
import { init } from "./init.ts";
import { resolveBaseUrl, run } from "./run.ts";
import { restoreCommand } from "./restore.ts";
import { rotateKeys, type RotateKind } from "./keys.ts";
import { destroy } from "./destroy.ts";
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
  dev [--port 8787] [--no-persist] [--remote [--env dev]]
                                          Run locally (Miniflare/workerd), rebuild on change. --remote binds the
                                          env's real Workers AI, Vectorize, Browser Rendering and Images (AI Search
                                          stays on the local fallback)
                                          (needs wrangler; billed; dev writes reach those indexes)
  deploy [--env prod] [--gradual N] [--dry-run] [--message text]
         [--wait [--shard kind:key ...] [--wait-timeout s] [--url URL]] [--admin-token T]
                                          Deploy ember-<project>-<env> through the Cloudflare API. --wait polls
                                          global:main (+ --shard) until migrated; fails on a refused migration
  destroy [--env name] --yes              Delete ember-<project>-<env>: the Worker and its Durable Object data, this
                                          env's Vectorize indexes / AI Search instances / indexing queue, the files
                                          queue and (if empty) bucket
  run <fn> ['<json args>'] [--shard kind:key] [--env name | --url URL] [--token T] [--query|--mutation|--action]
                                          Call a query, mutation or action over HTTP (dev by default)
  logs [--env name] [--fn module:fn] [--shard kind[:key]] [--errors] [--json]
                                          Stream the Worker's logs (tail API). --fn/--shard filter per execution
                                          (needs the Worker var EMBER_TRACE=1; else they match log text)
  projects ls [--json]                    Projects and environments in the account registry (D1 ember-registry)
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

Shared: --registry <name> (or EMBER_REGISTRY_NAME) overrides the registry D1 database (default ember-registry);
--account <id> where no ember.json is at hand.

Environment: CLOUDFLARE_API_TOKEN (else \`npx wrangler auth token\`), CLOUDFLARE_ACCOUNT_ID,
EMBER_ADMIN_TOKEN (uploaded as a Worker secret by deploy; enables GET /api/_ember/status|data|crons and --wait),
EMBER_METRICS_DATASET (default ember_metrics), EMBER_ANALYTICS_TOKEN / EMBER_DASHBOARD_TOKEN (dashboard deploy).`;

function maybeProject(): Project | null {
  return findProjectRoot() ? loadProject() : null;
}

/** Cloudflare client for the project's (or --account / CLOUDFLARE_ACCOUNT_ID) account. */
function accountClient(project: Project | null, account?: string, env?: string): CfClient {
  const accountId =
    account ?? (project && env ? project.config.environments[env]?.account : undefined) ?? project?.config.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
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
        },
      });
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
      if (!values.wait && (values.shard?.length || timeoutMs !== undefined)) throw new Error("--shard and --wait-timeout need --wait");
      await deploy(loadProject(), {
        ...(values.env ? { env: values.env } : {}),
        ...(gradual !== undefined ? { gradual } : {}),
        ...(values.message ? { message: values.message } : {}),
        ...(values["admin-token"] ? { adminToken: values["admin-token"] } : {}),
        ...(values.registry ? { registryName: values.registry } : {}),
        ...(values.wait
          ? {
              wait: {
                ...(values.shard?.length ? { shards: values.shard } : {}),
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(values.url ? { url: values.url } : {}),
              },
            }
          : {}),
        dryRun: !!values["dry-run"],
      });
      return 0;
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
      const { values } = parseArgs({ args: rest, options: { env: { type: "string" }, yes: { type: "boolean" } } });
      const r = await destroy(loadProject(), { ...(values.env ? { env: values.env } : {}), ...(values.yes ? { yes: true } : {}) });
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
        },
      });
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
      if (r.generatedToken) console.log(`\nDashboard token (shown once; store it in your password manager): ${r.generatedToken}`);
      return 0;
    }
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}
