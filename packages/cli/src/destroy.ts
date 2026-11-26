// `ember destroy [--env name] --yes`: deletes one environment of the project from the Cloudflare account.
//
// Order: the Worker first (detached from its queues — Cloudflare refuses to delete a queue consumer — then deleted
// with its Durable Objects and their data, so nothing writes during the rest), then this
// env's external index resources (Vectorize indexes by owner description, AI Search instances by the
// `ember-<project>-<env>__` prefix, the indexing queue), then the files queue / notifications and bucket (the bucket
// only when it is empty: R2 refuses otherwise, and objects are not deleted here). Resources of other projects or
// environments are never matched (see deploy/ai.ts). The account registry row is kept (history). Before any of that,
// the Ember Dashboard (when it exists and knows this Worker) drops its service binding and its admin token for it.
//
// Ownership comes first of all (`checkOwner`): Worker names are `ember-<project>-<env>`, so project "chat" env
// "preview-prod" and project "chat-preview" env "prod" share one. Nothing is touched unless the Worker's own marks
// (EMBER_PROJECT/EMBER_ENV, set by every deploy) and the account registry agree that it is this project's environment.

import { isDerivedPreview, resolveEnv, workerName, type Project } from "./config.ts";
import { CfClient, resolveToken } from "./deploy/cf.ts";
import { detachQueueConsumer, findQueue, indexingQueueName, pruneAiResources } from "./deploy/ai.ts";
import { clearAiState } from "./deploy/index.ts";
import { filesBucketName, filesQueueName } from "./deploy/files.ts";
import { deleteComponentQueues, loadComponentQueueState, saveComponentQueueState } from "./deploy/queues.ts";
import { unlinkDashboard } from "./dashboard-link.ts";
import { D1Registry, registryName } from "./registry.ts";

export interface DestroyOptions {
  env?: string;
  /** Required: destroying deletes data. */
  yes?: boolean;
  fetch?: typeof fetch;
  token?: string;
  accountId?: string;
  /** Registry database name (default EMBER_REGISTRY_NAME or `ember-registry`), for the dashboard's bindings. */
  registryName?: string;
  /** Dashboard Worker name (default ember-dashboard). */
  dashboardName?: string;
  log?: (line: string) => void;
}

export async function destroy(project: Project, opts: DestroyOptions = {}): Promise<{ deleted: string[]; warnings: string[] }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const env = resolveEnv(project, opts.env);
  const c = project.config;
  const worker = workerName(c.project, env.name);
  if (!opts.yes) {
    throw new Error(`ember destroy deletes ${worker}, all its Durable Object data and its AI index resources (Vectorize, AI Search). Re-run with --yes.`);
  }
  const accountId = opts.accountId ?? env.config.account ?? c.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error(`No Cloudflare account: set "account" in ember.json or CLOUDFLARE_ACCOUNT_ID.`);
  const client = new CfClient({ accountId, token: opts.token ?? resolveToken(), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const deleted: string[] = [];
  const warnings: string[] = [];
  await checkOwner(client, project, env.name, worker, opts.registryName);

  // Best effort: the dashboard is optional and must not block a destroy (its next deploy drops the binding anyway).
  const unlinked = await unlinkDashboard(client, worker, {
    ...(opts.dashboardName ? { name: opts.dashboardName } : {}),
    registry: () => D1Registry.open(client, registryName(opts.registryName), { create: false }).catch(() => null),
    log,
  }).catch((e: Error) => {
    log(`  warning: the Ember Dashboard was not updated (${e.message}); \`ember dashboard deploy\` drops ${worker} later`);
    return false;
  });
  if (unlinked) deleted.push(`dashboard link ${worker}`);

  // Cloudflare refuses to delete a Worker that consumes a queue (measured): detach it from this env's queues first.
  const compQueues = loadComponentQueueState(project, env.name);
  for (const name of [indexingQueueName(c.project, env.name), filesQueueName(c.project, env.name), `ember-${c.project}-${env.name}-actions`, ...compQueues]) {
    await detachQueueConsumer(client, name, worker, log);
  }
  const w = await client.request("DELETE", `/workers/scripts/${worker}?force=true`);
  if (w.success) deleted.push(`worker ${worker}`);
  else if (w.status !== 404 && !w.errors.some((e) => e.code === 10007)) throw new Error(`DELETE worker ${worker}: ${w.errors.map((e) => e.message).join("; ")}`);

  deleted.push(...(await pruneAiResources(client, c.project, env.name, worker, null, log)));
  // Queues components owned (recorded by the deploys of this env).
  deleted.push(...(await deleteComponentQueues(client, worker, compQueues, log)));
  saveComponentQueueState(project, env.name, []);
  clearAiState(project, env.name);

  if (c.resources?.files) {
    const bucket = filesBucketName(c.project, env.name);
    const queueName = filesQueueName(c.project, env.name);
    const q = await findQueue(client, queueName);
    if (q) {
      await client.request("DELETE", `/event_notifications/r2/${bucket}/configuration/queues/${q}`);
      await client.call("DELETE", `/queues/${q}`);
      deleted.push(`queue ${queueName}`);
    }
    const b = await client.request("DELETE", `/r2/buckets/${bucket}`);
    if (b.success) deleted.push(`bucket ${bucket}`);
    else if (b.status !== 404) warnings.push(`bucket ${bucket} was kept (${b.errors.map((e) => e.message).join("; ") || b.status}): empty it, then delete it`);
  }
  for (const d of deleted) log(`  deleted ${d}`);
  for (const x of warnings) log(`  warning: ${x}`);
  return { deleted, warnings };
}

/**
 * Refuses to destroy `worker` unless it is `project`'s environment `env`:
 * - the Worker, when it exists, carries EMBER_PROJECT/EMBER_ENV (every `ember deploy` sets both) naming them. A
 *   derived preview (`preview-<slug>`) without those marks is refused too (it was not deployed by `ember deploy
 *   --preview`); a declared environment without them (a Worker from before the marks) is allowed;
 * - the account registry, when there is one, does not record the Worker name or the project name for another project
 *   (another environment, or a fingerprint that is not ember.json's).
 * A Worker already deleted (a repeated destroy) passes when the registry does not name another owner: idempotent.
 */
export async function checkOwner(client: CfClient, project: Project, env: string, worker: string, registry?: string): Promise<void> {
  const c = project.config;
  const refuse = (why: string): never => {
    throw new Error(`ember destroy refuses to delete ${worker}: ${why}. Nothing was deleted.`);
  };
  const s = await client.request<{ bindings?: Array<{ type: string; name: string; text?: string }> }>("GET", `/workers/scripts/${worker}/settings`);
  const absent = !s.success && (s.status === 404 || s.errors.some((e) => e.code === 10007));
  if (!s.success && !absent) refuse(`its settings could not be read to check who owns it (GET settings → ${s.status} ${s.errors.map((e) => e.message).join("; ")})`);
  if (s.success) {
    const plain = new Map((s.result?.bindings ?? []).filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]));
    const [p, e] = [plain.get("EMBER_PROJECT"), plain.get("EMBER_ENV")];
    if ((p !== undefined && p !== c.project) || (e !== undefined && e !== env)) {
      refuse(`it belongs to project ${JSON.stringify(p ?? "?")} environment ${JSON.stringify(e ?? "?")} (its EMBER_PROJECT/EMBER_ENV), not ${JSON.stringify(c.project)}/${JSON.stringify(env)}`);
    }
    if ((p === undefined || e === undefined) && isDerivedPreview(project, env)) {
      refuse(`it has no EMBER_PROJECT/EMBER_ENV naming ${JSON.stringify(c.project)}/${JSON.stringify(env)}, so it is not a preview \`ember deploy --preview\` created for this project`);
    }
  }
  const reg = await D1Registry.open(client, registryName(registry), { create: false, ddl: false }).catch(() => null);
  if (!reg) return;
  // A registry that cannot answer is not a "no": only a database without the tables yet is (nothing recorded).
  const rows = (sql: string, ...params: unknown[]) =>
    reg.exec(sql, ...params).catch((e: Error) => (/no such table/i.test(e.message) ? [] : refuse(`the account registry could not be read to check who owns it (${e.message})`)));
  const [byWorker] = await rows("SELECT project, env FROM environments WHERE worker = ?", worker);
  if (byWorker && (byWorker.project !== c.project || byWorker.env !== env)) {
    refuse(`the account registry records it for project ${JSON.stringify(byWorker.project)} environment ${JSON.stringify(byWorker.env)}`);
  }
  const [owner] = await rows("SELECT fingerprint, repo FROM projects WHERE name = ?", c.project);
  if (owner && owner.fingerprint !== c.fingerprint) {
    refuse(`project ${JSON.stringify(c.project)} is registered in this account by another repository${owner.repo ? ` (${String(owner.repo)})` : ""} (fingerprint)`);
  }
}
