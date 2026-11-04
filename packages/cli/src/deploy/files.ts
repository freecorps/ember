// Files resources for `ember deploy` (PLAN §7, §21). All idempotent; re-running a deploy converges:
//   R2 bucket `ember-<project>-<env>`  + CORS (browser PUT/GET, ETag exposed for multipart)
//                                       + lifecycle (t/ temp uploads expire after 7 days, stale multipart aborted)
//   Queue `ember-<project>-<env>-files` + this Worker as its consumer
//   R2 event notification: object-create under f/ and t/ → that queue (confirms uploads without the client)
//   S3 credentials for presigned URLs (secrets EMBER_R2_ACCESS_KEY_ID / EMBER_R2_SECRET_ACCESS_KEY):
//     1. EMBER_R2_ACCESS_KEY_ID + EMBER_R2_SECRET_ACCESS_KEY in the deploying shell → uploaded as secrets;
//     2. already on the Worker → kept (keep_bindings);
//     3. else an account API token scoped to the bucket is created (needs a Cloudflare token allowed to create API
//        tokens; the wrangler OAuth token is not) → access key id = token id, secret = sha256(token value);
//     4. else proxy mode: uploads/downloads go through the Worker (works everywhere, costs Worker CPU/bandwidth).

import { createHash } from "node:crypto";
import { CloudflareApiError, type CfClient } from "./cf.ts";

export const filesBucketName = (project: string, env: string) => `ember-${project}-${env}`;
export const filesQueueName = (project: string, env: string) => `ember-${project}-${env}-files`;

export const EVENT_ACTIONS = ["PutObject", "CopyObject", "CompleteMultipartUpload"] as const;
export const EVENT_PREFIXES = ["f/", "t/"] as const;

export const CORS_RULES = {
  rules: [
    {
      allowed: { origins: ["*"], methods: ["GET", "PUT", "HEAD"], headers: ["*"] },
      exposeHeaders: ["ETag", "Content-Length", "Content-Range"],
      maxAgeSeconds: 86400,
    },
  ],
};

export const LIFECYCLE_RULES = {
  rules: [
    { id: "ember-expire-temp-uploads", enabled: true, conditions: { prefix: "t/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 7 * 86400 } } },
    { id: "ember-abort-multipart", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * 86400 } } },
  ],
};

export interface FilesState {
  bucket: string;
  queue: string;
  queueId: string;
  created: { bucket: boolean; queue: boolean };
}

const isConflict = (e: unknown) => e instanceof CloudflareApiError && (e.status === 409 || e.has(10004) || e.has(11009) || /already exists/i.test(e.message));

/** Bucket + CORS + lifecycle + queue (before the Worker upload, which binds them). */
export async function ensureFilesResources(client: CfClient, project: string, env: string, log: (l: string) => void): Promise<FilesState> {
  const bucket = filesBucketName(project, env);
  const queue = filesQueueName(project, env);
  const created = { bucket: false, queue: false };

  const head = await client.request("GET", `/r2/buckets/${bucket}`);
  if (!head.success) {
    try {
      await client.call("POST", "/r2/buckets", { name: bucket });
      created.bucket = true;
    } catch (e) {
      if (!isConflict(e)) throw e;
    }
  }
  await client.call("PUT", `/r2/buckets/${bucket}/cors`, CORS_RULES);
  await client.call("PUT", `/r2/buckets/${bucket}/lifecycle`, LIFECYCLE_RULES);

  let queueId = await findQueue(client, queue);
  if (!queueId) {
    try {
      queueId = (await client.call<{ queue_id: string }>("POST", "/queues", { queue_name: queue })).queue_id;
      created.queue = true;
    } catch (e) {
      if (!isConflict(e)) throw e;
      queueId = await findQueue(client, queue);
    }
  }
  if (!queueId) throw new Error(`queue ${queue}: could not be created or found`);
  log(`  files: bucket ${bucket}${created.bucket ? " (created)" : ""}, queue ${queue}${created.queue ? " (created)" : ""}`);
  return { bucket, queue, queueId, created };
}

async function findQueue(client: CfClient, name: string): Promise<string | null> {
  const list = await client.call<Array<{ queue_id: string; queue_name: string }>>("GET", `/queues?name=${encodeURIComponent(name)}&per_page=100`);
  return (list ?? []).find((q) => q.queue_name === name)?.queue_id ?? null;
}

/** After the Worker exists: consumer + event notification rules. */
export async function wireFilesQueue(client: CfClient, worker: string, state: FilesState, log: (l: string) => void): Promise<{ consumer: boolean; notification: boolean }> {
  const consumers = await client.call<Array<{ script?: string; script_name?: string; service?: string }>>("GET", `/queues/${state.queueId}/consumers`);
  let consumer = false;
  if (!(consumers ?? []).some((c) => (c.script ?? c.script_name ?? c.service) === worker)) {
    await client.call("POST", `/queues/${state.queueId}/consumers`, {
      type: "worker",
      script_name: worker,
      settings: { batch_size: 10, max_retries: 5, max_wait_time_ms: 1000 },
    });
    consumer = true;
  }

  const cfg = await client.request<{ queues?: Array<{ queueId: string; rules?: Array<{ prefix?: string; actions?: string[] }> }> }>(
    "GET",
    `/event_notifications/r2/${state.bucket}/configuration`,
  );
  const mine = cfg.success ? (cfg.result?.queues ?? []).find((q) => q.queueId === state.queueId) : undefined;
  const have = new Set((mine?.rules ?? []).map((r) => `${r.prefix ?? ""}|${[...(r.actions ?? [])].sort().join(",")}`));
  const want = EVENT_PREFIXES.map((p) => `${p}|${[...EVENT_ACTIONS].sort().join(",")}`);
  let notification = false;
  if (!want.every((w) => have.has(w))) {
    await client.call("PUT", `/event_notifications/r2/${state.bucket}/configuration/queues/${state.queueId}`, {
      rules: EVENT_PREFIXES.map((prefix) => ({ prefix, actions: [...EVENT_ACTIONS], description: "ember: confirm uploads" })),
    });
    notification = true;
  }
  log(`  files: consumer ${consumer ? "added" : "ok"}, event notifications ${notification ? "configured" : "ok"}`);
  return { consumer, notification };
}

/**
 * S3 credentials from an account API token scoped to the bucket (Cloudflare: access key id = token id, secret
 * access key = SHA-256 of the token value). Null when the deploying token may not create tokens.
 */
export async function createR2Credentials(client: CfClient, bucket: string, worker: string): Promise<{ accessKeyId: string; secretAccessKey: string } | null> {
  try {
    const groups = await client.call<Array<{ id: string; name: string }>>("GET", "/tokens/permission_groups");
    const write = (groups ?? []).find((g) => g.name === "Workers R2 Storage Bucket Item Write");
    if (!write) return null;
    const token = await client.call<{ id: string; value: string }>("POST", "/tokens", {
      name: `${worker} files (ember)`,
      policies: [
        {
          effect: "allow",
          permission_groups: [{ id: write.id }],
          resources: { [`com.cloudflare.edge.r2.bucket.${client.accountId}_default_${bucket}`]: "*" },
        },
      ],
    });
    if (!token?.id || !token.value) return null;
    return { accessKeyId: token.id, secretAccessKey: createHash("sha256").update(token.value).digest("hex") };
  } catch (e) {
    if (e instanceof CloudflareApiError) return null;
    throw e;
  }
}

/** Tears down a files environment (bucket must be emptied first by the caller). Used by spikes / `ember destroy`. */
export async function deleteFilesResources(client: CfClient, state: { bucket: string; queueId: string | null }): Promise<void> {
  if (state.queueId) {
    await client.request("DELETE", `/event_notifications/r2/${state.bucket}/configuration/queues/${state.queueId}`);
    await client.request("DELETE", `/queues/${state.queueId}`);
  }
  await client.request("DELETE", `/r2/buckets/${state.bucket}`);
}
