// Domain onboarding, shared by the Worker (`domains:sync`, with its own CLOUDFLARE_API_TOKEN secret) and the
// operator script (`scripts/domains.ts`, with the CLI's token lookup, in memory only) which then records the
// result through `POST /domains/import`: the Worker never needs to hold a Cloudflare token.
import { CfError, deleteEventSubscription, deleteRule, deleteSending, enableRoutingSubdomain, ensureEventSubscription, ensureSending, ensureWorkerRule, findZone, routingState, type CfCreds, type DnsRecord } from "./cloudflare.ts";

export type DomainState = {
  name: string;
  zoneId?: string;
  zoneName?: string;
  sendingTag?: string;
  status: "pending" | "verified" | "failed";
  sending: boolean;
  receiving: boolean;
  routingStatus?: string;
  records: DnsRecord[];
  ruleIds: string[];
  subscriptionId?: string;
  createdSending?: boolean;
  notes: string[];
};

const NAME = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A syntactically valid (lowercase) domain name. */
export const isDomainName = (name: string): boolean => NAME.test(name);

export async function syncDomain(
  c: CfCreds,
  a: { name: string; enableRouting?: boolean; sending?: boolean; receiving?: boolean },
  deps: { prev: DomainState | null; mailboxes: string[]; worker: string; queue: string },
): Promise<DomainState> {
  const name = a.name.toLowerCase();
  if (!isDomainName(name)) throw new Error(`invalid domain ${a.name}`);
  const prev = deps.prev;
  const wantSend = a.sending ?? prev?.sending ?? true;
  const wantRecv = a.receiving ?? prev?.receiving ?? true;
  const notes: string[] = [];
  const zone = await findZone(c, name);
  if (!zone) {
    notes.push(`${name} is not in a zone of this Cloudflare account: add the zone first (Email Service needs Cloudflare DNS).`);
    return { name, status: "failed", sending: wantSend, receiving: wantRecv, records: [], ruleIds: prev?.ruleIds ?? [], notes };
  }
  const records: DnsRecord[] = [];
  let sendingTag = prev?.sendingTag;
  let createdSending = prev?.createdSending ?? false;
  let sendingOk = !wantSend;
  if (wantSend) {
    const s = await ensureSending(c, zone.id, name);
    sendingTag = s.sending.tag;
    createdSending ||= s.created;
    records.push(...s.records);
    sendingOk = s.sending.enabled;
    if (!sendingOk) notes.push("Email Sending is onboarding this domain (Cloudflare adds its DNS records; verify again).");
  }
  let routingStatus: string | undefined;
  const ruleIds = [...(prev?.ruleIds ?? [])];
  let subscriptionId = prev?.subscriptionId;
  let recvOk = !wantRecv;
  if (wantRecv) {
    let r = await routingState(c, zone, name);
    if (!r.enabled && a.enableRouting && name !== zone.name && r.status === "subdomain_missing") {
      await enableRoutingSubdomain(c, zone.id, name);
      notes.push(`Email Routing subdomain ${name} created (only the dashboard can remove it: there is no API for that).`);
      r = await routingState(c, zone, name);
    }
    routingStatus = r.status;
    records.push(...r.records);
    if (r.note) notes.push(r.note);
    recvOk = r.enabled;
    if (r.enabled) {
      for (const address of deps.mailboxes.filter((x) => x.endsWith(`@${name}`))) {
        try {
          const rule = await ensureWorkerRule(c, zone.id, address, deps.worker);
          if (rule.created) ruleIds.push(rule.id);
        } catch (e) {
          notes.push((e as Error).message);
        }
      }
    }
  }
  if (wantSend && sendingOk) {
    try {
      subscriptionId = (await ensureEventSubscription(c, zone.id, name, deps.queue)).id;
    } catch (e) {
      notes.push(`delivery events: ${(e as Error).message}`);
    }
  }
  return {
    name,
    zoneId: zone.id,
    zoneName: zone.name,
    ...(sendingTag ? { sendingTag } : {}),
    status: sendingOk && recvOk ? "verified" : "pending",
    sending: wantSend,
    receiving: wantRecv,
    ...(routingStatus ? { routingStatus } : {}),
    records,
    ruleIds,
    ...(subscriptionId ? { subscriptionId } : {}),
    createdSending,
    notes,
  };
}

/** Deletes what onboarding created (rules, the event subscription, the sending onboarding if it created it). */
export async function destroyDomain(c: CfCreds, d: DomainState): Promise<string[]> {
  const errors: string[] = [];
  const attempt = async (what: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      if (!(e instanceof CfError && e.status === 404)) errors.push(`${what}: ${(e as Error).message}`);
    }
  };
  if (d.zoneId) {
    for (const id of d.ruleIds) await attempt(`rule ${id}`, () => deleteRule(c, d.zoneId!, id));
    if (d.createdSending && d.sendingTag) await attempt("sending domain", () => deleteSending(c, d.zoneId!, d.sendingTag!));
  }
  if (d.subscriptionId) await attempt("event subscription", () => deleteEventSubscription(c, d.subscriptionId!));
  return errors;
}
