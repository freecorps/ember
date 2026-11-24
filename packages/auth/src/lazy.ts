/**
 * `emberAuth` with Better Auth loaded on first use (what the generated Worker entry uses for ember/auth.config.ts).
 *
 * Every isolate of the deployment evaluates the Worker module: the `Shard`s, `System`, the Worker itself. Better
 * Auth, its plugins, Kysely and Zod are ~750 KiB of that module, needed only by the `Auth` Durable Object and by
 * `/api/auth/*` (password work in the Worker). Measured in production: `startup_time_ms` 55 with them, 7 without; a
 * shard's first call after a deploy +100 ms at the median (docs/spikes/remote/latency-protocol.md §3).
 *
 *   // generated worker entry
 *   import { emberAuthLazy } from "@freecorps/ember-auth/lazy";
 *   const auth = emberAuthLazy(() => import("../ember/auth.config.ts"), { project: "acme", static: { basePath: "/api/auth", cookieStrategy: "compact" } });
 *   export const Auth = auth.Auth;
 *   export default createEmberWorker({ ..., auth });
 *
 * With `static` (the CLI computes it from the config at build: `authStaticSettings`), `verify`, key rotation, the
 * admin calls and routing never load Better Auth: the verifier is the same one `emberAuth` builds (`settings.ts`).
 * Nor do `/api/auth/*` requests: `GET /jwks` is answered from the verifier's cached JWKS, the Turnstile gate
 * (`turnstile.ts`) and the password work (`password.ts`, scrypt, imported on the first password request) run here as
 * `emberAuth` runs them (the config's own `ember.passwordRules` come with the static settings), and everything else
 * goes straight to the DO. Exceptions, which load the config as before: a
 * config with its own password `hash`/`verify` (for password requests), and settings from an older CLI (without
 * `static.worker`, for Turnstile and password requests).
 * Without it (the function form `defineAuth((env) => ...)`), the first `verify` loads everything, as `emberAuth` does.
 *
 * The static settings are what the config resolved to in Node at build. In the value form `basePath`, `baseURL`,
 * `session.cookieCache.strategy` and `advanced.ipAddress` must not depend on the environment (read env-dependent
 * options in the function form). A difference is detected where Better Auth is loaded: the Auth DO on boot (where
 * tokens are issued and every sign-in lands), so a deployment that signs anyone in logs it. That isolate then switches
 * to the runtime values; Worker isolates keep the build-time ones until the next deploy.
 * The CLI bundles with code splitting: Better Auth, the config, the cookie-cache decoder and scrypt are chunks of
 * their own, compiled and evaluated only when first imported.
 */
import { DurableObject, env as workerEnv } from "cloudflare:workers";
import type { AuthEnv } from "./define.ts";
import { isAuthPath, isJwksRequest, jwksFromVerifier, makeVerifier, sameStaticSettings, type AuthStaticSettings } from "./settings.ts";
import { assertPasswordRules, needsPasswordPlan, PASSWORD_RULES, type PasswordRule } from "./password-rules.ts";
import { turnstileGate } from "./turnstile.ts";
import type { Identity } from "./types.ts";
import type { Verifier, VerifyOptions, VerifyResult } from "./verify.ts";
import type {
  AuthApiInput,
  AuthApiResult,
  AuthDurableObject,
  AuthImport,
  AuthImportResult,
  AuthTablesImport,
  AuthTablesImportResult,
  AuthRpc,
  AuthStats,
  DeferredAuthClass,
  EmberAuth,
  EmberAuthSettings,
} from "./worker.ts";
import type { PasswordPlan, CredentialLookup } from "./password.ts";
import type { SessionInfo, SessionQuery } from "./verify.ts";
import type { AdminSession, AdminUser, UserQuery } from "./admin.ts";
import type { JSONWebKeySet } from "jose";

export type { AuthStaticSettings };

export interface EmberAuthLazySettings extends EmberAuthSettings {
  /** From the CLI (`authStaticSettings(config)`); null or absent: the config is loaded to verify. */
  static?: AuthStaticSettings | null;
}

/** The default export of ember/auth.config.ts, as `import()` gives it. */
export type AuthConfigModule = { default: unknown };

export interface EmberAuthLazy {
  /** The `Auth` Durable Object class: loads Better Auth when the object starts. */
  Auth: new (ctx: DurableObjectState, env: AuthEnv) => DurableObject<AuthEnv> & AuthRpc;
  fetch(request: Request, env?: AuthEnv): Promise<Response | null>;
  verify(token: string, o?: VerifyOptions): Promise<Identity | null>;
  verifySensitive(token: string): Promise<Identity | null>;
  verifyRequest(request: Request, o?: VerifyOptions): Promise<Identity | null>;
  verifyDetailed(token: string, o?: VerifyOptions): Promise<VerifyResult | null>;
  verifyRequestDetailed(request: Request, o?: VerifyOptions): Promise<VerifyResult | null>;
  stub(env?: AuthEnv): AuthRpc;
  api(endpoint: string, input?: AuthApiInput, env?: AuthEnv): Promise<AuthApiResult>;
  rotateKeys(env?: AuthEnv): Promise<{ keys: Array<Record<string, unknown>> }>;
  admin: EmberAuth["admin"];
  /** The full `emberAuth` (loads Better Auth and the config). */
  load(): Promise<EmberAuth>;
  /** Whether `load()` has run in this isolate (tests, diagnostics). */
  loaded(): boolean;
}

export function emberAuthLazy(
  config: () => Promise<AuthConfigModule>,
  settings: EmberAuthLazySettings,
  /** The full implementation (tests inject a counting loader). */
  impl: () => Promise<Pick<typeof import("./worker.ts"), "emberAuth">> = () => import("./worker.ts"),
): EmberAuthLazy {
  const { static: known, ...rest } = settings;
  if (settings.passwordRules) assertPasswordRules(settings.passwordRules, "emberAuthLazy: passwordRules");
  /** Built-in rules, then the config's (`ember.passwordRules`, carried in the static settings), then the settings'. */
  const rulesOf = (s: AuthStaticSettings): Record<string, PasswordRule> => {
    const fromConfig = s.worker?.passwordRules;
    return fromConfig || settings.passwordRules ? { ...PASSWORD_RULES, ...(fromConfig ?? {}), ...(settings.passwordRules ?? {}) } : PASSWORD_RULES;
  };
  let rulesFor: { s: AuthStaticSettings; rules: Record<string, PasswordRule> } | null = null;
  const getEnv = (): AuthEnv => settings.env ?? (workerEnv as unknown as AuthEnv);
  const bindingName = settings.binding ?? "AUTH";
  const instance = settings.instance ?? "auth";
  const stubOf = (env: AuthEnv): AuthRpc => {
    const ns = env[bindingName] as DurableObjectNamespace | undefined;
    if (!ns) throw new Error(`auth: missing Durable Object binding ${bindingName}`);
    return ns.get(ns.idFromName(instance)) as unknown as AuthRpc;
  };

  /** The static settings in use: null after a divergence (this isolate then verifies and routes as `emberAuth`). */
  let active: AuthStaticSettings | null = known ?? null;
  let verifier: Verifier | null = null;
  let full: Promise<EmberAuth> | null = null;
  let isLoaded = false;
  let gate: ReturnType<typeof turnstileGate> | null = null;
  const load = (): Promise<EmberAuth> =>
    (full ??= Promise.all([impl(), config()]).then(([m, c]) => {
      const auth = m.emberAuth(c.default as Parameters<typeof m.emberAuth>[0], rest);
      isLoaded = true;
      // The CLI read the same file at build: a difference means the config reads something at runtime that the
      // build did not see. The full path is the reference; say so loudly.
      if (known) {
        const s = auth.staticSettings;
        if (!sameStaticSettings(s, known)) {
          active = null;
          verifier = null;
          console.error(
            `ember: auth.config.ts resolved differently at runtime than at build (${JSON.stringify(s)} vs ${JSON.stringify(known)}): ` +
              "this isolate now uses the runtime values, but isolates that only verify tokens keep the build-time ones. " +
              "Read env-dependent auth options in defineAuth((env) => ...) and redeploy",
          );
        }
      }
      return auth;
    }));
  // A failed load is retried on the next call (a transient error must not poison the isolate).
  const loadOnce = () => load().catch((e) => {
    full = null;
    throw e;
  });

  const getVerifier = async (): Promise<Verifier> => {
    if (!active) return (await loadOnce()).verifier();
    return (verifier ??= makeVerifier({ project: settings.project, settings, config: active, env: getEnv(), stub: () => stubOf(getEnv()) }));
  };

  class Auth extends DurableObject<AuthEnv> implements AuthRpc {
    #inner: (AuthDurableObject & { boot(): Promise<void> }) | null = null;

    constructor(ctx: DurableObjectState, env: AuthEnv) {
      super(ctx, env);
      // No event reaches the object before Better Auth is loaded and the boot (migration) has run.
      void ctx.blockConcurrencyWhile(async () => {
        const auth = await loadOnce();
        const inner = new (auth.Auth as unknown as DeferredAuthClass)(ctx, env, { deferBoot: true });
        await inner.boot();
        this.#inner = inner;
      });
    }

    private get inner(): AuthDurableObject {
      if (!this.#inner) throw new Error("auth: the Auth object did not start");
      return this.#inner;
    }
    /** Better Auth options the object runs with (tests). */
    get options() {
      return this.inner.options;
    }
    override fetch(request: Request): Promise<Response> {
      // What the full class's `fetch` does.
      return this.inner.handle(request);
    }
    handle(request: Request, plan?: PasswordPlan): Promise<Response> {
      return this.inner.handle(request, plan);
    }
    credentialHash(lookup: CredentialLookup): Promise<string | null> {
      return this.inner.credentialHash(lookup);
    }
    lookupSession(q: SessionQuery): Promise<SessionInfo | null> {
      return this.inner.lookupSession(q);
    }
    getJwks(): Promise<JSONWebKeySet> {
      return this.inner.getJwks();
    }
    stats(): Promise<AuthStats> {
      return this.inner.stats();
    }
    userForSync(id: string): Promise<Record<string, unknown> | null> {
      return this.inner.userForSync(id);
    }
    rotateJwks(): Promise<JSONWebKeySet> {
      return this.inner.rotateJwks();
    }
    api(endpoint: string, input?: AuthApiInput): Promise<AuthApiResult> {
      return this.inner.api(endpoint, input);
    }
    importUsers(rows: AuthImport): Promise<AuthImportResult> {
      return this.inner.importUsers(rows);
    }
    importAuthTables(rows: AuthTablesImport): Promise<AuthTablesImportResult> {
      return this.inner.importAuthTables(rows);
    }
    adminUsers(q?: UserQuery): Promise<{ users: AdminUser[]; total: number; next: number | null }> {
      return this.inner.adminUsers(q);
    }
    adminSessions(userId: string): Promise<AdminSession[]> {
      return this.inner.adminSessions(userId);
    }
    adminRevoke(o: { userId: string; sessionId?: string }): Promise<{ revoked: number }> {
      return this.inner.adminRevoke(o);
    }
  }
  Object.defineProperty(Auth, "name", { value: "Auth" });

  return {
    Auth,
    async fetch(request, env = getEnv()) {
      // Only `<basePath>/*` (and the oauth-provider's issuer metadata) needs Better Auth; every other path answers null.
      if (!active || isLoaded) return (await loadOnce()).fetch(request, env);
      const path = new URL(request.url).pathname;
      if (!isAuthPath(path, active)) return null;
      const route = path.startsWith(active.basePath) ? path.slice(active.basePath.length) || "/" : path;
      // What the full `fetch` does, in the same order, without evaluating Better Auth in this isolate: the JWKS from
      // the verifier's cache, the Turnstile gate, the password plan, then the DO.
      const jwks = await jwksFromVerifier(request, route, getVerifier);
      if (jwks) return jwks;
      // A load during that await may have found a divergence (`active` is then null): the full path from here on.
      if (!active) return (await loadOnce()).fetch(request, env);
      if (rulesFor?.s !== active) rulesFor = { s: active, rules: rulesOf(active) };
      const rules = rulesFor.rules;
      const passwordWork = needsPasswordPlan(request.method, route, rules);
      if (!settings.turnstile && !passwordWork) return stubOf(env).handle(request);
      // Settings from an older CLI: the Worker's own work needs the config.
      const light = active.worker;
      if (!light) return (await loadOnce()).fetch(request, env);
      if (settings.turnstile && !isJwksRequest(request, route)) {
        gate ??= turnstileGate(settings.turnstile, { basePath: active.basePath, ...(light.ipAddress ? { advanced: { ipAddress: light.ipAddress } } : {}) });
        const rejected = await gate(request, env);
        if (rejected) return rejected;
      }
      if (!passwordWork) return stubOf(env).handle(request);
      // The config's own password hooks: hashed with them (the token, if any, is spent: no second gate).
      if (light.hasher !== "default") return (await loadOnce()).fetchGated(request, env);
      const { defaultHasher, preparePasswordPlan } = await import("./password.ts");
      // A load during the gate (or that import) may have found a divergence (`active` is then null): the runtime
      // config's hasher, past the gate already (no second gate, the token is spent).
      if (!active) return (await loadOnce()).fetchGated(request, env);
      const stub = stubOf(env);
      const { request: forward, plan } = await preparePasswordPlan(request, route, defaultHasher, (by) => stub.credentialHash(by), rules);
      // Same during the planning (body, hashing, credential lookup): a default-hasher plan does not fit the runtime
      // hooks. `forward` still carries the body; past the gate already.
      if (!active) return (await loadOnce()).fetchGated(forward, env);
      return stub.handle(forward, plan);
    },
    verify: async (token, o) => (await getVerifier()).verify(token, o),
    verifySensitive: async (token) => (await getVerifier()).verify(token, { sensitive: true }),
    verifyRequest: async (request, o) => (await getVerifier()).verifyRequest(request, o),
    verifyDetailed: async (token, o) => (await getVerifier()).verifyDetailed(token, o),
    verifyRequestDetailed: async (request, o) => (await getVerifier()).verifyRequestDetailed(request, o),
    stub: (env = getEnv()) => stubOf(env),
    api: (endpoint, input, env = getEnv()) => stubOf(env).api(endpoint, input),
    async rotateKeys(env = getEnv()) {
      // Without static settings the full verifier is the one in use: let it drop its cached keys itself.
      if (!active) return (await loadOnce()).rotateKeys(env);
      const jwks = await stubOf(env).rotateJwks();
      verifier = null;
      return jwks as unknown as { keys: Array<Record<string, unknown>> };
    },
    admin: {
      users: (env, q) => stubOf(env).adminUsers(q),
      sessions: (env, userId) => stubOf(env).adminSessions(userId),
      revoke: (env, o) => stubOf(env).adminRevoke(o),
    },
    load: loadOnce,
    loaded: () => isLoaded,
  };
}
