// `ember.json` (PLAN §21): one project per file, N environments, resources named `ember-<project>-<env>`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * `auth` in ember.json (PLAN §9, §21). With `ember/auth.config.ts` the project runs its own `Auth` DO; with `from` it
 * trusts another Ember project's JWTs (SSO through its JWKS) and has no `Auth` DO.
 */
export interface AuthSettings {
  /**
   * SSO: the identity project, as its public URL (its Worker serves `<from>/api/auth/jwks`) or as its name in the
   * account registry (`"<project>"` or `"<project>/<env>"`; `ember deploy` resolves it and records the link).
   */
  from?: string;
  /** Public URL of this deployment (JWT issuer, Better Auth `baseURL`). Default: the workers.dev URL. */
  url?: string;
  /** Shard that receives `internal.users.sync` (profile sync outbox). Default "global:main". */
  syncShard?: string;
  /**
   * Turnstile captcha on sign-up, sign-in and password reset (Better Auth's captcha plugin, checked in the Worker
   * before any password work). The secret is the Worker secret TURNSTILE_SECRET_KEY (`ember env set`; `.dev.vars`
   * in `ember dev`); clients send the widget token in `x-captcha-response`.
   */
  turnstile?: boolean | TurnstileConfig;
}

export interface TurnstileConfig {
  /** Auth paths that need a token (default `/sign-up/email`, `/sign-in/email`, `/request-password-reset`). */
  endpoints?: string[];
  /** Reject tokens minted for another widget action. */
  expectedAction?: string;
  /** Reject tokens issued for other hostnames. */
  allowedHostnames?: string[];
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
  /**
   * Ember Dashboard (PLAN §21): `true` = `ember deploy` keeps this project linked to the account's dashboard (creates
   * it from a terminal, updates its bindings and this project's admin token); `false` = never. Absent: the first
   * `ember deploy` in a terminal asks and writes the answer here; CI and other non-terminals never ask.
   */
  dashboard?: boolean;
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
   * `ember-<project>-<env>-actions` (EMBER_ACTIONS); `browser`: Browser Rendering binding (EMBER_BROWSER, `ctx.browser`).
   */
  resources?: { files?: boolean; actions?: boolean; images?: boolean; browser?: boolean };
  auth?: AuthSettings;
  /**
   * Worker bundle. `keepNames` (default false): keep `Function.prototype.name` of renamed functions and classes
   * (esbuild `keepNames`), for code that reads it. It wraps every function the bundle creates, Ember's per-call
   * closures included: about 20% of a hot shard's CPU per mutation, so it is off unless asked for.
   */
  build?: { keepNames?: boolean };
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
  if (c.dashboard !== undefined && typeof c.dashboard !== "boolean") fail(`"dashboard" must be a boolean`);
  if (c.functionsDir !== undefined && typeof c.functionsDir !== "string") fail(`"functionsDir" must be a string`);
  if (c.resources !== undefined) {
    const r = c.resources as Record<string, unknown>;
    if (!r || typeof r !== "object" || Array.isArray(r)) fail(`"resources" must be an object`);
    for (const [k, x] of Object.entries(r)) {
      if (!["files", "actions", "images", "browser"].includes(k)) fail(`"resources.${k}" is unknown (files, actions, images, browser)`);
      if (typeof x !== "boolean") fail(`"resources.${k}" must be a boolean`);
    }
    // ctx.browser uses the binding's Quick Actions, available from this compatibility date.
    if (r.browser && typeof c.compatibilityDate === "string" && c.compatibilityDate < "2026-03-24") fail(`"resources.browser" needs "compatibilityDate" >= 2026-03-24 (Browser Rendering quick actions)`);
  }
  if (c.build !== undefined) {
    const b = c.build as Record<string, unknown>;
    if (!b || typeof b !== "object" || Array.isArray(b)) fail(`"build" must be an object`);
    for (const [k, x] of Object.entries(b)) {
      if (k !== "keepNames") fail(`"build.${k}" is unknown (keepNames)`);
      if (typeof x !== "boolean") fail(`"build.${k}" must be a boolean`);
    }
  }
  const envs = c.environments;
  if (!envs || typeof envs !== "object" || Array.isArray(envs) || !Object.keys(envs).length) fail(`"environments" must be a non-empty object`);
  const checkAuth = (a: unknown, at: string) => {
    if (a === undefined) return;
    if (!a || typeof a !== "object" || Array.isArray(a)) fail(`${at} must be an object`);
    const o = a as Record<string, unknown>;
    if (o.url !== undefined && (typeof o.url !== "string" || !/^https?:\/\/[^/]+/.test(o.url))) fail(`${at}.url must be an http(s) URL`);
    // SSO: the identity project's URL (a trailing slash or a path is fine: remoteAuth strips trailing slashes and
    // appends its basePath), or its name (`"<project>"` / `"<project>/<env>"`, resolved by `ember deploy`).
    if (o.from !== undefined && (typeof o.from !== "string" || !/^(https?:\/\/[^/\s]+(\/\S*)?|[a-z0-9][a-z0-9-]{0,62}(\/[a-z0-9][a-z0-9-]{0,62})?)$/.test(o.from)))
      fail(`${at}.from must be an http(s) URL, "<project>" or "<project>/<env>"`);
    if (o.syncShard !== undefined && (typeof o.syncShard !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}:\S{1,190}$/.test(o.syncShard)))
      fail(`${at}.syncShard must be a shard name <kind>:<key>`);
    if (o.turnstile !== undefined && typeof o.turnstile !== "boolean") {
      const t = o.turnstile as Record<string, unknown>;
      if (!t || typeof t !== "object" || Array.isArray(t)) fail(`${at}.turnstile must be true, false or an object`);
      const strings = (x: unknown) => Array.isArray(x) && x.every((y) => typeof y === "string" && y.length > 0);
      if (t.endpoints !== undefined && (!strings(t.endpoints) || !(t.endpoints as string[]).every((e) => e.startsWith("/")))) fail(`${at}.turnstile.endpoints must be paths like "/sign-in/email"`);
      if (t.allowedHostnames !== undefined && !strings(t.allowedHostnames)) fail(`${at}.turnstile.allowedHostnames must be a string array`);
      if (t.expectedAction !== undefined && (typeof t.expectedAction !== "string" || !t.expectedAction)) fail(`${at}.turnstile.expectedAction must be a string`);
      const extra = Object.keys(t).filter((k) => !["endpoints", "allowedHostnames", "expectedAction"].includes(k));
      if (extra.length) fail(`${at}.turnstile: unknown key ${extra[0]}`);
    }
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

/** Sets one top-level key of ember.json, keeping the user's key order and the rest of the file as parsed. */
export function writeConfigKey<K extends keyof EmberConfigFile>(project: Project, key: K, value: EmberConfigFile[K]): void {
  const raw = JSON.parse(readFileSync(project.configPath, "utf8")) as Record<string, unknown>;
  raw[key] = value;
  writeFileSync(project.configPath, JSON.stringify(raw, null, 2) + "\n");
  project.config[key] = value;
}
