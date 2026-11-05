// SSO by project name (PLAN §21): `ember.json` `auth: { from: "<project>" }` or `"<project>/<env>"` instead of a URL.
// `ember deploy` resolves the name to the identity project's deployed URL through the account registry (D1
// `ember-registry`, `environments`), builds the Worker with that URL (`remoteAuth({ from })`: JWKS + issuer) and
// records the link in `auth_links`. A URL keeps working as before.

import type { AuthSettings, Project } from "./config.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** `"identity"` / `"identity/prod"` → names; a URL → null. */
export function parseAuthFrom(from: string): { project: string; env?: string } | null {
  if (/^https?:\/\//.test(from)) return null;
  const [project, env, extra] = from.split("/");
  if (!project || !NAME.test(project) || extra !== undefined || (env !== undefined && !NAME.test(env))) {
    throw new Error(`auth.from must be an http(s) URL, "<project>" or "<project>/<env>" (got ${JSON.stringify(from)})`);
  }
  return env ? { project, env } : { project };
}

/** What the resolver needs from the registry (D1Registry.exec). */
export interface SsoRegistry {
  exec(sql: string, ...params: unknown[]): Promise<Array<Record<string, unknown>>>;
}

/**
 * The identity project's URL. Environment: the one given, else the same name as the deploying env, else `prod`, else
 * its only environment; anything else is ambiguous.
 */
export async function resolveAuthFrom(registry: SsoRegistry, from: { project: string; env?: string }, deployingEnv: string): Promise<{ project: string; env: string; url: string }> {
  const rows = (await registry.exec("SELECT env, url FROM environments WHERE project = ? ORDER BY env", from.project)).map((r) => ({ env: String(r.env), url: (r.url as string | null) ?? null }));
  if (!rows.length) throw new Error(`auth.from: project "${from.project}" is not in the account registry (deploy it first, or use its URL)`);
  const pick = from.env
    ? rows.find((r) => r.env === from.env)
    : (rows.find((r) => r.env === deployingEnv) ?? rows.find((r) => r.env === "prod") ?? (rows.length === 1 ? rows[0] : undefined));
  if (!pick) {
    throw new Error(
      from.env
        ? `auth.from: "${from.project}" has no environment "${from.env}" (registered: ${rows.map((r) => r.env).join(", ")})`
        : `auth.from: "${from.project}" has several environments (${rows.map((r) => r.env).join(", ")}): use "${from.project}/<env>"`,
    );
  }
  if (!pick.url) throw new Error(`auth.from: ${from.project}/${pick.env} has no public URL in the registry (workers.dev disabled?): use its URL`);
  return { project: from.project, env: pick.env, url: pick.url.replace(/\/+$/, "") };
}

/** The project with `auth.from` replaced by a URL for `env` (the env override wins in `authSettings`). */
export function withAuthFrom(project: Project, env: string, url: string): Project {
  const envs = project.config.environments;
  const auth: AuthSettings = { ...(envs[env]?.auth ?? {}), from: url };
  return { ...project, config: { ...project.config, environments: { ...envs, [env]: { ...(envs[env] ?? {}), auth } } } };
}
