// Pure deploy planning: metadata (bindings + full `exports` map) and the upload strategy.
//
// Evidence (docs/spikes/remote/RESULTS.md):
// - R1: one multipart PUT with `exports` creates SQLite DO classes and their bindings; `exports` and `migrations`
//   are mutually exclusive (100400); every provisioned class must stay declared (100402).
// - R2: versions must not carry `migrations` (10211); a gradual (multi-version) deployment needs identical
//   `exports` in every version (100405); a version that changes `exports` deploys fine at 100%.

import { DO_CLASSES } from "../build.ts";

export type ExportEntry =
  | { type: "durable-object"; storage: "sqlite"; state?: "created" }
  | { type: "durable-object"; state: "deleted" };

export type Binding =
  | { type: "durable_object_namespace"; name: string; class_name: string }
  | { type: "plain_text"; name: string; text: string }
  | { type: "version_metadata"; name: string }
  | { type: "r2_bucket"; name: string; bucket_name: string }
  | { type: "queue"; name: string; queue_name: string };

export interface WorkerMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: Binding[];
  exports: Record<string, ExportEntry>;
  observability: { enabled: boolean };
  annotations?: Record<string, string>;
}

export interface CurrentState {
  exists: boolean;
  /** DO classes with a provisioned namespace for this script. */
  provisionedClasses: string[];
  /** Versions of the active deployment (empty when the script does not exist). */
  activeVersions: Array<{ version_id: string; percentage: number }>;
}

export interface MetadataInput {
  project: string;
  env: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  locationHint?: string;
  vars?: Record<string, string>;
  /** Optional placeholders (names `ember-<project>-<env>-<suffix>`). The bucket/queue must exist: not provisioned yet. */
  resources?: { files?: boolean; actions?: boolean };
  provisionedClasses: string[];
}

/**
 * Full `exports` map: every Ember DO class, `state: "created"` for classes not provisioned yet and the live form
 * otherwise. Provisioned classes that Ember no longer exports are refused (deleting one drops its data).
 */
export function desiredExports(provisioned: Iterable<string>): { exports: Record<string, ExportEntry>; created: string[] } {
  const prov = new Set(provisioned);
  const exports: Record<string, ExportEntry> = {};
  const created: string[] = [];
  for (const { className } of DO_CLASSES) {
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
  const { exports, created } = desiredExports(i.provisionedClasses);
  const prefix = `ember-${i.project}-${i.env}`;
  const bindings: Binding[] = [
    ...DO_CLASSES.map((d): Binding => ({ type: "durable_object_namespace", name: d.binding, class_name: d.className })),
    { type: "plain_text", name: "EMBER_ENV", text: i.env },
    { type: "plain_text", name: "EMBER_PROJECT", text: i.project },
    ...(i.locationHint ? [{ type: "plain_text", name: "EMBER_LOCATION_HINT", text: i.locationHint } as Binding] : []),
    ...Object.entries(i.vars ?? {}).map(([name, text]): Binding => ({ type: "plain_text", name, text })),
    { type: "version_metadata", name: "EMBER_VERSION" },
  ];
  if (i.resources?.files) bindings.push({ type: "r2_bucket", name: "FILES", bucket_name: `${prefix}-files` });
  if (i.resources?.actions) bindings.push({ type: "queue", name: "EMBER_ACTIONS", queue_name: `${prefix}-actions` });
  const metadata: WorkerMetadata = {
    main_module: "index.js",
    compatibility_date: i.compatibilityDate,
    compatibility_flags: i.compatibilityFlags ?? ["nodejs_compat"],
    bindings,
    exports,
    observability: { enabled: true },
  };
  return { metadata, createdClasses: created };
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
}): DeployPlan {
  const { worker, current, metadata, createdClasses } = input;
  const base = `/workers/scripts/${worker}`;
  const warnings: string[] = [];
  const steps: Step[] = [];
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
  steps.push({ kind: "registry", note: "record deploy in the account registry (D1 ember-registry) — stub, not implemented" });
  return { worker, strategy, createdClasses, metadata, steps, warnings };
}
