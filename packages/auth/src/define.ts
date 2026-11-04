/**
 * `defineAuth` for `ember/auth.config.ts`.
 *
 * The config is plain Better Auth options plus an optional `ember` block. It must be a pure value
 * (no database, no secret): the CLI evaluates it in Node at codegen time (`authTablesManifest`,
 * migrations) and the Worker / `Auth` DO evaluate the same module at runtime. Ember injects
 * `database`, `secret`, the `jwt()` and `bearer()` plugins, `advanced.cookiePrefix`, the cookie
 * cache and the password hooks (see `resolveAuthOptions`).
 *
 * Better Auth is pinned to a minor version (`~1.7.17`): the DDL path uses
 * `@better-auth/core/db/internal`, which is not a public API.
 */
import type { BetterAuthOptions } from "better-auth";

/** Session + user as Better Auth hands them to `jwt.definePayload`. */
export type AuthSession = {
  user: { id: string; email: string; name: string; emailVerified: boolean } & Record<string, unknown>;
  session: { id: string; userId: string; expiresAt: Date } & Record<string, unknown>;
};

export interface EmberAuthExtras {
  /** Extra JWT claims (keep them small: they ride along with every request / socket). */
  claims?: (session: AuthSession) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** JWT lifetime. Default "5m" (PLAN §9). */
  jwtTtl?: string | number;
  /** Cookie-cache lifetime in seconds. Default 300. */
  cookieCacheMaxAge?: number;
}

/** Options Ember owns; setting them in auth.config.ts is an error. */
export const INJECTED_OPTIONS = ["database", "secret", "secondaryStorage"] as const;

export type EmberAuthConfig<O extends BetterAuthOptions = BetterAuthOptions> = O & {
  ember?: EmberAuthExtras;
  /** Brand checked by the CLI so it can tell an Ember auth config from a random default export. */
  readonly __emberAuth: true;
};

export type DefineAuthInput = Omit<BetterAuthOptions, (typeof INJECTED_OPTIONS)[number]> & { ember?: EmberAuthExtras };

export function defineAuth<const O extends DefineAuthInput>(options: O): EmberAuthConfig<O & BetterAuthOptions> {
  for (const k of INJECTED_OPTIONS) {
    if (k in (options as Record<string, unknown>)) {
      throw new Error(`defineAuth: "${k}" is managed by Ember (auth runs in the Auth Durable Object); remove it from auth.config.ts`);
    }
  }
  const pluginIds = new Set<string>();
  for (const p of options.plugins ?? []) {
    if (pluginIds.has(p.id)) throw new Error(`defineAuth: plugin "${p.id}" is listed twice`);
    pluginIds.add(p.id);
  }
  return Object.freeze({ ...options, __emberAuth: true as const }) as unknown as EmberAuthConfig<O & BetterAuthOptions>;
}

export function isEmberAuthConfig(x: unknown): x is EmberAuthConfig {
  return typeof x === "object" && x !== null && (x as { __emberAuth?: unknown }).__emberAuth === true;
}
