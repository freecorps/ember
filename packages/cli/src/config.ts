// `ember.json` (PLAN §21): one project per file, N environments, resources named `ember-<project>-<env>`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * `auth` in ember.json (PLAN §9, §21). With `ember/auth.config.ts` the project runs its own `Auth` DO; with `from` it
 * trusts another Ember project's JWTs (SSO through its JWKS) and has no `Auth` DO.
 */
export interface AuthSettings {
  /** SSO: public URL of the identity project (its Worker serves `<from>/api/auth/jwks`). */
  from?: string;
  /** Public URL of this deployment (JWT issuer, Better Auth `baseURL`). Default: the workers.dev URL. */
  url?: string;
  /** Shard that receives `internal.users.sync` (profile sync outbox). Default "global:main". */
  syncShard?: string;
}

export interface EnvironmentConfig {
  /** Overrides the project's Cloudflare account. */
  account?: string;
  /** Plain-text vars bound into the Worker. */
  vars?: Record<string, string>;
  /** Per-environment overrides of the project's `auth` (e.g. a custom domain as `url`). */
  auth?: AuthSettings;
}

export interface EmberConfigFile {
  project: string;
  /**
   * Random id of this repository's project, written by the first `ember deploy`. The account registry refuses a
   * project name already registered with another fingerprint (PLAN §21).
   */
  fingerprint?: string;
  /**
   * Execution metrics (Analytics Engine, PLAN §14). Default: on, dataset `ember_metrics` (one per account), every
   * execution recorded. `sample` (0..1) keeps that fraction of successful executions; errors are always kept.
   */
  metrics?: { enabled?: boolean; dataset?: string; sample?: number };
  account?: string;
  /** Functions directory, relative to ember.json (default "ember"). */
  functionsDir?: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  /** DO location hint for new shards (passed to the Worker as EMBER_LOCATION_HINT). */
  locationHint?: string;
  environments: Record<string, EnvironmentConfig>;
  /**
   * Optional bindings. `files`: R2 bucket `ember-<project>-<env>` (EMBER_FILES) + queue `-files` + event
   * notifications, provisioned by `ember deploy`; `images`: Images binding (EMBER_IMAGES); `actions`: queue
   * `ember-<project>-<env>-actions` (EMBER_ACTIONS).
   */
  resources?: { files?: boolean; actions?: boolean; images?: boolean };
  auth?: AuthSettings;
}

export interface Project {
  root: string;
  configPath: string;
  config: EmberConfigFile;
  /** Absolute path of the functions directory (`ember/`). */
  dir: string;
  /** `ember/_generated`. */
  generatedDir: string;
  /** `.ember/` (local state: builds, dev persistence). */
  stateDir: string;
}

export const CONFIG_FILE = "ember.json";
export const DEFAULT_COMPATIBILITY_DATE = "2026-10-01";
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function validateConfig(raw: unknown, where = CONFIG_FILE): EmberConfigFile {
  const fail = (msg: string): never => {
    throw new ConfigError(`${where}: ${msg}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("expected a JSON object");
  const c = raw as Record<string, unknown>;
  if (typeof c.project !== "string" || !NAME.test(c.project)) fail(`"project" must match ${NAME} (lowercase, digits, -)`);
  if (c.account !== undefined && typeof c.account !== "string") fail(`"account" must be a string`);
  if (typeof c.compatibilityDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.compatibilityDate)) fail(`"compatibilityDate" must be YYYY-MM-DD`);
  if (c.compatibilityFlags !== undefined && (!Array.isArray(c.compatibilityFlags) || c.compatibilityFlags.some((f) => typeof f !== "string")))
    fail(`"compatibilityFlags" must be a string array`);
  if (c.locationHint !== undefined && typeof c.locationHint !== "string") fail(`"locationHint" must be a string`);
  if (c.fingerprint !== undefined && (typeof c.fingerprint !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(c.fingerprint))) fail(`"fingerprint" must be 8–64 letters, digits or -`);
  if (c.metrics !== undefined) {
    const m = c.metrics as Record<string, unknown>;
    if (!m || typeof m !== "object" || Array.isArray(m)) fail(`"metrics" must be an object`);
    if (m.enabled !== undefined && typeof m.enabled !== "boolean") fail(`"metrics.enabled" must be a boolean`);
    if (m.dataset !== undefined && (typeof m.dataset !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(m.dataset))) fail(`"metrics.dataset" must be an identifier`);
    if (m.sample !== undefined && (typeof m.sample !== "number" || !(m.sample >= 0 && m.sample <= 1))) fail(`"metrics.sample" must be a number in [0, 1]`);
  }
  if (c.functionsDir !== undefined && typeof c.functionsDir !== "string") fail(`"functionsDir" must be a string`);
  const envs = c.environments;
  if (!envs || typeof envs !== "object" || Array.isArray(envs) || !Object.keys(envs).length) fail(`"environments" must be a non-empty object`);
  const checkAuth = (a: unknown, at: string) => {
    if (a === undefined) return;
    if (!a || typeof a !== "object" || Array.isArray(a)) fail(`${at} must be an object`);
    const o = a as Record<string, unknown>;
    for (const k of ["from", "url"] as const) {
      if (o[k] === undefined) continue;
      if (typeof o[k] !== "string" || !/^https?:\/\/[^/]+/.test(o[k] as string)) fail(`${at}.${k} must be an http(s) URL`);
    }
    if (o.syncShard !== undefined && (typeof o.syncShard !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}:\S{1,190}$/.test(o.syncShard)))
      fail(`${at}.syncShard must be a shard name <kind>:<key>`);
  };
  checkAuth(c.auth, `"auth"`);
  for (const [name, e] of Object.entries(envs as object)) {
    if (!NAME.test(name)) fail(`environment "${name}" must match ${NAME}`);
    if (!e || typeof e !== "object") fail(`environment "${name}" must be an object`);
    checkAuth((e as EnvironmentConfig).auth, `environments.${name}.auth`);
  }
  const worker = workerName(c.project as string, Object.keys(envs as object).sort((a, b) => b.length - a.length)[0]!);
  if (worker.length > 63) fail(`project + environment names are too long for a Worker name (${worker})`);
  return c as unknown as EmberConfigFile;
}

/** Finds `ember.json` from `cwd` upwards. */
export function findProjectRoot(cwd = process.cwd()): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function loadProject(cwd = process.cwd()): Project {
  const root = findProjectRoot(cwd);
  if (!root) throw new ConfigError(`No ${CONFIG_FILE} found in ${cwd} or its parents. Run \`ember init\` first.`);
  const configPath = join(root, CONFIG_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new ConfigError(`${configPath}: invalid JSON (${(e as Error).message})`);
  }
  const config = validateConfig(raw, configPath);
  return projectFrom(root, config);
}

export function projectFrom(root: string, config: EmberConfigFile): Project {
  const dir = join(root, config.functionsDir ?? "ember");
  return { root, configPath: join(root, CONFIG_FILE), config, dir, generatedDir: join(dir, "_generated"), stateDir: join(root, ".ember") };
}

/** `ember-<project>-<env>`: the Worker (and prefix for R2/D1/Queues) of one environment. */
export function workerName(project: string, env: string): string {
  return `ember-${project}-${env}`;
}

export function resolveEnv(project: Project, env: string | undefined): { name: string; config: EnvironmentConfig } {
  const envs = project.config.environments;
  const name = env ?? (envs.prod ? "prod" : Object.keys(envs)[0]!);
  const config = envs[name];
  if (!config) throw new ConfigError(`Unknown environment "${name}". Known: ${Object.keys(envs).join(", ")}`);
  return { name, config };
}

/** Project `auth` merged with the environment's overrides. */
export function authSettings(project: Project, env?: string): AuthSettings {
  const base = project.config.auth ?? {};
  const over = env ? (project.config.environments[env]?.auth ?? {}) : {};
  return { ...base, ...over };
}
