// Account registry (PLAN §21): D1 database `ember-registry` in the user's account, created idempotently by the first
// `ember deploy` / `ember dashboard deploy`. The CLI talks to it over the D1 REST API; project Workers write the shard
// catalog through an EMBER_REGISTRY binding (runtime metrics.ts) and the dashboard reads it through its own binding.
//
// Ownership: each repository's ember.json carries a random `fingerprint` (written by the first deploy). A project name
// belongs to the first fingerprint that registered it; deploys from another repo with the same name are refused, as
// are Worker-name collisions (`ember-a-b` + env `c` vs `ember-a` + env `b-c`).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Project } from "./config.ts";
import { CloudflareApiError, type CfClient } from "./deploy/cf.ts";

export const DEFAULT_REGISTRY_NAME = "ember-registry";

/** `--registry` flag, else EMBER_REGISTRY_NAME, else `ember-registry`. */
export const registryName = (flag?: string, env: NodeJS.ProcessEnv = process.env) => flag ?? env.EMBER_REGISTRY_NAME ?? DEFAULT_REGISTRY_NAME;

/** Same statement as `SHARDS_TABLE_DDL` in @ember/runtime metrics.ts (redeclared: the CLI cannot import workerd code). */
export const SHARDS_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS shards (project TEXT NOT NULL, env TEXT NOT NULL, shard TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, " +
  "schema_version TEXT, db_size INTEGER NOT NULL DEFAULT 0, last_write INTEGER, reported_at INTEGER NOT NULL, PRIMARY KEY (project, env, shard))";

export const REGISTRY_DDL: string[] = [
  "CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, repo TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS environments (project TEXT NOT NULL, env TEXT NOT NULL, worker TEXT NOT NULL UNIQUE, url TEXT, schema_version TEXT, version_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, env))",
  "CREATE TABLE IF NOT EXISTS deployments (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, env TEXT NOT NULL, worker TEXT NOT NULL, version_id TEXT, schema_version TEXT, url TEXT, message TEXT, strategy TEXT, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS deployments_by_env ON deployments (project, env, at)",
  "CREATE TABLE IF NOT EXISTS domains (host TEXT PRIMARY KEY, project TEXT NOT NULL, env TEXT NOT NULL, worker TEXT NOT NULL, kind TEXT NOT NULL, zone_id TEXT, zone TEXT, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS inbound_addresses (address TEXT PRIMARY KEY, project TEXT NOT NULL, env TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS auth_links (project TEXT NOT NULL, env TEXT NOT NULL, identity_project TEXT, identity_url TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (project, env))",
  SHARDS_TABLE_DDL,
];

export class RegistryConflictError extends Error {
  override name = "RegistryConflictError";
}

export interface DeployRecord {
  project: string;
  env: string;
  worker: string;
  url: string | null;
  versionId: string | null;
  schemaVersion: string;
  message?: string;
  strategy?: string;
}

/** What `ember deploy` needs from the registry. */
export interface ProjectRegistry {
  /** D1 database id, bound into project Workers as EMBER_REGISTRY (shard catalog); null = no binding. */
  readonly databaseId: string | null;
  /** Refuses (RegistryConflictError) names owned by another repository; registers the project otherwise. */
  claim(info: { project: string; env: string; worker: string; fingerprint: string; repo?: string | null }): Promise<void>;
  recordDeploy(info: DeployRecord): Promise<void>;
}

export const noopRegistry: ProjectRegistry = { databaseId: null, claim: async () => {}, recordDeploy: async () => {} };

type Row = Record<string, unknown>;

/** Registry over the D1 REST API (`POST /d1/database/{id}/query`). */
export class D1Registry implements ProjectRegistry {
  private readonly client: CfClient;
  readonly name: string;
  readonly databaseId: string;
  /** True when this call created the database. */
  readonly created: boolean;
  private readonly now: () => number;

  private constructor(client: CfClient, name: string, databaseId: string, created: boolean, now: () => number) {
    this.client = client;
    this.name = name;
    this.databaseId = databaseId;
    this.created = created;
    this.now = now;
  }

  /** Finds the database by name (creating it when missing) and applies the DDL (idempotent). */
  static async open(client: CfClient, name = registryName(), opts: { create?: boolean; now?: () => number; log?: (l: string) => void } = {}): Promise<D1Registry> {
    let id = await findDatabase(client, name);
    let created = false;
    if (!id) {
      if (opts.create === false) throw new Error(`registry D1 database ${name} not found (run \`ember deploy\` first)`);
      try {
        id = (await client.call<{ uuid: string }>("POST", "/d1/database", { name })).uuid;
        created = true;
      } catch (e) {
        if (!(e instanceof CloudflareApiError && (e.status === 409 || /already exists/i.test(e.message)))) throw e;
        id = await findDatabase(client, name);
      }
      if (!id) throw new Error(`registry ${name}: could not be created or found`);
      opts.log?.(`  registry: created D1 database ${name}`);
    }
    const reg = new D1Registry(client, name, id, created, opts.now ?? Date.now);
    await reg.exec(REGISTRY_DDL.join(";\n"));
    return reg;
  }

  /** Runs one or more statements; returns the rows of the last one. */
  async exec(sql: string, ...params: unknown[]): Promise<Row[]> {
    const r = await this.client.call<Array<{ results?: Row[]; success: boolean }>>("POST", `/d1/database/${this.databaseId}/query`, { sql, params });
    return r?.[r.length - 1]?.results ?? [];
  }

  async claim(info: { project: string; env: string; worker: string; fingerprint: string; repo?: string | null }): Promise<void> {
    const now = this.now();
    const [owner] = await this.exec("SELECT fingerprint, repo FROM projects WHERE name = ?", info.project);
    if (owner && owner.fingerprint !== info.fingerprint) {
      throw new RegistryConflictError(
        `project "${info.project}" is already registered in this account by another repository` +
          `${owner.repo ? ` (${owner.repo})` : ""}. Rename "project" in ember.json, or — if this repo really owns it — set ` +
          `"fingerprint" in ember.json to the registered one (see \`ember projects ls\`).`,
      );
    }
    const [clash] = await this.exec("SELECT project, env FROM environments WHERE worker = ? AND NOT (project = ? AND env = ?)", info.worker, info.project, info.env);
    if (clash) throw new RegistryConflictError(`Worker name ${info.worker} is already used by project "${clash.project}" environment "${clash.env}"; rename the project or environment.`);
    if (!owner) await this.exec("INSERT INTO projects (name, fingerprint, repo, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING", info.project, info.fingerprint, info.repo ?? null, now, now);
    // A concurrent first deploy from another repo may have won the INSERT: re-check.
    if (!owner) {
      const [again] = await this.exec("SELECT fingerprint FROM projects WHERE name = ?", info.project);
      if (again && again.fingerprint !== info.fingerprint) throw new RegistryConflictError(`project "${info.project}" was just registered by another repository`);
    }
    await this.exec(
      "INSERT INTO environments (project, env, worker, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, env) DO UPDATE SET updated_at = excluded.updated_at",
      info.project, info.env, info.worker, now, now,
    );
  }

  async recordDeploy(d: DeployRecord): Promise<void> {
    const now = this.now();
    await this.exec(
      "INSERT INTO deployments (project, env, worker, version_id, schema_version, url, message, strategy, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      d.project, d.env, d.worker, d.versionId, d.schemaVersion, d.url, d.message ?? null, d.strategy ?? null, now,
    );
    await this.exec(
      "UPDATE environments SET url = COALESCE(?, url), schema_version = ?, version_id = ?, updated_at = ? WHERE project = ? AND env = ?",
      d.url, d.schemaVersion, d.versionId, now, d.project, d.env,
    );
    await this.exec("UPDATE projects SET updated_at = ? WHERE name = ?", now, d.project);
  }

  async projects(): Promise<Array<{ name: string; fingerprint: string; repo: string | null; envs: Array<{ env: string; worker: string; url: string | null; schemaVersion: string | null; updatedAt: number; lastDeploy: number | null }> }>> {
    const ps = await this.exec("SELECT name, fingerprint, repo FROM projects ORDER BY name");
    const es = await this.exec(
      "SELECT e.project, e.env, e.worker, e.url, e.schema_version, e.updated_at, (SELECT MAX(at) FROM deployments d WHERE d.project = e.project AND d.env = e.env) AS last_deploy FROM environments e ORDER BY e.project, e.env",
    );
    return ps.map((p) => ({
      name: String(p.name),
      fingerprint: String(p.fingerprint),
      repo: (p.repo as string | null) ?? null,
      envs: es
        .filter((e) => e.project === p.name)
        .map((e) => ({
          env: String(e.env),
          worker: String(e.worker),
          url: (e.url as string | null) ?? null,
          schemaVersion: (e.schema_version as string | null) ?? null,
          updatedAt: Number(e.updated_at),
          lastDeploy: e.last_deploy === null ? null : Number(e.last_deploy),
        })),
    }));
  }

  async domains(): Promise<Row[]> {
    return this.exec("SELECT * FROM domains ORDER BY host");
  }

  async addDomain(d: { host: string; project: string; env: string; worker: string; kind: "custom_domain" | "route"; zoneId: string; zone: string }): Promise<void> {
    const [owner] = await this.exec("SELECT project, env FROM domains WHERE host = ?", d.host);
    if (owner && (owner.project !== d.project || owner.env !== d.env)) throw new RegistryConflictError(`${d.host} is registered to ${owner.project}/${owner.env}`);
    await this.exec(
      "INSERT INTO domains (host, project, env, worker, kind, zone_id, zone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (host) DO UPDATE SET worker = excluded.worker, kind = excluded.kind",
      d.host, d.project, d.env, d.worker, d.kind, d.zoneId, d.zone, this.now(),
    );
  }
}

export async function findDatabase(client: CfClient, name: string): Promise<string | null> {
  const list = await client.call<Array<{ uuid: string; name: string }>>("GET", `/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
  return (list ?? []).find((d) => d.name === name)?.uuid ?? null;
}

/** The project's fingerprint from ember.json, generating and saving one (first deploy) when missing. */
export function ensureFingerprint(project: Project, opts: { write?: boolean } = {}): string {
  if (project.config.fingerprint) return project.config.fingerprint;
  const fp = randomUUID();
  if (opts.write !== false && existsSync(project.configPath)) {
    // Keep the user's key order; append the fingerprint.
    const raw = JSON.parse(readFileSync(project.configPath, "utf8")) as Record<string, unknown>;
    raw.fingerprint = fp;
    writeFileSync(project.configPath, JSON.stringify(raw, null, 2) + "\n");
  }
  project.config.fingerprint = fp;
  return fp;
}

/** `git remote get-url origin` (informational: shown when another repo tries to take the name). */
export function gitRemote(cwd: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim();
    // Never store credentials embedded in a remote URL.
    return url.replace(/\/\/[^@/]+@/, "//") || null;
  } catch {
    return null;
  }
}
