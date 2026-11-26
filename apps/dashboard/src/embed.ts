// Embed blocks (docs/design/contracts.md "Dashboard", "Embeds"): a component's or app's own page, shown in the SPA in
// an `<iframe sandbox="allow-scripts">`. The iframe cannot carry the SPA's credentials (a dashboard token lives in the
// SPA's memory, never in a cookie), so the SPA first asks `GET /api/dash/embed` (read role) for a short-lived ticket:
// a URL `/embed/<project>/<env><route>?dashboard&exp&sig`, signed with a key kept in the registry (`dashboard_meta`),
// valid for that one page for a few minutes. `GET /embed/...` checks it, fetches the page from the project through the admin
// channel (`dashboards/embed`: only routes an embed block names), and serves it from the dashboard's origin under:
//
//   - CSP `sandbox allow-scripts`: even opened on its own (not in the iframe) the page runs in an opaque origin,
//     never with the dashboard's cookies or storage;
//   - `script-src` with the SHA-256 of each inline script the page has (no URL, no `unsafe-inline`, no event-handler
//     attributes), `connect-src 'none'`, images and fonts only `data:`/`blob:`, no forms, no frames, no `<base>`: the
//     page's one way out is `postMessage` to the dashboard, which runs only the functions the block allows and asks
//     the person to confirm every write;
//   - `frame-ancestors` the dashboard's own origins (and `X-Frame-Options: SAMEORIGIN` for older browsers).

import { metaSecret, type D1Like } from "./audit.ts";
import { b64url, readLimited, sameSecret } from "./http.ts";
import { environment, projectAdmin, type ProjectEnv } from "./projects.ts";
import { allowedOrigins } from "./security.ts";

/** How long a ticket stays valid (a reload of the block asks for a new one). */
export const EMBED_TICKET_TTL_MS = 5 * 60_000;
/** Largest page the dashboard serves (as the runtime's `DASHBOARD_EMBED_MAX`). */
export const EMBED_MAX_BYTES = 1024 * 1024;
/** Inline scripts hashed at most (a page with more is refused). */
const MAX_SCRIPTS = 32;

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const DASHBOARD_KEY = /^(?:[A-Za-z][A-Za-z0-9_]{0,39}(?:\/[A-Za-z][A-Za-z0-9_]{0,39}){0,7})?$/;
const ROUTE = /^\/(?:[A-Za-z0-9_~.-]+\/)*[A-Za-z0-9_~.-]*$/;

/** The same rule as `isDashboardEmbedRoute` (@freecorps/ember-server): a plain path, no `.`/`..` segments. */
export function isEmbedRoute(route: string): boolean {
  return route.length <= 200 && ROUTE.test(route) && !route.split("/").some((s) => s === "." || s === "..");
}

export interface EmbedScope {
  project: string;
  env: string;
  dashboard: string;
  route: string;
}

/** Why a scope is malformed, or null. */
export function embedScopeProblem(s: EmbedScope): string | null {
  if (!NAME.test(s.project) || !NAME.test(s.env)) return "project and env required";
  if (!DASHBOARD_KEY.test(s.dashboard)) return "dashboard: the spec's key (\"\" for the app's, a component's install name)";
  if (!isEmbedRoute(s.route)) return "route: a plain path like /dashboard/page (no scheme, host, query, \"..\" or escapes)";
  return null;
}

const keys = new WeakMap<D1Like, Promise<CryptoKey>>();
function ticketKey(db: D1Like): Promise<CryptoKey> {
  let k = keys.get(db);
  if (!k) {
    k = metaSecret(db, "embed_key").then((hex) => crypto.subtle.importKey("raw", new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
    k.catch(() => keys.delete(db));
    keys.set(db, k);
  }
  return k;
}

const ticketText = (s: EmbedScope, exp: number) => `ember-dashboard-embed\n${exp}\n${s.project}\n${s.env}\n${s.dashboard}\n${s.route}`;

/** The iframe's URL for `s`, valid until `now + EMBED_TICKET_TTL_MS`. */
export async function embedUrl(db: D1Like, s: EmbedScope, now = Date.now()): Promise<{ url: string; expires: number }> {
  const exp = now + EMBED_TICKET_TTL_MS;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await ticketKey(db), new TextEncoder().encode(ticketText(s, exp))));
  const q = new URLSearchParams({ dashboard: s.dashboard, exp: String(exp), sig: b64url(mac) });
  return { url: `/embed/${s.project}/${s.env}${s.route}?${q}`, expires: exp };
}

/**
 * The scope of an `/embed/<project>/<env><route>` URL (the route is the rest of the path, as the block declares it).
 * The URL parser has already resolved `.`/`..` segments (encoded ones too), so a path that had them names another
 * scope, whose signature does not match; anything with an escape left is refused by the route check.
 */
function scopeOf(url: URL): EmbedScope {
  const rest = url.pathname.slice("/embed/".length).split("/");
  return { project: rest[0] ?? "", env: rest[1] ?? "", dashboard: url.searchParams.get("dashboard") ?? "", route: rest.length >= 2 ? `/${rest.slice(2).join("/")}` : "" };
}

/** The scope a ticket URL grants, or why it does not. */
export async function checkTicket(db: D1Like, url: URL, now = Date.now()): Promise<EmbedScope | { problem: string; status: number }> {
  const s = scopeOf(url);
  const q = url.searchParams;
  const bad = embedScopeProblem(s);
  if (bad) return { problem: bad, status: 400 };
  const exp = Number(q.get("exp"));
  const sig = q.get("sig") ?? "";
  if (!Number.isSafeInteger(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return { problem: "missing or malformed ticket", status: 403 };
  let mac: Uint8Array;
  try {
    mac = new Uint8Array(await crypto.subtle.sign("HMAC", await ticketKey(db), new TextEncoder().encode(ticketText(s, exp))));
  } catch {
    return { problem: "the ticket could not be checked", status: 503 };
  }
  // Signature first (constant time), then the clock: a forged ticket learns nothing from the expiry check.
  if (!sameSecret(b64url(mac), sig)) return { problem: "invalid ticket", status: 403 };
  if (exp < now || exp > now + EMBED_TICKET_TTL_MS + 60_000) return { problem: "expired ticket (reload the block)", status: 403 };
  return s;
}

/** SHA-256 sources (`'sha256-...'`) of the page's inline scripts, or null when it has more than `MAX_SCRIPTS`. */
export async function inlineScriptHashes(html: string): Promise<string[] | null> {
  const out = new Set<string>();
  let n = 0;
  // A script element's text ends at the first `</script` (the HTML tokenizer's rule for the common case). A page that
  // nests markup the regex reads differently gets a hash that matches nothing: its script is blocked, never allowed.
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script/gi)) {
    if (/\bsrc\s*=/i.test(m[1] ?? "")) continue;
    if (++n > MAX_SCRIPTS) return null;
    // The parser normalizes newlines (CRLF, CR → LF) before the browser hashes the text.
    const text = (m[2] ?? "").replace(/\r\n?/g, "\n");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    out.add(`'sha256-${btoa(String.fromCharCode(...digest))}'`);
  }
  return [...out];
}

/** The page's Content-Security-Policy. */
export function embedCsp(scriptHashes: string[], ancestors: string[]): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${scriptHashes.length ? scriptHashes.join(" ") : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors.join(" ")}`,
  ].join("; ");
}

const EMBED_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()",
};

/** A refusal shown inside the iframe: plain text, no script. */
function refusal(status: number, message: string, ancestors: string[]): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": `sandbox; default-src 'none'; frame-ancestors ${ancestors.join(" ")}`, ...EMBED_HEADERS },
  });
}

/** `GET /embed/<project>/<env><route>?dashboard&exp&sig`: an embed block's page (see the top of this file). */
export async function serveEmbed(request: Request, env: ProjectEnv & { REGISTRY?: D1Like; DASHBOARD_ORIGIN?: unknown }, url: URL, fetchImpl: typeof fetch): Promise<Response> {
  const ancestors = allowedOrigins(env, url);
  if (request.method !== "GET" && request.method !== "HEAD") return refusal(405, "use GET", ancestors);
  if (!env.REGISTRY) return refusal(500, "the REGISTRY binding is missing", ancestors);
  const s = await checkTicket(env.REGISTRY, url);
  if ("problem" in s) return refusal(s.status, s.problem, ancestors);
  const target = await environment(env.REGISTRY, s.project, s.env);
  if (!target) return refusal(404, `${s.project}/${s.env} is not in the registry`, ancestors);
  let res: Response;
  try {
    res = await projectAdmin(env, target, `/api/_ember/dashboards/embed?${new URLSearchParams({ dashboard: s.dashboard, route: s.route })}`, fetchImpl);
  } catch (e) {
    return refusal(502, `${target.worker} did not answer (${(e as Error).message})`, ancestors);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `${target.worker} answered ${res.status}`;
    try {
      const b = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (b.error?.code === "not_found" && b.error.message === "not found") message = `${target.worker} runs an older runtime without embed pages: update the runtime (ember deploy)`;
      else if (b.error) message = `${b.error.code ?? "error"}: ${b.error.message ?? ""}`;
    } catch {
      // not JSON: the status says enough
    }
    return refusal(res.status === 404 ? 404 : 502, message, ancestors);
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "text/html") {
    await res.body?.cancel().catch(() => undefined);
    return refusal(502, `the embed route answered ${type || "no content type"}, not text/html`, ancestors);
  }
  const bytes = await readLimited(res.body, EMBED_MAX_BYTES);
  if (!bytes) return refusal(502, `the embed page is over ${EMBED_MAX_BYTES} bytes`, ancestors);
  const html = new TextDecoder().decode(bytes);
  const hashes = await inlineScriptHashes(html);
  if (!hashes) return refusal(502, `the embed page has more than ${MAX_SCRIPTS} inline scripts`, ancestors);
  return new Response(request.method === "HEAD" ? null : (bytes as Uint8Array<ArrayBuffer>), {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": embedCsp(hashes, ancestors), ...EMBED_HEADERS },
  });
}
