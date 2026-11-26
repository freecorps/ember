// `ember mcp`: the Ember project as MCP tools for coding agents (contracts.md "MCP"). Code facts (schema,
// functions, types, codegen) come from the project on disk; live ones (run, data, shards, logs, metrics) from an
// environment: the running `ember dev` ("local", the default) or a deployed environment the server was started
// with access to (`--allow-env <name>` to read it, `--allow-run <name>` to run functions there). A mutation or action
// on a deployed environment also needs `confirm: "<env>"` in the call. Admin calls use the project's admin token
// (EMBER_ADMIN_TOKEN) through the runtime's existing admin endpoints (`/api/_ember/run`, `data`, `status`, `inspect`).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { limitWarnings, queryFunctionStats, type FunctionStats } from "@freecorps/ember-dashboard/metrics-sql";
import { codegen as runCodegen, type CodegenResult, type FunctionManifest } from "../codegen/index.ts";
import { envConfig, resolveEnv, workerName, type Project } from "../config.ts";
import { CfClient, resolveToken } from "../deploy/cf.ts";
import { DEFAULT_METRICS_DATASET } from "../deploy/plan.ts";
import { devUrl } from "../dev.ts";
import { streamLogs, type StreamLogsOptions } from "../logs.ts";
import { D1Registry, registryName } from "../registry.ts";
import { DEFAULT_SHARD, normalizeFnName, resolveBaseUrl } from "../run.ts";
import { apiUrl } from "../secure-url.ts";
import { adminRequest, formatShardList, formatShardReport, inspectShard, listShards, table, type AdminTarget } from "../shards.ts";
import { ToolError, type JsonSchema, type McpTool, type ToolOutput } from "./server.ts";

/** The environment name that means the running `ember dev` of this project. */
export const LOCAL = "local";

type Row = Record<string, unknown>;

export interface EmberMcpOptions {
  project: Project;
  /** The project's admin token (run, data, shards inspect). Default: EMBER_ADMIN_TOKEN. */
  adminToken?: string;
  /** Deployed environments the read tools (data, shards, logs, metrics) may reach (`--allow-env`). */
  allowEnv?: string[];
  /** Deployed environments `run` may execute functions on (`--allow-run`; implies `allowEnv`). */
  allowRun?: string[];
  /** Injected for tests. */
  fetch?: typeof fetch;
  devUrl?: () => string | null;
  client?: (env: string) => CfClient;
  registry?: (env: string) => Promise<{ exec(sql: string, ...params: unknown[]): Promise<Row[]> }>;
  WebSocket?: StreamLogsOptions["WebSocket"];
  metrics?: (o: { env: string; hours: number }) => Promise<FunctionStats[]>;
  codegen?: typeof runCodegen;
}

const SHARD: JsonSchema = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}:\\S{1,190}$", description: 'Shard name "<kind>:<key>" (default "global:main"; functions routed by an argument derive it from that argument).' };
const ENV: JsonSchema = {
  type: "string",
  pattern: "^[a-z][a-z0-9-]{0,39}$",
  description: `Where to act: "${LOCAL}" (default) is this project's running \`ember dev\`; any other name is a deployed environment from ember.json (or a preview-<slug>), which the server must have been started with access to (--allow-env / --allow-run).`,
};

const json = (x: unknown) => JSON.stringify(x, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
const out = (text: string, structured?: Record<string, unknown>): ToolOutput => ({ text, ...(structured ? { structured } : {}) });

/** The newest mtime and the file count under the functions folder (without `_generated`): a cheap staleness key. */
function sourceStamp(dir: string): string {
  let newest = 0;
  let count = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "_generated" || name === "node_modules" || name.startsWith(".")) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        count++;
        newest = Math.max(newest, st.mtimeMs);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return `${count}:${newest}`;
}

export function emberTools(o: EmberMcpOptions): McpTool[] {
  const { project } = o;
  const gen = o.codegen ?? runCodegen;
  const adminToken = () => {
    const t = o.adminToken ?? process.env.EMBER_ADMIN_TOKEN;
    if (!t) throw new ToolError("This tool calls the project's admin endpoints: start the MCP server with EMBER_ADMIN_TOKEN set (for the local `ember dev`, start it with the same EMBER_ADMIN_TOKEN).");
    return t;
  };
  const allowEnv = new Set([...(o.allowEnv ?? []), ...(o.allowRun ?? [])]);
  const allowRun = new Set(o.allowRun ?? []);

  /** The base URL of an environment, after the access check. */
  const target = (env: string | undefined, need: "read" | "run"): { env: string; url: string; local: boolean } => {
    const name = env ?? LOCAL;
    if (name === LOCAL) {
      const url = (o.devUrl ?? (() => devUrl(project)))();
      if (!url) throw new ToolError(`No \`ember dev\` is running for ${project.config.project}: start it (with EMBER_ADMIN_TOKEN set), or name a deployed environment the server may reach.`);
      return { env: name, url: resolveBaseUrl(project, { url }), local: true };
    }
    let resolved: string;
    try {
      resolved = resolveEnv(project, name).name;
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    const allowed = need === "run" ? allowRun : allowEnv;
    if (!allowed.has(resolved)) {
      throw new ToolError(
        need === "run"
          ? `Running functions on the deployed environment "${resolved}" is off: the user must restart \`ember mcp\` with --allow-run ${resolved} (then mutations and actions there also need confirm: "${resolved}"). Use env "${LOCAL}" (ember dev) instead.`
          : `The deployed environment "${resolved}" is not reachable from this server: the user must restart \`ember mcp\` with --allow-env ${resolved}. Use env "${LOCAL}" (ember dev) instead.`,
      );
    }
    try {
      return { env: resolved, url: resolveBaseUrl(project, { env: resolved }), local: false };
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
  };
  const admin = (url: string): AdminTarget => ({ url, adminToken: adminToken(), ...(o.fetch ? { fetch: o.fetch } : {}) });
  const deployedOnly = (env: string | undefined, what: string): string => {
    if (!env || env === LOCAL) throw new ToolError(`${what} come from Cloudflare: name a deployed environment (env), not the local \`ember dev\`.`);
    return target(env, "read").env;
  };
  const client = (env: string) => {
    if (o.client) return o.client(env);
    const accountId = envConfig(project, env)?.account ?? project.config.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) throw new ToolError(`No Cloudflare account: set "account" in ember.json or CLOUDFLARE_ACCOUNT_ID.`);
    return new CfClient({ accountId, token: resolveToken(), ...(o.fetch ? { fetch: o.fetch } : {}) });
  };
  const registry = o.registry ?? ((env: string) => D1Registry.open(client(env), registryName(), { create: false, ddl: false }));

  // Codegen in check mode (writes nothing), reused while the functions folder (without _generated) is unchanged.
  let cached: { stamp: string; r: CodegenResult } | null = null;
  const manifest = async (): Promise<CodegenResult> => {
    const stamp = sourceStamp(project.dir);
    if (cached?.stamp === stamp) return cached.r;
    let r: CodegenResult;
    try {
      // A project never generated (no ember/_generated): its modules import ./_generated/server, which check mode
      // cannot resolve, so it is generated once (gitignored output, what `ember dev` writes too).
      r = await gen(project, existsSync(project.generatedDir) ? { check: true } : {});
    } catch (e) {
      throw new ToolError(`The project does not load (codegen): ${(e as Error).message}`);
    }
    cached = { stamp: sourceStamp(project.dir), r };
    return r;
  };
  const findFn = async (name: string): Promise<{ fn: FunctionManifest; r: CodegenResult }> => {
    const r = await manifest();
    let wanted: string;
    try {
      wanted = normalizeFnName(name);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    const fn = r.manifest.functions.find((f) => f.name === name || f.name === wanted);
    if (!fn) {
      const near = r.manifest.functions.filter((f) => f.name.includes(wanted.split(":").pop()!)).map((f) => f.name);
      throw new ToolError(`No function ${name}.${near.length ? ` Did you mean: ${near.slice(0, 5).join(", ")}?` : ""} (the \`functions\` tool lists them)`);
    }
    return { fn, r };
  };

  const tools: McpTool[] = [
    {
      name: "schema",
      title: "Database schema",
      description:
        "The app's tables (ember/schema.ts) with their document shape, indexes (name, kind, fields) and the shard kind each lives in. Read from the code on disk (what the next deploy would migrate to), not from a deployment.",
      inputSchema: { type: "object", properties: { table: { type: "string", description: "Only this table." } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async call(a) {
        const r = await manifest();
        const all = r.manifest.schema.tables as Record<string, { document?: unknown; indexes?: Array<{ name: string; kind: string; fields: string[]; sparse?: boolean }>; shard?: { name?: string } | null; replicated?: unknown }>;
        const names = Object.keys(all).filter((n) => !n.startsWith("_")).sort();
        if (a.table !== undefined && !all[a.table as string]) throw new ToolError(`No table ${String(a.table)} (tables: ${names.join(", ")})`);
        const tables = (a.table ? [a.table as string] : names).map((name) => {
          const t = all[name]!;
          return { name, shard: t.shard?.name ?? "global", ...(t.replicated ? { replicated: true } : {}), indexes: (t.indexes ?? []).map((i) => ({ name: i.name, kind: i.kind, fields: i.fields, ...(i.sparse ? { sparse: true } : {}) })), document: t.document ?? null };
        });
        const text = tables.map((t) => `${t.name} (shard ${t.shard}${t.replicated ? ", replicated" : ""})\n${t.indexes.length ? t.indexes.map((i) => `  index ${i.name} [${i.kind}] (${i.fields.join(", ")})`).join("\n") : "  no indexes"}`).join("\n");
        return out(`schema ${r.manifest.schema.version.slice(0, 12)}: ${tables.length} table(s)\n${text}\n\n${json({ tables })}`, { version: r.manifest.schema.version, tables });
      },
    },
    {
      name: "functions",
      title: "Functions",
      description:
        'The app\'s functions (queries, mutations, actions, HTTP actions) with visibility, shard routing and the application errors each may throw. Names are "module:function" (ember/messages.ts `list` is "messages:list"). Use `types` for one function\'s full contract.',
      inputSchema: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Substring of the name." },
          type: { type: "string", enum: ["query", "mutation", "action", "httpAction"] },
          visibility: { type: "string", enum: ["public", "internal"] },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      async call(a) {
        const r = await manifest();
        const fns = r.manifest.functions
          .filter((f) => (a.filter === undefined || f.name.includes(a.filter as string)) && (a.type === undefined || f.type === a.type) && (a.visibility === undefined || f.visibility === a.visibility))
          .map((f) => ({ name: f.name, type: f.type, visibility: f.visibility, ...(f.shard ? { shard: f.shard } : {}), ...(f.errors?.length ? { errors: f.errors } : {}), ...(f.sensitive ? { sensitive: true } : {}), ...(f.component ? { component: f.component } : {}) }));
        const text = fns.length
          ? table(["FUNCTION", "TYPE", "VISIBILITY", "SHARD", "ERRORS"], fns.map((f) => [f.name, f.type, f.visibility, f.shard ? `${f.shard.kind}${f.shard.fromArg ? ` (arg ${f.shard.fromArg})` : f.shard.fromClaim ? ` (claim ${f.shard.fromClaim})` : ""}` : "global", (f.errors ?? []).join(" | ")]))
          : "No function matches.";
        return out(text, { functions: fns });
      },
    },
    {
      name: "types",
      title: "Function contract",
      description: "One function's contract as the generated api.d.ts types it: arguments, result and declared errors (TypeScript). Use before calling `run`, or to write client code.",
      inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, description: 'Function name, "module:function" (or "module.function").' } }, required: ["name"], additionalProperties: false },
      annotations: { readOnlyHint: true },
      async call(a) {
        const { fn, r } = await findFn(a.name as string);
        const contract = r.contracts.get(fn.name) ?? "(no contract: HTTP action)";
        return out(`${fn.name} (${fn.visibility} ${fn.type}${fn.errors?.length ? `, throws ${fn.errors.join(" | ")}` : ""})\n${contract}`, { name: fn.name, type: fn.type, visibility: fn.visibility, errors: fn.errors ?? [], contract });
      },
    },
    {
      name: "run",
      title: "Run a function",
      description:
        `Runs a query, mutation or action (public or internal) through the runtime's admin function runner and returns its value or error. Default env "${LOCAL}" (the running \`ember dev\`). A deployed environment needs the server started with --allow-run <env>, and every mutation or action there needs confirm set to the environment's name: ask the user before doing that, it changes real data. "as" runs it as a user (identity { subject, claims }; sensitive functions refuse that).`,
      inputSchema: {
        type: "object",
        properties: {
          fn: { type: "string", minLength: 1, description: 'Function name, "module:function".' },
          args: { type: "object", description: "Arguments (JSON object; the function's validators check them)." },
          shard: SHARD,
          env: ENV,
          as: { type: "object", properties: { subject: { type: "string", minLength: 1 }, claims: { type: "object" } }, required: ["subject"], additionalProperties: false, description: "Run as this user instead of as the administrator." },
          confirm: { type: "string", description: "The deployed environment's name, repeated: required for mutations and actions outside the local ember dev." },
        },
        required: ["fn"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      async call(a) {
        const { fn } = await findFn(a.fn as string);
        if (fn.type === "httpAction") throw new ToolError(`${fn.name} is an HTTP action: call its route over HTTP instead.`);
        const t = target(a.env as string | undefined, "run");
        if (!t.local && fn.type !== "query" && a.confirm !== t.env) {
          throw new ToolError(`${fn.name} is a ${fn.type} on the deployed environment "${t.env}": it changes real data. Ask the user, then call again with confirm: "${t.env}".`);
        }
        const args = (a.args ?? {}) as Record<string, unknown>;
        let shard = a.shard as string | undefined;
        if (!shard && fn.shard && fn.shard.kind !== "global") {
          const v = fn.shard.fromArg !== undefined ? args[fn.shard.fromArg] : undefined;
          if (typeof v === "string" || typeof v === "number") shard = `${fn.shard.kind}:${v}`;
          else throw new ToolError(`${fn.name} runs in "${fn.shard.kind}" shards: pass shard ("${fn.shard.kind}:<key>")${fn.shard.fromArg ? ` or the ${fn.shard.fromArg} argument` : ""}.`);
        }
        const body = { fn: fn.name, args, shard: shard ?? DEFAULT_SHARD, ...(a.as ? { as: a.as } : {}) };
        const res = await (o.fetch ?? fetch)(apiUrl(t.url, "/api/_ember/run"), {
          method: "POST",
          headers: { authorization: `Bearer ${adminToken()}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let r: { ok?: boolean; value?: unknown; error?: { code: string; message: string; data?: unknown }; ms?: number };
        try {
          r = JSON.parse(text) as typeof r;
        } catch {
          throw new ToolError(`POST /api/_ember/run on ${t.env}: HTTP ${res.status} ${text.slice(0, 300)}`);
        }
        const where = `${fn.name} on ${t.env} (${body.shard})`;
        if (!r.ok) return { text: `${where} failed: ${r.error?.code ?? res.status}: ${r.error?.message ?? text.slice(0, 300)}${r.error?.data !== undefined ? `\ndata: ${json(r.error.data)}` : ""}`, structured: { ok: false, env: t.env, shard: body.shard, error: r.error ?? { code: String(res.status), message: text.slice(0, 300) } }, isError: true };
        return out(`${where} → ${r.ms !== undefined ? `${r.ms.toFixed(1)} ms` : "ok"}\n${json(r.value ?? null)}`, { ok: true, env: t.env, shard: body.shard, value: r.value ?? null, ...(r.ms !== undefined ? { ms: r.ms } : {}) });
      },
    },
    {
      name: "data",
      title: "Browse table data",
      description:
        `Reads one shard's documents, read-only, a page at a time (as stored: system fields included). Without table: the shard's tables with row counts. Pass the returned cursor to get the next page. Internal tables (_jobs, _files, ...) are listed too. Default env "${LOCAL}".`,
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", minLength: 1 },
          shard: SHARD,
          cursor: { type: "string", description: "The cursor of the previous page." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          jobs: { type: "string", enum: ["open", "done"], description: "For table _jobs: only jobs not finished yet, or only finished ones." },
          env: ENV,
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      async call(a) {
        const t = target(a.env as string | undefined, "read");
        const shard = (a.shard as string | undefined) ?? DEFAULT_SHARD;
        const q = new URLSearchParams({ shard });
        if (a.table) q.set("table", a.table as string);
        if (a.cursor) q.set("cursor", a.cursor as string);
        q.set("limit", String(a.limit ?? 50));
        if (a.jobs) q.set("jobs", a.jobs as string);
        const r = await adminRequest<{ tables?: Array<{ name: string; kind: string; rows: number }>; table?: string; rows?: unknown[]; cursor?: string | null; done?: boolean }>(admin(t.url), "GET", `/api/_ember/data?${q}`).catch((e: Error) => {
          throw new ToolError(e.message);
        });
        if (r.tables) return out(`${shard} on ${t.env}:\n${table(["TABLE", "KIND", "ROWS"], r.tables.map((x) => [x.name, x.kind, String(x.rows)]))}`, { env: t.env, shard, tables: r.tables });
        const rows = r.rows ?? [];
        return out(`${r.table} on ${shard} (${t.env}): ${rows.length} row(s)${r.done ? ", last page" : `, more: cursor "${r.cursor}"`}\n${json(rows)}`, { env: t.env, shard, table: r.table ?? null, rows, cursor: r.done ? null : (r.cursor ?? null), done: !!r.done });
      },
    },
    {
      name: "shards",
      title: "Shards",
      description:
        "Without shard: a deployed environment's shards from the account registry catalog (size, schema version, last write). With shard: that shard live (size, schema and commit version, tables with row counts, open jobs, subscriptions). The local `ember dev` has no catalog: pass shard there.",
      inputSchema: { type: "object", properties: { shard: SHARD, kind: { type: "string", description: "Catalog: only this shard kind." }, env: ENV }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async call(a) {
        if (a.shard) {
          const t = target(a.env as string | undefined, "read");
          const r = await inspectShard(admin(t.url), a.shard as string).catch((e: Error) => {
            throw new ToolError(e.message);
          });
          return out(formatShardReport(r), { env: t.env, ...r });
        }
        const env = deployedOnly(a.env as string | undefined, "The shard catalog and its sizes");
        const reg = await registry(env);
        const shards = await listShards((sql, ...p) => reg.exec(sql, ...p), project.config.project, env, a.kind ? { kind: a.kind as string } : {});
        return out(formatShardList(shards), { env, shards });
      },
    },
    {
      name: "logs",
      title: "Recent logs",
      description:
        "Tails a deployed environment's Worker logs for a few seconds (Cloudflare tail: what happens now, not history) and returns the lines: requests, console output, exceptions, and with the Worker var EMBER_TRACE=1 one line per function execution. Filters: fn, shard, errors.",
      inputSchema: {
        type: "object",
        properties: {
          env: { ...ENV, description: "Deployed environment (required: the local `ember dev` prints to its own terminal)." },
          seconds: { type: "integer", minimum: 1, maximum: 60, default: 10 },
          fn: { type: "string", description: 'Only this function ("module:function").' },
          shard: { type: "string", description: 'Only this shard ("kind:key") or kind ("org").' },
          errors: { type: "boolean", description: "Only failures, exceptions and error logs." },
          maxLines: { type: "integer", minimum: 1, maximum: 2000, default: 300 },
        },
        required: ["env"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async call(a) {
        const env = deployedOnly(a.env as string, "Logs");
        const worker = workerName(project.config.project, env);
        const lines: string[] = [];
        const max = (a.maxLines as number | undefined) ?? 300;
        let dropped = 0;
        const seconds = (a.seconds as number | undefined) ?? 10;
        const r = await streamLogs(client(env), worker, {
          until: new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000).unref?.()),
          print: (l) => (lines.length < max ? void lines.push(l) : void dropped++),
          color: false,
          filters: { ...(a.fn ? { fn: a.fn as string } : {}), ...(a.shard ? { shard: a.shard as string } : {}), ...(a.errors ? { errors: true } : {}) },
          ...(o.WebSocket ? { WebSocket: o.WebSocket } : {}),
        }).catch((e: Error) => {
          throw new ToolError(`tail ${worker}: ${e.message}`);
        });
        const body = lines.filter((l) => !l.startsWith("tailing "));
        return out(`${worker}: ${r.events} event(s) in ${seconds}s${dropped ? `, ${dropped} line(s) over maxLines dropped` : ""}\n${body.join("\n") || "(no logs in that window)"}`, { env, worker, seconds, events: r.events, lines: body, dropped });
      },
    },
    {
      name: "metrics",
      title: "Function metrics",
      description: "Per-function calls, error rate, p50/p95 latency and rows read of a deployed environment (Analytics Engine), with the calls that came near a per-transaction limit.",
      inputSchema: { type: "object", properties: { env: { ...ENV, description: "Deployed environment (required)." }, hours: { type: "integer", minimum: 1, maximum: 720, default: 24 } }, required: ["env"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async call(a) {
        const env = deployedOnly(a.env as string, "Metrics");
        const hours = (a.hours as number | undefined) ?? 24;
        const stats = o.metrics
          ? await o.metrics({ env, hours })
          : await (async () => {
              const c = client(env);
              return queryFunctionStats({ accountId: c.accountId, token: resolveToken(), dataset: project.config.metrics?.dataset ?? process.env.EMBER_METRICS_DATASET ?? DEFAULT_METRICS_DATASET, project: project.config.project, env, sinceHours: hours, ...(o.fetch ? { fetch: o.fetch } : {}) });
            })();
        if (!stats.length) return out(`No executions recorded on ${env} in the last ${hours} h.`, { env, hours, functions: [] });
        const near = stats.flatMap((f) => limitWarnings(f.limitPeaks ?? {}).map((w) => `${f.fn}: ${w.message}`));
        const text = table(
          ["FUNCTION", "KIND", "CALLS", "ERR%", "P50MS", "P95MS", "ROWS/CALL"],
          stats.map((f) => [f.fn, f.kind, f.calls.toFixed(0), (f.errorRate * 100).toFixed(1), f.p50.toFixed(2), f.p95.toFixed(2), f.avgRowsRead.toFixed(1)]),
          [2, 3, 4, 5, 6],
        );
        return out(`${env}, last ${hours} h:\n${text}${near.length ? `\n\nnear a limit:\n${[...new Set(near)].join("\n")}` : ""}`, { env, hours, functions: stats.map((f) => ({ fn: f.fn, kind: f.kind, calls: f.calls, errorRate: f.errorRate, p50: f.p50, p95: f.p95, avgRowsRead: f.avgRowsRead })), nearLimits: [...new Set(near)] });
      },
    },
    {
      name: "codegen",
      title: "Run codegen",
      description:
        "Runs `ember codegen`: evaluates ember/, regenerates ember/_generated (client types, api.d.ts, manifest) and reports warnings and errors (a schema that does not load, an invalid function). check: write nothing, report which generated files are stale. strict: also fail on any/unknown results and undeclared errors. Run it after editing schema.ts or functions.",
      inputSchema: { type: "object", properties: { check: { type: "boolean" }, strict: { type: "boolean" } }, additionalProperties: false },
      annotations: { readOnlyHint: false, idempotentHint: true },
      async call(a) {
        if (a.check && !existsSync(project.generatedDir)) {
          return { text: `codegen --check: ${project.generatedDir} does not exist yet: run codegen without check`, structured: { ok: false, stale: ["_generated"], warnings: [], errors: [] }, isError: true };
        }
        let r: CodegenResult;
        try {
          r = await gen(project, { ...(a.check ? { check: true } : {}), ...(a.strict ? { strict: true } : {}) });
        } catch (e) {
          return { text: `codegen failed: ${(e as Error).message}`, structured: { ok: false, error: (e as Error).message }, isError: true };
        }
        if (!a.check) cached = null;
        const ok = !r.errors.length && !(a.check && r.stale.length);
        const lines = [
          `codegen${a.check ? " --check" : ""}: ${r.manifest.functions.length} functions, ${Object.keys(r.manifest.schema.tables).length} tables${a.check ? (r.stale.length ? `; stale: ${r.stale.join(", ")}` : " (up to date)") : `; ${r.written.length} file(s) written`}`,
          ...r.warnings.map((w) => `warning: ${w}`),
          ...r.errors.map((e) => `error: ${e}`),
        ];
        return { text: lines.join("\n"), structured: { ok, functions: r.manifest.functions.length, tables: Object.keys(r.manifest.schema.tables).length, written: r.written, stale: r.stale, warnings: r.warnings, errors: r.errors }, isError: !ok };
      },
    },
  ];
  return tools;
}

/** The server's instructions (`initialize`): how environments and confirmations work. */
export function instructions(o: Pick<EmberMcpOptions, "project" | "allowEnv" | "allowRun">): string {
  const reads = [...new Set([...(o.allowEnv ?? []), ...(o.allowRun ?? [])])];
  return [
    `Ember project "${o.project.config.project}" (functions in ${o.project.config.functionsDir ?? "ember"}/). Function names are "module:function".`,
    "schema, functions, types and codegen read the code on disk. run, data and shards act on an environment: \"local\" (default) is the project's running `ember dev`.",
    reads.length ? `Deployed environments this server may read: ${reads.join(", ")}.` : "No deployed environment is reachable (the user can restart with --allow-env <env>).",
    o.allowRun?.length ? `run may execute on: ${o.allowRun.join(", ")}; mutations and actions there need confirm: "<env>" and change real data: ask the user first.` : "run executes on the local ember dev only.",
    "logs and metrics need a deployed environment.",
  ].join("\n");
}

/** The CLI's version (package.json next to src/ or dist/). */
export function cliVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
