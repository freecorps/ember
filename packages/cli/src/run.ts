// `ember run <fn> '<json>'`: one-shot HTTP call (POST /api/query | /api/mutation | /api/action) against dev or a
// deployment.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FunctionManifest } from "./codegen/index.ts";
import type { Project } from "./config.ts";
import { loadDeployments } from "./deploy/index.ts";
import { devUrl } from "./dev.ts";

export interface RunOptions {
  fn: string;
  args?: string;
  shard?: string;
  url?: string;
  env?: string;
  token?: string;
  /** Force the endpoint when the manifest is missing. */
  kind?: "query" | "mutation" | "action";
  fetch?: typeof fetch;
}

export const DEFAULT_SHARD = "global:main";

/** `messages.list`, `messages:list` and `dir/mod:fn` are accepted. */
export function normalizeFnName(fn: string): string {
  if (fn.includes(":")) return fn;
  const parts = fn.split(/[./]/);
  if (parts.length < 2) throw new Error(`Function name "${fn}" must be module:function (e.g. messages:list)`);
  return `${parts.slice(0, -1).join("/")}:${parts[parts.length - 1]}`;
}

export function resolveBaseUrl(project: Project, opts: Pick<RunOptions, "url" | "env">): string {
  if (opts.url) return opts.url;
  if (opts.env) {
    const d = loadDeployments(project)[opts.env];
    if (!d?.url) throw new Error(`No deployed URL known for "${opts.env}" (run \`ember deploy --env ${opts.env}\` or pass --url)`);
    return d.url;
  }
  const dev = devUrl(project);
  if (!dev) throw new Error("No `ember dev` running (pass --url or --env)");
  return dev;
}

export async function run(project: Project, opts: RunOptions): Promise<{ status: number; body: unknown }> {
  const fn = normalizeFnName(opts.fn);
  let kind = opts.kind;
  if (!kind) {
    const manifestPath = join(project.generatedDir, "manifest.json");
    const info = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { functions: FunctionManifest[] }).functions.find((f) => f.name === fn)
      : undefined;
    if (!info) throw new Error(`Unknown function "${fn}" (run \`ember codegen\`, or pass --query/--mutation/--action)`);
    if (info.type !== "query" && info.type !== "mutation" && info.type !== "action") throw new Error(`"${fn}" is a ${info.type}: it cannot be run over HTTP`);
    if (info.visibility === "internal") throw new Error(`"${fn}" is internal: clients (and \`ember run\`) can only call public functions`);
    kind = info.type;
  }
  let args: unknown = {};
  if (opts.args) {
    try {
      args = JSON.parse(opts.args);
    } catch (e) {
      throw new Error(`Args must be JSON: ${(e as Error).message}`);
    }
  }
  const base = resolveBaseUrl(project, opts);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await (opts.fetch ?? fetch)(new URL(`/api/${kind}`, base), {
    method: "POST",
    headers,
    body: JSON.stringify({ fn, args, shard: opts.shard ?? DEFAULT_SHARD }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, body };
}
