/**
 * Verified caller identity. Structurally identical to `Identity` in `@freecorps/ember-server` (kept local so
 * this package has no dependency on the engine).
 */
export type Identity = {
  subject: string;
  issuer?: string;
  /** Expiry, seconds since epoch. */
  exp?: number;
  /** When the token was issued, seconds since epoch (JWT `iat`). */
  iat?: number;
  claims?: Record<string, unknown>;
};
