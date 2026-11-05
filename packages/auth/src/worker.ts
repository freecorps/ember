/**
 * Workerd side of `@freecorps/ember-auth`: the `Auth` Durable Object hosting Better Auth next to its SQLite,
 * the `/api/auth/*` fetch handler with Worker-side password hashing, and `verify(token)`.
 *
 *   // generated worker entry
 *   import authConfig from "../ember/auth.config.ts";
 *   const auth = emberAuth(authConfig, { project: "acme" });
 *   export const Auth = auth.Auth;
 *   export default createEmberWorker({ ..., auth });   // auth.verify(token)
 *   // and in fetch: (await auth.fetch(request, env)) ?? <ember routes>
 */
import { DurableObject, env as workerEnv } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { JSONWebKeySet } from "jose";
import { doSqliteAdapter, sqlStorageExecutor } from "./adapter.ts";
import { migrate, schemaFingerprint, userJournalDDL, type MigrateOptions } from "./ddl.ts";
import type { EmberAuthConfig } from "./define.ts";
import { DEFAULT_BASE_PATH, jwtIssuer, resolveAuthOptions, userPasswordHooks, type PasswordHooks, type UserChangeEvent } from "./options.ts";
import {
  defaultHasher,
  LocalHashError,
  PASSWORD_RULES,
  preparePasswordPlan,
  type CredentialLookup,
  type PasswordPlan,
  type PasswordRule,
} from "./password.ts";
import type { Identity } from "./types.ts";
import { createVerifier, type SessionInfo, type SessionQuery, type Verifier, type VerifyOptions, type VerifyResult } from "./verify.ts";

export type AuthEnv = Record<string, unknown>;

/** Context handed to the profile-sync hook, inside the Auth DO. */
export type UserChangeContext = { storage: DurableObjectStorage; env: AuthEnv };
export type ProfileSyncHook = (event: UserChangeEvent, user: Record<string, unknown>, ctx: UserChangeContext) => void | Promise<void>;

export interface EmberAuthSettings {
  /** Project name (`ember.json`): cookie prefix `<project>.session_token`. */
  project: string;
  /** DO namespace binding of the `Auth` class. Default "AUTH". */
  binding?: string;
  /** `idFromName` of the single Auth DO. Default "auth". */
  instance?: string;
  /** Public base URL (pins the JWT issuer). Default: env `EMBER_AUTH_URL`, then `baseURL` in the config. */
  baseURL?: string;
  /** Default: env `EMBER_AUTH_SECRET`, then `BETTER_AUTH_SECRET`. */
  secret?: string;
  /** Every verify does the authoritative DO lookup (path c). */
  sensitive?: boolean;
  /** Fail instead of hashing inside the DO when an endpoint was not prepared by the Worker. */
  strictHashing?: boolean;
  /** Extra / overridden password-bearing endpoints (relative to basePath). */
  passwordRules?: Record<string, PasswordRule>;
  /** Profile sync (PLAN §9): wire to the runtime outbox → `internal.users.sync`. */
  onUserChange?: ProfileSyncHook;
  /** Static JWKS embedded at deploy. Default: env `EMBER_AUTH_JWKS` (JSON). */
  jwks?: JSONWebKeySet;
  /** Env override (tests). Default: `env` from `cloudflare:workers`. */
  env?: AuthEnv;
}

export interface SsoSettings {
  /** URL of the identity project (its Worker serves `<from>/api/auth/jwks`). */
  from: string;
  basePath?: string;
  /** Expected issuer. Default: origin of `from`. `null` skips the check. */
  issuer?: string | null;
  jwks?: JSONWebKeySet;
  sensitive?: boolean;
  fetch?: typeof fetch;
}

/** RPC surface of the Auth DO used by the Worker (narrow on purpose: Better Auth types are huge). */
export interface AuthRpc {
  handle(request: Request, plan?: PasswordPlan): Promise<Response>;
  credentialHash(lookup: CredentialLookup): Promise<string | null>;
  lookupSession(q: SessionQuery): Promise<SessionInfo | null>;
  getJwks(): Promise<JSONWebKeySet>;
  stats(): Promise<AuthStats>;
  /** Current user row for profile sync (outbox recovery), or null. */
  userForSync(id: string): Promise<Record<string, unknown> | null>;
}

export type AuthStats = { localHashes: number; plannedHashes: number; plannedVerifies: number; migration: string[] };

type AuthInstance = {
  handler(request: Request): Promise<Response>;
  api: Record<string, (...args: any[]) => Promise<any>>;
  $context: Promise<any>;
};

const toSessionInfo = (s: { session: Record<string, any>; user: Record<string, any> } | null): SessionInfo | null => {
  if (!s) return null;
  const org = s.session.activeOrganizationId;
  return {
    userId: s.user.id,
    sessionId: s.session.id,
    expiresAt: new Date(s.session.expiresAt).getTime(),
    email: s.user.email,
    name: s.user.name,
    emailVerified: Boolean(s.user.emailVerified),
    org: typeof org === "string" ? org : null,
  };
};

const asHeaders = (h: [string, string][]) => new Headers(h);

const stringEnv = (env: AuthEnv, k: string) => (typeof env[k] === "string" && env[k] ? (env[k] as string) : undefined);

function parseJwksEnv(v: unknown): JSONWebKeySet | null {
  if (!v) return null;
  try {
    const j = (typeof v === "string" ? JSON.parse(v) : v) as JSONWebKeySet;
    return Array.isArray(j?.keys) ? j : null;
  } catch {
    return null;
  }
}

/** Instance of the Auth DO class (what `ctx.exports` / bindings see). */
export type AuthDurableObject = DurableObject<AuthEnv> & AuthRpc & { readonly options: BetterAuthOptions };
export type AuthClass = new (ctx: DurableObjectState, env: AuthEnv) => AuthDurableObject;

export interface EmberAuth {
  basePath: string;
  /** The `Auth` Durable Object class: export it from the Worker entry under the binding's class name. */
  Auth: AuthClass;
  /** Handle `<basePath>/*` (password work in the Worker); null for other paths. */
  fetch(request: Request, env?: AuthEnv): Promise<Response | null>;
  /** `EmberAuthHook.verify`: JWT → cookie-cache value → session token. */
  verify(token: string, o?: VerifyOptions): Promise<Identity | null>;
  /** Always the authoritative DO lookup (revocation-exact). */
  verifySensitive(token: string): Promise<Identity | null>;
  verifyRequest(request: Request, o?: VerifyOptions): Promise<Identity | null>;
  verifyDetailed(token: string, o?: VerifyOptions): Promise<VerifyResult | null>;
  verifyRequestDetailed(request: Request, o?: VerifyOptions): Promise<VerifyResult | null>;
  /** Stub of the Auth DO (internal RPC). */
  stub(env?: AuthEnv): AuthRpc;
  verifier(): Verifier;
  workerStats(): { workerHashes: number; workerVerifies: number };
}

export function emberAuth(config: EmberAuthConfig | BetterAuthOptions, settings: EmberAuthSettings): EmberAuth {
  const bindingName = settings.binding ?? "AUTH";
  const instance = settings.instance ?? "auth";
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const rules = { ...PASSWORD_RULES, ...settings.passwordRules };
  const hasher: PasswordHooks = userPasswordHooks(config) ?? defaultHasher;
  const workerStats = { workerHashes: 0, workerVerifies: 0 };
  const countingHasher: PasswordHooks = {
    hash: (p) => (workerStats.workerHashes++, hasher.hash(p)),
    verify: (d) => (workerStats.workerVerifies++, hasher.verify(d)),
  };

  const getEnv = (): AuthEnv => settings.env ?? (workerEnv as unknown as AuthEnv);
  const secretOf = (env: AuthEnv) => {
    const s = settings.secret ?? stringEnv(env, "EMBER_AUTH_SECRET") ?? stringEnv(env, "BETTER_AUTH_SECRET");
    if (!s) throw new Error("auth: missing secret (set EMBER_AUTH_SECRET)");
    return s;
  };
  const baseURLOf = (env: AuthEnv) =>
    settings.baseURL ?? stringEnv(env, "EMBER_AUTH_URL") ?? (typeof config.baseURL === "string" ? config.baseURL : undefined);

  const stubOf = (env: AuthEnv): AuthRpc => {
    const ns = env[bindingName] as DurableObjectNamespace | undefined;
    if (!ns) throw new Error(`auth: missing Durable Object binding ${bindingName}`);
    return ns.get(ns.idFromName(instance)) as unknown as AuthRpc;
  };

  const planStore = new AsyncLocalStorage<PasswordPlan | undefined>();

  class Auth extends DurableObject<AuthEnv> implements AuthRpc {
    readonly auth: AuthInstance;
    readonly options: BetterAuthOptions;
    private counters = { localHashes: 0, plannedHashes: 0, plannedVerifies: 0 };
    private applied: string[] = [];

    constructor(ctx: DurableObjectState, env: AuthEnv) {
      super(ctx, env);
      const executor = sqlStorageExecutor(ctx.storage.sql, (fn) => ctx.storage.transaction(() => fn(executor)));
      const password: PasswordHooks = {
        hash: async (pw) => {
          const hit = planStore.getStore()?.hashes.find(([p]) => p === pw);
          if (hit) {
            this.counters.plannedHashes++;
            return hit[1];
          }
          if (settings.strictHashing) throw new LocalHashError("password hash");
          this.counters.localHashes++;
          return hasher.hash(pw);
        },
        verify: async ({ hash, password: pw }) => {
          const hit = planStore.getStore()?.verdicts.find((v) => v.hash === hash && v.password === pw);
          if (hit) {
            this.counters.plannedVerifies++;
            return hit.ok;
          }
          if (settings.strictHashing) throw new LocalHashError("password verify");
          this.counters.localHashes++;
          return hasher.verify({ hash, password: pw });
        },
      };
      const sync = settings.onUserChange;
      const baseURL = baseURLOf(env);
      this.options = resolveAuthOptions(config, {
        project: settings.project,
        secret: secretOf(env),
        ...(baseURL ? { baseURL } : {}),
        database: doSqliteAdapter(executor),
        password,
        ...(sync ? { onUserChange: (event, user) => sync(event, user, { storage: ctx.storage, env }) } : {}),
      });
      this.auth = betterAuth(this.options) as unknown as AuthInstance;
      void ctx.blockConcurrencyWhile(async () => {
        await this.migrate();
        // Profile sync: journal user writes atomically (triggers), so a change whose after-hook never ran (the DO died
        // in between) is recovered by the outbox alarm. Every boot: a table rebuild drops triggers.
        if (sync) for (const stmt of userJournalDDL(this.options)) ctx.storage.sql.exec(stmt);
      });
    }

    /** The user's current row for profile sync (outbox recovery of a lost hook), or null when it is gone. */
    async userForSync(id: string): Promise<Record<string, unknown> | null> {
      const ctx = await this.auth.$context;
      return ((await ctx.internalAdapter.findUserById(id)) as Record<string, unknown> | null) ?? null;
    }

    /** Additive migration on boot; skipped when the schema fingerprint is unchanged. */
    protected async migrate(opts: MigrateOptions = {}) {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS "_ember_auth_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`);
      const fp = await schemaFingerprint(this.options, opts);
      const row = sql.exec(`SELECT "value" FROM "_ember_auth_meta" WHERE "key" = 'schema'`).toArray()[0];
      if (row?.value === fp) return;
      this.ctx.storage.transactionSync(() => {
        this.applied = migrate(sql, this.options, opts);
        sql.exec(`INSERT OR REPLACE INTO "_ember_auth_meta" ("key", "value") VALUES ('schema', ?)`, fp);
      });
    }

    override async fetch(request: Request) {
      return this.handle(request);
    }

    async handle(request: Request, plan?: PasswordPlan) {
      return planStore.run(plan, () => this.auth.handler(request));
    }

    async credentialHash(lookup: CredentialLookup): Promise<string | null> {
      const ctx = await this.auth.$context;
      let userId: string | undefined;
      if ("email" in lookup) {
        const found = await ctx.internalAdapter.findUserByEmail(lookup.email.toLowerCase(), { includeAccounts: true });
        if (!found) return null;
        const acc = (found.accounts as { providerId: string; accountId: string; password?: string | null }[]).find(
          (a) => a.providerId === "credential" && a.accountId === found.user.id,
        );
        return acc?.password ?? null;
      }
      const s = await this.auth.api.getSession!({ headers: asHeaders(lookup.headers), query: { disableCookieCache: true } });
      userId = s?.user?.id;
      if (!userId) return null;
      const acc = await ctx.internalAdapter.findCredentialAccount(userId);
      return acc?.password ?? null;
    }

    async lookupSession(q: SessionQuery): Promise<SessionInfo | null> {
      if ("sessionId" in q) {
        const ctx = await this.auth.$context;
        const session = await ctx.adapter.findOne({ model: "session", where: [{ field: "id", value: q.sessionId }] });
        if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
        const user = await ctx.internalAdapter.findUserById(session.userId);
        return user ? toSessionInfo({ session, user }) : null;
      }
      const headers = "token" in q ? new Headers({ authorization: `Bearer ${q.token}` }) : asHeaders(q.headers);
      const s = await this.auth.api.getSession!({ headers, query: { disableCookieCache: true } }).catch(() => null);
      return toSessionInfo(s);
    }

    async getJwks(): Promise<JSONWebKeySet> {
      return (await this.auth.api.getJwks!()) as JSONWebKeySet;
    }

    async stats(): Promise<AuthStats> {
      return { ...this.counters, migration: this.applied };
    }
  }

  let verifier: Verifier | null = null;
  const getVerifier = () => {
    if (verifier) return verifier;
    const env = getEnv();
    const issuer = jwtIssuer(baseURLOf(env));
    verifier = createVerifier({
      issuer,
      audience: issuer,
      jwks: {
        static: settings.jwks ?? parseJwksEnv(env.EMBER_AUTH_JWKS),
        fetch: () => stubOf(getEnv()).getJwks(),
      },
      cookie: { secret: secretOf(env), prefix: settings.project, strategy: config.session?.cookieCache?.strategy === "jwe" ? "jwe" : "compact" },
      lookup: (q) => stubOf(getEnv()).lookupSession(q),
      ...(settings.sensitive !== undefined ? { sensitive: settings.sensitive } : {}),
    });
    return verifier;
  };

  /**
   * Handle `<basePath>/*`: returns null for other paths. Password work for known endpoints happens
   * here, in the Worker, before the request reaches the DO.
   */
  async function fetchHandler(request: Request, env: AuthEnv = getEnv()): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname !== basePath && !url.pathname.startsWith(basePath + "/")) return null;
    const stub = stubOf(env);
    const route = url.pathname.slice(basePath.length) || "/";
    const { request: forward, plan } = await preparePasswordPlan(request, route, countingHasher, (by) => stub.credentialHash(by), rules);
    return stub.handle(forward, plan);
  }

  return {
    basePath,
    /** The `Auth` Durable Object class: export it from the Worker entry under the binding's class name. */
    Auth,
    fetch: fetchHandler,
    /** `EmberAuthHook.verify`: JWT → cookie-cache value → session token. */
    verify: (token: string, o?: VerifyOptions): Promise<Identity | null> => getVerifier().verify(token, o),
    verifySensitive: (token: string) => getVerifier().verify(token, { sensitive: true }),
    verifyRequest: (request: Request, o?: VerifyOptions) => getVerifier().verifyRequest(request, o),
    verifyDetailed: (token: string, o?: VerifyOptions): Promise<VerifyResult | null> => getVerifier().verifyDetailed(token, o),
    verifyRequestDetailed: (request: Request, o?: VerifyOptions) => getVerifier().verifyRequestDetailed(request, o),
    /** Stub of the Auth DO (internal RPC). */
    stub: (env: AuthEnv = getEnv()) => stubOf(env),
    verifier: getVerifier,
    workerStats: () => ({ ...workerStats }),
  };
}

/**
 * SSO (`auth: { from: "<identity-project-url>" }`, PLAN §21): verify JWTs issued by another Ember
 * project against its remote JWKS. Opaque session tokens are checked against the identity
 * project's `get-session`. Sensitive mode with a JWT fails closed (no remote session-by-id API).
 */
export function remoteAuth(sso: SsoSettings) {
  const doFetch = sso.fetch ?? ((input: RequestInfo, init?: RequestInit) => fetch(input, init));
  const base = sso.from.replace(/\/+$/, "") + (sso.basePath ?? DEFAULT_BASE_PATH);
  const issuer = sso.issuer === undefined ? new URL(sso.from).origin : sso.issuer;
  const verifier = createVerifier({
    issuer,
    audience: null,
    jwks: {
      static: sso.jwks ?? null,
      fetch: async () => {
        const r = await doFetch(`${base}/jwks`);
        if (!r.ok) throw new Error(`auth: JWKS fetch from ${base}/jwks failed (${r.status})`);
        return (await r.json()) as JSONWebKeySet;
      },
    },
    cookie: null,
    lookupBySessionId: false,
    lookup: async (q) => {
      if (!("token" in q)) return null;
      const r = await doFetch(`${base}/get-session?disableCookieCache=true`, { headers: { authorization: `Bearer ${q.token}` } });
      if (!r.ok) return null;
      return toSessionInfo((await r.json()) as { session: Record<string, any>; user: Record<string, any> } | null);
    },
    ...(sso.sensitive !== undefined ? { sensitive: sso.sensitive } : {}),
  });
  return {
    verify: (token: string, o?: VerifyOptions) => verifier.verify(token, o),
    verifySensitive: (token: string) => verifier.verify(token, { sensitive: true }),
    verifyDetailed: (token: string, o?: VerifyOptions) => verifier.verifyDetailed(token, o),
    verifier: () => verifier,
  };
}

export { doSqliteAdapter, sqlStorageExecutor } from "./adapter.ts";
export type { SqlExecutor, SqlValue } from "./adapter.ts";
export { classifyToken, createVerifier } from "./verify.ts";
export type { AuthVia, SessionInfo, SessionQuery, Verifier, VerifierConfig, VerifyOptions, VerifyResult } from "./verify.ts";
export { defaultHasher, LocalHashError, PASSWORD_RULES, preparePasswordPlan } from "./password.ts";
export type { CredentialLookup, PasswordPlan, PasswordRule } from "./password.ts";
export type { Identity } from "./types.ts";
