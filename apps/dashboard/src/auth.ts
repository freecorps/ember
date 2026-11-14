// Who is calling the dashboard API, and with which role (docs/design/contracts.md "Dashboard").
//
//   Authorization: Bearer <DASHBOARD_TOKEN>        → admin, actor "token"
//   Authorization: Bearer <DASHBOARD_READ_TOKEN>   → read,  actor "read-token"
//   Cf-Access-Jwt-Assertion (Cloudflare Access)    → actor = the email; admin when it matches DASHBOARD_ADMINS
//                                                    ("ana@x.com", "@x.com" for a domain, "*" for everyone Access
//                                                    lets in), read otherwise
// Neither Access nor a token configured → 403 (the dashboard is never open without a login).

import { err, fromB64url, sameSecret } from "./http.ts";

export type Role = "read" | "admin";

export interface Principal {
  via: "access" | "token";
  /** Email (Access), or "token" / "read-token". Written to the audit log. */
  actor: string;
  role: Role;
}

export interface AuthEnv {
  DASHBOARD_TOKEN?: string;
  DASHBOARD_READ_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Comma- or space-separated: emails, `@domain`, or `*`. */
  DASHBOARD_ADMINS?: string;
  [k: string]: unknown;
}

type Jwk = JsonWebKey & { kid?: string };
const certCache = new Map<string, { at: number; keys: Jwk[] }>();

export async function verifyAccessJwt(
  token: string,
  o: { teamDomain: string; aud: string; now?: number; fetch?: typeof fetch },
): Promise<{ email?: string; sub?: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string; sub?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]!)));
    payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!)));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const now = (o.now ?? Date.now()) / 1000;
  const team = o.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(o.aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (payload.iss && payload.iss.replace(/\/+$/, "") !== `https://${team}`) return null;
  let cached = certCache.get(team);
  if (!cached || Date.now() - cached.at > 10 * 60_000 || !cached.keys.some((k) => k.kid === header.kid)) {
    const res = await (o.fetch ?? fetch)(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    cached = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys ?? [] };
    certCache.set(team, cached);
  }
  const jwk = cached.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
  } catch {
    return null;
  }
  return { ...(payload.email ? { email: payload.email } : {}), ...(payload.sub ? { sub: payload.sub } : {}) };
}

/** Whether `email` is listed in DASHBOARD_ADMINS. */
export function isAdminEmail(list: string | undefined, email: string | undefined): boolean {
  if (!list || !email) return false;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  for (const raw of list.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    if (entry.startsWith("@") ? at > 0 && e.slice(at) === entry : e === entry) return true;
  }
  return false;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function accessConfigured(env: AuthEnv): boolean {
  return nonEmpty(env.ACCESS_TEAM_DOMAIN) && nonEmpty(env.ACCESS_AUD);
}

export async function authenticate(request: Request, env: AuthEnv, fetchImpl?: typeof fetch): Promise<Principal | Response> {
  const accessOn = accessConfigured(env);
  const tokenOn = nonEmpty(env.DASHBOARD_TOKEN) || nonEmpty(env.DASHBOARD_READ_TOKEN);
  if (!accessOn && !tokenOn) return err(403, "dashboard_locked", "configure Cloudflare Access (ACCESS_TEAM_DOMAIN + ACCESS_AUD) or the DASHBOARD_TOKEN secret");
  const bearer = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim();
  if (bearer) {
    // Both compared every time: which one matched does not show in the timing.
    const admin = nonEmpty(env.DASHBOARD_TOKEN) && sameSecret(bearer, env.DASHBOARD_TOKEN);
    const read = nonEmpty(env.DASHBOARD_READ_TOKEN) && sameSecret(bearer, env.DASHBOARD_READ_TOKEN);
    if (admin) return { via: "token", actor: "token", role: "admin" };
    if (read) return { via: "token", actor: "read-token", role: "read" };
  }
  if (accessOn) {
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (jwt) {
      const who = await verifyAccessJwt(jwt, { teamDomain: env.ACCESS_TEAM_DOMAIN!, aud: env.ACCESS_AUD!, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
      if (who) {
        const actor = who.email ?? (who.sub ? `sub:${who.sub}` : "access");
        return { via: "access", actor, role: isAdminEmail(env.DASHBOARD_ADMINS, who.email) ? "admin" : "read" };
      }
    }
  }
  return err(401, "unauthenticated", accessOn ? "Cloudflare Access login or dashboard token required" : "dashboard token required");
}
