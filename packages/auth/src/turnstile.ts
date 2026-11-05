/**
 * Turnstile on the auth routes (PLAN §13): Better Auth's `captcha` plugin with provider `cloudflare-turnstile`,
 * run by the Worker *before* it hashes or verifies a password, so a bot request costs a siteverify call instead of
 * a scrypt hash and never reaches the Auth DO.
 *
 *   ember.json  "auth": { "turnstile": true }        // or { endpoints, expectedAction, allowedHostnames }
 *   secret      ember env set TURNSTILE_SECRET_KEY    // .dev.vars in `ember dev`
 *   client      header `x-captcha-response: <token from the Turnstile widget>` on sign-up / sign-in / password reset
 *
 * Responses are Better Auth's: 400 `MISSING_RESPONSE`, 403 `VERIFICATION_FAILED`, 500 `UNKNOWN_ERROR` (siteverify
 * unreachable). Turnstile tokens are single-use, so verification happens exactly once (here, not again in the DO).
 */
import type { BetterAuthOptions } from "better-auth";
import { captcha } from "better-auth/plugins";

/** Worker secret holding the Turnstile secret key. */
export const TURNSTILE_SECRET_ENV = "TURNSTILE_SECRET_KEY";

export interface TurnstileSettings {
  /**
   * Auth paths (relative to the base path, wildcards allowed) that need a token. Default: Better Auth's
   * `/sign-up/email`, `/sign-in/email`, `/request-password-reset`.
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

type Gate = (request: Request, env: Record<string, unknown>) => Promise<Response | null>;

const json = (status: number, code: string, message: string) => new Response(JSON.stringify({ code, message }), { status, headers: { "content-type": "application/json" } });

/** A gate for `<basePath>/*` requests: a Response to send back (rejected), or null to go on. */
export function turnstileGate(settings: TurnstileSettings | true, options: Pick<BetterAuthOptions, "basePath" | "advanced">): Gate {
  const s: TurnstileSettings = settings === true ? {} : settings;
  const secretEnv = s.secretEnv ?? TURNSTILE_SECRET_ENV;
  // The plugin reads the client IP through Better Auth's `getIP`: on Cloudflare that is `cf-connecting-ip`.
  const ctxOptions = {
    basePath: options.basePath,
    advanced: {
      ...options.advanced,
      ipAddress: { ...options.advanced?.ipAddress, ipAddressHeaders: options.advanced?.ipAddress?.ipAddressHeaders ?? ["cf-connecting-ip", "x-forwarded-for"] },
    },
  };
  const logger = {
    error: (msg: string, ...rest: unknown[]) => console.error(`ember-auth turnstile: ${msg}`, ...rest),
    warn: (msg: string, ...rest: unknown[]) => console.warn(`ember-auth turnstile: ${msg}`, ...rest),
    info: () => {},
    debug: () => {},
  };
  let warned = false;
  return async (request, env) => {
    if (request.method !== "POST") return null;
    const secretKey = typeof env[secretEnv] === "string" ? (env[secretEnv] as string) : "";
    const plugin = captcha({
      provider: "cloudflare-turnstile",
      secretKey,
      ...(s.endpoints ? { endpoints: s.endpoints } : {}),
      ...(s.expectedAction ? { expectedAction: s.expectedAction } : {}),
      ...(s.allowedHostnames ? { allowedHostnames: s.allowedHostnames } : {}),
      ...(s.siteVerifyURL ? { siteVerifyURLOverride: s.siteVerifyURL } : {}),
    });
    if (!secretKey) {
      // No secret: the plugin answers 500 for protected paths (MISSING_SECRET_KEY, logged) and passes the others.
      // Fail closed on those with our own code, and put the fix in the log rather than in the response.
      const probe = await plugin.onRequest(request, { options: ctxOptions, logger: { ...logger, error: () => {} } } as never);
      if (!probe) return null;
      if (!warned) {
        warned = true;
        console.error(`ember-auth: auth.turnstile is on but ${secretEnv} is not set (ember env set ${secretEnv}; .dev.vars in ember dev): protected auth routes answer 500`);
      }
      return json(500, "CAPTCHA_NOT_CONFIGURED", "Captcha is not configured on this server");
    }
    const out = await plugin.onRequest(request, { options: ctxOptions, logger } as never);
    return out?.response ?? null;
  };
}
