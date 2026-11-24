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
import { assertPasswordRules, type PasswordRule } from "./password-rules.ts";

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
  /**
   * Copy Better Auth data into the app's shards as read-only `auth:*` tables (PLAN §22 L3, contracts.md "Replicação
   * entre shards"). `organization: true` (or `{ shard: "<kind>" }`, default `"org"`): `organization`, `member`,
   * `invitation`, `team` and `teamMember` rows go to the shard `<kind>:<organizationId>`, and the `user` row of every
   * member goes to each organization shard the user belongs to. Needs the `organization()` plugin.
   */
  replicate?: { organization?: boolean | { shard?: string } };
  /**
   * Password-bearing endpoints of plugins Ember does not know (relative to `basePath`), so their passwords are hashed
   * and verified in the Worker like the built-in ones (`PASSWORD_RULES`; a rule here replaces a built-in one for the
   * same path). `hash`: body fields holding new passwords; `verify`: the body field holding a password to check and how
   * the Worker finds the stored hash (`by`: `"email"`, `"username"`, `"phoneNumber"` — read from the body field of that
   * name, or `keyField` — or `"session"`). Without a rule, such an endpoint hashes inside the single `Auth` Durable
   * Object (slow, serializes every auth request) or fails under `strictHashing`.
   *
   *   ember: { passwordRules: { "/my-plugin/sign-in": { verify: { field: "secret", by: "email" } } } }
   *
   * Plain data: the CLI embeds it in the Worker entry, so requests are routed without loading Better Auth.
   */
  passwordRules?: Record<string, PasswordRule>;
  /**
   * `user` fields that never leave the `Auth` Durable Object, besides the ones Better Auth marks `returned: false`: kept
   * out of the profile sync (`internal.users.sync`) and of the `auth:user` replica tables. For a plugin that stores a
   * secret on the user row. Each name must be a field of the user model (checked at codegen).
   */
  hiddenUserFields?: string[];
}

/** Options Ember owns; setting them in auth.config.ts is an error. */
export const INJECTED_OPTIONS = ["database", "secret", "secondaryStorage"] as const;

export type EmberAuthConfig<O extends BetterAuthOptions = BetterAuthOptions> = O & {
  ember?: EmberAuthExtras;
  /** Brand checked by the CLI so it can tell an Ember auth config from a random default export. */
  readonly __emberAuth: true;
};

export type DefineAuthInput = Omit<BetterAuthOptions, (typeof INJECTED_OPTIONS)[number]> & { ember?: EmberAuthExtras };

function defineAuthValue<const O extends DefineAuthInput>(options: O): EmberAuthConfig<O & BetterAuthOptions> {
  for (const k of INJECTED_OPTIONS) {
    if (k in (options as Record<string, unknown>)) {
      throw new Error(`defineAuth: "${k}" is managed by Ember (auth runs in the Auth Durable Object); remove it from auth.config.ts`);
    }
  }
  assertEmberExtras((options as { ember?: unknown }).ember);
  const pluginIds = new Set<string>();
  for (const p of options.plugins ?? []) {
    if (pluginIds.has(p.id)) throw new Error(`defineAuth: plugin "${p.id}" is listed twice`);
    pluginIds.add(p.id);
  }
  return Object.freeze({ ...options, __emberAuth: true as const }) as unknown as EmberAuthConfig<O & BetterAuthOptions>;
}

/** Checks the parts of the `ember` block that are plain data (embedded in the Worker entry, read at codegen). */
function assertEmberExtras(ember: unknown): void {
  if (ember === undefined) return;
  if (typeof ember !== "object" || ember === null || Array.isArray(ember)) throw new Error("defineAuth: ember must be an object");
  const e = ember as Record<string, unknown>;
  if (e.passwordRules !== undefined) assertPasswordRules(e.passwordRules, "defineAuth: ember.passwordRules");
  const hidden = e.hiddenUserFields;
  if (hidden !== undefined && (!Array.isArray(hidden) || !hidden.every((f) => typeof f === "string" && f.length > 0))) {
    throw new Error('defineAuth: ember.hiddenUserFields must be an array of user field names, like ["pluginSecret"]');
  }
}

/** The Worker's bindings and variables, as the `Auth` DO and the Worker see them. */
export type AuthEnv = Record<string, unknown>;

/**
 * `defineAuth((env) => ({...}))`: options that depend on the environment (a variable, a binding a hook writes to). Codegen
 * calls it with an empty `env` (the tables must not depend on it); the Worker and the `Auth` DO with their own.
 */
export type EmberAuthFactory = {
  readonly __emberAuth: true;
  readonly factory: (env: AuthEnv) => EmberAuthConfig;
};

export function defineAuth<const O extends DefineAuthInput>(build: (env: AuthEnv) => O): EmberAuthFactory;
export function defineAuth<const O extends DefineAuthInput>(options: O): EmberAuthConfig<O & BetterAuthOptions>;
export function defineAuth(input: DefineAuthInput | ((env: AuthEnv) => DefineAuthInput)): EmberAuthConfig | EmberAuthFactory {
  if (typeof input === "function") {
    return Object.freeze({ __emberAuth: true as const, factory: (env: AuthEnv) => defineAuthValue(input(env)) });
  }
  return defineAuthValue(input);
}

/** True for `defineAuth(...)`'s value and function forms. */
export function isEmberAuthConfig(x: unknown): x is EmberAuthConfig | EmberAuthFactory {
  return typeof x === "object" && x !== null && (x as { __emberAuth?: unknown }).__emberAuth === true;
}

/** The options for `env`: the value form as is, the function form called with it. */
export function resolveAuthConfig(config: EmberAuthConfig | EmberAuthFactory | BetterAuthOptions, env: AuthEnv): EmberAuthConfig | BetterAuthOptions {
  return isEmberAuthConfig(config) && "factory" in config && typeof config.factory === "function" ? config.factory(env) : (config as EmberAuthConfig | BetterAuthOptions);
}
