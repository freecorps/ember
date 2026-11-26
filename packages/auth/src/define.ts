/**
 * `defineAuth` for `ember/auth.config.ts`.
 *
 * The config is plain Better Auth options plus an optional `ember` block. It must be a pure value
 * (no database, no secret): the CLI evaluates it in Node at codegen time (`authTablesManifest`,
 * migrations) and the Worker / `Auth` DO evaluate the same module at runtime. Ember injects
 * `database`, `secret`, the `jwt()` and `bearer()` plugins, `advanced.cookiePrefix`, the cookie
 * cache and the password hooks (see `resolveAuthOptions`).
 *
 * Better Auth is pinned to a minor version (`~1.7.28`): the DDL path uses
 * `@better-auth/core/db/internal`, which is not a public API.
 */
import type { BetterAuthOptions } from "better-auth";
import { installFetchTimeout } from "./fetch-timeout.ts";
import { assertPasswordRules, type PasswordRule } from "./password-rules.ts";

// Before auth.config.ts builds its clients (it imports defineAuth first): one that captures `globalThis.fetch` when
// built, like the Stripe SDK's `createFetchHttpClient()`, then gets the bounded fetch (`ember.fetchTimeoutMs`).
installFetchTimeout();

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
  /**
   * Ceiling, in milliseconds, on each outbound `fetch` Better Auth and its plugins make from the `Auth` Durable Object
   * (discovery, token exchange and JWKS of sso and genericOAuth, haveIBeenPwned, ...): past it the request fails with a
   * `TimeoutError` instead of holding that auth request until the client gives up. A plugin's own shorter timeout still
   * applies (jose's JWKS fetch: 5 s); a longer one is capped (the Stripe SDK's `timeout`, 80 s by default, when its
   * client uses the global fetch: raise this if a plugin needs more). Default 10000; `0` or `false` turns it off.
   * Nothing else in the isolate is affected (the Worker, other Durable Objects, actions).
   */
  fetchTimeoutMs?: number | false;
}

/** Options Ember owns; setting them in auth.config.ts is an error. */
export const INJECTED_OPTIONS = ["database", "secret", "secondaryStorage"] as const;

/**
 * Claims every Ember session's token carries (`jwt.definePayload` in `resolveAuthOptions`; a session-token or cookie
 * identity has the same): the Better Auth session id and the user's email, name and verification.
 */
export type SessionClaims = {
  /** Better Auth session id. */
  sid: string;
  email: string;
  name: string;
  emailVerified: boolean;
};
/** With the `organization()` plugin: the session's active organization (absent when none is active). */
export type OrganizationClaims = { org?: string };

type Expand<T> = { [K in keyof T]: T[K] };
type HasPlugin<O, Id extends string> = O extends { plugins?: infer P } ? (P extends ReadonlyArray<infer E> ? ([Extract<E, { id: Id }>] extends [never] ? false : true) : false) : false;
type CustomClaims<O> = O extends { ember?: { claims?: infer F } } ? (F extends (...args: never) => infer R ? Awaited<R> : {}) : {};

/**
 * The claims of an identity signed in with these options: `SessionClaims`, `org` with the organization plugin, and
 * what `ember.claims` returns. Those are optional: only a JWT carries them (an identity from a session token or the
 * session cookie has the Better Auth claims alone).
 */
export type ClaimsOfOptions<O> = Expand<SessionClaims & (HasPlugin<O, "organization"> extends true ? OrganizationClaims : {}) & Partial<CustomClaims<O>>>;

/**
 * The claims of the identities an `ember/auth.config.ts` signs in (`ClaimsOf<typeof authConfig>`): what codegen prints
 * in `_generated/claims.d.ts`, typing `ctx.auth.require().claims` and `fromAuth("...")`. `SessionClaims` for a config
 * that does not tell (plain Better Auth options).
 */
export type ClaimsOf<C> = C extends { readonly __claims?: infer K } ? Exclude<K, undefined> : SessionClaims;

export type EmberAuthConfig<O extends BetterAuthOptions = BetterAuthOptions, Claims = SessionClaims> = O & {
  ember?: EmberAuthExtras;
  /** Brand checked by the CLI so it can tell an Ember auth config from a random default export. */
  readonly __emberAuth: true;
  /** Type only (never set): the claims of the identities it signs in (`ClaimsOf`). */
  readonly __claims?: Claims;
};

export type DefineAuthInput = Omit<BetterAuthOptions, (typeof INJECTED_OPTIONS)[number]> & { ember?: EmberAuthExtras };

function defineAuthValue<const O extends DefineAuthInput>(options: O): EmberAuthConfig<O & BetterAuthOptions, ClaimsOfOptions<O>> {
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
  return Object.freeze({ ...options, __emberAuth: true as const }) as unknown as EmberAuthConfig<O & BetterAuthOptions, ClaimsOfOptions<O>>;
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
  fetchTimeoutMsOf(e.fetchTimeoutMs, "defineAuth");
}

/** A valid `ember.fetchTimeoutMs` as milliseconds (0: no bound); anything else throws, so a typo never turns it off. */
function fetchTimeoutMsOf(t: unknown, who: string): number {
  if (t === undefined) return DEFAULT_FETCH_TIMEOUT_MS;
  if (t === false) return 0;
  if (typeof t === "number" && Number.isInteger(t) && t >= 0 && t <= MAX_FETCH_TIMEOUT_MS) return t;
  throw new Error(`${who}: ember.fetchTimeoutMs must be a whole number of milliseconds from 0 to ${MAX_FETCH_TIMEOUT_MS}, or false (0 and false turn the bound off)`);
}

/** Default `ember.fetchTimeoutMs`. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
/** The longest `ember.fetchTimeoutMs` (a timer's limit: 2^31 - 1 ms, about 24.8 days). */
export const MAX_FETCH_TIMEOUT_MS = 2_147_483_647;

/**
 * The outbound fetch bound the `Auth` DO runs with (`ember.fetchTimeoutMs`): milliseconds, 0 for none. Checked again
 * here: a plain Better Auth options object (no `defineAuth`) with an `ember` block reaches the DO unvalidated.
 */
export function fetchTimeoutOf(config: unknown): number {
  return fetchTimeoutMsOf((config as { ember?: { fetchTimeoutMs?: unknown } } | null)?.ember?.fetchTimeoutMs, "auth");
}

/** The Worker's bindings and variables, as the `Auth` DO and the Worker see them. */
export type AuthEnv = Record<string, unknown>;

/**
 * `defineAuth((env) => ({...}))`: options that depend on the environment (a variable, a binding a hook writes to). Codegen
 * calls it with an empty `env` (the tables must not depend on it); the Worker and the `Auth` DO with their own.
 */
export type EmberAuthFactory<Claims = SessionClaims> = {
  readonly __emberAuth: true;
  readonly factory: (env: AuthEnv) => EmberAuthConfig;
  /** Type only (never set): the claims of the identities it signs in (`ClaimsOf`). */
  readonly __claims?: Claims;
};

export function defineAuth<const O extends DefineAuthInput>(build: (env: AuthEnv) => O): EmberAuthFactory<ClaimsOfOptions<O>>;
export function defineAuth<const O extends DefineAuthInput>(options: O): EmberAuthConfig<O & BetterAuthOptions, ClaimsOfOptions<O>>;
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
