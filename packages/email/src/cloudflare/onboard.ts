// Domain onboarding as one idempotent call: sending (Email Service), receiving (Email Routing: checked, and a routing
// subdomain only when asked), one Worker rule per mailbox address, and the delivery-event subscription to the
// component's queue. The caller keeps the returned `DomainState` (it holds the ids of what was created) and passes it
// back on the next sync and to `destroyDomain`. Product-agnostic: no storage, no HTTP API, no API keys.
import { CfError, deleteEventSubscription, deleteRule, deleteSending, enableRoutingSubdomain, ensureCatchAllRule, ensureEventSubscription, ensureSending, ensureWorkerRule, findZone, releaseCatchAllRule, routingState, type CfCreds, type DnsRecord } from "./api.ts";

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
  /** The zone's catch-all rule points at this Worker (set by `catchAll`; `destroyDomain` turns it off). */
  catchAll?: string;
  notes: string[];
};

const NAME = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A syntactically valid (lowercase) domain name. */
export const isDomainName = (name: string): boolean => NAME.test(name);

export type SyncDomainOptions = {
  /** The domain or subdomain to onboard (case-insensitive). */
  name: string;
  /** Create the Email Routing subdomain when it is missing (there is no API to remove it again). */
  enableRouting?: boolean;
  /** Default: the previous state's value, else true. */
  sending?: boolean;
  /** Default: the previous state's value, else true. */
  receiving?: boolean;
};

export type SyncDomainDeps = {
  /** The state a previous sync returned (keeps created ids), or null. */
  prev: DomainState | null;
  /** Inbound addresses (mailboxes); those on this domain get a literal rule → `worker`. */
  mailboxes: string[];
  /** The Worker that receives the mail (`ember-<project>-<env>`, see `emailResources`). */
  worker: string;
  /** The component's delivery-events queue (see `emailResources`). */
  queue: string;
  /**
   * A mailbox of this domain is its catch-all: the zone's catch-all rule → `worker`. Only for a zone apex (the rule
   * is the zone's); refused when the catch-all already routes mail elsewhere.
   */
  catchAll?: boolean;
};

/**
 * Onboards (or re-checks) a domain. Idempotent: run it again until `status` is `verified` (a new sending domain
 * takes a minute or two; notes say what is missing and what needs the zone owner).
 */
export async function syncDomain(
  c: CfCreds,
  a: SyncDomainOptions,
  deps: SyncDomainDeps,
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
  let catchAll = prev?.catchAll;
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
      for (const address of deps.mailboxes.map((x) => x.toLowerCase()).filter((x) => x.endsWith(`@${name}`))) {
        try {
          const rule = await ensureWorkerRule(c, zone.id, address, deps.worker);
          // Reused rules point at this Worker too: track them so destroyDomain removes them and re-syncs see them.
          if (!ruleIds.includes(rule.id)) ruleIds.push(rule.id);
        } catch (e) {
          notes.push((e as Error).message);
        }
      }
      if (deps.catchAll && name !== zone.name) notes.push(`a catch-all is the zone's rule: only ${zone.name} can have one, not ${name}`);
      else if (deps.catchAll) {
        try {
          await ensureCatchAllRule(c, zone.id, deps.worker);
          catchAll = deps.worker;
        } catch (e) {
          notes.push(`catch-all: ${(e as Error).message}`);
        }
      } else if (catchAll && name === zone.name) {
        // No catch-all mailbox any more: the rule this sync set goes back off.
        try {
          await releaseCatchAllRule(c, zone.id, catchAll);
          catchAll = undefined;
        } catch (e) {
          notes.push(`catch-all: ${(e as Error).message}`);
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
    ...(catchAll ? { catchAll } : {}),
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
    if (d.catchAll) await attempt("catch-all", async () => void (await releaseCatchAllRule(c, d.zoneId!, d.catchAll!)));
  }
  if (d.subscriptionId) await attempt("event subscription", () => deleteEventSubscription(c, d.subscriptionId!));
  return errors;
}
