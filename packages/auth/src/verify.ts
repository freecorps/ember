/**
 * `verify(token)` for the Ember Worker (PLAN §9): `verify-core.ts` with Better Auth's cookie-cache decoder wired in
 * (path (b), `<project>.session_data`). `remoteAuth` (SSO: no cookie cache) builds on `verify-core.ts` directly.
 */
import { getCookieCache } from "better-auth/cookies";
import { createVerifier as createCoreVerifier, type CookieCacheReader, type VerifierConfig } from "./verify-core.ts";

export { classifyToken, toSessionInfo } from "./verify-core.ts";
export type { AuthVia, CookieCacheReader, SessionInfo, SessionQuery, TokenKind, Verifier, VerifierConfig, VerifyOptions, VerifyResult } from "./verify-core.ts";

const readCookieCache: CookieCacheReader = (headers, opts) => getCookieCache(headers, opts);

export function createVerifier(cfg: VerifierConfig) {
  return createCoreVerifier({ readCookieCache, ...cfg });
}
