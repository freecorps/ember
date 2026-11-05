// Operator-side domain onboarding: runs the same code as the Worker's `POST /domains` with your Cloudflare login
// (the CLI's token lookup: CLOUDFLARE_API_TOKEN or wrangler's OAuth), in memory only, and records the result in the
// mail service through `POST /domains/import`. Use it when the Worker has no CLOUDFLARE_API_TOKEN secret.
//
//   EMBER_ADMIN_TOKEN=... bun --conditions=@freecorps/ember-source scripts/domains.ts add mail.example.com --url https://mail.example.com [--enable-routing]
//   EMBER_ADMIN_TOKEN=... bun --conditions=@freecorps/ember-source scripts/domains.ts remove mail.example.com --url https://mail.example.com
import { resolveToken } from "../../../packages/cli/src/deploy/cf.ts";
import { destroyDomain, syncDomain, type DomainState } from "../src/onboard.ts";
import type { CfCreds } from "../src/cloudflare.ts";

export async function cfCreds(): Promise<CfCreds> {
  const apiToken = resolveToken();
  const r = (await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: { authorization: `Bearer ${apiToken}` } })).json()) as { result: Array<{ id: string }> };
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? r.result[0]!.id;
  return { apiToken, accountId };
}

const api = (url: string, admin: string) => async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${url.replace(/\/+$/, "")}${path}`, { method, headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const j = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${j?.message ?? ""}`);
  return j;
};

/** Onboards `name` from this machine and records it in the service at `url`. */
export async function addDomain(c: CfCreds, url: string, admin: string, name: string, o: { enableRouting?: boolean; project: string; env: string }) {
  const call = api(url, admin);
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

export async function removeDomain(c: CfCreds, url: string, admin: string, name: string) {
  const call = api(url, admin);
  const d = ((await call("GET", "/domains")).data as any[]).find((x) => x.name === name);
  if (!d) return [];
  return destroyDomain(c, { name, status: d.status, sending: true, receiving: true, records: [], notes: [], ruleIds: d.cloudflare.rule_ids, createdSending: d.cloudflare.created_sending, ...(d.cloudflare.zone_id ? { zoneId: d.cloudflare.zone_id } : {}), ...(d.cloudflare.sending_tag ? { sendingTag: d.cloudflare.sending_tag } : {}), ...(d.cloudflare.subscription_id ? { subscriptionId: d.cloudflare.subscription_id } : {}) });
}

if (import.meta.main) {
  const [cmd, name] = process.argv.slice(2);
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const url = arg("--url");
  const admin = process.env.EMBER_ADMIN_TOKEN;
  if (!cmd || !name || !url || !admin) {
    console.error("usage: EMBER_ADMIN_TOKEN=... domains.ts add|remove <domain> --url <mail url> [--project mail --env prod] [--enable-routing]");
    process.exit(2);
  }
  const c = await cfCreds();
  if (cmd === "add") {
    const d = await addDomain(c, url, admin, name, { enableRouting: process.argv.includes("--enable-routing"), project: arg("--project") ?? "mail", env: arg("--env") ?? "prod" });
    console.log(JSON.stringify({ name: d.name, status: d.status, records: d.records, notes: d.notes }, null, 2));
  } else if (cmd === "remove") {
    const errors = await removeDomain(c, url, admin, name);
    console.log(errors.length ? errors.join("\n") : "removed");
  }
}
