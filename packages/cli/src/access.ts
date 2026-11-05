// `ember dashboard deploy --access` (PLAN §21): Cloudflare Access in front of the Ember Dashboard.
//
// Finds or creates a self-hosted Access application for the dashboard's host (workers.dev or a custom domain) with an
// allow policy for the given emails / email domains, and returns its AUD tag plus the team domain the dashboard
// Worker needs to verify `Cf-Access-Jwt-Assertion` (ACCESS_TEAM_DOMAIN / ACCESS_AUD; apps/dashboard verifies RS256,
// aud, exp against the team's certs). Needs a Zero Trust organization in the account and a token with Access
// (Apps and Policies) edit; the team domain comes from `GET /access/organizations` or `--access-team`.

import type { CfClient } from "./deploy/cf.ts";

export interface AccessOptions {
  /** Host the application protects (e.g. `ember-dashboard.<subdomain>.workers.dev`). */
  host: string;
  /** Application name. */
  name: string;
  /** Allowed emails and email domains (at least one). */
  emails?: string[];
  emailDomains?: string[];
  /** `<team>.cloudflareaccess.com`; read from the Zero Trust organization when omitted. */
  team?: string;
  sessionDuration?: string;
  log?: (line: string) => void;
}

export interface AccessApp {
  id: string;
  aud: string;
  team: string;
  created: boolean;
}

type App = { id: string; aud: string; domain: string; name: string };

export async function ensureAccessApp(client: CfClient, o: AccessOptions): Promise<AccessApp> {
  const log = o.log ?? (() => {});
  const include = [...(o.emails ?? []).map((email) => ({ email: { email } })), ...(o.emailDomains ?? []).map((domain) => ({ email_domain: { domain } }))];
  let team = o.team?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!team) {
    const org = await client.request<{ auth_domain?: string }>("GET", "/access/organizations");
    team = org.success ? org.result?.auth_domain : undefined;
    if (!team) {
      throw new Error(
        "--access: could not read the Zero Trust organization (no Zero Trust set up, or the token lacks Access: Organizations read). " +
          "Pass --access-team <team>.cloudflareaccess.com",
      );
    }
  }
  const apps = (await client.call<App[]>("GET", "/access/apps?per_page=1000")) ?? [];
  const existing = apps.find((a) => a.domain === o.host || a.domain === `${o.host}/`);
  if (existing) {
    log(`  access: reusing application ${existing.name} for ${o.host}`);
    return { id: existing.id, aud: existing.aud, team, created: false };
  }
  if (!include.length) throw new Error("--access: no Access application protects this host yet; pass --access-email you@example.com (repeatable) or --access-domain example.com");
  const app = await client.call<App>("POST", "/access/apps", {
    name: o.name,
    type: "self_hosted",
    domain: o.host,
    session_duration: o.sessionDuration ?? "24h",
    app_launcher_visible: false,
  });
  await client.call("POST", `/access/apps/${app.id}/policies`, { name: `${o.name} allow`, decision: "allow", include, precedence: 1 });
  log(`  access: created application ${o.name} for ${o.host} (${include.length} allow rule${include.length === 1 ? "" : "s"})`);
  return { id: app.id, aud: app.aud, team, created: true };
}
