/**
 * `verify(token)` for the Ember Worker (PLAN §9): `verify-core.ts` with Better Auth's cookie-cache decoder wired in
 * (path (b), `<project>.session_data`). `remoteAuth` (SSO: no cookie cache) builds on `verify-core.ts` directly.
 *
 * The decoder (`better-auth/cookies`: Better Auth's cookie helpers, better-call and zod, ~190 KiB) is imported on the
 * first request that carries a cookie cache: `verify-core.ts` calls it only then. JWTs and session tokens never load
 * it, and the Worker bundler puts it in its own chunk, outside every isolate's startup.
 */
import { createVerifier as createCoreVerifier, type CookieCacheReader, type VerifierConfig } from "./verify-core.ts";

export { classifyToken, toSessionInfo } from "./verify-core.ts";
export type { AuthVia, CookieCacheReader, SessionInfo, SessionQuery, TokenKind, Verifier, VerifierConfig, VerifyOptions, VerifyResult } from "./verify-core.ts";

const readCookieCache: CookieCacheReader = async (headers, opts) => (await import("better-auth/cookies")).getCookieCache(headers, opts);

/** Always Better Auth's cookie-cache decoder (a caller's own goes to `verify-core.ts`'s `createVerifier`). */
export function createVerifier(cfg: Omit<VerifierConfig, "readCookieCache">) {
  return createCoreVerifier({ ...cfg, readCookieCache });
}
