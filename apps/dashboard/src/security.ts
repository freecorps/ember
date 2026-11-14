// Write protection for the dashboard API (docs/design/contracts.md "Dashboard").
//
// Cloudflare Access signs people in with a cookie (CF_Authorization) and its edge adds the JWT header to every request
// that cookie rides on, cross-site ones included. So a write (any non-GET method) must prove it comes from the SPA:
//   1. `Origin` equals the dashboard's own origin (or one in DASHBOARD_ORIGIN); a missing Origin is refused;
//   2. `Sec-Fetch-Site`, when the browser sends it, is `same-origin`;
//   3. `Content-Type: application/json` (a cross-site form or a "simple" fetch cannot send it without a preflight,
//      and the API answers no preflight);
//   4. `X-Ember-Csrf` carries the token `/api/me` hands out: HMAC-SHA256 over the caller's identity with a random key
//      kept in the registry (`dashboard_meta`), so a page that cannot read our responses cannot know it.
// A bearer token alone is not sent by browsers automatically, but the same checks apply to it: one rule for every write.

import type { D1Like } from "./audit.ts";
import { metaSecret } from "./audit.ts";
import type { Principal } from "./auth.ts";
import { b64url, err, sameSecret } from "./http.ts";

export const CSRF_HEADER = "x-ember-csrf";

const keys = new WeakMap<D1Like, Promise<CryptoKey>>();

function csrfKey(db: D1Like): Promise<CryptoKey> {
  let k = keys.get(db);
  if (!k) {
    k = metaSecret(db, "csrf_key").then((hex) => {
      const raw = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
      return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    });
    k.catch(() => keys.delete(db));
    keys.set(db, k);
  }
  return k;
}

/** The CSRF token of `who` (stable for an identity and role; changes if the registry's key is replaced). */
export async function csrfToken(db: D1Like, who: Principal): Promise<string> {
  const key = await csrfKey(db);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`ember-dashboard-csrf\n${who.via}\n${who.actor}\n${who.role}`));
  return b64url(new Uint8Array(mac));
}

/** Origins allowed to write: DASHBOARD_ORIGIN (comma-separated) when set, else the request URL's own origin. */
export function allowedOrigins(env: { DASHBOARD_ORIGIN?: unknown }, url: URL): string[] {
  const list = typeof env.DASHBOARD_ORIGIN === "string" ? env.DASHBOARD_ORIGIN.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean) : [];
  return list.length ? list : [url.origin];
}

/** null when the request may write; else the refusal (403) and its code for the audit log. */
export async function checkWriteRequest(request: Request, url: URL, env: { DASHBOARD_ORIGIN?: unknown }, db: D1Like, who: Principal): Promise<{ res: Response; code: string } | null> {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(env, url).includes(origin)) return { res: err(403, "bad_origin", "writes must come from the dashboard itself (Origin)"), code: "bad_origin" };
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return { res: err(403, "bad_origin", "cross-site write refused (Sec-Fetch-Site)"), code: "bad_origin" };
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return { res: err(415, "bad_content_type", "writes take Content-Type: application/json"), code: "bad_content_type" };
  const sent = request.headers.get(CSRF_HEADER) ?? "";
  const expected = await csrfToken(db, who);
  if (!sent || !sameSecret(sent, expected)) return { res: err(403, "bad_csrf", `missing or stale ${CSRF_HEADER} (reload the dashboard)`), code: "bad_csrf" };
  return null;
}

/** Environments where destructive actions need the typed confirmation: DASHBOARD_PROTECTED_ENVS, default prod/production. */
export function protectedEnvs(env: { DASHBOARD_PROTECTED_ENVS?: unknown }): string[] {
  const raw = typeof env.DASHBOARD_PROTECTED_ENVS === "string" ? env.DASHBOARD_PROTECTED_ENVS : "prod,production";
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** null when confirmed (or not needed); else 428 with the text to type in `error.data.expected`. */
export function checkConfirmation(o: { destructive: boolean; envName: string; protectedEnvs: string[]; expected: string; sent: unknown }): Response | null {
  if (!o.destructive || !o.protectedEnvs.includes(o.envName)) return null;
  if (typeof o.sent === "string" && o.sent === o.expected) return null;
  return err(428, "confirmation_required", `type ${JSON.stringify(o.expected)} to confirm this action on ${o.envName}`, { expected: o.expected });
}
