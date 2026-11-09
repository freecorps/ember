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
import { migrate, schemaFingerprint, USER_JOURNAL_TABLE, userJournalDDL, type MigrateOptions } from "./ddl.ts";
import { resolveAuthConfig, type AuthEnv, type EmberAuthConfig, type EmberAuthFactory } from "./define.ts";
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
import { turnstileGate, type TurnstileSettings } from "./turnstile.ts";
import type { Identity } from "./types.ts";
import { createVerifier, type SessionInfo, type SessionQuery, type Verifier, type VerifyOptions, type VerifyResult } from "./verify.ts";

export type { AuthEnv };

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
  /**
   * Turnstile on sign-up / sign-in / password reset (ember.json `auth.turnstile`): Better Auth's captcha plugin, run
   * in the Worker before any password work. Secret: env `TURNSTILE_SECRET_KEY` (`ember env set`).
   */
  turnstile?: TurnstileSettings | true;
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
  /** Retires the current JWT signing keys and mints a new one (key rotation); returns the public JWKS. */
  rotateJwks(): Promise<JSONWebKeySet>;
  /**
   * Runs `auth.api[endpoint]` in the DO (a server-side call: no HTTP, no cookies set) and answers its result, or
   * `{ error }` with Better Auth's status and code when it throws. For the Worker's own code only: anything a plugin
   * marks server-only is reachable here.
   */
  api(endpoint: string, input?: AuthApiInput): Promise<AuthApiResult>;
  /**
   * Inserts `user` and `account` rows as given (ids and password hashes kept), skipping ids already there, in one
   * transaction. Answers why it imported nothing instead of throwing.
   */
  importUsers(rows: AuthImport): Promise<AuthImportResult>;
}

/** What `api` passes to the endpoint: Better Auth's `{ body, query, headers }`. */
export type AuthApiInput = { body?: unknown; query?: Record<string, unknown>; headers?: [string, string][] };
export type AuthApiResult = { ok: true; value: unknown } | { ok: false; error: { status: number; code: string; message: string } };

/** Rows for `importUsers`: the `user` and `account` columns Better Auth stores; dates as `Date`, ISO text or ms. */
export type AuthImport = { users: Record<string, unknown>[]; accounts?: Record<string, unknown>[] };
/** Counts, or why nothing was imported (a row without an id, a row SQLite refused: the whole import is rolled back). */
export type AuthImportResult = { ok: true; users: number; accounts: number; skipped: number } | { ok: false; error: string };

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
  api(endpoint: string, input?: AuthApiInput, env?: AuthEnv): Promise<AuthApiResult>;
  /** Key rotation: retire the current JWT signing key(s) and mint a new one; returns the public JWKS. */
  rotateKeys(env?: AuthEnv): Promise<{ keys: Array<Record<string, unknown>> }>;
  verifier(): Verifier;
  workerStats(): { workerHashes: number; workerVerifies: number };
}

export function emberAuth(input: EmberAuthConfig | EmberAuthFactory | BetterAuthOptions, settings: EmberAuthSettings): EmberAuth {
  const getEnv = (): AuthEnv => settings.env ?? (workerEnv as unknown as AuthEnv);
  // The function form gets the Worker's env (`cloudflare:workers`, or `settings.env` in tests): the same bindings and
  // variables the `Auth` DO sees, so its hooks can write D1 or call another Durable Object.
  const config = resolveAuthConfig(input, getEnv());
  const bindingName = settings.binding ?? "AUTH";
  const instance = settings.instance ?? "auth";
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const rules = { ...PASSWORD_RULES, ...settings.passwordRules };
  const hasher: PasswordHooks = userPasswordHooks(config) ?? defaultHasher;
  const workerStats = { workerHashes: 0, workerVerifies: 0 };
  if (settings.turnstile && (config.plugins ?? []).some((p) => p.id === "captcha")) {
    throw new Error("auth: auth.turnstile (ember.json) and a captcha() plugin in auth.config.ts are mutually exclusive: keep one");
  }
  const gate = settings.turnstile ? turnstileGate(settings.turnstile, { basePath, ...(config.advanced ? { advanced: config.advanced } : {}) }) : null;
  const countingHasher: PasswordHooks = {
    hash: (p) => (workerStats.workerHashes++, hasher.hash(p)),
    verify: (d) => (workerStats.workerVerifies++, hasher.verify(d)),
  };

  /** Generation 0: the deploy-time secret (also Better Auth's legacy key for payloads from before any rotation). */
  const baseSecretOf = (env: AuthEnv) => {
    const s = settings.secret ?? stringEnv(env, "EMBER_AUTH_SECRET") ?? stringEnv(env, "BETTER_AUTH_SECRET");
    if (!s) throw new Error("auth: missing secret (set EMBER_AUTH_SECRET)");
    return s;
  };
  /** `ember keys rotate --auth-secret` adds EMBER_AUTH_SECRET_R<n>; newest first. */
  const rotatedOf = (env: AuthEnv): Array<{ version: number; value: string }> =>
    settings.secret
      ? []
      : Object.entries(env)
          .map(([k, v]) => [/^EMBER_AUTH_SECRET_R(\d+)$/.exec(k)?.[1], v] as const)
          .filter((e): e is readonly [string, string] => e[0] !== undefined && typeof e[1] === "string" && e[1] !== "")
          .map(([n, value]) => ({ version: Number(n), value }))
          .sort((a, b) => b.version - a.version);
  /** The secret that signs now (cookie cache, sessions): the newest generation. */
  const secretOf = (env: AuthEnv) => rotatedOf(env)[0]?.value ?? baseSecretOf(env);
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
        secret: baseSecretOf(env),
        ...(rotatedOf(env).length ? { secrets: [...rotatedOf(env), { version: 0, value: baseSecretOf(env) }] } : {}),
        ...(baseURL ? { baseURL } : {}),
        database: doSqliteAdapter(executor),
        password,
        ...(sync ? { onUserChange: (event, user) => sync(event, user, { storage: ctx.storage, env }) } : {}),
      });
      this.auth = betterAuth(this.options) as unknown as AuthInstance;
      void ctx.blockConcurrencyWhile(async () => {
        await this.migrate();
        // Profile sync: journal user writes atomically (triggers), so a change whose after-hook never ran (the DO died
        // in between) is recovered by the outbox alarm. Every boot: a table rebuild drops triggers and an added
        // column or a kind change must reach the delete trigger's body (re-created, atomically).
        if (sync) ctx.storage.transactionSync(() => { for (const stmt of userJournalDDL(this.options)) ctx.storage.sql.exec(stmt); });
      });
    }

    /**
     * Key rotation: every live signing key gets `expiresAt = now` (Better Auth stops signing with it but keeps
     * publishing it in /jwks for `jwks.gracePeriod`, 30 days by default, so tokens already issued — 5 min TTL —
     * keep verifying), then one JWT is signed, which mints the new key (encrypted with the current secret).
     */
    async rotateJwks(): Promise<JSONWebKeySet> {
      const ctx = await this.auth.$context;
      const now = new Date();
      const keys = (await ctx.adapter.findMany({ model: "jwks" })) as Array<{ id: string; expiresAt?: Date | string | null }>;
      for (const k of keys) {
        const exp = k.expiresAt ? new Date(k.expiresAt).getTime() : Infinity;
        if (exp > now.getTime()) await ctx.adapter.update({ model: "jwks", where: [{ field: "id", value: k.id }], update: { expiresAt: now } });
      }
      await this.auth.api.signJWT!({ body: { payload: { sub: "ember:key-rotation" } } });
      return this.getJwks();
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

    async api(endpoint: string, input: AuthApiInput = {}): Promise<AuthApiResult> {
      const fn = Object.hasOwn(this.auth.api, endpoint) ? this.auth.api[endpoint] : undefined;
      if (typeof fn !== "function") return { ok: false, error: { status: 404, code: "UNKNOWN_ENDPOINT", message: `auth: no endpoint ${endpoint}` } };
      try {
        const value = await fn({
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.query ? { query: input.query } : {}),
          headers: asHeaders(input.headers ?? []),
        });
        // Over RPC: plain data only (a Response, should an endpoint answer one, is read as JSON).
        return { ok: true, value: value instanceof Response ? await value.json().catch(() => null) : value };
      } catch (e) {
        const err = e as { statusCode?: number; status?: unknown; body?: { code?: string; message?: string }; message?: string };
        if (typeof err.statusCode !== "number") throw e;
        return {
          ok: false,
          error: { status: err.statusCode, code: err.body?.code ?? String(err.status ?? "ERROR"), message: err.body?.message ?? err.message ?? "" },
        };
      }
    }

    async importUsers(rows: AuthImport): Promise<AuthImportResult> {
      const ctx = await this.auth.$context;
      const asDates = (row: Record<string, unknown>) => {
        const out: Record<string, unknown> = { ...row };
        for (const k of ["createdAt", "updatedAt", "accessTokenExpiresAt", "refreshTokenExpiresAt", "banExpires"]) {
          const v = out[k];
          if (typeof v === "string" || typeof v === "number") out[k] = new Date(v);
        }
        if (typeof out.emailVerified === "number") out.emailVerified = out.emailVerified !== 0;
        return out;
      };
      // Checked before anything is written, so malformed input answers why instead of throwing over RPC.
      const input = (typeof rows === "object" && rows !== null ? rows : {}) as Partial<AuthImport>;
      if (!Array.isArray(input.users)) return { ok: false, error: "users must be an array" };
      if (input.accounts !== undefined && !Array.isArray(input.accounts)) return { ok: false, error: "accounts must be an array" };
      const lists = [["user", input.users], ["account", input.accounts ?? []]] as const;
      for (const [model, list] of lists) {
        for (const row of list as unknown[]) {
          if (typeof row !== "object" || row === null || Array.isArray(row)) return { ok: false, error: `${model === "user" ? "a user" : "an account"} row that is not an object` };
          const id = (row as Record<string, unknown>).id;
          if (typeof id !== "string" || id === "") return { ok: false, error: `${model === "user" ? "a user" : "an account"} row without an id` };
        }
      }
      const result = { ok: true as const, users: 0, accounts: 0, skipped: 0 };
      const journaled = this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, USER_JOURNAL_TABLE).toArray().length > 0;
      // One transaction: a failed row leaves nothing half imported.
      try {
        await ctx.adapter.transaction(async (tx: typeof ctx.adapter) => {
          for (const [model, list] of lists) {
            for (const row of list) {
              if (await tx.findOne({ model, where: [{ field: "id", value: row.id as string }] })) {
                result.skipped++;
                continue;
              }
              await tx.create({ model, data: asDates(row), forceAllowId: true });
              if (model === "user") {
                result.users++;
                // A copy, not a sign-up: the profile-sync trigger's journal row goes too, in the same transaction,
                // so the outbox alarm never recovers it as a `create` (no hook ran, none should).
                if (journaled) this.ctx.storage.sql.exec(`DELETE FROM "${USER_JOURNAL_TABLE}" WHERE user_id = ? AND event = 'create'`, row.id as string);
              } else result.accounts++;
            }
          }
        });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      return result;
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
    // Captcha first: a rejected request costs no password hash and never reaches the DO.
    const rejected = gate ? await gate(request, env) : null;
    if (rejected) return rejected;
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
    /** `AuthRpc.api`: a server-side call into Better Auth, from the Worker's own code. */
    api: (endpoint: string, input?: AuthApiInput, env: AuthEnv = getEnv()) => stubOf(env).api(endpoint, input),
    /** `EmberAuthHook.rotateKeys`: new JWT signing key; the Worker's verifier drops its cached keys. */
    rotateKeys: async (env: AuthEnv = getEnv()) => {
      const jwks = await stubOf(env).rotateJwks();
      verifier = null;
      return jwks as unknown as { keys: Array<Record<string, unknown>> };
    },
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
export { turnstileGate, TURNSTILE_SECRET_ENV } from "./turnstile.ts";
export type { TurnstileSettings } from "./turnstile.ts";
export { defaultHasher, LocalHashError, PASSWORD_RULES, preparePasswordPlan } from "./password.ts";
export type { CredentialLookup, PasswordPlan, PasswordRule } from "./password.ts";
export type { Identity } from "./types.ts";
