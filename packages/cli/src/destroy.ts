// `ember destroy [--env name] --yes`: deletes one environment of the project from the Cloudflare account.
//
// Order: the Worker first (with its Durable Objects and their data — nothing writes during the rest), then this
// env's external index resources (Vectorize indexes by owner description, AI Search instances by the
// `ember-<project>-<env>__` prefix, the indexing queue), then the files queue / notifications and bucket (the bucket
// only when it is empty: R2 refuses otherwise, and objects are not deleted here). Resources of other projects or
// environments are never matched (see deploy/ai.ts). The account registry row is kept (history).

import { resolveEnv, workerName, type Project } from "./config.ts";
import { CfClient, resolveToken } from "./deploy/cf.ts";
import { pruneAiResources } from "./deploy/ai.ts";
import { clearAiState } from "./deploy/index.ts";
import { filesBucketName, filesQueueName } from "./deploy/files.ts";

export interface DestroyOptions {
  env?: string;
  /** Required: destroying deletes data. */
  yes?: boolean;
  fetch?: typeof fetch;
  token?: string;
  accountId?: string;
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

  const w = await client.request("DELETE", `/workers/scripts/${worker}?force=true`);
  if (w.success) deleted.push(`worker ${worker}`);
  else if (w.status !== 404 && !w.errors.some((e) => e.code === 10007)) throw new Error(`DELETE worker ${worker}: ${w.errors.map((e) => e.message).join("; ")}`);

  deleted.push(...(await pruneAiResources(client, c.project, env.name, null, log)));
  clearAiState(project, env.name);

  if (c.resources?.files) {
    const bucket = filesBucketName(c.project, env.name);
    const queueName = filesQueueName(c.project, env.name);
    const queues = await client.call<Array<{ queue_id: string; queue_name: string }>>("GET", `/queues?name=${encodeURIComponent(queueName)}&per_page=100`);
    const q = (queues ?? []).find((x) => x.queue_name === queueName);
    if (q) {
      await client.request("DELETE", `/event_notifications/r2/${bucket}/configuration/queues/${q.queue_id}`);
      await client.call("DELETE", `/queues/${q.queue_id}`);
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
