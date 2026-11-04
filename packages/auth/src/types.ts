/**
 * Verified caller identity. Structurally identical to `Identity` in `@ember/server` (kept local so
 * this package has no dependency on the engine).
 */
export type Identity = {
  subject: string;
  issuer?: string;
  /** Expiry, seconds since epoch. */
  exp?: number;
  claims?: Record<string, unknown>;
};
