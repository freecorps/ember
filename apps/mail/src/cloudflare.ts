// Domain onboarding against the Cloudflare API (the mail app's Worker calls it with its own API token secret,
// never a person's login). Everything here is idempotent and scoped to the domain being onboarded:
//
// - Sending (Email Service): `POST /zones/{zone}/email/sending/subdomains {name}` onboards a domain or subdomain;
//   its DNS records (cf-bounce MX/SPF, DKIM, DMARC) come from `.../subdomains/{tag}/dns`. Deletable per domain.
// - Receiving (Email Routing): routing is a zone feature. For the zone apex it must already be enabled; for a
//   subdomain it must be listed in the zone's routing `subdomains`. Enabling it is NOT automated by default:
//   enabling the apex rewrites the zone's MX/SPF, and a routing subdomain has no API to remove it again (the only
//   DELETE disables routing for the whole zone; checked 2026-11). `enableRouting: true` creates a subdomain
//   (`POST /email/routing/dns {name}`) when the operator accepts that; removal is a dashboard step.
// - Rules: one literal rule per inbound address → this Worker (created and deleted by id; other rules untouched).
// - Delivery events: a Queues event subscription (source `email.sending`, zone + domain) → the component's queue.

export interface CfCreds {
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
}

export class CfError extends Error {
  override name = "CfError";
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(message);
  }
}

export type DnsRecord = { type: string; name: string; value: string; priority?: number; ttl?: number; purpose: "sending" | "receiving" };

async function call<T>(c: CfCreds, method: string, path: string, body?: unknown): Promise<T> {
  const res = await (c.fetch ?? fetch)(`https://api.cloudflare.com/client/v4${path.replace("{account}", c.accountId)}`, {
    method,
    headers: { authorization: `Bearer ${c.apiToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: Array<{ code: number; message: string }> } | null;
  if (!res.ok || !j?.success) {
    const errs = j?.errors ?? [];
    throw new CfError(`${method} ${path.replace(c.accountId, "<account>")}: ${res.status} ${errs.map((e) => `${e.code} ${e.message}`).join("; ") || res.statusText}`, res.status, errs.map((e) => e.code));
  }
  return j.result as T;
}

/** The zone of `domain` in this account (walks up the labels: `a.b.example.com` → `example.com`). */
export async function findZone(c: CfCreds, domain: string): Promise<{ id: string; name: string } | null> {
  const labels = domain.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join(".");
    const zones = await call<Array<{ id: string; name: string; account?: { id: string } }>>(c, "GET", `/zones?name=${encodeURIComponent(name)}&account.id=${c.accountId}`);
    if (zones[0]) return { id: zones[0].id, name: zones[0].name };
  }
  return null;
}

type SendingSubdomain = { tag: string; id?: string; name: string; enabled: boolean };
type RawRecord = { name: string; content: string; type: string; priority?: number; ttl?: number };
const rec = (r: RawRecord, purpose: DnsRecord["purpose"]): DnsRecord => ({
  type: r.type,
  name: r.name,
  value: r.content.replace(/^"|"$/g, ""),
  ...(r.priority !== undefined ? { priority: r.priority } : {}),
  ...(r.ttl !== undefined ? { ttl: r.ttl } : {}),
  purpose,
});

export async function sendingDomain(c: CfCreds, zoneId: string, name: string): Promise<SendingSubdomain | null> {
  const list = await call<SendingSubdomain[]>(c, "GET", `/zones/${zoneId}/email/sending/subdomains`);
  return list.find((s) => s.name === name) ?? null;
}

/** Onboards `name` for sending (idempotent) and returns its DNS records. */
export async function ensureSending(c: CfCreds, zoneId: string, name: string): Promise<{ sending: SendingSubdomain; records: DnsRecord[]; created: boolean }> {
  let sending = await sendingDomain(c, zoneId, name);
  let created = false;
  if (!sending) {
    sending = await call<SendingSubdomain>(c, "POST", `/zones/${zoneId}/email/sending/subdomains`, { name });
    created = true;
  }
  const records = await call<RawRecord[]>(c, "GET", `/zones/${zoneId}/email/sending/subdomains/${sending.tag}/dns`);
  return { sending, records: (records ?? []).map((r) => rec(r, "sending")), created };
}

export async function deleteSending(c: CfCreds, zoneId: string, tag: string): Promise<void> {
  await call(c, "DELETE", `/zones/${zoneId}/email/sending/subdomains/${tag}`);
}

export type RoutingState = { enabled: boolean; status: string; records: DnsRecord[]; note?: string };

/** Whether Email Routing receives mail for `name` (apex or routing subdomain), and the records it needs. */
export async function routingState(c: CfCreds, zone: { id: string; name: string }, name: string): Promise<RoutingState> {
  const s = await call<{ enabled: boolean; status: string; subdomains?: Array<{ name: string; enabled: boolean; status: string }> }>(c, "GET", `/zones/${zone.id}/email/routing`);
  const apex = name === zone.name;
  const sub = apex ? null : (s.subdomains ?? []).find((x) => x.name === name);
  let records: DnsRecord[] = [];
  try {
    const r = await call<RawRecord[] | { records?: RawRecord[] }>(c, "GET", `/zones/${zone.id}/email/routing/dns${apex ? "" : `?subdomain=${encodeURIComponent(name)}`}`);
    records = (Array.isArray(r) ? r : (r.records ?? [])).map((x) => rec(x, "receiving"));
  } catch {
    // older zones: no records view
  }
  if (apex) {
    return { enabled: s.enabled && s.status === "ready", status: s.status, records, ...(s.status === "ready" ? {} : { note: "Email Routing for the apex is not ready: enabling it rewrites the zone's MX/SPF (dashboard: Email → Email Routing)." }) };
  }
  if (!s.enabled) return { enabled: false, status: "zone_disabled", records, note: `Email Routing is off for ${zone.name}; enabling it changes the apex MX/SPF (a zone-wide change).` };
  if (!sub) return { enabled: false, status: "subdomain_missing", records, note: `Add ${name} under Email Routing → Settings → Subdomains (adds MX/SPF on ${name} only), or call verify with enableRouting.` };
  return { enabled: sub.enabled && sub.status === "ready", status: sub.status, records };
}

/** Adds `name` as a routing subdomain (records on the subdomain only). There is no API to remove it again. */
export async function enableRoutingSubdomain(c: CfCreds, zoneId: string, name: string): Promise<void> {
  await call(c, "POST", `/zones/${zoneId}/email/routing/dns`, { name });
}

type Rule = { id: string; name?: string; enabled: boolean; matchers: Array<{ type: string; field?: string; value?: string }>; actions: Array<{ type: string; value?: string[] }> };

/** A literal rule `address` → `worker` (reused when one already points there). */
export async function ensureWorkerRule(c: CfCreds, zoneId: string, address: string, worker: string): Promise<{ id: string; created: boolean }> {
  const rules = await call<Rule[]>(c, "GET", `/zones/${zoneId}/email/routing/rules?per_page=200`);
  const mine = rules.find((r) => r.matchers.some((m) => m.type === "literal" && m.value?.toLowerCase() === address));
  if (mine) {
    if (mine.actions.some((a) => a.type === "worker" && a.value?.includes(worker))) return { id: mine.id, created: false };
    throw new CfError(`${address} already has a routing rule to something else (rule ${mine.id}); not changing it`, 409, []);
  }
  const r = await call<Rule>(c, "POST", `/zones/${zoneId}/email/routing/rules`, {
    name: `ember mail: ${address}`,
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: [{ type: "worker", value: [worker] }],
  });
  return { id: r.id, created: true };
}

export async function deleteRule(c: CfCreds, zoneId: string, id: string): Promise<void> {
  await call(c, "DELETE", `/zones/${zoneId}/email/routing/rules/${id}`);
}

/** Queues event subscription: Email Service delivery events of `domain` → `queue` (by name). */
export async function ensureEventSubscription(c: CfCreds, zoneId: string, domain: string, queue: string): Promise<{ id: string; created: boolean }> {
  const queues = await call<Array<{ queue_id: string; queue_name: string }>>(c, "GET", `/accounts/{account}/queues?name=${encodeURIComponent(queue)}`);
  const q = queues.find((x) => x.queue_name === queue);
  if (!q) throw new CfError(`queue ${queue} not found (deploy the mail app first)`, 404, []);
  const subs = await call<Array<{ id: string; source?: { type?: string; domain?: string; zone_id?: string }; destination?: { queue_id?: string } }>>(c, "GET", `/accounts/{account}/event_subscriptions/subscriptions?per_page=100`);
  const mine = subs.find((s) => s.source?.type === "email.sending" && s.source.domain === domain && s.destination?.queue_id === q.queue_id);
  if (mine) return { id: mine.id, created: false };
  const s = await call<{ id: string }>(c, "POST", `/accounts/{account}/event_subscriptions/subscriptions`, {
    name: `${queue} ${domain}`.slice(0, 100),
    enabled: true,
    source: { type: "email.sending", zone_id: zoneId, domain },
    destination: { type: "queues.queue", queue_id: q.queue_id },
    // Subscription event names are short; delivered messages carry `type: "cf.email.sending.message.<x>"`.
    events: ["message.delivered", "message.deferred", "message.bounced", "message.failed", "message.rejected", "message.complained"],
  });
  return { id: s.id, created: true };
}

export async function deleteEventSubscription(c: CfCreds, id: string): Promise<void> {
  await call(c, "DELETE", `/accounts/{account}/event_subscriptions/subscriptions/${id}`);
}
