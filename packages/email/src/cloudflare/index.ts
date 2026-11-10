// `@freecorps/ember-email/cloudflare`: put a domain on Cloudflare for the email component. Sending (Email Service),
// receiving (Email Routing rules → the app's Worker), and delivery events (event subscription → the component's
// queue), plus removal of what it created. Runs on Workers, Node and Bun (only `fetch`); no postal-mime, no storage.
//
//   import { emailResources, resolveAccountId, syncDomain } from "@freecorps/ember-email/cloudflare";
//   const c = { apiToken, accountId: await resolveAccountId(apiToken, { env: process.env }) };
//   const { worker, eventsQueue } = emailResources("acme", "prod");
//   let d = await syncDomain(c, { name: "mail.acme.com" }, { prev: null, mailboxes: ["support@mail.acme.com"], worker, queue: eventsQueue });
//   // keep `d` (it holds the ids of what was created); later: await destroyDomain(c, d)

export {
  CfError,
  deleteEventSubscription,
  deleteRule,
  deleteSending,
  enableRoutingSubdomain,
  ensureEventSubscription,
  ensureSending,
  ensureWorkerRule,
  ensureCatchAllRule,
  releaseCatchAllRule,
  findZone,
  routingState,
  sendingDomain,
  type CfCreds,
  type DnsRecord,
  type RoutingState,
} from "./api.ts";
export { destroyDomain, isDomainName, syncDomain, type DomainState, type SyncDomainDeps, type SyncDomainOptions } from "./onboard.ts";

/**
 * Names `ember deploy` gives an app's Worker and the email component's delivery-events queue (`install` is the name
 * the component was installed under, `email` by default).
 */
export function emailResources(project: string, env: string, install = "email"): { worker: string; eventsQueue: string } {
  const worker = `ember-${project}-${env}`;
  return { worker, eventsQueue: `${worker}-${install}-events` };
}

/**
 * The account to work in: `CLOUDFLARE_ACCOUNT_ID`, or the token's only account. No account, several accounts, or a
 * failed lookup → a clear error asking for CLOUDFLARE_ACCOUNT_ID (never a guess).
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
