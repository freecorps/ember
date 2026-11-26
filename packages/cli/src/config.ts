// `ember.json` (PLAN §21): one project per file, N environments, resources named `ember-<project>-<env>`.

import { createHash } from "node:crypto";
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
  /**
   * With `from`: ask the origin whether a JWT's session (`sid`) is still alive before `sensitive` functions run
   * (PLAN §22 L14; without it they are refused for JWTs of `from`). Ember POSTs a signed `{ sid, sub }` to `url`; the
   * shared secret is the Worker secret `secretEnv` (default SESSION_LOOKUP_SECRET, `ember env set`; `.dev.vars` in
   * `ember dev`). The origin checks it with `@freecorps/ember-auth/session-lookup`.
   */
  sessionLookup?: SessionLookupConfig;
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

export interface SessionLookupConfig {
  /** The origin's lookup endpoint (https; http only for localhost). */
  url: string;
  /** Worker secret with the shared secret. Default SESSION_LOOKUP_SECRET. */
  secretEnv?: string;
  /** Longest wait for the origin before refusing (fail closed). Default 2000 ms. */
  timeoutMs?: number;
  /** Reuse an `active` answer this long. Default 0 (every sensitive call asks). */
  cacheMs?: number;
}

/** Default Worker secret of `auth.sessionLookup`. */
export const SESSION_LOOKUP_SECRET_DEFAULT = "SESSION_LOOKUP_SECRET";

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
  /** Overrides the project's `limits` (merged key by key). */
  limits?: WorkerLimits;
  /** Overrides the project's `placement`. */
  placement?: WorkerPlacement;
}

/**
 * Worker limits (ember.json `limits`). `cpuMs`: CPU time one invocation of the Worker may use, in ms (Cloudflare's
 * `limits.cpu_ms`; 10–300000 on the paid plan, whose default is 30000). Durable Objects have their own CPU limit per
 * request; this one bounds the Worker (HTTP routing, actions). Absent: not managed (whatever the Worker has stays).
 */
export interface WorkerLimits {
  cpuMs?: number;
}

/**
 * `"smart"`: Smart Placement (Cloudflare runs the Worker near the back ends it talks to: its Durable Objects, the
 * APIs actions call). Absent: not managed (the Worker keeps whatever placement it has).
 */
export type WorkerPlacement = "smart";

/** Bounds of `limits.cpuMs` (Cloudflare Workers, paid plan). */
export const CPU_MS_MIN = 10;
export const CPU_MS_MAX = 300_000;

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
   * Workers Logs of the deployed Worker. Default `true`: on, every invocation (billed per log line past the plan's
   * allowance). `false`: off. `{ enabled?, head_sampling_rate? }`: on unless `enabled: false`, keeping the fraction
   * `head_sampling_rate` (0..1, default 1) of invocations' logs.
   */
  observability?: boolean | { enabled?: boolean; head_sampling_rate?: number };
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
   * closures included: about 20% of a hot shard's CPU per mutation, so it is off unless asked for. `lazyActions`
   * (default true): modules that export only actions are imported on first use (a chunk of their own, out of every
   * Shard DO's startup); `false` imports every module statically.
   */
  build?: { keepNames?: boolean; lazyActions?: boolean };
  /** Worker limits (`cpuMs`), applied by `ember deploy`; environments may override them. */
  limits?: WorkerLimits;
  /** `"smart"`: Smart Placement, applied by `ember deploy`; environments may override it. */
  placement?: WorkerPlacement;
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
  if (c.observability !== undefined && typeof c.observability !== "boolean") {
    const o = c.observability as Record<string, unknown>;
    if (!o || typeof o !== "object" || Array.isArray(o)) fail(`"observability" must be a boolean or an object { enabled?, head_sampling_rate? }`);
    for (const k of Object.keys(o)) if (k !== "enabled" && k !== "head_sampling_rate") fail(`"observability.${k}" is unknown (enabled, head_sampling_rate)`);
    if (o.enabled !== undefined && typeof o.enabled !== "boolean") fail(`"observability.enabled" must be a boolean`);
    if (o.head_sampling_rate !== undefined && (typeof o.head_sampling_rate !== "number" || !(o.head_sampling_rate >= 0 && o.head_sampling_rate <= 1)))
      fail(`"observability.head_sampling_rate" must be a number in [0, 1]`);
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
      if (k !== "keepNames" && k !== "lazyActions") fail(`"build.${k}" is unknown (keepNames, lazyActions)`);
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
    if (o.sessionLookup !== undefined) {
      const l = o.sessionLookup as Record<string, unknown>;
      if (!l || typeof l !== "object" || Array.isArray(l)) fail(`${at}.sessionLookup must be an object { url, secretEnv?, timeoutMs?, cacheMs? }`);
      if (typeof l.url !== "string" || !/^(https:\/\/[^/\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/\S*)?$/.test(l.url)) fail(`${at}.sessionLookup.url must be an https URL (http only for localhost)`);
      if (l.secretEnv !== undefined && (typeof l.secretEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(l.secretEnv) || /^EMBER_/.test(l.secretEnv)))
        fail(`${at}.sessionLookup.secretEnv must be an env var name (not EMBER_*: those are managed by ember)`);
      for (const k of ["timeoutMs", "cacheMs"] as const) {
        if (l[k] !== undefined && (typeof l[k] !== "number" || !Number.isInteger(l[k]) || (l[k] as number) < (k === "timeoutMs" ? 1 : 0) || (l[k] as number) > 60_000))
          fail(`${at}.sessionLookup.${k} must be an integer number of milliseconds (${k === "timeoutMs" ? 1 : 0}-60000)`);
      }
      const extra = Object.keys(l).filter((k) => !["url", "secretEnv", "timeoutMs", "cacheMs"].includes(k));
      if (extra.length) fail(`${at}.sessionLookup: unknown key ${extra[0]}`);
    }
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
  const checkLimits = (l: unknown, at: string) => {
    if (l === undefined) return;
    if (!l || typeof l !== "object" || Array.isArray(l)) fail(`${at} must be an object { cpuMs? }`);
    const o = l as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== "cpuMs") fail(`${at}.${k} is unknown (cpuMs)`);
    if (o.cpuMs !== undefined && (typeof o.cpuMs !== "number" || !Number.isInteger(o.cpuMs) || o.cpuMs < CPU_MS_MIN || o.cpuMs > CPU_MS_MAX))
      fail(`${at}.cpuMs must be an integer number of milliseconds (${CPU_MS_MIN}-${CPU_MS_MAX})`);
  };
  const checkPlacement = (p: unknown, at: string) => {
    if (p !== undefined && p !== "smart") fail(`${at} must be "smart" (Smart Placement) or absent`);
  };
  checkLimits(c.limits, `"limits"`);
  checkPlacement(c.placement, `"placement"`);
  for (const [name, e] of Object.entries(envs as object)) {
    if (!NAME.test(name)) fail(`environment "${name}" must match ${NAME}`);
    if (!e || typeof e !== "object") fail(`environment "${name}" must be an object`);
    checkAuth((e as EnvironmentConfig).auth, `environments.${name}.auth`);
    checkLimits((e as EnvironmentConfig).limits, `environments.${name}.limits`);
    checkPlacement((e as EnvironmentConfig).placement, `environments.${name}.placement`);
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
  const config = envConfig(project, name);
  if (!config) {
    const hint = name.startsWith(PREVIEW_PREFIX) && !envs[PREVIEW_BASE] ? ` (preview environments derive from "environments.${PREVIEW_BASE}", which ember.json does not declare)` : "";
    throw new ConfigError(`Unknown environment "${name}". Known: ${Object.keys(envs).join(", ")}${hint}`);
  }
  return { name, config };
}

/**
 * Ephemeral preview environments (`ember deploy --preview <branch>`): `preview-<slug>`, never declared in ember.json,
 * derived from `environments.preview` (vars, account, auth overrides but its `url`, limits, placement). Every resource
 * name derives from the environment (`ember-<project>-preview-<slug>`: the Worker, its Durable Objects, R2 bucket,
 * queues, indexes), so a preview shares nothing with prod.
 */
export const PREVIEW_BASE = "preview";
export const PREVIEW_PREFIX = "preview-";

/**
 * The environment `--preview <branch>` deploys: `preview-<slug>`, the slug being the branch lowercased with every run
 * of other characters turned into one `-`. A slug longer than fits (the environment name is at most 40 characters and
 * the Worker name `ember-<project>-preview-<slug>` at most 63) is cut and ends in 6 hex characters of the branch's
 * sha256, so two long branches with a common prefix stay apart. The same branch always gives the same name.
 */
export function previewEnvName(project: string, branch: string): string {
  const raw = branch.trim();
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new ConfigError(`--preview: ${JSON.stringify(branch)} has no letters or digits to name an environment after`);
  const max = Math.min(40 - PREVIEW_PREFIX.length, 63 - workerName(project, PREVIEW_PREFIX).length);
  if (slug.length <= max) return `${PREVIEW_PREFIX}${slug}`;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 6);
  return `${PREVIEW_PREFIX}${slug.slice(0, max - 7).replace(/-+$/, "")}-${hash}`;
}

/** Whether `name` is a preview environment derived from `environments.preview` (not declared in ember.json). */
export function isDerivedPreview(project: Project, name: string): boolean {
  const envs = project.config.environments;
  return !Object.hasOwn(envs, name) && name.startsWith(PREVIEW_PREFIX) && name.length > PREVIEW_PREFIX.length && NAME.test(name) && !!envs[PREVIEW_BASE];
}

/** An environment's config: declared in ember.json, or derived from `environments.preview` (`preview-<slug>`). */
export function envConfig(project: Project, name: string): EnvironmentConfig | undefined {
  const envs = project.config.environments;
  if (Object.hasOwn(envs, name)) return envs[name];
  return isDerivedPreview(project, name) ? envs[PREVIEW_BASE] : undefined;
}

/**
 * Project `auth` merged with the environment's overrides. A derived preview environment drops `url`: the issuer of
 * one branch's Worker is its own workers.dev address, never the URL the base environment names.
 */
export function authSettings(project: Project, env?: string): AuthSettings {
  const base = project.config.auth ?? {};
  const over = env ? (envConfig(project, env)?.auth ?? {}) : {};
  const merged: AuthSettings = { ...base, ...over };
  if (env && isDerivedPreview(project, env)) delete merged.url;
  return merged;
}

/** Cloudflare settings `ember deploy` manages for an environment (the environment's values over the project's). */
export function workerSettings(project: Project, env: string): { limits?: WorkerLimits; placement?: WorkerPlacement } {
  const e = envConfig(project, env);
  const limits = { ...(project.config.limits ?? {}), ...(e?.limits ?? {}) };
  const placement = e?.placement ?? project.config.placement;
  return { ...(limits.cpuMs !== undefined ? { limits } : {}), ...(placement ? { placement } : {}) };
}

/** Sets one top-level key of ember.json, keeping the user's key order and the rest of the file as parsed. */
export function writeConfigKey<K extends keyof EmberConfigFile>(project: Project, key: K, value: EmberConfigFile[K]): void {
  const raw = JSON.parse(readFileSync(project.configPath, "utf8")) as Record<string, unknown>;
  raw[key] = value;
  writeFileSync(project.configPath, JSON.stringify(raw, null, 2) + "\n");
  project.config[key] = value;
}
