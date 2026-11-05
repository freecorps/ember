// Component queues (PLAN §12, contracts.md "Componentes", hooks): a component declares `queues: { events: {...} }`
// and the composed manifest lists them under `manifest.components[key].queues` ({ name, queue: suffix, binding,
// consumer }). The deploy:
//   - before the upload: creates `ember-<project>-<env>-<suffix>` (idempotent), so the producer binding resolves;
//   - binds it as `{ type: "queue", name: binding }` (metadata);
//   - after the upload: adds the Worker as its consumer (with the component's consumer settings);
//   - after the deploy: detaches and deletes queues a previous deploy of this env created that are gone now.
// The names are recorded per env in `.ember/component-queues.json` so `ember destroy` finds them without a build.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../config.ts";
import type { CfClient } from "./cf.ts";
import { detachQueueConsumer, findQueue } from "./ai.ts";
import { isConflict } from "./files.ts";
import type { Binding } from "./plan.ts";

export type ComponentQueueSpec = {
  /** Physical queue name. */
  queue: string;
  binding: string;
  component: string;
  consumer?: { maxBatchSize?: number; maxBatchTimeoutSeconds?: number; maxRetries?: number; retryDelaySeconds?: number };
};

type ComponentsLike = Record<string, { queues?: Array<{ name: string; queue: string; binding: string; consumer?: ComponentQueueSpec["consumer"] }> }>;

/** Cloudflare queue names: 1–63 chars of [a-z0-9-]. */
const QUEUE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function componentQueues(components: ComponentsLike | undefined, project: string, env: string): ComponentQueueSpec[] {
  const out: ComponentQueueSpec[] = [];
  for (const [key, c] of Object.entries(components ?? {})) {
    for (const q of c.queues ?? []) {
      const queue = `ember-${project}-${env}-${q.queue}`;
      if (!QUEUE_RE.test(queue)) throw new Error(`Component ${key}: queue name ${queue} is not a valid Cloudflare queue name (max 63, [a-z0-9-]); use a shorter install name`);
      out.push({ queue, binding: q.binding, component: key, ...(q.consumer ? { consumer: q.consumer } : {}) });
    }
  }
  return out;
}

/**
 * Producer bindings of the component queues. composeApp already refuses invalid names and repeats among queues and
 * within an install; this also checks them against the Worker's other component bindings (`taken`: another
 * install's ratelimit/send_email binding is not seen by composeApp) and guards hand-edited manifests, so a clash
 * fails at plan time instead of at the Cloudflare upload.
 */
export function queueBindings(specs: ComponentQueueSpec[], taken: Binding[] = []): Binding[] {
  const names = new Set(taken.map((b) => b.name));
  const queues = new Set<string>();
  for (const s of specs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.binding)) throw new Error(`Component ${s.component}: invalid queue binding name ${s.binding}`);
    if (names.has(s.binding)) throw new Error(`Components ask for the binding ${s.binding} twice (component ${s.component})`);
    if (queues.has(s.queue)) throw new Error(`Components declare the queue ${s.queue} twice (component ${s.component})`);
    names.add(s.binding);
    queues.add(s.queue);
  }
  return specs.map((s) => ({ type: "queue", name: s.binding, queue_name: s.queue }));
}

/** Creates the queues that do not exist yet; returns their ids by name. */
export async function ensureComponentQueues(client: CfClient, specs: ComponentQueueSpec[], log: (l: string) => void): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const s of specs) {
    let id = await findQueue(client, s.queue);
    if (!id) {
      try {
        id = (await client.call<{ queue_id: string }>("POST", "/queues", { queue_name: s.queue })).queue_id;
        log(`  component queue ${s.queue} (created, ${s.component})`);
      } catch (e) {
        // Only "already exists" (created concurrently) falls back to a lookup; a 400/403/network error surfaces as is.
        if (!isConflict(e)) throw e;
        id = await findQueue(client, s.queue);
      }
    }
    if (!id) throw new Error(`queue ${s.queue}: could not be created or found`);
    ids.set(s.queue, id);
  }
  return ids;
}

/** Makes `worker` the consumer of each queue (with the component's settings), once. */
export async function wireComponentQueues(client: CfClient, worker: string, specs: ComponentQueueSpec[], ids: Map<string, string>, log: (l: string) => void): Promise<void> {
  for (const s of specs) {
    const id = ids.get(s.queue);
    if (!id) continue;
    const consumers = await client.call<Array<{ script?: string; script_name?: string; service?: string }>>("GET", `/queues/${id}/consumers`);
    if ((consumers ?? []).some((k) => (k.script ?? k.script_name ?? k.service) === worker)) continue;
    const settings: Record<string, number> = {};
    if (s.consumer?.maxBatchSize !== undefined) settings.batch_size = s.consumer.maxBatchSize;
    if (s.consumer?.maxBatchTimeoutSeconds !== undefined) settings.max_wait_time_ms = s.consumer.maxBatchTimeoutSeconds * 1000;
    if (s.consumer?.maxRetries !== undefined) settings.max_retries = s.consumer.maxRetries;
    if (s.consumer?.retryDelaySeconds !== undefined) settings.retry_delay = s.consumer.retryDelaySeconds;
    await client.call("POST", `/queues/${id}/consumers`, { script_name: worker, type: "worker", ...(Object.keys(settings).length ? { settings } : {}) });
    log(`  component queue ${s.queue}: Worker consumer added`);
  }
}

/** Detaches `worker` from and deletes the named queues (the ones that left the app, or all of them on destroy). */
export async function deleteComponentQueues(client: CfClient, worker: string, names: string[], log: (l: string) => void): Promise<string[]> {
  const deleted: string[] = [];
  for (const name of names) {
    await detachQueueConsumer(client, name, worker, log);
    const id = await findQueue(client, name);
    if (!id) continue;
    await client.call("DELETE", `/queues/${id}`);
    deleted.push(`queue ${name}`);
  }
  return deleted;
}

const stateFile = (project: Project) => join(project.stateDir, "component-queues.json");

export function loadComponentQueueState(project: Project, env: string): string[] {
  try {
    return (JSON.parse(readFileSync(stateFile(project), "utf8")) as Record<string, string[]>)[env] ?? [];
  } catch {
    return [];
  }
}

export function saveComponentQueueState(project: Project, env: string, names: string[]): void {
  mkdirSync(project.stateDir, { recursive: true });
  let all: Record<string, string[]> = {};
  try {
    all = JSON.parse(readFileSync(stateFile(project), "utf8"));
  } catch {
    // first time
  }
  if (names.length) all[env] = names;
  else delete all[env];
  writeFileSync(stateFile(project), JSON.stringify(all, null, 2) + "\n");
}
