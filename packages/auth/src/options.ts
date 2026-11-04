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

export const DEFAULT_BASE_PATH = "/api/auth";
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
  baseURL?: string;
  database?: BetterAuthOptions["database"];
  /** Replaces `emailAndPassword.password` (the Auth DO passes its pre-hashed lookup here). */
  password?: PasswordHooks;
  onUserChange?: UserChangeHook;
}

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function assertProjectName(project: string) {
  if (!PROJECT_RE.test(project)) {
    throw new Error(`auth: project name "${project}" must match ${PROJECT_RE} (it is used as the cookie prefix)`);
  }
}

/** The JWT issuer Ember pins when `baseURL` is static; null means "resolved per request". */
export function jwtIssuer(baseURL: string | undefined): string | null {
  if (!baseURL) return null;
  return new URL(baseURL).origin;
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

  const userHooks = options.databaseHooks?.user;
  const onUserChange = r.onUserChange;
  const databaseHooks: BetterAuthOptions["databaseHooks"] = onUserChange
    ? {
        ...options.databaseHooks,
        user: {
          ...userHooks,
          create: {
            ...userHooks?.create,
            after: async (user, ctx) => {
              await userHooks?.create?.after?.(user, ctx);
              await onUserChange("create", user);
            },
          },
          update: {
            ...userHooks?.update,
            after: async (user, ctx) => {
              await userHooks?.update?.after?.(user, ctx);
              await onUserChange("update", user);
            },
          },
          delete: {
            ...userHooks?.delete,
            after: async (user, ctx) => {
              await userHooks?.delete?.after?.(user, ctx);
              await onUserChange("delete", user);
            },
          },
        },
      }
    : options.databaseHooks;

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
  if (r.database) out.database = r.database;
  if (databaseHooks) out.databaseHooks = databaseHooks;
  if (r.password && options.emailAndPassword) {
    out.emailAndPassword = { ...options.emailAndPassword, password: r.password };
  }
  return out;
}
