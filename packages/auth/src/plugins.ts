/**
 * Better Auth plugins at the version Ember pins (`~1.7.17`), so `ember/auth.config.ts` can import them without
 * depending on `better-auth` directly:
 *
 *   import { organization, twoFactor } from "@freecorps/ember-auth/plugins";
 *
 * Do not add `jwt()` or `bearer()`: Ember injects them.
 */
export * from "better-auth/plugins";
