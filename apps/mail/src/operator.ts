// What scripts/domains.ts does from the operator's machine (no Node APIs here, so it is typechecked and tested on
// workerd with the app): onboard or remove a domain with the operator's Cloudflare token and record the result in
// the mail service over its HTTP API (`POST /domains/import`, `POST /domains/:id/forget`).
import type { CfCreds } from "./cloudflare.ts";
import { destroyDomain, syncDomain, type DomainState } from "./onboard.ts";

/**
 * The account to work in: `CLOUDFLARE_ACCOUNT_ID`, or the token's only account. No account, several accounts, or a
 * failed lookup → a clear error asking for CLOUDFLARE_ACCOUNT_ID (never a guess, never a TypeError).
 */
export async function resolveAccountId(apiToken: string, o: { env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}): Promise<string> {
  const fromEnv = o.env?.CLOUDFLARE_ACCOUNT_ID;
  if (fromEnv) return fromEnv;
  const res = await (o.fetch ?? fetch)("https://api.cloudflare.com/client/v4/accounts", { headers: { authorization: `Bearer ${apiToken}` } });
  const r = (await res.json().catch(() => null)) as { success?: boolean; result?: Array<{ id?: string }>; errors?: Array<{ message?: string }> } | null;
  if (!res.ok || !r?.success) throw new Error(`could not list Cloudflare accounts (${res.status} ${r?.errors?.[0]?.message ?? res.statusText}): set CLOUDFLARE_ACCOUNT_ID`);
  const accounts = (r.result ?? []).filter((a): a is { id: string } => typeof a.id === "string" && a.id !== "");
  if (!accounts.length) throw new Error("this Cloudflare token sees no account: set CLOUDFLARE_ACCOUNT_ID");
  if (accounts.length > 1) throw new Error(`this Cloudflare token sees ${accounts.length} accounts: set CLOUDFLARE_ACCOUNT_ID to pick one`);
  return accounts[0]!.id;
}

const api = (url: string, admin: string, f: typeof fetch = fetch) => async (method: string, path: string, body?: unknown) => {
  const res = await f(`${url.replace(/\/+$/, "")}${path}`, { method, headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const j = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${j?.message ?? ""}`);
  return j;
};

/** Onboards `name` from this machine and records it in the service at `url`. */
export async function addDomain(c: CfCreds, url: string, admin: string, name: string, o: { enableRouting?: boolean; project: string; env: string; fetch?: typeof fetch }) {
  const call = api(url, admin, o.fetch);
  const domains = (await call("GET", "/domains")).data as any[];
  const prevView = domains.find((d) => d.name === name);
  const prev: DomainState | null = prevView
    ? { name, status: prevView.status, sending: prevView.capabilities.sending === "enabled", receiving: prevView.capabilities.receiving === "enabled", records: [], ruleIds: prevView.cloudflare.rule_ids, notes: [], ...(prevView.cloudflare.zone_id ? { zoneId: prevView.cloudflare.zone_id } : {}), ...(prevView.cloudflare.sending_tag ? { sendingTag: prevView.cloudflare.sending_tag } : {}), ...(prevView.cloudflare.subscription_id ? { subscriptionId: prevView.cloudflare.subscription_id } : {}), createdSending: prevView.cloudflare.created_sending }
    : null;
  const mailboxes = ((await call("GET", "/inbox/mailboxes")).data as Array<{ address: string }>).map((m) => m.address);
  const worker = `ember-${o.project}-${o.env}`;
  const state = await syncDomain(c, { name, ...(o.enableRouting ? { enableRouting: true } : {}) }, { prev, mailboxes, worker, queue: `${worker}-email-events` });
  return call("POST", "/domains/import", state);
}

/**
 * Deletes what onboarding created in Cloudflare, then the service's record (so the domain stops being accepted as a
 * From domain). Returns the Cloudflare errors; with any, the record (and the ids it holds) stays for a retry.
 */
export async function removeDomain(c: CfCreds, url: string, admin: string, name: string, o: { fetch?: typeof fetch } = {}): Promise<string[]> {
  const call = api(url, admin, o.fetch);
  const d = ((await call("GET", "/domains")).data as any[]).find((x) => x.name === name);
  if (!d) return [];
  const errors = await destroyDomain(c, { name, status: d.status, sending: true, receiving: true, records: [], notes: [], ruleIds: d.cloudflare.rule_ids, createdSending: d.cloudflare.created_sending, ...(d.cloudflare.zone_id ? { zoneId: d.cloudflare.zone_id } : {}), ...(d.cloudflare.sending_tag ? { sendingTag: d.cloudflare.sending_tag } : {}), ...(d.cloudflare.subscription_id ? { subscriptionId: d.cloudflare.subscription_id } : {}) });
  if (!errors.length) await call("POST", `/domains/${encodeURIComponent(d.id)}/forget`);
  return errors;
}
