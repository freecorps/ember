// Operator-side domain onboarding: runs the same code as the Worker's `POST /domains` with your Cloudflare login
// (the CLI's token lookup: CLOUDFLARE_API_TOKEN or wrangler's OAuth), in memory only, and records the result in the
// mail service through `POST /domains/import`. Use it when the Worker has no CLOUDFLARE_API_TOKEN secret.
//
//   EMBER_ADMIN_TOKEN=... bun --conditions=@freecorps/ember-source scripts/domains.ts add mail.example.com --url https://mail.example.com [--enable-routing]
//   EMBER_ADMIN_TOKEN=... bun --conditions=@freecorps/ember-source scripts/domains.ts remove mail.example.com --url https://mail.example.com
//
// `remove` deletes what onboarding created in Cloudflare, then the service's record (`POST /domains/:id/forget`),
// so the domain stops being accepted as a From domain. If a Cloudflare deletion fails, the record (and the ids it
// holds) stays so the removal can be retried. The logic lives in src/operator.ts (typechecked and tested).
import { resolveToken } from "../../../packages/cli/src/deploy/cf.ts";
import type { CfCreds } from "../src/cloudflare.ts";
import { addDomain, removeDomain, resolveAccountId } from "../src/operator.ts";

export { addDomain, removeDomain };

export async function cfCreds(): Promise<CfCreds> {
  const apiToken = resolveToken();
  return { apiToken, accountId: await resolveAccountId(apiToken, { env: process.env }) };
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
    if (errors.length) process.exit(1);
  }
}
