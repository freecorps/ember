/**
 * Turn a user `defineAuth(...)` config into the final Better Auth options Ember runs.
 *
 * Pure (no Cloudflare APIs): the CLI calls it at codegen time with no database so
 * `getAuthTables(options)` sees exactly the tables the `Auth` DO will create (the injected jwt
 * plugin adds `jwks`, `rateLimit.storage: "database"` adds `rateLimit`).
 */
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { bearer, jwt } from "better-auth/plugins";
import type { AuthSession, EmberAuthConfig, EmberAuthExtras } from "./define.ts";

import { DEFAULT_BASE_PATH, jwtIssuer } from "./settings.ts";

export { DEFAULT_BASE_PATH, jwtIssuer };
export const DEFAULT_JWT_TTL = "5m";
export const DEFAULT_COOKIE_CACHE_MAX_AGE = 5 * 60;

export type UserChangeEvent = "create" | "update" | "delete";
/**
 * Profile sync hook (PLAN §9): called in the `Auth` DO after a user row is created, updated or
 * deleted (Better Auth runs `databaseHooks.*.after` once the write has committed). The runtime
 * wires this to an outbox that delivers `internal.users.sync` to the target shard.
 */
export type UserChangeHook = (event: UserChangeEvent, user: Record<string, unknown>) => void | Promise<void>;

export type PasswordHooks = {
  hash: (password: string) => Promise<string>;
  verify: (data: { hash: string; password: string }) => Promise<boolean>;
};

export interface ResolveOptions {
  /** Project name: becomes `advanced.cookiePrefix` (PLAN §21). */
  project: string;
  secret?: string;
  /**
   * Rotated secrets, newest first (`EMBER_AUTH_SECRET_R<n>`): Better Auth's versioned `secrets` (the first signs and
   * encrypts, the others decrypt); `secret` stays as the legacy key for payloads encrypted before any rotation.
   */
  secrets?: Array<{ version: number; value: string }>;
  baseURL?: string;
  database?: BetterAuthOptions["database"];
  /** Replaces `emailAndPassword.password` (the Auth DO passes its pre-hashed lookup here). */
  password?: PasswordHooks;
  onUserChange?: UserChangeHook;
}

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * `onUserChange` as the `databaseHooks` of a plugin (`init` → `options.databaseHooks`), so they run before every other
 * plugin's and the config's: the outbox gets a user's events in the order the writes happened.
 */
function profileSyncPlugin(onUserChange: UserChangeHook): BetterAuthPlugin {
  const hook = (event: UserChangeEvent) => ({ after: async (user: Record<string, unknown>) => void (await onUserChange(event, user)) });
  return {
    id: "ember-profile-sync",
    init: () => ({ options: { databaseHooks: { user: { create: hook("create"), update: hook("update"), delete: hook("delete") } } } }),
  } as BetterAuthPlugin;
}

export function assertProjectName(project: string) {
  if (!PROJECT_RE.test(project)) {
    throw new Error(`auth: project name "${project}" must match ${PROJECT_RE} (it is used as the cookie prefix)`);
  }
}


function stripEmber(config: EmberAuthConfig | BetterAuthOptions): { options: BetterAuthOptions; extras: EmberAuthExtras } {
  const { ember, __emberAuth: _brand, ...options } = config as EmberAuthConfig;
  return { options: options as BetterAuthOptions, extras: ember ?? {} };
}

export function userPasswordHooks(config: EmberAuthConfig | BetterAuthOptions): PasswordHooks | undefined {
  const p = (config as BetterAuthOptions).emailAndPassword?.password;
  return p?.hash && p.verify ? { hash: p.hash, verify: p.verify } : undefined;
}

export function resolveAuthOptions(config: EmberAuthConfig | BetterAuthOptions, r: ResolveOptions): BetterAuthOptions {
  assertProjectName(r.project);
  const { options, extras } = stripEmber(config);
  const plugins: BetterAuthPlugin[] = [...((options.plugins ?? []) as BetterAuthPlugin[])];
  if (plugins.some((p) => p.id === "jwt")) {
    throw new Error("auth: Ember adds the jwt() plugin itself (5 min tokens verified in the Worker); remove it from auth.config.ts");
  }
  const baseURL = r.baseURL ?? (typeof options.baseURL === "string" ? options.baseURL : undefined);
  const issuer = jwtIssuer(baseURL);
  const claims = extras.claims;
  plugins.push(
    jwt({
      jwt: {
        expirationTime: extras.jwtTtl ?? DEFAULT_JWT_TTL,
        ...(issuer ? { issuer, audience: issuer } : {}),
        definePayload: async (s) => {
          const session = s as unknown as AuthSession;
          const org = session.session.activeOrganizationId;
          return {
            sid: session.session.id,
            email: session.user.email,
            name: session.user.name,
            emailVerified: session.user.emailVerified,
            ...(typeof org === "string" ? { org } : {}),
            ...(claims ? await claims(session) : {}),
          };
        },
      },
    }) as unknown as BetterAuthPlugin,
  );
  if (!plugins.some((p) => p.id === "bearer")) plugins.push(bearer() as unknown as BetterAuthPlugin);

  const cookieCache = options.session?.cookieCache;
  const strategy = cookieCache?.strategy ?? "compact";
  if (strategy === "jwt") throw new Error('auth: session.cookieCache.strategy "jwt" is not supported; use "compact" (default) or "jwe"');

  // Profile sync runs as the *first* plugin's hooks: Better Auth runs plugin `databaseHooks` in plugin order and the
  // config's own last, and a plugin's `user.create.after` may write the user (stripe's `createCustomerOnSignUp`), whose
  // `update` would otherwise reach the outbox before the `create` (an upserting `users.sync` would end on the stale row).
  const onUserChange = r.onUserChange;
  if (onUserChange) plugins.unshift(profileSyncPlugin(onUserChange));

  const out: BetterAuthOptions = {
    ...options,
    basePath: options.basePath ?? DEFAULT_BASE_PATH,
    plugins,
    advanced: { ...options.advanced, cookiePrefix: r.project },
    session: {
      ...options.session,
      cookieCache: {
        maxAge: extras.cookieCacheMaxAge ?? DEFAULT_COOKIE_CACHE_MAX_AGE,
        ...cookieCache,
        enabled: cookieCache?.enabled ?? true,
        strategy,
      },
    },
    // No secondaryStorage (PLAN §9): rate limits live in the Auth DO's SQLite.
    rateLimit: { ...options.rateLimit, storage: options.rateLimit?.storage ?? "database" },
  };
  if (baseURL) out.baseURL = baseURL;
  if (r.secret) out.secret = r.secret;
  if (r.secrets?.length) out.secrets = r.secrets;
  if (r.database) out.database = r.database;
  if (r.password && options.emailAndPassword) {
    out.emailAndPassword = { ...options.emailAndPassword, password: r.password };
  }
  return out;
}
