// `ember env` (PLAN §13): a project's secrets and plain vars per environment, plus `.dev.vars` for `ember dev`.
//
// Where values live:
//   secrets   Worker secrets (`secret_text`) of `ember-<project>-<env>`, through the Workers API. Write-only: the API
//             never returns a value. They survive every `ember deploy` (uploads carry `keep_bindings: secret_text`).
//             `ember env get --reveal` reads one back through the deployed Worker's admin endpoint (EMBER_ADMIN_TOKEN).
//   vars      `environments.<env>.vars` in ember.json (plain text, committed, sent as `plain_text` bindings by deploy).
//   local     `.dev.vars` next to ember.json (dotenv syntax, gitignored), read by `ember dev` only.
//
// Why not Cloudflare Secrets Store (researched 2026-11, open beta): one store per account and 100 secrets per
// account, shared by every project and environment in it (PLAN §21 runs N projects × envs per account); values are
// read with an async `await env.X.get()` (libraries expecting `env.X` strings, Better Auth among them, would need
// adapters); production secrets are unreachable from local dev. Worker secrets are per Worker (= per project and
// env), synchronous strings, and already the mechanism `ember deploy` and `ember keys rotate` use.
//
// Values are never printed (unless --reveal), logged or written to disk by this module.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudflareApiError, type CfClient } from "./deploy/cf.ts";
import { CONFIG_FILE, ConfigError, type Project } from "./config.ts";

export const DEV_VARS_FILE = ".dev.vars";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names Ember manages itself (auth secret, admin token, storage secrets, generations of them...). */
export const isManagedName = (name: string) => /^EMBER_/.test(name);

/**
 * Names `ember env get --reveal` (and the Worker's reveal endpoint) refuse: every managed name, plus
 * BETTER_AUTH_SECRET, the legacy name the auth secret is still read from (packages/auth). Users may set or remove it
 * (migrating to EMBER_AUTH_SECRET), but it signs sessions, so it never comes back out.
 */
export const isNeverRevealed = (name: string) => isManagedName(name) || name === "BETTER_AUTH_SECRET";

export function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid binding name (letters, digits and _; not starting with a digit)`);
  if (isManagedName(name)) throw new Error(`${name}: EMBER_* names are managed by ember (deploy, keys rotate); pick another name`);
}

// ------------------------------------------------------------------------------------------------ CLI flags

/** Flags of `ember env` (parsed by main.ts). */
export interface EnvFlags {
  env?: string;
  var?: boolean;
  local?: boolean;
  json?: boolean;
  reveal?: boolean;
  url?: string;
  "admin-token"?: string;
  "from-env"?: string;
}

const ENV_FLAGS: Record<string, { flags: Array<keyof EnvFlags>; args: number; usage: string }> = {
  list: { flags: ["env", "json", "local"], args: 0, usage: "ember env list [--env name | --local] [--json]" },
  set: { flags: ["env", "var", "from-env"], args: 2, usage: "ember env set <NAME> [--env name] [--from-env VAR] | ember env set <NAME> (<value> | --from-env VAR) --var" },
  get: { flags: ["env", "json", "reveal", "url", "admin-token"], args: 1, usage: "ember env get <NAME> [--env name] [--reveal [--url u] [--admin-token t]] [--json]" },
  rm: { flags: ["env", "var"], args: 1, usage: "ember env rm <NAME> [--env name] [--var]" },
};
const ENV_ALIASES: Record<string, string> = { ls: "list", delete: "rm" };

/**
 * Validates an `ember env` invocation before anything runs: a flag the subcommand does not use, or a combination
 * that would be ignored, is an error rather than silently doing something else. Returns the canonical subcommand.
 */
export function checkEnvArgs(sub: string | undefined, flags: EnvFlags, positionals: string[]): "list" | "set" | "get" | "rm" {
  const canonical = sub === undefined ? undefined : (ENV_ALIASES[sub] ?? sub);
  const spec = canonical ? ENV_FLAGS[canonical] : undefined;
  if (!canonical || !spec) throw new Error("usage: ember env list|set|get|rm ... (ember help)");
  const given = (Object.keys(flags) as Array<keyof EnvFlags>).filter((k) => flags[k] !== undefined && flags[k] !== false);
  const bad = given.find((k) => !spec.flags.includes(k));
  if (bad) throw new Error(`--${bad} does not apply to \`ember env ${sub}\` (usage: ${spec.usage})`);
  if (positionals.length > spec.args) throw new Error(`unexpected argument ${JSON.stringify(positionals[spec.args])} (usage: ${spec.usage})`);
  if (canonical === "list" && flags.local && flags.env !== undefined) throw new Error(`--local lists ${DEV_VARS_FILE}, which has no environments: drop --env`);
  if (canonical === "get" && !flags.reveal) {
    const extra = (["url", "admin-token"] as const).find((k) => flags[k] !== undefined);
    if (extra) throw new Error(`--${extra} only applies with --reveal`);
  }
  if (canonical === "set" && positionals[1] !== undefined && flags["from-env"] !== undefined) {
    throw new Error("pass the value either on the command line (--var only) or with --from-env, not both");
  }
  return canonical as "list" | "set" | "get" | "rm";
}

// ------------------------------------------------------------------------------------------------ .dev.vars

/** dotenv-style parser: `KEY=value`, `export KEY=value`, `#` comments, single/double quotes (double: \n \" \\). */
export function parseDevVars(text: string, where = DEV_VARS_FILE): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new ConfigError(`${where}:${i + 1}: expected KEY=value`);
    let rest = m[2]!;
    const q = rest[0];
    if (q !== '"' && q !== "'") {
      out[m[1]!] = rest.replace(/\s+#.*$/, "").trim();
      continue;
    }
    // Quoted: scan to the closing quote (may span lines). Double quotes take \n \r \t \" \\ escapes.
    const start = i + 1;
    let value = "";
    rest = rest.slice(1);
    for (;;) {
      let closed = false;
      for (let j = 0; j < rest.length; j++) {
        const ch = rest[j]!;
        if (q === '"' && ch === "\\" && j + 1 < rest.length) {
          const e = rest[++j]!;
          value += ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" } as Record<string, string>)[e] ?? `\\${e}`;
        } else if (ch === q) {
          if (!/^\s*(#.*)?$/.test(rest.slice(j + 1))) throw new ConfigError(`${where}:${i + 1}: unexpected text after the closing quote`);
          closed = true;
          break;
        } else value += ch;
      }
      if (closed) break;
      if (++i >= lines.length) throw new ConfigError(`${where}:${start}: unterminated ${q} quote`);
      value += "\n";
      rest = lines[i]!;
    }
    out[m[1]!] = value;
  }
  return out;
}

export interface DevVars {
  vars: Record<string, string>;
  file: string | null;
  warnings: string[];
}

/** `.dev.vars` of the project (or none). Warns when the file is not gitignored or sets EMBER_* names. */
export function loadDevVars(project: Project): DevVars {
  const file = join(project.root, DEV_VARS_FILE);
  if (!existsSync(file)) return { vars: {}, file: null, warnings: [] };
  const vars = parseDevVars(readFileSync(file, "utf8"), file);
  const warnings: string[] = [];
  for (const k of Object.keys(vars)) {
    if (isManagedName(k)) {
      warnings.push(`${DEV_VARS_FILE}: ${k} ignored (EMBER_* names are managed by ember)`);
      delete vars[k];
    }
  }
  if (gitIgnored(project.root, DEV_VARS_FILE) === false) warnings.push(`${DEV_VARS_FILE} holds secrets but git does not ignore it: add "${DEV_VARS_FILE}*" to .gitignore`);
  return { vars, file, warnings };
}

/** true/false when `root` is in a git work tree, null otherwise (or without git). */
export function gitIgnored(root: string, rel: string): boolean | null {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
  } catch {
    return null;
  }
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Lines `ember init` keeps in .gitignore. */
export const GITIGNORE_LINES = [".ember/", `${DEV_VARS_FILE}*`];

/** Appends the missing GITIGNORE_LINES to `<root>/.gitignore`; true when the file changed. */
export function ensureGitignore(root: string): boolean {
  const p = join(root, ".gitignore");
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (!missing.length) return false;
  writeFileSync(p, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${cur ? "\n" : ""}# ember: local state and dev secrets\n${missing.join("\n")}\n`);
  return true;
}

// ------------------------------------------------------------------------------------------------ remote

export interface EnvTarget {
  client: CfClient;
  project: Project;
  env: string;
  worker: string;
}

export interface EnvEntry {
  name: string;
  kind: "secret" | "var";
  /** Set by ember itself (EMBER_*): listed, never changed by `ember env`. */
  managed: boolean;
}

const notDeployed = (t: EnvTarget) => new Error(`${t.worker} is not deployed yet: run \`ember deploy --env ${t.env}\` first (secrets are stored on the Worker)`);
const missingScript = (e: unknown) => e instanceof CloudflareApiError && (e.status === 404 || e.has(10007));

export async function secretNames(t: EnvTarget): Promise<string[] | null> {
  const r = await t.client.request<Array<{ name: string }>>("GET", `/workers/scripts/${t.worker}/secrets`);
  if (r.status === 404 || r.errors.some((e) => e.code === 10007)) return null;
  if (!r.success) throw new CloudflareApiError(`GET /workers/scripts/${t.worker}/secrets`, r.status, r.errors);
  return (r.result ?? []).map((s) => s.name).sort();
}

const varsOf = (t: EnvTarget) => t.project.config.environments[t.env]?.vars ?? {};

export async function envList(t: EnvTarget): Promise<{ deployed: boolean; entries: EnvEntry[] }> {
  const secrets = await secretNames(t);
  const entries: EnvEntry[] = [
    ...(secrets ?? []).map((name): EnvEntry => ({ name, kind: "secret", managed: isManagedName(name) })),
    ...Object.keys(varsOf(t)).sort().map((name): EnvEntry => ({ name, kind: "var", managed: false })),
  ];
  return { deployed: secrets !== null, entries };
}

/** Sets a secret on the deployed Worker (a new version goes live at once), or a var in ember.json (next deploy). */
export async function envSet(t: EnvTarget, name: string, value: string, opts: { var?: boolean } = {}): Promise<{ kind: "secret" | "var"; created: boolean }> {
  checkName(name);
  if (value === "") throw new Error(`${name}: empty value (use \`ember env rm ${name}\` to remove it)`);
  if (opts.var) {
    const secrets = await secretNames(t);
    if (secrets?.includes(name)) throw new Error(`${name} is a secret on ${t.worker}; \`ember env rm ${name}\` it first to make it a var`);
    const created = !(name in varsOf(t));
    writeVars(t.project, t.env, { ...varsOf(t), [name]: value });
    return { kind: "var", created };
  }
  if (name in varsOf(t)) throw new Error(`${name} is a plain var in ${CONFIG_FILE} (environments.${t.env}.vars); remove it there first (\`ember env rm ${name} --var\`)`);
  const before = await secretNames(t);
  if (before === null) throw notDeployed(t);
  await secretWrite(t, () => t.client.call("PUT", `/workers/scripts/${t.worker}/secrets`, { name, text: value, type: "secret_text" }));
  return { kind: "secret", created: !before.includes(name) };
}

/** A secret write (PUT or DELETE) with the errors every secret change shares translated into the next step. */
async function secretWrite(t: EnvTarget, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (e) {
    if (missingScript(e)) throw notDeployed(t);
    // A split (gradual) deployment cannot take a secret change: it would land on one version only.
    if (e instanceof CloudflareApiError && /multiple versions|gradual|versions secret/i.test(e.message)) {
      throw new Error(`${t.worker} has a gradual deployment in progress: finish it (ember deploy at 100%) before changing secrets`);
    }
    throw e;
  }
}

export async function envRm(t: EnvTarget, name: string, opts: { var?: boolean } = {}): Promise<"secret" | "var" | null> {
  checkName(name);
  if (opts.var || name in varsOf(t)) {
    if (!(name in varsOf(t))) return null;
    const { [name]: _gone, ...rest } = varsOf(t);
    writeVars(t.project, t.env, rest);
    return "var";
  }
  const names = await secretNames(t);
  if (!names?.includes(name)) return null;
  await secretWrite(t, () => t.client.call("DELETE", `/workers/scripts/${t.worker}/secrets/${encodeURIComponent(name)}`));
  return "secret";
}

export type EnvGet = { name: string; kind: "secret" | "var"; managed: boolean; value?: string } | null;

/**
 * Describes one name; the value only with `reveal` (vars from ember.json; secrets through the Worker's admin
 * endpoint `POST /api/_ember/env/reveal`, which needs EMBER_ADMIN_TOKEN and refuses EMBER_* names).
 */
export async function envGet(t: EnvTarget, name: string, opts: { reveal?: boolean; url?: string; adminToken?: string; fetch?: typeof fetch } = {}): Promise<EnvGet> {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid binding name`);
  if (name in varsOf(t)) return { name, kind: "var", managed: false, ...(opts.reveal ? { value: varsOf(t)[name]! } : {}) };
  const names = await secretNames(t);
  if (names === null) throw notDeployed(t);
  if (!names.includes(name)) return null;
  const entry = { name, kind: "secret" as const, managed: isManagedName(name) };
  if (!opts.reveal) return entry;
  if (isNeverRevealed(name)) throw new Error(`${name} is managed by ember and is never revealed`);
  if (!opts.adminToken) throw new Error("--reveal reads the value through the deployed Worker: set EMBER_ADMIN_TOKEN (or pass --admin-token)");
  if (!opts.url) throw new Error(`--reveal: no URL known for ${t.worker} (pass --url)`);
  const res = await (opts.fetch ?? fetch)(new URL("/api/_ember/env/reveal", opts.url), {
    method: "POST",
    headers: { authorization: `Bearer ${opts.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; value?: string; error?: { code: string; message: string } };
  if (!res.ok || !body.ok || typeof body.value !== "string") throw new Error(`--reveal: ${body.error?.code ?? res.status}: ${body.error?.message ?? "failed"}`);
  return { ...entry, value: body.value };
}

/** Rewrites `environments.<env>.vars` in ember.json, keeping the rest of the file as it is. */
function writeVars(project: Project, env: string, vars: Record<string, string>) {
  const raw = JSON.parse(readFileSync(project.configPath, "utf8")) as { environments: Record<string, { vars?: Record<string, string> }> };
  const e = (raw.environments[env] ??= {});
  if (Object.keys(vars).length) e.vars = Object.fromEntries(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)));
  else delete e.vars;
  writeFileSync(project.configPath, JSON.stringify(raw, null, 2) + "\n");
  project.config.environments[env] = { ...project.config.environments[env], ...(e.vars ? { vars: e.vars } : {}) };
  if (!e.vars) delete project.config.environments[env]!.vars;
}

// ------------------------------------------------------------------------------------------------ input

/** Reads a secret value: piped stdin, or a hidden prompt on a TTY. Never echoes it. */
export async function readSecretValue(name: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of input) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    // One trailing newline is from `echo` / heredocs, not part of the value.
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  output.write(`Value for ${name} (hidden): `);
  input.setRawMode?.(true);
  input.resume();
  input.setEncoding("utf8");
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      input.setRawMode?.(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
  });
}
