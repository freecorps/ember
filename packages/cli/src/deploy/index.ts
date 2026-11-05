// `ember deploy [--env] [--gradual N] [--dry-run]`.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorker, type WorkerBuild } from "../build.ts";
import { codegen } from "../codegen/index.ts";
import { authSettings, resolveEnv, workerName, type Project } from "../config.ts";
import { CfClient, CloudflareApiError, resolveToken } from "./cf.ts";
import { createR2Credentials, ensureFilesResources, filesBucketName, filesQueueName, wireFilesQueue, type FilesState } from "./files.ts";
import { componentQueues, deleteComponentQueues, ensureComponentQueues, loadComponentQueueState, queueBindings, saveComponentQueueState, wireComponentQueues } from "./queues.ts";
import { buildMetadata, componentBindings, DEFAULT_METRICS_DATASET, NEW_VERSION, planDeploy, type MetadataInput, redactMetadata, type CurrentState, type DeployPlan, type WorkerMetadata } from "./plan.ts";
import { waitForShards, type WaitOptions } from "./wait.ts";
import { ensureAiResources, namespaceWarnings, planAiResources, pruneAiResources, wireIndexingQueue, type AiResources, type AiState, type SchemaManifestLike } from "./ai.ts";
import { D1Registry, ensureFingerprint, gitRemote, noopRegistry, registryName, type ProjectRegistry } from "../registry.ts";
import { parseAuthFrom, resolveAuthFrom, withAuthFrom, type SsoRegistry } from "../sso.ts";

export * from "./plan.ts";
export { waitForShards, MigrationRefusedError, type WaitOptions, type ShardStatus } from "./wait.ts";
export { CfClient, CloudflareApiError, resolveToken } from "./cf.ts";
export * from "./files.ts";
export * from "./ai.ts";

export { D1Registry, noopRegistry, RegistryConflictError, type ProjectRegistry } from "../registry.ts";

export interface DeployOptions {
  env?: string;
  dryRun?: boolean;
  gradual?: number;
  message?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  token?: string;
  accountId?: string;
  /**
   * Account registry. Default: the D1 database `registryName` (created when missing); `false` skips it (no
   * ownership check, no EMBER_REGISTRY binding).
   */
  registry?: ProjectRegistry | false;
  /** Registry database name (default EMBER_REGISTRY_NAME or `ember-registry`). */
  registryName?: string;
  log?: (line: string) => void;
  /** Skip codegen + bundling (tests). `schema`: the manifest (external indexes); default none. */
  prebuilt?: { build: WorkerBuild; hasCrons: boolean; schemaVersion: string; schema?: SchemaManifestLike };
  sleep?: (ms: number) => Promise<void>;
  /**
   * Admin token: uploaded as the `EMBER_ADMIN_TOKEN` secret (enables `GET /api/_ember/status`) and used by
   * `wait`. Default: the `EMBER_ADMIN_TOKEN` environment variable.
   */
  adminToken?: string;
  /** After deploying, poll the status of `global:main` + `shards` until migrated; throws on a refused migration. */
  wait?: { shards?: string[]; timeoutMs?: number; intervalMs?: number; url?: string } | boolean;
  /** How long the JWKS step waits for `<url>/api/auth/jwks` to answer after a deploy (default 90 s). */
  jwksTimeoutMs?: number;
  /**
   * R2 S3 credentials for presigned file URLs (`resources.files`). Default: EMBER_R2_ACCESS_KEY_ID /
   * EMBER_R2_SECRET_ACCESS_KEY from the environment; else kept from the Worker; else a bucket-scoped API token is
   * created when the Cloudflare token allows it; else files run in proxy mode (through the Worker).
   */
  r2Credentials?: { accessKeyId: string; secretAccessKey: string };
}

export interface DeployResult {
  plan: DeployPlan;
  versionId: string | null;
  url: string | null;
  dryRun: boolean;
  /** Present with `wait`. */
  shards?: Awaited<ReturnType<typeof waitForShards>>;
  /** Local auth: what the deploy did with the auth secrets (names only, never values). */
  auth?: { url: string; generatedSecret: boolean; jwks: "embedded" | "kept" | "failed" | "skipped" };
  /** `resources.files`: where presigned credentials came from (never values) and the provisioned names. */
  files?: { bucket: string; queue: string; mode: "s3" | "proxy"; credentials: "provided" | "kept" | "created" | "none" };
  /** External indexes (PLAN §6): the resources the schema needs, and what this deploy created / deleted. */
  ai?: { resources: AiResources; created: string[]; deleted: string[] };
}

export function workerForm(metadata: WorkerMetadata, code: string): FormData {
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  fd.append(metadata.main_module, new Blob([code], { type: "application/javascript+module" }), metadata.main_module);
  return fd;
}

export async function fetchCurrentState(client: CfClient, worker: string): Promise<CurrentState> {
  const d = await client.request<{ deployments: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(
    "GET",
    `/workers/scripts/${worker}/deployments`,
  );
  if (d.status === 404 || d.errors.some((e) => e.code === 10007)) return { exists: false, provisionedClasses: [], activeVersions: [] };
  if (!d.success) throw new CloudflareApiError(`GET /workers/scripts/${worker}/deployments`, d.status, d.errors);
  const ns = await client.call<Array<{ script?: string; class?: string }>>("GET", "/workers/durable_objects/namespaces?per_page=1000");
  const provisionedClasses = (ns ?? []).filter((n) => n.script === worker && n.class).map((n) => n.class!);
  const secrets = await client.call<Array<{ name: string; type: string }>>("GET", `/workers/scripts/${worker}/secrets`);
  return {
    exists: true,
    provisionedClasses,
    activeVersions: d.result?.deployments?.[0]?.versions ?? [],
    secrets: (secrets ?? []).map((x) => x.name),
  };
}

export async function deploy(project: Project, opts: DeployOptions = {}): Promise<DeployResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const env = resolveEnv(project, opts.env);
  const c = project.config;
  const worker = workerName(c.project, env.name);

  // SSO by project name (sso.ts): resolve to the identity project's URL before building.
  const ssoName = parseAuthFrom(authSettings(project, env.name).from ?? "https://-");
  let ssoLink: { project: string; env: string; url: string } | null = null;
  if (ssoName) {
    if (opts.dryRun) project = withAuthFrom(project, env.name, `https://${ssoName.project}.resolved-from-registry.invalid`);
    else {
      const reg: SsoRegistry =
        opts.registry && opts.registry !== noopRegistry && "exec" in opts.registry
          ? (opts.registry as unknown as SsoRegistry)
          : await D1Registry.open(
              new CfClient({ accountId: opts.accountId ?? env.config.account ?? c.account ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "", token: opts.token ?? resolveToken(), ...(opts.fetch ? { fetch: opts.fetch } : {}) }),
              registryName(opts.registryName),
              { create: false },
            );
      ssoLink = await resolveAuthFrom(reg, ssoName, env.name);
      project = withAuthFrom(project, env.name, ssoLink.url);
      log(`  auth: SSO from ${ssoLink.project}/${ssoLink.env} → ${ssoLink.url} (registry)`);
    }
  }

  let prepared = opts.prebuilt;
  if (!prepared) {
    const gen = await codegen(project);
    for (const w of gen.warnings) log(`warning: ${w}`);
    const build = await buildWorker(project, { outDir: join(project.stateDir, "build", env.name), env: env.name });
    prepared = { build, hasCrons: gen.manifest.crons.length > 0, schemaVersion: gen.manifest.schema.version, schema: gen.manifest.schema as unknown as SchemaManifestLike };
  }
  const { build, hasCrons, schemaVersion } = prepared;
  // External indexes: resources derived from the schema; prune when this env had (or has) some.
  const ai = planAiResources(prepared.schema ?? { tables: {} }, c.project, env.name);
  const hasAi = ai.vectorize.length + ai.aiSearch.length > 0;
  const aiPrune = hasAi || loadAiState(project, env.name).length > 0;
  const adminToken = opts.adminToken ?? process.env.EMBER_ADMIN_TOKEN ?? undefined;
  const wait = opts.wait === true ? {} : opts.wait || undefined;
  if (wait && !adminToken && !opts.dryRun) throw new Error("--wait needs an admin token: set EMBER_ADMIN_TOKEN (or pass --admin-token).");
  const message = opts.message ?? `ember deploy (schema ${schemaVersion.slice(0, 12)})`;
  const localAuth = build.auth?.kind === "local";
  const authCfg = authSettings(project, env.name);
  const accountId = opts.accountId ?? env.config.account ?? c.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const filesOn = !!c.resources?.files;
  const metricsOn = c.metrics?.enabled !== false;
  const metrics = metricsOn
    ? { dataset: c.metrics?.dataset ?? process.env.EMBER_METRICS_DATASET ?? DEFAULT_METRICS_DATASET, ...(c.metrics?.sample !== undefined ? { sample: c.metrics.sample } : {}) }
    : undefined;
  // Bindings installed components asked for (PLAN §12), e.g. the rateLimit component's Rate Limiting binding.
  const compManifest = (prepared.schema as { components?: Parameters<typeof componentBindings>[0] & Parameters<typeof componentQueues>[0] } | undefined)?.components;
  // Queues owned by components (hooks): created before the upload, bound as producers, consumed by this Worker.
  const compQueues = componentQueues(compManifest, c.project, env.name);
  const staleQueues = loadComponentQueueState(project, env.name).filter((n) => !compQueues.some((q) => q.queue === n));
  const plainBindings = componentBindings(compManifest, c.project, env.name);
  const compBindings = [...plainBindings, ...queueBindings(compQueues, plainBindings)];
  const queuePlan = compQueues.length || staleQueues.length ? { componentQueues: { current: compQueues.map((q) => q.queue), stale: staleQueues } } : {};
  const filesNames = filesOn ? { bucket: filesBucketName(c.project, env.name), queue: filesQueueName(c.project, env.name) } : undefined;
  const metaInput = {
    ...(accountId ? { accountId } : {}),
    project: c.project,
    env: env.name,
    compatibilityDate: c.compatibilityDate,
    ...(c.compatibilityFlags ? { compatibilityFlags: c.compatibilityFlags } : {}),
    ...(c.locationHint ? { locationHint: c.locationHint } : {}),
    ...(env.config.vars ? { vars: env.config.vars } : {}),
    ...(c.resources ? { resources: c.resources } : {}),
    ...(adminToken ? { secrets: { EMBER_ADMIN_TOKEN: adminToken } } : {}),
    ...(localAuth ? { auth: true } : {}),
    ...(metrics ? { metrics } : {}),
    ...(hasAi ? { aiIndexes: ai } : {}),
    ...(compBindings.length ? { componentBindings: compBindings } : {}),
  } as Omit<MetadataInput, "provisionedClasses">;
  /**
   * Local auth (PLAN §9): EMBER_AUTH_SECRET is generated on the first deploy and then only kept (`keep_bindings`):
   * re-sending it would log everybody out. EMBER_AUTH_URL (issuer / baseURL) is a plain var sent every time.
   */
  const withAuth = (input: typeof metaInput, current: CurrentState, url: string) => {
    if (!localAuth) return { input, generated: false };
    const vars = { ...(input.vars ?? {}) };
    vars.EMBER_AUTH_URL ??= url;
    const secrets: Record<string, string> = { ...("secrets" in input ? input.secrets : {}) };
    const generated = !(current.secrets ?? []).includes("EMBER_AUTH_SECRET");
    if (generated) secrets.EMBER_AUTH_SECRET = randomBytes(32).toString("base64url");
    return { input: { ...input, vars, ...(Object.keys(secrets).length ? { secrets } : {}) }, generated };
  };

  /**
   * Files (PLAN §7): EMBER_STORAGE_SECRET (proxy download signatures) is generated once and kept; S3 credentials
   * enable presigned URLs (see `r2Credentials`). EMBER_PUBLIC_URL makes proxy URLs absolute.
   */
  type FilesCreds = NonNullable<DeployResult["files"]>["credentials"];
  const withFiles = async <T extends { vars?: Record<string, string>; secrets?: Record<string, string> }>(input: T, current: CurrentState, publicUrl: string | null, client: CfClient | null): Promise<{ input: T; credentials: FilesCreds }> => {
    if (!filesOn) return { input, credentials: "none" };
    const secrets: Record<string, string> = { ...(input.secrets ?? {}) };
    const vars = { ...(input.vars ?? {}) };
    if (publicUrl) vars.EMBER_PUBLIC_URL ??= publicUrl;
    const has = (n: string) => (current.secrets ?? []).includes(n);
    // Any generation counts (`ember keys rotate --files` adds EMBER_STORAGE_SECRET_R<n> and may drop generation 0).
    if (!(current.secrets ?? []).some((n) => /^EMBER_STORAGE_SECRET(_R\d+)?$/.test(n))) secrets.EMBER_STORAGE_SECRET = randomBytes(32).toString("base64url");
    let credentials: FilesCreds = "none";
    const envKey = process.env.EMBER_R2_ACCESS_KEY_ID;
    const envSecret = process.env.EMBER_R2_SECRET_ACCESS_KEY;
    let creds = opts.r2Credentials ?? (envKey && envSecret ? { accessKeyId: envKey, secretAccessKey: envSecret } : undefined);
    if (creds) credentials = "provided";
    else if (has("EMBER_R2_ACCESS_KEY_ID") && has("EMBER_R2_SECRET_ACCESS_KEY")) credentials = "kept";
    else if (client) {
      creds = (await createR2Credentials(client, filesNames!.bucket, worker)) ?? undefined;
      if (creds) credentials = "created";
    }
    if (creds) {
      secrets.EMBER_R2_ACCESS_KEY_ID = creds.accessKeyId;
      secrets.EMBER_R2_SECRET_ACCESS_KEY = creds.secretAccessKey;
    }
    return { input: { ...input, vars, ...(Object.keys(secrets).length ? { secrets } : {}) }, credentials };
  };

  if (opts.dryRun) {
    // No API calls: the plan assumes the Worker does not exist yet (the real run fetches the current state).
    const none: CurrentState = { exists: false, provisionedClasses: [], activeVersions: [], secrets: [] };
    const { input: authed } = withAuth(metaInput, none, authCfg.url ?? `https://${worker}.<subdomain>.workers.dev`);
    const { input } = await withFiles(authed, none, `https://${worker}.<subdomain>.workers.dev`, null);
    const { metadata, createdClasses } = buildMetadata({ ...input, provisionedClasses: [] });
    const plan = planDeploy({ worker, current: none, metadata, createdClasses, hasCrons, authJwks: localAuth, ...(filesNames ? { files: filesNames } : {}), ...(hasAi ? { ai } : {}), aiPrune, ...queuePlan, ...(opts.gradual !== undefined ? { gradual: opts.gradual } : {}) });
    printPlan(plan, build, log, true);
    return { plan, versionId: null, url: null, dryRun: true };
  }

  if (!accountId) throw new Error(`No Cloudflare account: set "account" in ember.json or CLOUDFLARE_ACCOUNT_ID.`);
  const client = new CfClient({
    accountId,
    token: opts.token ?? resolveToken(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });

  const registry = opts.registry === false ? noopRegistry : (opts.registry ?? (await D1Registry.open(client, registryName(opts.registryName), { log })));
  if (registry !== noopRegistry) await registry.claim({ project: c.project, env: env.name, worker, fingerprint: ensureFingerprint(project), repo: gitRemote(project.root) });
  if (registry.databaseId) metaInput.registryId = registry.databaseId;
  // Vectorize namespace headroom (PLAN §6): shards per kind from the catalog vs 50k namespaces per index.
  if (ai.vectorize.some((v) => v.shardIsolation === "namespace") && "exec" in registry) {
    try {
      const rows = await (registry as unknown as SsoRegistry).exec("SELECT kind, COUNT(*) AS n FROM shards WHERE project = ? AND env = ? GROUP BY kind", c.project, env.name);
      const tables = (prepared.schema as { tables: Record<string, { shard?: { name: string } }> } | undefined)?.tables ?? {};
      const kinds = Object.fromEntries(Object.entries(tables).map(([t, x]) => [t, x.shard?.name ?? "global"]));
      for (const w of namespaceWarnings(ai, kinds, Object.fromEntries(rows.map((r) => [String(r.kind), Number(r.n)])))) log(`  warning: ${w}`);
    } catch {
      // the catalog is advisory here
    }
  }

  const current = await fetchCurrentState(client, worker);
  let workersDev: string | null = null;
  const subdomain = async () => {
    const sub = await client.request<{ subdomain?: string }>("GET", "/workers/subdomain");
    return sub.success && sub.result?.subdomain ? `https://${worker}.${sub.result.subdomain}.workers.dev` : null;
  };
  let authUrl: string | null = null;
  if (localAuth) {
    authUrl = authCfg.url ?? (workersDev = await subdomain());
    if (!authUrl) throw new Error(`auth: no public URL for ${worker} (no workers.dev subdomain): set "auth": { "url": ... } in ember.json`);
    authUrl = authUrl.replace(/\/+$/, "");
  }
  const { input: authed, generated } = withAuth(metaInput, current, authUrl ?? "");
  if (filesOn && !workersDev) workersDev = await subdomain();
  const { input, credentials: filesCreds } = await withFiles(authed, current, workersDev, client);
  const authJwks = localAuth && !(current.secrets ?? []).includes("EMBER_AUTH_JWKS");
  const { metadata, createdClasses } = buildMetadata({ ...input, provisionedClasses: current.provisionedClasses });
  const plan = planDeploy({ worker, current, metadata, createdClasses, hasCrons, authJwks, ...(filesNames ? { files: filesNames } : {}), ...(hasAi ? { ai } : {}), aiPrune, ...queuePlan, ...(opts.gradual !== undefined ? { gradual: opts.gradual } : {}) });
  printPlan(plan, build, log, false);
  if (localAuth) log(`  auth: ${authUrl} (EMBER_AUTH_SECRET ${generated ? "generated now" : "kept from the previous deploy"})`);
  const filesMode: "s3" | "proxy" = filesCreds === "none" ? "proxy" : "s3";
  if (filesOn) {
    log(`  files: ${filesMode === "s3" ? `presigned R2 URLs (S3 credentials ${filesCreds})` : "proxy mode (no S3 credentials: set EMBER_R2_ACCESS_KEY_ID/EMBER_R2_SECRET_ACCESS_KEY for presigned URLs)"}`);
  }
  let filesState: FilesState | null = null;
  let aiState: AiState | null = null;
  let aiDeleted: string[] = [];
  let queueIds = new Map<string, string>();

  let versionId: string | null = null;
  let url: string | null = null;
  let jwks: NonNullable<DeployResult["auth"]>["jwks"] = localAuth ? "kept" : "skipped";
  for (const step of plan.steps) {
    switch (step.kind) {
      case "upload-script": {
        await client.call(step.method, step.path, workerForm(metadata, build.code));
        log(`  uploaded ${worker} (created ${createdClasses.join(", ") || "no classes"})`);
        break;
      }
      case "upload-version": {
        // Annotations are proven on version uploads (R2); the Script PUT path does not send them.
        const meta = { ...metadata, annotations: { "workers/message": message.slice(0, 100) } };
        const r = await client.call<{ id: string; number?: number }>(step.method, step.path, workerForm(meta, build.code));
        versionId = r.id;
        log(`  uploaded version ${r.id}${r.number !== undefined ? ` (#${r.number})` : ""}`);
        break;
      }
      case "deploy": {
        if (!versionId) throw new Error("internal: no version to deploy");
        const versions = step.versions.map((v) => ({ ...v, version_id: v.version_id === NEW_VERSION ? versionId! : v.version_id }));
        await client.call(step.method, step.path, { strategy: "percentage", versions, annotations: { "workers/message": message.slice(0, 100) } });
        log(`  deployed ${versions.map((v) => `${v.version_id.slice(0, 8)}@${v.percentage}%`).join(" + ")}`);
        break;
      }
      case "schedules":
        await client.call(step.method, step.path, step.body);
        log(`  cron triggers: ${step.body.map((s) => s.cron).join(", ") || "none"}`);
        // R15 (docs/spikes/remote/ops-e2e.md): a new Worker's trigger first fired ~11 min after it was set.
        if (step.body.length && plan.strategy === "create") log("  note: a new Worker's Cron Trigger can take ~10+ minutes to fire for the first time; crons.ts starts after that");
        break;
      case "subdomain": {
        await client.call(step.method, step.path, step.body);
        url = workersDev ?? (await subdomain());
        break;
      }
      case "auth-jwks": {
        const keys = await fetchJwks(`${authUrl}/api/auth/jwks`, opts.fetch ?? fetch, opts.jwksTimeoutMs ?? 90_000, opts.sleep);
        if (!keys) {
          jwks = "failed";
          log(`  warning: ${authUrl}/api/auth/jwks did not answer; EMBER_AUTH_JWKS not set (the next deploy retries; verify falls back to the Auth DO)`);
          break;
        }
        await client.call(step.method, step.path, { name: "EMBER_AUTH_JWKS", text: JSON.stringify(keys), type: "secret_text" });
        jwks = "embedded";
        log(`  auth: embedded the JWKS (${keys.keys.length} key${keys.keys.length === 1 ? "" : "s"}) as EMBER_AUTH_JWKS`);
        break;
      }
      case "files-resources":
        filesState = await ensureFilesResources(client, c.project, env.name, log);
        break;
      case "files-wire":
        if (!filesState) throw new Error("internal: files resources were not provisioned");
        await wireFilesQueue(client, worker, filesState, log);
        break;
      case "ai-resources":
        aiState = await ensureAiResources(client, ai, log);
        saveAiState(project, env.name, step.names);
        break;
      case "ai-wire":
        if (!aiState) throw new Error("internal: ai resources were not provisioned");
        await wireIndexingQueue(client, worker, aiState, log);
        break;
      case "ai-prune":
        // After the new version is live: never delete what the running code still binds.
        if (plan.steps.some((x) => x.kind === "deploy" && x.versions.length > 1)) {
          log("  ai indexes: prune skipped (gradual deployment: the previous version is still live; the next 100% deploy prunes)");
          break;
        }
        try {
          aiDeleted = await pruneAiResources(client, c.project, env.name, worker, hasAi ? ai : null, log);
          if (!hasAi) saveAiState(project, env.name, []);
        } catch (e) {
          log(`  warning: could not prune unused AI index resources (${(e as Error).message}); the next deploy retries`);
        }
        break;
      case "component-queues":
        queueIds = await ensureComponentQueues(client, compQueues, log);
        saveComponentQueueState(project, env.name, [...new Set([...loadComponentQueueState(project, env.name), ...step.queues])]);
        break;
      case "component-queues-wire":
        await wireComponentQueues(client, worker, compQueues, queueIds, log);
        break;
      case "component-queues-prune":
        if (plan.steps.some((x) => x.kind === "deploy" && x.versions.length > 1)) {
          log("  component queues: prune skipped (gradual deployment: the previous version still binds them)");
          break;
        }
        try {
          for (const d of await deleteComponentQueues(client, worker, step.queues, log)) log(`  deleted ${d}`);
          saveComponentQueueState(project, env.name, compQueues.map((q) => q.queue));
        } catch (e) {
          log(`  warning: could not delete unused component queues (${(e as Error).message}); the next deploy retries`);
        }
        break;
      case "registry":
        await registry.recordDeploy({ project: c.project, env: env.name, worker, url, versionId, schemaVersion, message, strategy: plan.strategy });
        if (ssoLink && "exec" in registry) {
          await (registry as unknown as SsoRegistry).exec(
            "INSERT INTO auth_links (project, env, identity_project, identity_url, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, env) DO UPDATE SET identity_project = excluded.identity_project, identity_url = excluded.identity_url",
            c.project, env.name, `${ssoLink.project}/${ssoLink.env}`, ssoLink.url, Date.now(),
          );
        }
        if (registry.databaseId) log(`  registry: recorded ${c.project}/${env.name}`);
        break;
    }
  }
  if (url) log(`\n${worker} → ${url}`);
  saveDeployment(project, env.name, { worker, url, versionId, at: new Date().toISOString() });
  if (wait) {
    const base = wait.url ?? url;
    if (!base) throw new Error("--wait: no deployment URL known (workers.dev disabled?); pass --url");
    log(`waiting for shards to migrate (schema ${schemaVersion.slice(0, 12)})...`);
    const w: WaitOptions = {
      url: base,
      adminToken: adminToken!,
      expectedVersion: schemaVersion,
      log,
      ...(wait.shards ? { shards: wait.shards } : {}),
      ...(wait.timeoutMs !== undefined ? { timeoutMs: wait.timeoutMs } : {}),
      ...(wait.intervalMs !== undefined ? { intervalMs: wait.intervalMs } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    };
    const shards = await waitForShards(w);
    return { plan, versionId, url, dryRun: false, shards, ...(localAuth ? { auth: { url: authUrl!, generatedSecret: generated, jwks } } : {}), ...(filesNames ? { files: { ...filesNames, mode: filesMode, credentials: filesCreds } } : {}), ...(aiPrune ? { ai: { resources: ai, created: aiState?.created ?? [], deleted: aiDeleted } } : {}) };
  }
  return { plan, versionId, url, dryRun: false, ...(localAuth ? { auth: { url: authUrl!, generatedSecret: generated, jwks } } : {}), ...(filesNames ? { files: { ...filesNames, mode: filesMode, credentials: filesCreds } } : {}), ...(aiPrune ? { ai: { resources: ai, created: aiState?.created ?? [], deleted: aiDeleted } } : {}) };
}

/** GET the Auth DO's JWKS through the public URL, retrying while a fresh workers.dev route propagates. */
async function fetchJwks(url: string, fetchImpl: typeof fetch, timeoutMs: number, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
  const end = Date.now() + timeoutMs;
  for (let i = 0; ; i++) {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (res.ok) {
        const body = (await res.json()) as { keys?: unknown };
        if (Array.isArray(body?.keys) && body.keys.length) return body as { keys: Array<Record<string, unknown>> };
      }
    } catch {
      // not reachable yet
    }
    if (Date.now() >= end) return null;
    await sleep(Math.min(5000, 500 * 2 ** i));
  }
}

function printPlan(plan: DeployPlan, build: WorkerBuild, log: (l: string) => void, dry: boolean) {
  log(`${dry ? "[dry run] " : ""}deploy ${plan.worker}: ${plan.strategy}${plan.createdClasses.length ? ` (new DO classes: ${plan.createdClasses.join(", ")})` : ""}`);
  log(`  bundle ${(build.bytes / 1024).toFixed(1)} KiB sha256 ${build.sha256.slice(0, 12)}`);
  for (const w of plan.warnings) log(`  warning: ${w}`);
  if (dry) {
    log(`  (dry run makes no API calls: it assumes a first deploy; a real run fetches the current deployment and DO namespaces)`);
    log(`  metadata: ${JSON.stringify(redactMetadata(plan.metadata), null, 2).split("\n").join("\n  ")}`);
    for (const s of plan.steps) {
      if (s.kind === "registry") log(`  - ${s.note}`);
      else if (s.kind === "files-resources") log(`  - ensure R2 bucket ${s.bucket} (CORS, lifecycle) and queue ${s.queue}`);
      else if (s.kind === "files-wire") log(`  - ${s.queue}: Worker consumer + R2 event notifications (f/, t/)`);
      else if (s.kind === "ai-resources") log(`  - ensure external index resources: ${s.names.join(", ")}`);
      else if (s.kind === "ai-wire") log(`  - ${s.queue}: Worker consumer (external index delivery)`);
      else if (s.kind === "ai-prune") log(`  - delete this env's Vectorize indexes / AI Search instances the schema no longer uses`);
      else if (s.kind === "component-queues") log(`  - ensure component queues: ${s.queues.join(", ")}`);
      else if (s.kind === "component-queues-wire") log(`  - component queues: Worker consumer (${s.queues.join(", ")})`);
      else if (s.kind === "component-queues-prune") log(`  - delete component queues no longer declared: ${s.queues.join(", ")}`);
      else log(`  - ${s.method} /accounts/:account${s.path}${"body" in s ? ` ${JSON.stringify(s.body)}` : ""}${"versions" in s ? ` ${JSON.stringify(s.versions)}` : ""}`);
    }
  }
}

export interface DeploymentRecord {
  worker: string;
  url: string | null;
  versionId: string | null;
  at: string;
}

const deploymentsFile = (project: Project) => join(project.stateDir, "deployments.json");
const aiStateFile = (project: Project) => join(project.stateDir, "ai-resources.json");

/** External index resources last provisioned per env (a hint for pruning after they leave the schema). */
export function loadAiState(project: Project, env: string): string[] {
  try {
    return (JSON.parse(readFileSync(aiStateFile(project), "utf8")) as Record<string, string[]>)[env] ?? [];
  } catch {
    return [];
  }
}

/** Forgets an env's external index resources (ember destroy). */
export function clearAiState(project: Project, env: string): void {
  saveAiState(project, env, []);
}

function saveAiState(project: Project, env: string, names: string[]) {
  mkdirSync(project.stateDir, { recursive: true });
  let all: Record<string, string[]> = {};
  try {
    all = JSON.parse(readFileSync(aiStateFile(project), "utf8"));
  } catch {
    // first time
  }
  if (names.length) all[env] = names;
  else delete all[env];
  writeFileSync(aiStateFile(project), JSON.stringify(all, null, 2) + "\n");
}

export function loadDeployments(project: Project): Record<string, DeploymentRecord> {
  const p = deploymentsFile(project);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function saveDeployment(project: Project, env: string, rec: DeploymentRecord) {
  mkdirSync(project.stateDir, { recursive: true });
  const all = loadDeployments(project);
  all[env] = rec;
  writeFileSync(deploymentsFile(project), JSON.stringify(all, null, 2) + "\n");
}
