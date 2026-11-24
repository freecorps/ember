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
import { getAuthTables } from "better-auth/db";
import type { JSONWebKeySet } from "jose";
import { doSqliteAdapter, sqlStorageExecutor } from "./adapter.ts";
import { migrate, replicaJournalDDL, replicaJournalDropDDL, schemaFingerprint, tableSpecs, USER_JOURNAL_TABLE, userJournalDDL, type MigrateOptions } from "./ddl.ts";
import { resolveAuthConfig, type AuthEnv, type EmberAuthConfig, type EmberAuthFactory } from "./define.ts";
import { hiddenFieldsOf, hiddenUserFieldsOf, withoutHidden } from "./hidden.ts";
import { resolveAuthOptions, userPasswordHooks, type PasswordHooks, type UserChangeEvent } from "./options.ts";
import { baseSecretOf, DEFAULT_BASE_PATH, isAuthPath, isJwksRequest, jwksFromVerifier, makeVerifier, rotatedSecretsOf, staticSettingsOfResolved, stringEnv, type AuthStaticSettings } from "./settings.ts";
import {
  assertPasswordRules,
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
import { toSessionInfo, type SessionInfo, type SessionQuery, type Verifier, type VerifyOptions, type VerifyResult } from "./verify.ts";
import { listSessions, listUsers, revokeSessions, type AdminAdapter, type AdminSession, type AdminUser, type UserQuery } from "./admin.ts";

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
  /**
   * Extra / overridden password-bearing endpoints (relative to basePath), over `PASSWORD_RULES` and the config's
   * `ember.passwordRules` (which is where an app declares them: the generated entry passes none).
   */
  passwordRules?: Record<string, PasswordRule>;
  /** Profile sync (PLAN §9): wire to the runtime outbox → `internal.users.sync`. */
  onUserChange?: ProfileSyncHook;
  /** Static JWKS embedded at deploy. Default: env `EMBER_AUTH_JWKS` (JSON). */
  jwks?: JSONWebKeySet;
  /** Env override (tests). Default: `env` from `cloudflare:workers`. */
  env?: AuthEnv;
  /**
   * Turnstile on sign-up / sign-in / password reset (ember.json `auth.turnstile`): siteverify as Better Auth's captcha
   * plugin does it (`turnstile.ts`), run in the Worker before any password work. Secret: env `TURNSTILE_SECRET_KEY`.
   */
  turnstile?: TurnstileSettings | true;
  /**
   * API keys as Ember identities (the api-key plugin with `enableSessionForAPIKeys: true`). Off by default: a client
   * exchanges its key for the usual JWT (`GET <basePath>/token` with the key header). On: a key sent as
   * `Authorization: Bearer <key>` verifies too, looked up in the Auth DO on every call (revoking the key ends it at
   * once; a bearer is routed by shape, so it costs one lookup either way, and a key shaped like a session token —
   * 32 alphanumerics, only possible with a `customKeyGenerator` — is not accepted as a bearer), and a `sensitive` check of a JWT minted from a key (its `sid` is the key id) finds the key by id instead of a
   * session. `header`: the plugin's `apiKeyHeaders` (default `x-api-key`).
   */
  apiKeys?: boolean | { header?: string };
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
   * transaction. Answers why it imported nothing instead of throwing. (`importAuthTables` for the other tables.)
   */
  importUsers(rows: AuthImport): Promise<AuthImportResult>;
  /**
   * Inserts rows of any Better Auth table (`{ tables: { user, account, organization, member, ... } }`, by model key)
   * as given, parents before children, skipping ids already there, in one transaction. No hook runs; organization
   * data reaches the org shards through replication like any write (the triggers journal the inserts).
   */
  importAuthTables(rows: AuthTablesImport): Promise<AuthTablesImportResult>;
  /** Dashboard: users (newest first; `q` matches email or name), without credentials. */
  adminUsers(q?: UserQuery): Promise<{ users: AdminUser[]; total: number; next: number | null }>;
  /** Dashboard: a user's sessions, never their tokens. */
  adminSessions(userId: string): Promise<AdminSession[]>;
  /** Dashboard: ends one session or all of a user's. */
  adminRevoke(o: { userId: string; sessionId?: string }): Promise<{ revoked: number }>;
}

/** What `api` passes to the endpoint: Better Auth's `{ body, query, headers }`. */
export type AuthApiInput = { body?: unknown; query?: Record<string, unknown>; headers?: [string, string][] };
export type AuthApiResult = { ok: true; value: unknown } | { ok: false; error: { status: number; code: string; message: string } };

/** Rows for `importUsers`: the `user` and `account` columns Better Auth stores; dates as `Date`, ISO text or ms. */
export type AuthImport = { users: Record<string, unknown>[]; accounts?: Record<string, unknown>[] };
/** Counts, or why nothing was imported (a row without an id, a row SQLite refused: the whole import is rolled back). */
export type AuthImportResult = { ok: true; users: number; accounts: number; skipped: number } | { ok: false; error: string };
/** Rows for `importAuthTables`, by Better Auth model key; dates as `Date`, ISO text or ms; booleans as 0/1 or booleans. */
export type AuthTablesImport = { tables: Record<string, Record<string, unknown>[]> };
/** Inserted rows per model, or why nothing was imported. */
export type AuthTablesImportResult = { ok: true; imported: Record<string, number>; skipped: number } | { ok: false; error: string };

export type AuthStats = { localHashes: number; plannedHashes: number; plannedVerifies: number; migration: string[] };

type AuthInstance = {
  handler(request: Request): Promise<Response>;
  api: Record<string, (...args: any[]) => Promise<any>>;
  $context: Promise<any>;
};

const asHeaders = (h: [string, string][]) => new Headers(h);
const qi = (ident: string) => `"${ident.replaceAll('"', '""')}"`;
/** Better Auth's email comparison in `findUserByEmail`. */
const nfcLower = (v: string) => v.normalize("NFC").toLowerCase();
type DirectTable = { name: string; col(field: string): string | undefined };
type DirectNames = { user: DirectTable; session: DirectTable; account: DirectTable };

/**
 * Better Auth session tokens are `generateId(32)` (32 alphanumerics), sent by the bearer plugin as is or signed
 * (`<token>.<sig>`, possibly URL-encoded). The API-key plugin's default keys are `<prefix><64 letters>`, which never
 * match; a custom `customKeyGenerator` that issues exactly this shape is not accepted as a bearer (use its header).
 */
const isSessionTokenShape = (token: string) => /^[A-Za-z0-9]{32}(?:$|[.%])/.test(token);

/** Instance of the Auth DO class (what `ctx.exports` / bindings see). */
export type AuthDurableObject = DurableObject<AuthEnv> & AuthRpc & { readonly options: BetterAuthOptions };
export type AuthClass = new (ctx: DurableObjectState, env: AuthEnv) => AuthDurableObject;
/**
 * The same class, as `lazy.ts` constructs it inside its own `Auth` (which already holds `blockConcurrencyWhile`):
 * `deferBoot` leaves the boot (migration, journal triggers) to an explicit `boot()`.
 */
export type DeferredAuthClass = new (ctx: DurableObjectState, env: AuthEnv, opts: { deferBoot: true }) => AuthDurableObject & { boot(): Promise<void> };

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
  /** Users and sessions for the Ember Dashboard (never credentials or session tokens). */
  admin: {
    users(env: AuthEnv, q?: UserQuery): Promise<{ users: AdminUser[]; total: number; next: number | null }>;
    sessions(env: AuthEnv, userId: string): Promise<AdminSession[]>;
    revoke(env: AuthEnv, o: { userId: string; sessionId?: string }): Promise<{ revoked: number }>;
  };
  verifier(): Verifier;
  workerStats(): { workerHashes: number; workerVerifies: number };
  /** What the Worker needs from the config without Better Auth (`lazy.ts` checks the CLI's copy against it). */
  staticSettings: AuthStaticSettings;
  /**
   * `fetch` for a request that already passed the Turnstile gate (`lazy.ts`, which gates without loading Better Auth):
   * the rest of the same handler. Tokens are single-use, so the gate must not run twice.
   */
  fetchGated(request: Request, env?: AuthEnv): Promise<Response | null>;
}

/**
 * Whether the journal triggers in the database are exactly the ones `ddl` creates (same SQL text) and none it drops is
 * left: then the boot has nothing to re-create. A table rebuild (it drops its triggers), a changed column list or a
 * replication switch all show as a difference.
 */
function triggersCurrent(sql: SqlStorage, ddl: string[]): boolean {
  const want = new Map<string, string>();
  const gone = new Set<string>();
  for (const stmt of ddl) {
    const created = /^CREATE TRIGGER "([^"]+)"/.exec(stmt);
    if (created) {
      want.set(created[1]!, stmt);
      gone.delete(created[1]!);
      continue;
    }
    const dropped = /^DROP TRIGGER IF EXISTS "([^"]+)"/.exec(stmt);
    if (dropped && !want.has(dropped[1]!)) gone.add(dropped[1]!);
  }
  const have = new Map(sql.exec(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`).toArray().map((r) => [String(r.name), String(r.sql)] as const));
  for (const [name, stmt] of want) if (have.get(name) !== stmt) return false;
  for (const name of gone) if (have.has(name)) return false;
  return true;
}

export function emberAuth(input: EmberAuthConfig | EmberAuthFactory | BetterAuthOptions, settings: EmberAuthSettings): EmberAuth {
  const getEnv = (): AuthEnv => settings.env ?? (workerEnv as unknown as AuthEnv);
  // The function form gets the Worker's env (`cloudflare:workers`, or `settings.env` in tests): the same bindings and
  // variables the `Auth` DO sees, so its hooks can write D1 or call another Durable Object.
  const config = resolveAuthConfig(input, getEnv());
  const bindingName = settings.binding ?? "AUTH";
  const instance = settings.instance ?? "auth";
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const configRules = (config as { ember?: { passwordRules?: unknown } }).ember?.passwordRules;
  const rules: Record<string, PasswordRule> = {
    ...PASSWORD_RULES,
    ...(configRules !== undefined ? assertPasswordRules(configRules, "auth: ember.passwordRules") : {}),
    ...(settings.passwordRules ? assertPasswordRules(settings.passwordRules, "emberAuth: passwordRules") : {}),
  };
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

  const staticSettings = staticSettingsOfResolved(config);
  const rotatedOf = (env: AuthEnv) => rotatedSecretsOf(settings, env);
  const baseURLOf = (env: AuthEnv) =>
    settings.baseURL ?? stringEnv(env, "EMBER_AUTH_URL") ?? (typeof config.baseURL === "string" ? config.baseURL : undefined);

  const stubOf = (env: AuthEnv): AuthRpc => {
    const ns = env[bindingName] as DurableObjectNamespace | undefined;
    if (!ns) throw new Error(`auth: missing Durable Object binding ${bindingName}`);
    return ns.get(ns.idFromName(instance)) as unknown as AuthRpc;
  };

  const apiKeyHeader = settings.apiKeys ? ((typeof settings.apiKeys === "object" ? settings.apiKeys.header : undefined) ?? "x-api-key").toLowerCase() : null;

  const planStore = new AsyncLocalStorage<PasswordPlan | undefined>();

  class Auth extends DurableObject<AuthEnv> implements AuthRpc {
    readonly auth: AuthInstance;
    readonly options: BetterAuthOptions;
    /** `user` fields that never leave the DO (`hidden.ts`). */
    private hiddenUser: ReadonlySet<string> = new Set();
    private counters = { localHashes: 0, plannedHashes: 0, plannedVerifies: 0 };
    private applied: string[] = [];

    constructor(ctx: DurableObjectState, env: AuthEnv, opts?: { deferBoot?: boolean }) {
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
      const onUserChange = settings.onUserChange;
      // Hidden user fields (`hidden.ts`: `returned: false`, `ember.hiddenUserFields`) never reach the profile sync.
      const sync: ProfileSyncHook | undefined = onUserChange && ((event, user, c) => onUserChange(event, withoutHidden(user, this.hiddenUser), c));
      const baseURL = baseURLOf(env);
      this.options = resolveAuthOptions(config, {
        project: settings.project,
        secret: baseSecretOf(settings, env),
        ...(rotatedOf(env).length ? { secrets: [...rotatedOf(env), { version: 0, value: baseSecretOf(settings, env) }] } : {}),
        ...(baseURL ? { baseURL } : {}),
        database: doSqliteAdapter(executor),
        password,
        ...(sync ? { onUserChange: (event, user) => sync(event, user, { storage: ctx.storage, env }) } : {}),
      });
      this.auth = betterAuth(this.options) as unknown as AuthInstance;
      const userFields = getAuthTables(this.options).user?.fields ?? {};
      this.hiddenUser = hiddenFieldsOf("user", userFields, hiddenUserFieldsOf(config));
      if (!opts?.deferBoot) void ctx.blockConcurrencyWhile(() => this.boot());
    }

    /** Before any event (the constructor's `blockConcurrencyWhile`, or the lazy `Auth` that wraps this one). */
    async boot(): Promise<void> {
      await this.migrate();
      // Profile sync: journal user writes atomically (triggers), so a change whose after-hook never ran (the DO died
      // in between) is recovered by the outbox alarm. A table rebuild drops triggers and an added column or a kind
      // change must reach the delete trigger's body: they are re-created (atomically) unless sqlite_master already
      // holds exactly the triggers the DDL creates (one read on a wake instead of ~25–38 DROP/CREATE).
      // Organization replication (PLAN §22 L3): the same atomic journal for the organization tables; off → no
      // triggers (nothing would consume their journal). On again: the journal asks for a resync of every organization.
      const storage = this.ctx.storage;
      const replicate = (config as { ember?: { replicate?: { organization?: unknown } } }).ember?.replicate?.organization;
      const user = settings.onUserChange ? userJournalDDL(this.options, this.hiddenUser) : [];
      const replica = replicate ? replicaJournalDDL(this.options) : replicaJournalDropDDL();
      if (triggersCurrent(storage.sql, [...user, ...replica])) return;
      if (user.length) storage.transactionSync(() => { for (const stmt of user) storage.sql.exec(stmt); });
      storage.transactionSync(() => { for (const stmt of replica) storage.sql.exec(stmt); });
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
      const user = (await ctx.internalAdapter.findUserById(id)) as Record<string, unknown> | null;
      return user ? withoutHidden(user, this.hiddenUser) : null;
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

    /** Physical table and column names of the models the direct reads below use (`tableSpecs`), or null. */
    private names(): DirectNames | null {
      if (this.#names !== undefined) return this.#names;
      const specs = tableSpecs(this.options);
      const table = (key: string) => {
        const t = specs.find((x) => x.key === key);
        if (!t) return null;
        const cols = new Map(t.columns.map((c) => [c.field, c.name]));
        return { name: t.name, col: (field: string) => cols.get(field) };
      };
      const user = table("user");
      const session = table("session");
      const account = table("account");
      const need = [user?.col("id"), user?.col("email"), user?.col("name"), user?.col("emailVerified"), session?.col("id"), session?.col("userId"), session?.col("expiresAt"), account?.col("userId"), account?.col("providerId"), account?.col("accountId"), account?.col("password")];
      this.#names = user && session && account && need.every((c) => c !== undefined) ? { user, session, account } : null;
      return this.#names;
    }
    #names: DirectNames | null | undefined;

    async credentialHash(lookup: CredentialLookup): Promise<string | null> {
      const ctx = await this.auth.$context;
      let userId: string | undefined;
      if ("email" in lookup) {
        const email = lookup.email.toLowerCase();
        const n = this.names();
        if (n) {
          // `findUserByEmail(email, { includeAccounts })` and the credential account among them, in one statement.
          const { user: u, account: a } = n;
          const row = this.ctx.storage.sql
            .exec(
              `SELECT u.${qi(u.col("email")!)} AS email, a.${qi(a.col("password")!)} AS password FROM ${qi(u.name)} u ` +
                `LEFT JOIN ${qi(a.name)} a ON a.${qi(a.col("userId")!)} = u.${qi(u.col("id")!)} AND a.${qi(a.col("providerId")!)} = 'credential' AND a.${qi(a.col("accountId")!)} = u.${qi(u.col("id")!)} ` +
                `WHERE u.${qi(u.col("email")!)} = ? ORDER BY a.rowid LIMIT 1`,
              email,
            )
            .toArray()[0];
          // Better Auth's check: the stored email is the one asked for, NFC-normalized.
          if (!row || typeof row.email !== "string" || nfcLower(row.email) !== nfcLower(email)) return null;
          return typeof row.password === "string" ? row.password : null;
        }
        const found = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });
        if (!found) return null;
        const acc = (found.accounts as { providerId: string; accountId: string; password?: string | null }[]).find(
          (a) => a.providerId === "credential" && a.accountId === found.user.id,
        );
        return acc?.password ?? null;
      }
      if ("username" in lookup || "phoneNumber" in lookup) {
        // What `/sign-in/username` and `/sign-in/phone-number` read: the user by that field (the username normalized
        // as the plugin does), then its credential account. No plugin (no such field): no hash.
        let where: { field: string; value: string } | null = null;
        if ("username" in lookup) {
          const plugin = (this.options.plugins ?? []).find((p) => p.id === "username");
          // The plugin's own normalizer (its `usernameNormalization`, `false`, or the default lowercase), which it
          // exposes as the field's input transform: the very function `/sign-in/username` looks the user up with.
          const normalize = plugin?.schema?.user?.fields?.username?.transform?.input;
          if (plugin && typeof lookup.username === "string") {
            const value = normalize ? await normalize(lookup.username) : lookup.username.toLowerCase();
            if (typeof value === "string") where = { field: "username", value };
          }
        } else if ((this.options.plugins ?? []).some((p) => p.id === "phone-number") && typeof lookup.phoneNumber === "string") {
          where = { field: "phoneNumber", value: lookup.phoneNumber };
        }
        if (!where) return null;
        const user = (await ctx.adapter.findOne({ model: "user", where: [where] })) as { id: string } | null;
        if (!user) return null;
        const acc = await ctx.internalAdapter.findCredentialAccount(user.id);
        return acc?.password ?? null;
      }
      const s = await this.auth.api.getSession!({ headers: asHeaders(lookup.headers ?? []), query: { disableCookieCache: true } });
      userId = s?.user?.id;
      if (!userId) return null;
      const acc = await ctx.internalAdapter.findCredentialAccount(userId);
      return acc?.password ?? null;
    }

    async lookupSession(q: SessionQuery): Promise<SessionInfo | null> {
      if ("sessionId" in q) {
        const n = this.names();
        if (n) {
          // The session row and its user in one statement (`adapter.findOne` + `findUserById`).
          const { session: s, user: u } = n;
          const org = s.col("activeOrganizationId");
          const row = this.ctx.storage.sql
            .exec(
              `SELECT s.${qi(s.col("id")!)} AS sid, s.${qi(s.col("expiresAt")!)} AS expiresAt${org ? `, s.${qi(org)} AS org` : ""}, ` +
                `u.${qi(u.col("id")!)} AS uid, u.${qi(u.col("email")!)} AS email, u.${qi(u.col("name")!)} AS name, u.${qi(u.col("emailVerified")!)} AS emailVerified ` +
                `FROM ${qi(s.name)} s LEFT JOIN ${qi(u.name)} u ON u.${qi(u.col("id")!)} = s.${qi(s.col("userId")!)} WHERE s.${qi(s.col("id")!)} = ? LIMIT 1`,
              q.sessionId,
            )
            .toArray()[0];
          if (!row) return apiKeyHeader ? this.apiKeyById(q.sessionId) : null;
          if (new Date(row.expiresAt as string).getTime() <= Date.now()) return null;
          if (row.uid === null || row.uid === undefined) return null;
          return toSessionInfo({
            session: { id: String(row.sid), expiresAt: row.expiresAt, ...(org ? { activeOrganizationId: row.org } : {}) },
            user: { id: String(row.uid), email: row.email, name: row.name, emailVerified: row.emailVerified === 1 },
          });
        }
        const ctx = await this.auth.$context;
        const session = await ctx.adapter.findOne({ model: "session", where: [{ field: "id", value: q.sessionId }] });
        if (!session) return apiKeyHeader ? this.apiKeyById(q.sessionId) : null;
        if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
        const user = await ctx.internalAdapter.findUserById(session.userId);
        return user ? toSessionInfo({ session, user }) : null;
      }
      // One lookup per bearer, chosen by shape: a token that cannot be a session token goes to the API-key plugin
      // (which answers a session for its header and checks expiry, rate limits and remaining uses as for any
      // request), everything else to the bearer plugin. A miss is never retried the other way.
      const headers =
        "token" in q
          ? new Headers(apiKeyHeader && !isSessionTokenShape(q.token) ? { [apiKeyHeader]: q.token } : { authorization: `Bearer ${q.token}` })
          : asHeaders(q.headers);
      const s = await this.auth.api.getSession!({ headers, query: { disableCookieCache: true } }).catch(() => null);
      return toSessionInfo(s);
    }

    /** A JWT minted from an API key carries the key id as `sid`: live while the key exists, is enabled and unexpired. */
    private async apiKeyById(id: string): Promise<SessionInfo | null> {
      const ctx = await this.auth.$context;
      const key = (await ctx.adapter.findOne({ model: "apikey", where: [{ field: "id", value: id }] }).catch(() => null)) as
        | { id: string; referenceId?: string; enabled?: boolean | null; expiresAt?: Date | string | null }
        | null;
      if (!key?.referenceId || key.enabled === false) return null;
      const exp = key.expiresAt ? new Date(key.expiresAt).getTime() : Infinity;
      if (exp <= Date.now()) return null;
      const user = await ctx.internalAdapter.findUserById(key.referenceId);
      if (!user) return null;
      // No session row: the identity is valid for one JWT lifetime past this check (or until the key expires).
      return toSessionInfo({ session: { id: key.id, expiresAt: Math.min(exp, Date.now() + 5 * 60_000) }, user });
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
      const input = (typeof rows === "object" && rows !== null ? rows : {}) as Partial<AuthImport>;
      if (!Array.isArray(input.users)) return { ok: false, error: "users must be an array" };
      if (input.accounts !== undefined && !Array.isArray(input.accounts)) return { ok: false, error: "accounts must be an array" };
      const r = await this.importAuthTables({ tables: { user: input.users, account: input.accounts ?? [] } });
      return r.ok ? { ok: true, users: r.imported.user ?? 0, accounts: r.imported.account ?? 0, skipped: r.skipped } : r;
    }

    async importAuthTables(rows: AuthTablesImport): Promise<AuthTablesImportResult> {
      const ctx = await this.auth.$context;
      const specs = tableSpecs(this.options);
      const byKey = new Map(specs.map((t) => [t.key, t]));
      const tables = (typeof rows === "object" && rows !== null ? (rows as Partial<AuthTablesImport>).tables : undefined) ?? null;
      if (!tables || typeof tables !== "object" || Array.isArray(tables)) return { ok: false, error: "tables must be an object of row arrays by model" };
      // Checked before anything is written, so malformed input answers why instead of throwing over RPC.
      const a = (model: string) => (/^[aeio]/i.test(model) ? `an ${model}` : `a ${model}`);
      for (const [model, list] of Object.entries(tables)) {
        if (!byKey.has(model)) return { ok: false, error: `unknown auth table ${JSON.stringify(model)} (one of ${specs.map((t) => t.key).join(", ")})` };
        if (!Array.isArray(list)) return { ok: false, error: `${model} must be an array` };
        for (const row of list as unknown[]) {
          if (typeof row !== "object" || row === null || Array.isArray(row)) return { ok: false, error: `${a(model)} row that is not an object` };
          const id = (row as Record<string, unknown>).id;
          if ((typeof id !== "string" || id === "") && typeof id !== "number") return { ok: false, error: `${a(model)} row without an id` };
        }
      }
      // Parents before children (a member references its organization and its user), else Better Auth's order.
      const order: string[] = [];
      const visit = (key: string, path: Set<string>) => {
        if (order.includes(key) || path.has(key)) return;
        path.add(key);
        for (const c of byKey.get(key)!.columns) {
          const parent = c.references && specs.find((t) => t.name === c.references!.table)?.key;
          if (parent && parent !== key && parent in tables) visit(parent, path);
        }
        order.push(key);
      };
      for (const t of specs) if (t.key in tables) visit(t.key, new Set());
      const convert = (spec: (typeof specs)[number], row: Record<string, unknown>) => {
        const out: Record<string, unknown> = { ...row };
        for (const c of spec.columns) {
          const v = out[c.field];
          if (c.kind === "date" && (typeof v === "string" || typeof v === "number")) out[c.field] = new Date(v);
          if (c.kind === "boolean" && typeof v === "number") out[c.field] = v !== 0;
        }
        return out;
      };
      const result = { ok: true as const, imported: {} as Record<string, number>, skipped: 0 };
      const journaled = this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, USER_JOURNAL_TABLE).toArray().length > 0;
      const importedUsers: string[] = [];
      // One transaction: a failed row leaves nothing half imported.
      try {
        await ctx.adapter.transaction(async (tx: typeof ctx.adapter) => {
          for (const model of order) {
            const spec = byKey.get(model)!;
            for (const row of tables[model]!) {
              if (await tx.findOne({ model, where: [{ field: "id", value: row.id as string }] })) {
                result.skipped++;
                continue;
              }
              await tx.create({ model, data: convert(spec, row), forceAllowId: true });
              result.imported[model] = (result.imported[model] ?? 0) + 1;
              if (model === "user") importedUsers.push(String(row.id));
            }
          }
          // A copy, not a sign-up: the profile-sync trigger's journal rows go too, in the same transaction, so the
          // outbox alarm never recovers them as `create`s (no hook ran, none should). One statement for the whole
          // import (the journal has no index on user_id: one DELETE per user scanned it once per user).
          if (journaled && importedUsers.length) {
            this.ctx.storage.sql.exec(`DELETE FROM "${USER_JOURNAL_TABLE}" WHERE event = 'create' AND user_id IN (SELECT value FROM json_each(?))`, JSON.stringify(importedUsers));
          }
        });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      return result;
    }

    async adminUsers(q: UserQuery = {}) {
      return listUsers((await this.auth.$context).adapter as unknown as AdminAdapter, q);
    }

    async adminSessions(userId: string) {
      return listSessions((await this.auth.$context).adapter as unknown as AdminAdapter, userId);
    }

    async adminRevoke(o: { userId: string; sessionId?: string }) {
      return revokeSessions((await this.auth.$context).adapter as unknown as AdminAdapter, o);
    }

    async stats(): Promise<AuthStats> {
      return { ...this.counters, migration: this.applied };
    }
  }

  let verifier: Verifier | null = null;
  const getVerifier = () => {
    if (verifier) return verifier;
    verifier = makeVerifier({ project: settings.project, settings, config: staticSettings, env: getEnv(), stub: () => stubOf(getEnv()) });
    return verifier;
  };

  /**
   * Handle `<basePath>/*`: returns null for other paths. Password work for known endpoints happens
   * here, in the Worker, before the request reaches the DO.
   */
  async function fetchHandler(request: Request, env: AuthEnv = getEnv(), gated = false): Promise<Response | null> {
    const url = new URL(request.url);
    if (!isAuthPath(url.pathname, staticSettings)) return null;
    const route = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || "/" : url.pathname;
    // The JWKS from the verifier's cache (rotation drops it), without a round trip to the DO. Public keys are never
    // behind the captcha (an endpoint list like "/**" would otherwise break every verifier), also when the cache
    // cannot answer and the DO serves them.
    const jwks = await jwksFromVerifier(request, route, getVerifier);
    if (jwks) return jwks;
    // Captcha next: a rejected request costs no password hash and never reaches the DO.
    const rejected = gate && !gated && !isJwksRequest(request, route) ? await gate(request, env) : null;
    if (rejected) return rejected;
    const stub = stubOf(env);
    const { request: forward, plan } = await preparePasswordPlan(request, route, countingHasher, (by) => stub.credentialHash(by), rules);
    return stub.handle(forward, plan);
  }

  return {
    basePath,
    /** The `Auth` Durable Object class: export it from the Worker entry under the binding's class name. */
    Auth,
    fetch: (request: Request, env?: AuthEnv) => fetchHandler(request, env),
    fetchGated: (request: Request, env?: AuthEnv) => fetchHandler(request, env, true),
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
    staticSettings,
    /** `EmberAuthHook.admin`: users and sessions for the dashboard (admin endpoints). */
    admin: {
      users: (env: AuthEnv, q?: UserQuery) => stubOf(env).adminUsers(q),
      sessions: (env: AuthEnv, userId: string) => stubOf(env).adminSessions(userId),
      revoke: (env: AuthEnv, o: { userId: string; sessionId?: string }) => stubOf(env).adminRevoke(o),
    },
  };
}

export { doSqliteAdapter, sqlStorageExecutor } from "./adapter.ts";
export type { SqlExecutor, SqlValue } from "./adapter.ts";
// SSO / remote auth: also its own light entry, `@freecorps/ember-auth/remote` (no Better Auth in the bundle).
export { remoteAuth } from "./remote.ts";
export type { SsoSettings } from "./remote.ts";
export { createSessionCheck, DEFAULT_SESSION_LOOKUP_TIMEOUT_MS } from "./remote-session.ts";
export type { SessionLookupClaims, SessionLookupFn, SessionLookupSettings } from "./remote-session.ts";
export { SESSION_LOOKUP_SECRET_ENV, signSessionLookup, verifySessionLookupRequest } from "./session-lookup.ts";
export type { SessionLookupAnswer, SessionLookupQuery, SessionLookupVerdict } from "./session-lookup.ts";
export { classifyToken, createVerifier } from "./verify.ts";
export type { AuthVia, SessionInfo, SessionQuery, Verifier, VerifierConfig, VerifyOptions, VerifyResult } from "./verify.ts";
export { turnstileGate, TURNSTILE_SECRET_ENV } from "./turnstile.ts";
export type { TurnstileSettings } from "./turnstile.ts";
export { assertPasswordRules, CREDENTIAL_KEYS, defaultHasher, LocalHashError, PASSWORD_RULES, preparePasswordPlan } from "./password.ts";
export type { CredentialKey, CredentialLookup, PasswordPlan, PasswordRule } from "./password.ts";
export type { Identity } from "./types.ts";
