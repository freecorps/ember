/**
 * `@freecorps/ember-auth/remote`: `remoteAuth` alone, for a Worker whose users live in another project (SSO, `auth:
 * { from }`, PLAN §21) or in the backend an app is moving from (L14). Imports `jose`, the session lookup and the
 * verifier core: no Better Auth (that is ~750 KiB the SSO Worker does not bundle nor evaluate at cold start).
 * `@freecorps/ember-auth/worker` re-exports the same `remoteAuth`.
 */
import { env as workerEnv } from "cloudflare:workers";
import type { JSONWebKeySet } from "jose";
import type { AuthEnv } from "./define.ts";
import { createSessionCheck, type SessionLookupSettings } from "./remote-session.ts";
import { DEFAULT_BASE_PATH } from "./types.ts";
import { createVerifier, toSessionInfo, type VerifyOptions } from "./verify-core.ts";

export interface SsoSettings {
  /** URL of the identity project (its Worker serves `<from>/api/auth/jwks`). */
  from: string;
  basePath?: string;
  /** Expected issuer. Default: origin of `from`. `null` skips the check. */
  issuer?: string | null;
  jwks?: JSONWebKeySet;
  sensitive?: boolean;
  fetch?: typeof fetch;
  /**
   * Session check at the origin for `sensitive` calls with a JWT (PLAN §22 L14): without it a sensitive check of a
   * JWT fails closed (there is no session-by-id endpoint to ask). `{ url, secretEnv? }` POSTs a signed `{ sid, sub }`
   * to the origin (`@freecorps/ember-auth/session-lookup` has its side); a function is a custom integration.
   */
  sessionLookup?: SessionLookupSettings;
  /** Env override for `sessionLookup.secretEnv` (tests). Default: `env` from `cloudflare:workers`. */
  env?: AuthEnv;
}

/**
 * SSO (`auth: { from: "<identity-project-url>" }`, PLAN §21), or the backend an app is moving from (L14): verify
 * JWTs issued by another project against its remote JWKS. Opaque session tokens are checked against the identity
 * project's `get-session`. Sensitive mode with a JWT asks `sessionLookup` whether the session (`sid`) is alive, and
 * fails closed without one (no remote session-by-id API).
 */
export function remoteAuth(sso: SsoSettings) {
  const doFetch = sso.fetch ?? ((input: RequestInfo, init?: RequestInit) => fetch(input, init));
  const base = sso.from.replace(/\/+$/, "") + (sso.basePath ?? DEFAULT_BASE_PATH);
  const issuer = sso.issuer === undefined ? new URL(sso.from).origin : sso.issuer;
  const sessions = sso.sessionLookup
    ? createSessionCheck(sso.sessionLookup, { fetch: doFetch as typeof fetch, env: () => sso.env ?? (workerEnv as unknown as AuthEnv) })
    : null;
  const verifier = createVerifier({
    issuer,
    audience: null,
    jwks: {
      static: sso.jwks ?? null,
      fetch: async () => {
        const r = await doFetch(`${base}/jwks`);
        if (!r.ok) throw new Error(`auth: JWKS fetch from ${base}/jwks failed (${r.status})`);
        return (await r.json()) as JSONWebKeySet;
      },
    },
    cookie: null,
    lookupBySessionId: false,
    lookup: async (q) => {
      if (!("token" in q)) return null;
      const r = await doFetch(`${base}/get-session?disableCookieCache=true`, { headers: { authorization: `Bearer ${q.token}` } });
      if (!r.ok) return null;
      return toSessionInfo(await r.json());
    },
    ...(sessions ? { sessionCheck: sessions.check } : {}),
    ...(sso.sensitive !== undefined ? { sensitive: sso.sensitive } : {}),
  });
  return {
    verify: (token: string, o?: VerifyOptions) => verifier.verify(token, o),
    verifySensitive: (token: string, o?: Omit<VerifyOptions, "sensitive">) => verifier.verify(token, { ...o, sensitive: true }),
    verifyDetailed: (token: string, o?: VerifyOptions) => verifier.verifyDetailed(token, o),
    verifier: () => verifier,
    /** Where users, sessions and keys live (`EmberAuthHook.remote`): the dashboard says so instead of an error. */
    remote: { from: sso.from },
    /** Session lookup counters (tests, diagnostics); null without `sessionLookup`. */
    sessionLookupStats: () => sessions?.stats() ?? null,
  };
}

export { createSessionCheck, DEFAULT_SESSION_LOOKUP_TIMEOUT_MS } from "./remote-session.ts";
export type { SessionLookupClaims, SessionLookupFn, SessionLookupSettings } from "./remote-session.ts";
export { classifyToken } from "./verify-core.ts";
export type { AuthVia, Verifier, VerifyOptions, VerifyResult } from "./verify-core.ts";
export type { Identity } from "./types.ts";
