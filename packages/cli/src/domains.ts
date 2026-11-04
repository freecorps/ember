// `ember domains add <host> [--env]` (PLAN §21): one hostname per project environment. Before attaching a Workers
// Custom Domain the CLI checks, in the host's zone, the custom domains and Worker routes already in use plus the
// account registry, and refuses any that point elsewhere.

import { CloudflareApiError, type CfClient } from "./deploy/cf.ts";
import { RegistryConflictError, type D1Registry } from "./registry.ts";

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export interface DomainConflict {
  source: "custom_domain" | "route" | "registry";
  detail: string;
}

export interface DomainCheck {
  host: string;
  zone: { id: string; name: string };
  /** Already attached to this Worker (nothing to do). */
  attached: boolean;
  conflicts: DomainConflict[];
}

/** True when a Worker route pattern (`*.example.com/*`, `api.example.com/v1*`) can match requests to `host`. */
export function routeMatchesHost(pattern: string, host: string): boolean {
  const hostPart = pattern.replace(/^https?:\/\//, "").split("/")[0]!.toLowerCase();
  const re = new RegExp(`^${hostPart.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(host);
}

/** The account zone that contains `host` (longest suffix match). */
export async function findZone(client: CfClient, host: string): Promise<{ id: string; name: string } | null> {
  const labels = host.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join(".");
    const zones = await client.call<Array<{ id: string; name: string }>>("GET", `/zones?name=${encodeURIComponent(name)}&account.id=${client.accountId}`);
    const z = (zones ?? []).find((x) => x.name === name);
    if (z) return { id: z.id, name: z.name };
  }
  return null;
}

export async function checkDomain(client: CfClient, registry: D1Registry | null, host: string, owner: { project: string; env: string; worker: string }): Promise<DomainCheck> {
  host = host.toLowerCase().replace(/\.$/, "");
  if (!HOST.test(host)) throw new Error(`invalid hostname ${JSON.stringify(host)}`);
  const zone = await findZone(client, host);
  if (!zone) throw new Error(`no zone in this account contains ${host} (add the zone to Cloudflare first)`);
  const conflicts: DomainConflict[] = [];
  let attached = false;

  const domains = await client.call<Array<{ hostname: string; service: string; environment?: string }>>("GET", `/workers/domains?zone_id=${zone.id}`);
  for (const d of domains ?? []) {
    if (d.hostname.toLowerCase() !== host) continue;
    if (d.service === owner.worker) attached = true;
    else conflicts.push({ source: "custom_domain", detail: `${host} is a Custom Domain of Worker ${d.service}` });
  }

  const routes = await client.call<Array<{ pattern: string; script?: string | null }>>("GET", `/zones/${zone.id}/workers/routes`);
  for (const r of routes ?? []) {
    if (!routeMatchesHost(r.pattern, host)) continue;
    if (r.script && r.script !== owner.worker) conflicts.push({ source: "route", detail: `route ${r.pattern} → Worker ${r.script}` });
  }

  if (registry) {
    for (const d of await registry.domains()) {
      if (d.host === host && (d.project !== owner.project || d.env !== owner.env)) conflicts.push({ source: "registry", detail: `${host} is registered to ${d.project}/${d.env}` });
    }
  }
  return { host, zone, attached, conflicts };
}

export interface AddDomainResult extends DomainCheck {
  action: "attached" | "already-attached" | "dry-run";
}

/** Checks, then attaches `host` as a Workers Custom Domain of `owner.worker` and records it in the registry. */
export async function addDomain(
  client: CfClient,
  registry: D1Registry | null,
  host: string,
  owner: { project: string; env: string; worker: string },
  opts: { dryRun?: boolean; log?: (l: string) => void } = {},
): Promise<AddDomainResult> {
  const log = opts.log ?? (() => {});
  const check = await checkDomain(client, registry, host, owner);
  if (check.conflicts.length) {
    throw new RegistryConflictError(`refusing ${check.host}:\n${check.conflicts.map((c) => `  - [${c.source}] ${c.detail}`).join("\n")}`);
  }
  if (opts.dryRun) {
    log(`[dry run] ${check.host} (zone ${check.zone.name}) is free; would attach it to ${owner.worker}`);
    return { ...check, action: "dry-run" };
  }
  if (!check.attached) {
    try {
      await client.call("PUT", "/workers/domains", { hostname: check.host, service: owner.worker, zone_id: check.zone.id, environment: "production" });
    } catch (e) {
      if (e instanceof CloudflareApiError && e.status === 409) throw new RegistryConflictError(`${check.host}: ${e.message}`);
      throw e;
    }
  }
  await registry?.addDomain({ host: check.host, ...owner, kind: "custom_domain", zoneId: check.zone.id, zone: check.zone.name });
  log(`${check.host} → ${owner.worker}${check.attached ? " (already attached)" : ""}`);
  return { ...check, action: check.attached ? "already-attached" : "attached" };
}
