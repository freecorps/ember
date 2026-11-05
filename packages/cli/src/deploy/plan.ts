// Pure deploy planning: metadata (bindings + full `exports` map) and the upload strategy.
//
// Evidence (docs/spikes/remote/RESULTS.md):
// - R1: one multipart PUT with `exports` creates SQLite DO classes and their bindings; `exports` and `migrations`
//   are mutually exclusive (100400); every provisioned class must stay declared (100402).
// - R2: versions must not carry `migrations` (10211); a gradual (multi-version) deployment needs identical
//   `exports` in every version (100405); a version that changes `exports` deploys fine at 100%.

import { createHash } from "node:crypto";
import { doClasses } from "../build.ts";
import { aiBindings, type AiBinding, type AiResources } from "./ai.ts";

export type ExportEntry =
  | { type: "durable-object"; storage: "sqlite"; state?: "created" }
  | { type: "durable-object"; state: "deleted" };

export type Binding =
  | { type: "durable_object_namespace"; name: string; class_name: string }
  | { type: "plain_text"; name: string; text: string }
  | { type: "version_metadata"; name: string }
  | { type: "r2_bucket"; name: string; bucket_name: string }
  | { type: "queue"; name: string; queue_name: string }
  | { type: "images"; name: string }
  | { type: "secret_text"; name: string; text: string }
  | { type: "d1"; name: string; id: string }
  | { type: "analytics_engine"; name: string; dataset: string }
  | { type: "service"; name: string; service: string; environment?: string }
  /** Workers Rate Limiting binding (asked for by a component, e.g. rateLimit's `binding` config). */
  | { type: "ratelimit"; name: string; namespace_id: string; simple: { limit: number; period: number } }
  /** Email Service / Email Routing send binding (asked for by a component, e.g. the email component). */
  | { type: "send_email"; name: string; destination_address?: string; allowed_destination_addresses?: string[]; allowed_sender_addresses?: string[] }
  | AiBinding;

export interface WorkerMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: Binding[];
  exports: Record<string, ExportEntry>;
  observability: { enabled: boolean };
  /** Binding types carried over from the previous version (secrets set with `wrangler secret put`). */
  keep_bindings: string[];
  annotations?: Record<string, string>;
}

export interface CurrentState {
  exists: boolean;
  /** DO classes with a provisioned namespace for this script. */
  provisionedClasses: string[];
  /** Versions of the active deployment (empty when the script does not exist). */
  activeVersions: Array<{ version_id: string; percentage: number }>;
  /** Names of the Worker's secrets (values are never readable). Kept across uploads by `keep_bindings`. */
  secrets?: string[];
}

export interface MetadataInput {
  project: string;
  env: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  locationHint?: string;
  vars?: Record<string, string>;
  /**
   * Optional resources. `files`: R2 bucket `ember-<project>-<env>` as EMBER_FILES (provisioned by the deploy with its
   * queue and event notifications, PLAN §7); `images`: the Images binding as EMBER_IMAGES (thumbnails); `actions`:
   * queue `ember-<project>-<env>-actions` as EMBER_ACTIONS (must exist).
   */
  resources?: { files?: boolean; actions?: boolean; images?: boolean };
  /** Cloudflare account (R2 S3 endpoint for presigned URLs). */
  accountId?: string;
  /** Uploaded as `secret_text` bindings (e.g. EMBER_ADMIN_TOKEN); redacted when the plan is printed. */
  secrets?: Record<string, string>;
  provisionedClasses: string[];
  /** The project's own `Auth` DO (ember/auth.config.ts): `Auth` export + `AUTH` binding, `nodejs_compat`. */
  auth?: boolean;
  /** Account registry D1 id: bound as EMBER_REGISTRY (shards report to the catalog). */
  registryId?: string;
  /** Analytics Engine dataset bound as EMBER_METRICS (+ EMBER_METRICS_SAMPLE when sampling). */
  metrics?: { dataset: string; sample?: number };
  /** External indexes (deploy/ai.ts): Vectorize / AI Search / Workers AI / indexing queue bindings. */
  aiIndexes?: AiResources;
  /** Bindings installed components asked for (`componentBindings`). */
  componentBindings?: Binding[];
}

type ComponentsLike = Record<
  string,
  {
    bindings?: Array<{ type: string; name: string; limit?: number; period?: number; destination_address?: string; allowed_destination_addresses?: string[]; allowed_sender_addresses?: string[] }>;
  }
>;

/**
 * Bindings that installed components declared in the composed manifest (`manifest.components[*].bindings`).
 * Rate Limiting: `namespace_id` is derived from `ember-<project>-<env>/<binding>` (stable across deploys,
 * distinct per environment; two bindings with the same id would share counters per location).
 */
export function componentBindings(components: ComponentsLike | undefined, project: string, env: string): Binding[] {
  const out: Binding[] = [];
  const seen = new Set<string>();
  for (const [key, c] of Object.entries(components ?? {})) {
    for (const b of c.bindings ?? []) {
      if (seen.has(b.name)) throw new Error(`Components ask for the binding ${b.name} twice (component ${key})`);
      seen.add(b.name);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.name)) throw new Error(`Component ${key}: invalid binding name ${b.name}`);
      if (b.type === "send_email") {
        out.push({
          type: "send_email",
          name: b.name,
          ...(b.destination_address ? { destination_address: b.destination_address } : {}),
          ...(b.allowed_destination_addresses?.length ? { allowed_destination_addresses: b.allowed_destination_addresses } : {}),
          ...(b.allowed_sender_addresses?.length ? { allowed_sender_addresses: b.allowed_sender_addresses } : {}),
        });
        continue;
      }
      if (b.type !== "ratelimit") throw new Error(`Component ${key}: unknown binding type ${b.type}`);
      if (b.period !== 10 && b.period !== 60) throw new Error(`Component ${key}: ratelimit ${b.name} period must be 10 or 60 seconds`);
      if (!Number.isInteger(b.limit) || b.limit! <= 0) throw new Error(`Component ${key}: ratelimit ${b.name} limit must be a positive integer`);
      out.push({ type: "ratelimit", name: b.name, namespace_id: rateLimitNamespace(project, env, b.name), simple: { limit: b.limit!, period: b.period } });
    }
  }
  return out;
}

/** A positive 31-bit integer (as a string, like the API stores it) from the binding's identity. */
export function rateLimitNamespace(project: string, env: string, binding: string): string {
  const h = createHash("sha256").update(`ember-${project}-${env}/${binding}`).digest();
  return String((h.readUInt32BE(0) & 0x7fffffff) || 1);
}

export const DEFAULT_METRICS_DATASET = "ember_metrics";

/**
 * Full `exports` map: every Ember DO class, `state: "created"` for classes not provisioned yet and the live form
 * otherwise. Provisioned classes that Ember no longer exports are refused (deleting one drops its data).
 */
export function desiredExports(provisioned: Iterable<string>, auth = false): { exports: Record<string, ExportEntry>; created: string[] } {
  const prov = new Set(provisioned);
  const exports: Record<string, ExportEntry> = {};
  const created: string[] = [];
  for (const { className } of doClasses(auth)) {
    if (prov.has(className)) exports[className] = { type: "durable-object", storage: "sqlite" };
    else {
      exports[className] = { type: "durable-object", storage: "sqlite", state: "created" };
      created.push(className);
    }
    prov.delete(className);
  }
  if (prov.size)
    throw new Error(
      `The Worker has Durable Object classes Ember does not export: ${[...prov].join(", ")}. ` +
        "Deleting a class deletes its data; remove it by hand (exports tombstone) if that is intended.",
    );
  return { exports, created };
}

export function buildMetadata(i: MetadataInput): { metadata: WorkerMetadata; createdClasses: string[] } {
  const { exports, created } = desiredExports(i.provisionedClasses, !!i.auth);
  const prefix = `ember-${i.project}-${i.env}`;
  const bindings: Binding[] = [
    ...doClasses(!!i.auth).map((d): Binding => ({ type: "durable_object_namespace", name: d.binding, class_name: d.className })),
    { type: "plain_text", name: "EMBER_ENV", text: i.env },
    { type: "plain_text", name: "EMBER_PROJECT", text: i.project },
    ...(i.locationHint ? [{ type: "plain_text", name: "EMBER_LOCATION_HINT", text: i.locationHint } as Binding] : []),
    ...Object.entries(i.vars ?? {}).map(([name, text]): Binding => ({ type: "plain_text", name, text })),
    { type: "version_metadata", name: "EMBER_VERSION" },
    ...Object.entries(i.secrets ?? {}).map(([name, text]): Binding => ({ type: "secret_text", name, text })),
  ];
  if (i.resources?.files) {
    bindings.push({ type: "r2_bucket", name: "EMBER_FILES", bucket_name: prefix });
    bindings.push({ type: "plain_text", name: "EMBER_R2_BUCKET", text: prefix });
    if (i.accountId) bindings.push({ type: "plain_text", name: "EMBER_R2_ACCOUNT_ID", text: i.accountId });
  }
  if (i.resources?.images) bindings.push({ type: "images", name: "EMBER_IMAGES" });
  if (i.registryId) bindings.push({ type: "d1", name: "EMBER_REGISTRY", id: i.registryId });
  if (i.metrics) {
    bindings.push({ type: "analytics_engine", name: "EMBER_METRICS", dataset: i.metrics.dataset });
    if (i.metrics.sample !== undefined && i.metrics.sample < 1) bindings.push({ type: "plain_text", name: "EMBER_METRICS_SAMPLE", text: String(i.metrics.sample) });
  }
  if (i.resources?.actions) bindings.push({ type: "queue", name: "EMBER_ACTIONS", queue_name: `${prefix}-actions` });
  if (i.aiIndexes) bindings.push(...aiBindings(i.aiIndexes));
  if (i.componentBindings) bindings.push(...i.componentBindings);
  const metadata: WorkerMetadata = {
    main_module: "index.js",
    compatibility_date: i.compatibilityDate,
    // Better Auth needs node:async_hooks & co.: the Auth DO always runs with nodejs_compat.
    compatibility_flags: i.auth && i.compatibilityFlags && !i.compatibilityFlags.includes("nodejs_compat") ? [...i.compatibilityFlags, "nodejs_compat"] : (i.compatibilityFlags ?? ["nodejs_compat"]),
    bindings,
    exports,
    observability: { enabled: true },
    keep_bindings: ["secret_text", "secret_key"],
  };
  return { metadata, createdClasses: created };
}

/** The metadata with secret values replaced (for printing). */
export function redactMetadata(m: WorkerMetadata): WorkerMetadata {
  return { ...m, bindings: m.bindings.map((b) => (b.type === "secret_text" ? { ...b, text: "<redacted>" } : b)) };
}

export type Strategy =
  /** Script does not exist: one Script PUT creates it, its DO classes and deploys at 100% (R1). */
  | "create"
  /** `exports` change (new class): version upload, then a 100% deployment (R2). */
  | "exports-change"
  /** Code-only: version upload, then a 100% or percentage deployment (R2: DO ids stick to one version). */
  | "code-only";

export type Step =
  | { kind: "upload-script"; method: "PUT"; path: string }
  | { kind: "upload-version"; method: "POST"; path: string }
  | { kind: "deploy"; method: "POST"; path: string; versions: Array<{ version_id: string; percentage: number }> }
  | { kind: "schedules"; method: "PUT"; path: string; body: Array<{ cron: string }> }
  | { kind: "subdomain"; method: "POST"; path: string; body: { enabled: true; previews_enabled: false } }
  /** After the deploy: GET <url>/api/auth/jwks and store it as the EMBER_AUTH_JWKS secret (first verifies need no DO call). */
  | { kind: "auth-jwks"; method: "PUT"; path: string }
  /** Before the upload: R2 bucket (+ CORS, lifecycle) and the files queue, idempotently (deploy/files.ts). */
  | { kind: "files-resources"; bucket: string; queue: string }
  /** After the upload: the Worker consumes the files queue; R2 object-create events under f/ and t/ go to it. */
  | { kind: "files-wire"; bucket: string; queue: string }
  /** Before the upload: Vectorize indexes (+ metadata indexes), AI Search instances, the indexing queue. */
  | { kind: "ai-resources"; names: string[] }
  /** After the upload: the Worker consumes the indexing queue. */
  | { kind: "ai-wire"; queue: string }
  /** After the deploy: delete this env's Vectorize indexes / AI Search instances / queue the schema no longer uses. */
  | { kind: "ai-prune" }
  /** Before the upload: the queues components own (`ember-<project>-<env>-<install>-<name>`). */
  | { kind: "component-queues"; queues: string[] }
  /** After the upload: the Worker consumes them. */
  | { kind: "component-queues-wire"; queues: string[] }
  /** After the deploy: delete component queues a previous deploy created that the app no longer declares. */
  | { kind: "component-queues-prune"; queues: string[] }
  | { kind: "registry"; note: string };

export interface DeployPlan {
  worker: string;
  strategy: Strategy;
  createdClasses: string[];
  metadata: WorkerMetadata;
  steps: Step[];
  warnings: string[];
}

/** Placeholder for the version id returned by the upload step. */
export const NEW_VERSION = "$NEW_VERSION";

export function planDeploy(input: {
  worker: string;
  current: CurrentState;
  metadata: WorkerMetadata;
  createdClasses: string[];
  hasCrons: boolean;
  /** Percentage (1–99) of traffic for the new version; code-only deploys only. */
  gradual?: number;
  /** Embed the Auth DO's JWKS as a secret after deploying (local auth, secret not set yet). */
  authJwks?: boolean;
  /** Provision and wire the files bucket/queue (`resources.files`). */
  files?: { bucket: string; queue: string };
  /** External index resources (deploy/ai.ts). */
  ai?: AiResources;
  /** Look for (and delete) external index resources the schema no longer uses. */
  aiPrune?: boolean;
  /** Component queues: the ones the app declares now, and the ones a previous deploy created that are gone. */
  componentQueues?: { current: string[]; stale: string[] };
}): DeployPlan {
  const { worker, current, metadata, createdClasses } = input;
  const base = `/workers/scripts/${worker}`;
  const warnings: string[] = [];
  const steps: Step[] = [];
  if (input.files) steps.push({ kind: "files-resources", ...input.files });
  const ai = input.ai;
  if (ai && (ai.vectorize.length || ai.aiSearch.length)) {
    steps.push({ kind: "ai-resources", names: [...ai.vectorize.map((v) => v.name), ...ai.aiSearch.map((a) => a.name), ...(ai.queue ? [ai.queue] : [])] });
  }
  const cq = input.componentQueues;
  if (cq?.current.length) steps.push({ kind: "component-queues", queues: cq.current });
  let strategy: Strategy;
  if (!current.exists) {
    strategy = "create";
    steps.push({ kind: "upload-script", method: "PUT", path: base });
    if (input.gradual !== undefined) warnings.push("--gradual ignored: first deploy goes to 100%.");
  } else {
    strategy = createdClasses.length ? "exports-change" : "code-only";
    steps.push({ kind: "upload-version", method: "POST", path: `${base}/versions` });
    let versions = [{ version_id: NEW_VERSION, percentage: 100 }];
    if (input.gradual !== undefined && input.gradual < 100) {
      const old = current.activeVersions.length === 1 ? current.activeVersions[0] : undefined;
      if (strategy === "exports-change") warnings.push(`--gradual ignored: exports change (${createdClasses.join(", ")}) must deploy at 100% (R2, error 100405).`);
      else if (!old) warnings.push("--gradual ignored: the active deployment already splits traffic; promote it first.");
      else versions = [{ version_id: NEW_VERSION, percentage: input.gradual }, { version_id: old.version_id, percentage: 100 - input.gradual }];
    }
    steps.push({ kind: "deploy", method: "POST", path: `${base}/deployments`, versions });
  }
  // One minute trigger drives the System DO, which evaluates crons.ts per time zone (PLAN D10).
  steps.push({ kind: "schedules", method: "PUT", path: `${base}/schedules`, body: input.hasCrons ? [{ cron: "* * * * *" }] : [] });
  steps.push({ kind: "subdomain", method: "POST", path: `${base}/subdomain`, body: { enabled: true, previews_enabled: false } });
  if (input.files) steps.push({ kind: "files-wire", ...input.files });
  if (ai?.queue) steps.push({ kind: "ai-wire", queue: ai.queue });
  if (input.aiPrune) steps.push({ kind: "ai-prune" });
  if (cq?.current.length) steps.push({ kind: "component-queues-wire", queues: cq.current });
  if (cq?.stale.length) steps.push({ kind: "component-queues-prune", queues: cq.stale });
  if (input.authJwks) steps.push({ kind: "auth-jwks", method: "PUT", path: `${base}/secrets` });
  steps.push({ kind: "registry", note: "record the deployment in the account registry (D1 ember-registry)" });
  return { worker, strategy, createdClasses, metadata, steps, warnings };
}
