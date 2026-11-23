/**
 * Turnstile on the auth routes (PLAN §13), run by the Worker *before* it hashes or verifies a password, so a bot
 * request costs a siteverify call instead of a scrypt hash and never reaches the Auth DO.
 *
 *   ember.json  "auth": { "turnstile": true }        // or { endpoints, expectedAction, allowedHostnames }
 *   secret      ember env set TURNSTILE_SECRET_KEY    // .dev.vars in `ember dev`
 *   client      header `x-captcha-response: <token from the Turnstile widget>` on sign-up / sign-in / password reset
 *
 * Responses are Better Auth's captcha plugin's (provider `cloudflare-turnstile`, 1.7): 400 `MISSING_RESPONSE`, 403
 * `VERIFICATION_FAILED`, 500 `UNKNOWN_ERROR` (siteverify unreachable, not 2xx, not JSON, or past 10 s). Turnstile
 * tokens are single-use, so verification happens exactly once (here, not again in the DO) and is never retried.
 *
 * The plugin itself is not used: it is reached through `better-auth/plugins` (every plugin) and resolves the client IP
 * with zod, ~85 KiB the Worker would evaluate for one POST. What it does is reproduced here step for step (endpoint
 * matching, the `remoteip` it sends, the checks on the answer); `test/node/turnstile-parity.test.ts` runs both against
 * the same fake siteverify.
 */

/** Worker secret holding the Turnstile secret key. */
export const TURNSTILE_SECRET_ENV = "TURNSTILE_SECRET_KEY";

/** Cloudflare's siteverify endpoint. */
export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Better Auth's bound on one siteverify call (the plugin's `CAPTCHA_VERIFY_TIMEOUT_MS`): past it, fail closed. */
export const TURNSTILE_VERIFY_TIMEOUT_MS = 10_000;

/** The plugin's default endpoints (relative to the base path). */
export const TURNSTILE_DEFAULT_ENDPOINTS: readonly string[] = ["/sign-up/email", "/sign-in/email", "/request-password-reset"];

export interface TurnstileSettings {
  /**
   * Auth paths (relative to the base path, wildcards allowed) that need a token. Default: Better Auth's
   * `/sign-up/email`, `/sign-in/email`, `/request-password-reset`. Gated whatever the method (GET included); only
   * CORS preflights (OPTIONS) pass, since they cannot carry the token header.
   */
  endpoints?: string[];
  /** Reject tokens minted for another widget action. */
  expectedAction?: string;
  /** Reject tokens issued for other hostnames. */
  allowedHostnames?: string[];
  /** Env var with the secret key. Default `TURNSTILE_SECRET_KEY`. */
  secretEnv?: string;
  /** Siteverify URL override (tests). */
  siteVerifyURL?: string;
}

/** Better Auth's `advanced.ipAddress` (what decides the `remoteip` sent to siteverify). */
export interface TurnstileIpAddressOptions {
  ipAddressHeaders?: string[] | undefined;
  disableIpTracking?: boolean | undefined;
  ipv6Subnet?: number | undefined;
  trustedProxies?: string[] | undefined;
}

/** The part of the Better Auth options the gate reads (a `BetterAuthOptions` fits). */
export interface TurnstileGateOptions {
  basePath?: string | undefined;
  advanced?: { ipAddress?: TurnstileIpAddressOptions | undefined } | undefined;
}

type Gate = (request: Request, env: Record<string, unknown>) => Promise<Response | null>;

const json = (status: number, code: string, message: string) => new Response(JSON.stringify({ code, message }), { status, headers: { "content-type": "application/json" } });
/** Better Auth's `middlewareResponse` (key order and header spelling included). */
const pluginResponse = (status: number, code: string, message: string) => new Response(JSON.stringify({ message, code }), { status, headers: { "Content-Type": "application/json" } });

const logger = {
  error: (msg: string, ...rest: unknown[]) => console.error(`ember-auth turnstile: ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`ember-auth turnstile: ${msg}`, ...rest),
};

/** A gate for `<basePath>/*` requests: a Response to send back (rejected), or null to go on. */
export function turnstileGate(settings: TurnstileSettings | true, options: TurnstileGateOptions): Gate {
  const s: TurnstileSettings = settings === true ? {} : settings;
  const secretEnv = s.secretEnv ?? TURNSTILE_SECRET_ENV;
  const basePath = options.basePath ?? "/api/auth";
  // On Cloudflare the client IP is `cf-connecting-ip` (Better Auth's default header is only `x-forwarded-for`).
  const ip: TurnstileIpAddressOptions = {
    ...options.advanced?.ipAddress,
    ipAddressHeaders: options.advanced?.ipAddress?.ipAddressHeaders ?? ["cf-connecting-ip", "x-forwarded-for"],
  };
  const endpoints = s.endpoints?.length ? s.endpoints : TURNSTILE_DEFAULT_ENDPOINTS;
  const matchers = endpoints.map((e) => (e.includes("*") ? wildcardMatch(e) : (p: string) => p === e));
  const siteVerifyURL = s.siteVerifyURL || TURNSTILE_SITEVERIFY_URL;
  let warned = false;
  return async (request, env) => {
    // Every method on a configured endpoint (a custom GET endpoint is gated too), except CORS preflights: a browser
    // sends OPTIONS without custom headers, so it can never carry `x-captcha-response`.
    if (request.method === "OPTIONS") return null;
    let pathname: string;
    try {
      pathname = normalizeEndpointPath(new URL(request.url).pathname, basePath);
    } catch (e) {
      return unknownError(request, e);
    }
    if (!matchers.some((m) => m(pathname))) return null;
    const secretKey = typeof env[secretEnv] === "string" ? (env[secretEnv] as string) : "";
    if (!secretKey) {
      // Fail closed on protected paths with our own code (the plugin answers a generic 500), and put the fix in the
      // log rather than in the response.
      if (!warned) {
        warned = true;
        console.error(`ember-auth: auth.turnstile is on but ${secretEnv} is not set (ember env set ${secretEnv}; .dev.vars in ember dev): protected auth routes answer 500`);
      }
      return json(500, "CAPTCHA_NOT_CONFIGURED", "Captcha is not configured on this server");
    }
    const captchaResponse = request.headers.get("x-captcha-response");
    if (!captchaResponse) return pluginResponse(400, "MISSING_RESPONSE", "Missing CAPTCHA response");
    const remoteIP = clientIP(request.headers, ip);
    try {
      return await siteverify({ siteVerifyURL, secretKey, captchaResponse, remoteIP, expectedAction: s.expectedAction, allowedHostnames: s.allowedHostnames });
    } catch (e) {
      return unknownError(request, e);
    }
  };
}

function unknownError(request: Request, e: unknown): Response {
  logger.error(e instanceof Error ? e.message : "Unknown error", { endpoint: request.url, message: e });
  return pluginResponse(500, "UNKNOWN_ERROR", "Something went wrong");
}

type SiteverifyAnswer = { success?: unknown; "error-codes"?: unknown; hostname?: unknown; action?: unknown };

/** One siteverify call, as the plugin's `cloudflareTurnstile` handler makes it; null when the token passes. */
async function siteverify(o: {
  siteVerifyURL: string;
  secretKey: string;
  captchaResponse: string;
  remoteIP: string | null;
  expectedAction: string | undefined;
  allowedHostnames: string[] | undefined;
}): Promise<Response | null> {
  const res = await fetch(o.siteVerifyURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: o.secretKey, response: o.captchaResponse, ...(o.remoteIP ? { remoteip: o.remoteIP } : {}) }),
    signal: AbortSignal.timeout(TURNSTILE_VERIFY_TIMEOUT_MS),
  });
  // As better-fetch reads it: a non-2xx answer is no data; a JSON or text body is parsed as JSON, else kept as the
  // text; any other content type is a Blob (data, but without `success`: rejected).
  let data: unknown = null;
  if (res.ok) {
    if (bodyKind(res.headers.get("content-type")) === "blob") data = await res.blob();
    else {
      const text = await res.text();
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = text;
      }
    }
  } else await res.body?.cancel().catch(() => {});
  if (!data) throw new Error("CAPTCHA service unavailable");
  const answer = data as SiteverifyAnswer;
  const failed = (details: Record<string, unknown>) => {
    logger.warn("Cloudflare Turnstile verification failed", { provider: "cloudflare-turnstile", ...details });
    return pluginResponse(403, "VERIFICATION_FAILED", "Captcha verification failed");
  };
  if (!answer.success) {
    return failed({ reason: "siteverify_rejected", errorCodes: answer["error-codes"] ?? [], ...(answer.hostname ? { hostname: answer.hostname } : {}), ...(answer.action ? { action: answer.action } : {}) });
  }
  if (o.expectedAction && answer.action !== o.expectedAction) return failed({ reason: "action_mismatch", expectedAction: o.expectedAction, actualAction: answer.action });
  if (o.allowedHostnames && o.allowedHostnames.length > 0 && !(answer.hostname && o.allowedHostnames.includes(answer.hostname as string))) {
    return failed({ reason: "hostname_mismatch", allowedHostnames: o.allowedHostnames, actualHostname: answer.hostname });
  }
  return null;
}

const JSON_TYPE = /^application\/(?:[\w!#$%&*.^`~-]*\+)?json(;.+)?$/i;
const TEXT_TYPES = new Set(["image/svg", "application/xml", "application/xhtml", "application/html"]);
/** better-fetch's `detectResponseType`. */
function bodyKind(contentType: string | null): "json" | "text" | "blob" {
  if (!contentType) return "json";
  const type = contentType.split(";").shift() || "";
  if (JSON_TYPE.test(type)) return "json";
  return TEXT_TYPES.has(type) || type.startsWith("text/") ? "text" : "blob";
}

/** The plugin's path normalization: relative to the base path, no repeated or trailing slashes. */
export function normalizeEndpointPath(pathname: string, basePath: string): string {
  let p = (pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname).replace(/\/{2,}/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

// --- Better Auth's wildcard matcher (src/utils/wildcard.ts, MIT), with `/` as the separator. ---------------------

const REGEXP_SPECIAL = new Set(["-", "^", "$", "+", ".", "(", ")", "|", "[", "]", "{", "}", "*", "?", "\\"]);
const escapeRegExpChar = (c: string) => (REGEXP_SPECIAL.has(c) ? `\\${c}` : c);

function wildcardPattern(pattern: string): string {
  const separatorMatcher = "[/\\\\]";
  const wildcard = "[^/\\\\]";
  const requiredSeparator = `${separatorMatcher}+?`;
  const optionalSeparator = `${separatorMatcher}*?`;
  const segments = pattern.split("/");
  let result = "";
  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s]!;
    const nextSegment = segments[s + 1];
    if (!segment && s > 0) continue;
    const currentSeparator = s === segments.length - 1 ? optionalSeparator : nextSegment !== "**" ? requiredSeparator : "";
    if (segment === "**") {
      if (currentSeparator) {
        result += s === 0 ? "" : currentSeparator;
        result += `(?:${wildcard}*?${currentSeparator})*?`;
      }
      continue;
    }
    for (let c = 0; c < segment.length; c++) {
      const char = segment[c]!;
      if (char === "\\") {
        if (c < segment.length - 1) {
          result += escapeRegExpChar(segment[c + 1]!);
          c++;
        }
      } else if (char === "?") result += wildcard;
      else if (char === "*") result += `${wildcard}*?`;
      else result += escapeRegExpChar(char);
    }
    result += currentSeparator;
  }
  return result;
}

/** `wildcardMatch(pattern)` of Better Auth: `*` within one segment, `**` across segments, `?` one character. */
export function wildcardMatch(pattern: string): (sample: string) => boolean {
  const re = new RegExp(`^${wildcardPattern(pattern)}$`);
  return (sample) => re.test(sample);
}

// --- Better Auth's client IP (@better-auth/core utils/ip.ts, MIT), without zod. ------------------------------------

const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const IPV6_ALPHABET = /^[0-9a-fA-F:.]+$/;

const isIPv4 = (ip: string) => IPV4.test(ip);
/** zod's `z.ipv6()`: hex digits, colons and dots only, and a valid bracketed URL host. */
function isIPv6(ip: string): boolean {
  if (!IPV6_ALPHABET.test(ip)) return false;
  try {
    if (typeof URL.canParse === "function") return URL.canParse(`http://[${ip}]`);
    new URL(`http://[${ip}]`);
    return true;
  } catch {
    return false;
  }
}
const isValidIP = (ip: string) => isIPv4(ip) || isIPv6(ip);

function expandIPv6(ipv6: string): string[] {
  if (ipv6.includes("::")) {
    const sides = ipv6.split("::");
    const left = sides[0] ? sides[0].split(":") : [];
    const right = sides[1] ? sides[1].split(":") : [];
    const zeros = Array<string>(8 - left.length - right.length).fill("0000");
    return [...left.map((g) => g.padStart(4, "0")), ...zeros, ...right.map((g) => g.padStart(4, "0"))];
  }
  return ipv6.split(":").map((g) => g.padStart(4, "0"));
}

function extractIPv4FromMapped(ipv6: string): string | null {
  const lower = ipv6.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.substring(7);
    if (isIPv4(v4)) return v4;
  }
  const parts = ipv6.split(":");
  if (parts.length === 7 && parts[5]?.toLowerCase() === "ffff") {
    const v4 = parts[6];
    if (v4 && isIPv4(v4)) return v4;
  }
  if (lower.includes("::ffff:") || lower.includes(":ffff:")) {
    const g = expandIPv6(ipv6);
    if (g.length === 8 && g[0] === "0000" && g[1] === "0000" && g[2] === "0000" && g[3] === "0000" && g[4] === "0000" && g[5] === "ffff" && g[6] && g[7]) {
      return `${Number.parseInt(g[6].substring(0, 2), 16)}.${Number.parseInt(g[6].substring(2, 4), 16)}.${Number.parseInt(g[7].substring(0, 2), 16)}.${Number.parseInt(g[7].substring(2, 4), 16)}`;
    }
  }
  return null;
}

function normalizeIPv6(ipv6: string, subnetPrefix?: number): string {
  const groups = expandIPv6(ipv6);
  if (subnetPrefix !== undefined && subnetPrefix < 128) {
    let bits = Math.max(0, Math.floor(subnetPrefix));
    return groups
      .map((group) => {
        if (bits <= 0) return "0000";
        if (bits >= 16) {
          bits -= 16;
          return group;
        }
        const masked = Number.parseInt(group, 16) & ((65535 << (16 - bits)) & 65535);
        bits = 0;
        return masked.toString(16).padStart(4, "0");
      })
      .join(":")
      .toLowerCase();
  }
  return groups.join(":").toLowerCase();
}

function normalizeIP(ip: string, ipv6Subnet?: number): string {
  if (isIPv4(ip)) return ip.toLowerCase();
  if (!isIPv6(ip)) return ip.toLowerCase();
  const v4 = extractIPv4FromMapped(ip);
  if (v4) return v4.toLowerCase();
  return normalizeIPv6(ip, ipv6Subnet ?? 64);
}

function ipToBytes(ip: string): Uint8Array | null {
  if (isIPv4(ip)) return Uint8Array.from(ip.split(".").map(Number));
  if (!isIPv6(ip)) return null;
  const mapped = extractIPv4FromMapped(ip);
  if (mapped) return Uint8Array.from(mapped.split(".").map(Number));
  const groups = expandIPv6(ip);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = Number.parseInt(groups[i] ?? "0", 16);
    bytes[i * 2] = (group >> 8) & 255;
    bytes[i * 2 + 1] = group & 255;
  }
  return bytes;
}

function parseCIDR(value: string): { bytes: Uint8Array; prefix: number } | null {
  const slash = value.lastIndexOf("/");
  const bytes = ipToBytes(slash === -1 ? value : value.slice(0, slash));
  if (!bytes) return null;
  const maxBits = bytes.length * 8;
  if (slash === -1) return { bytes, prefix: maxBits };
  const prefixPart = value.slice(slash + 1);
  if (!/^\d+$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  return prefix <= maxBits ? { bytes, prefix } : null;
}

function matchesCIDR(ip: Uint8Array, net: { bytes: Uint8Array; prefix: number }): boolean {
  if (ip.length !== net.bytes.length) return false;
  let bits = net.prefix;
  for (let i = 0; i < ip.length && bits > 0; i++) {
    const take = bits >= 8 ? 8 : bits;
    const mask = take === 8 ? 255 : (255 << (8 - take)) & 255;
    if (((ip[i] ?? 0) & mask) !== ((net.bytes[i] ?? 0) & mask)) return false;
    bits -= 8;
  }
  return true;
}

function ipFromHeader(value: string, o: TurnstileIpAddressOptions): string | null {
  const forwarded = value.split(",").map((ip) => ip.trim()).filter(Boolean);
  if (forwarded.length === 0) return null;
  const trusted = (o.trustedProxies ?? []).map(parseCIDR).filter((p): p is NonNullable<typeof p> => p !== null);
  if (trusted.length > 0) {
    for (let i = forwarded.length - 1; i >= 0; i--) {
      const ip = forwarded[i];
      const bytes = ip ? ipToBytes(ip) : null;
      if (!ip || !bytes) return null;
      if (trusted.some((p) => matchesCIDR(bytes, p))) continue;
      return normalizeIP(ip, o.ipv6Subnet);
    }
    return null;
  }
  if (forwarded.length !== 1) return null;
  const ip = forwarded[0]!;
  return isValidIP(ip) ? normalizeIP(ip, o.ipv6Subnet) : null;
}

/** Better Auth reads NODE_ENV (and TEST) once, through `globalThis.process.env`: dev and test fall back to localhost. */
function devFallback(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const nodeEnv = env?.NODE_ENV ?? "";
  const test = env?.TEST;
  return nodeEnv === "dev" || nodeEnv === "development" || nodeEnv === "test" || (test ? test !== "false" : false);
}

/** Better Auth's `getIP`: the `remoteip` the captcha plugin sends (null: none). */
export function clientIP(headers: Headers, o: TurnstileIpAddressOptions): string | null {
  if (o.disableIpTracking) return null;
  for (const key of o.ipAddressHeaders || ["x-forwarded-for"]) {
    const value = headers.get(key);
    if (typeof value === "string") {
      const ip = ipFromHeader(value, o);
      if (ip) return ip;
    }
  }
  return devFallback() ? "127.0.0.1" : null;
}
