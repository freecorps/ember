// `ember` entry: init | codegen | dev | deploy | run | logs.

import { parseArgs } from "node:util";
import { codegen } from "./codegen/index.ts";
import { loadProject, resolveEnv, workerName } from "./config.ts";
import { deploy } from "./deploy/index.ts";
import { dev } from "./dev.ts";
import { init } from "./init.ts";
import { run } from "./run.ts";

const HELP = `ember <command> [options]

Commands:
  init [dir] [--project name] [--force]   Create ember.json and a sample app in ember/
  codegen                                 Generate ember/_generated (static client types + manifest)
  dev [--port 8787] [--no-persist]        Run locally (Miniflare/workerd), rebuild on change
  deploy [--env prod] [--gradual N] [--dry-run] [--message text]
         [--wait [--shard kind:key ...] [--wait-timeout s] [--url URL]] [--admin-token T]
                                          Deploy ember-<project>-<env> through the Cloudflare API. --wait polls
                                          global:main (+ --shard) until migrated; fails on a refused migration
  run <fn> ['<json args>'] [--shard kind:key] [--env name | --url URL] [--token T] [--query|--mutation|--action]
                                          Call a query, mutation or action over HTTP (dev by default)
  logs [--env name]                       Not implemented yet (prints the wrangler tail command)

Environment: CLOUDFLARE_API_TOKEN (else \`npx wrangler auth token\`), CLOUDFLARE_ACCOUNT_ID,
EMBER_ADMIN_TOKEN (uploaded as a Worker secret by deploy; enables GET /api/_ember/status and --wait).`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case "init": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { project: { type: "string" }, force: { type: "boolean" } } });
      const r = init({ ...(positionals[0] ? { dir: positionals[0] } : {}), ...(values.project ? { project: values.project } : {}), ...(values.force ? { force: true } : {}) });
      console.log(`Created in ${r.root}:\n${r.created.map((f) => `  ${f}`).join("\n")}\nNext: install @ember/server @ember/runtime @ember/client, then \`ember dev\`.`);
      return 0;
    }
    case "codegen": {
      parseArgs({ args: rest, options: {} });
      const project = loadProject();
      const t = Date.now();
      const r = await codegen(project);
      for (const w of r.warnings) console.warn(`warning: ${w}`);
      console.log(`codegen: ${r.manifest.functions.length} functions, ${Object.keys(r.manifest.schema.tables).length} tables → ${project.generatedDir} (${Date.now() - t} ms)`);
      return 0;
    }
    case "dev": {
      const { values } = parseArgs({ args: rest, options: { port: { type: "string" }, "no-persist": { type: "boolean" } } });
      const project = loadProject();
      const server = await dev(project, { ...(values.port ? { port: Number(values.port) } : {}), persist: !values["no-persist"] });
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
    case "logs": {
      const { values } = parseArgs({ args: rest, options: { env: { type: "string" } } });
      const project = loadProject();
      const env = resolveEnv(project, values.env);
      console.log(`ember logs is not implemented yet. Meanwhile: npx wrangler tail ${workerName(project.config.project, env.name)}`);
      return 0;
    }
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}
