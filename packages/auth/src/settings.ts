/**
 * The light part of the Worker side: what `verify(token)` needs (secrets, issuer, cookie strategy, JWKS from the env,
 * the Auth DO stub), without Better Auth. `worker.ts` (the whole of it) and `lazy.ts` (Better Auth loaded on first
 * use) both build their verifier here, so the two paths verify exactly the same way.
 *
 * Imports nothing heavy: `jose` and `better-auth/cookies` through `verify.ts`, types otherwise.
 */
import type { JSONWebKeySet } from "jose";
import type { AuthEnv, EmberAuthConfig, EmberAuthFactory } from "./define.ts";
import { DEFAULT_BASE_PATH } from "./types.ts";
import { createVerifier, type SessionInfo, type SessionQuery, type Verifier } from "./verify.ts";

export { DEFAULT_BASE_PATH } from "./types.ts";

/** The JWT issuer Ember pins when `baseURL` is static; null means "resolved per request". */
export function jwtIssuer(baseURL: string | undefined): string | null {
  if (!baseURL) return null;
  return new URL(baseURL).origin;
}

export const stringEnv = (env: AuthEnv, k: string) => (typeof env[k] === "string" && env[k] ? (env[k] as string) : undefined);

export function parseJwksEnv(v: unknown): JSONWebKeySet | null {
  if (!v) return null;
  try {
    const j = (typeof v === "string" ? JSON.parse(v) : v) as JSONWebKeySet;
    return Array.isArray(j?.keys) ? j : null;
  } catch {
    return null;
  }
}

/** Generation 0: the deploy-time secret (also Better Auth's legacy key for payloads from before any rotation). */
export function baseSecretOf(settings: { secret?: string }, env: AuthEnv): string {
  const s = settings.secret ?? stringEnv(env, "EMBER_AUTH_SECRET") ?? stringEnv(env, "BETTER_AUTH_SECRET");
  if (!s) throw new Error("auth: missing secret (set EMBER_AUTH_SECRET)");
  return s;
}

/** `ember keys rotate --auth-secret` adds EMBER_AUTH_SECRET_R<n>; newest first. */
export function rotatedSecretsOf(settings: { secret?: string }, env: AuthEnv): Array<{ version: number; value: string }> {
  if (settings.secret) return [];
  return Object.entries(env)
    .map(([k, v]) => [/^EMBER_AUTH_SECRET_R(\d+)$/.exec(k)?.[1], v] as const)
    .filter((e): e is readonly [string, string] => e[0] !== undefined && typeof e[1] === "string" && e[1] !== "")
    .map(([n, value]) => ({ version: Number(n), value }))
    .sort((a, b) => b.version - a.version);
}

/** The secret that signs now (cookie cache, sessions): the newest generation. */
export const secretOf = (settings: { secret?: string }, env: AuthEnv) => rotatedSecretsOf(settings, env)[0]?.value ?? baseSecretOf(settings, env);

/**
 * What the Worker needs from `auth.config.ts` to verify tokens and route `/api/auth/*`, known without loading Better
 * Auth. The CLI computes it at build time (`authStaticSettings`) and embeds it in the Worker entry; the full
 * `emberAuth` computes the same from the resolved config (and the lazy path checks they agree).
 */
export interface AuthStaticSettings {
  basePath: string;
  /** `baseURL` of the config when it is a string (the issuer falls back to it after `EMBER_AUTH_URL`). */
  baseURL?: string;
  cookieStrategy: "jwe" | "compact";
  /**
   * The oauth-provider plugin is on: it answers the issuer metadata (`/.well-known/openid-configuration`,
   * `/.well-known/oauth-authorization-server`) at the origin's root, outside `basePath`, where OAuth clients look for it.
   */
  issuerMetadata?: true;
}

/** Issuer metadata paths of the oauth-provider plugin (the JWT issuer is the origin, so they sit at the root). */
const ISSUER_METADATA_PATHS = new Set(["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]);

/** Whether the Auth DO answers `path`: `<basePath>/*`, plus the issuer metadata when the oauth-provider plugin is on. */
export function isAuthPath(path: string, s: AuthStaticSettings): boolean {
  if (path === s.basePath || path.startsWith(s.basePath + "/")) return true;
  return s.issuerMetadata === true && ISSUER_METADATA_PATHS.has(path);
}

/** From a resolved Better Auth config (`EmberAuthConfig`, the value form). */
export function staticSettingsOfResolved(config: {
  basePath?: string | undefined;
  baseURL?: unknown;
  session?: { cookieCache?: { strategy?: unknown } | undefined } | undefined;
  plugins?: readonly { id?: unknown }[] | undefined;
}): AuthStaticSettings {
  return {
    basePath: config.basePath ?? DEFAULT_BASE_PATH,
    ...(typeof config.baseURL === "string" ? { baseURL: config.baseURL } : {}),
    cookieStrategy: config.session?.cookieCache?.strategy === "jwe" ? "jwe" : "compact",
    ...(config.plugins?.some((p) => p?.id === "oauth-provider") ? { issuerMetadata: true as const } : {}),
  };
}

/**
 * For the CLI (Node, at build): the static settings of the default export of `ember/auth.config.ts`, or null when
 * the config is the function form (`defineAuth((env) => ...)`: the values may depend on the env, so the Worker loads
 * the config to verify, as before).
 */
export function authStaticSettings(input: EmberAuthConfig | EmberAuthFactory | Record<string, unknown>): AuthStaticSettings | null {
  if (typeof input !== "object" || input === null || "factory" in input) return null;
  return staticSettingsOfResolved(input as Parameters<typeof staticSettingsOfResolved>[0]);
}

/** Narrow RPC surface of the Auth DO the verifier needs. */
export interface VerifierStub {
  getJwks(): Promise<JSONWebKeySet>;
  lookupSession(q: SessionQuery): Promise<SessionInfo | null>;
}

/** The Worker's verifier: JWT against the JWKS (embedded, else the Auth DO), cookie cache, session lookup. */
export function makeVerifier(o: {
  project: string;
  settings: { baseURL?: string; secret?: string; sensitive?: boolean; jwks?: JSONWebKeySet };
  config: AuthStaticSettings;
  env: AuthEnv;
  stub: () => VerifierStub;
}): Verifier {
  const issuer = jwtIssuer(o.settings.baseURL ?? stringEnv(o.env, "EMBER_AUTH_URL") ?? o.config.baseURL);
  return createVerifier({
    issuer,
    audience: issuer,
    jwks: {
      static: o.settings.jwks ?? parseJwksEnv(o.env.EMBER_AUTH_JWKS),
      fetch: () => o.stub().getJwks(),
    },
    cookie: { secret: secretOf(o.settings, o.env), prefix: o.project, strategy: o.config.cookieStrategy },
    lookup: (q) => o.stub().lookupSession(q),
    ...(o.settings.sensitive !== undefined ? { sensitive: o.settings.sensitive } : {}),
  });
}

/** `Cache-Control` of `<basePath>/jwks` answered by the Worker (keys rotate with a grace period of days). */
export const JWKS_CACHE_CONTROL = "public, max-age=300";

/**
 * `GET <basePath>/jwks` from the Worker's verifier (its cached copy of the Auth DO's JWKS), or null to let Better Auth
 * answer (another path or method, or the JWKS could not be read).
 */
export async function jwksFromVerifier(request: Request, route: string, verifier: () => Promise<Verifier> | Verifier): Promise<Response | null> {
  if (route !== "/jwks" || request.method !== "GET") return null;
  const jwks = await (await verifier()).publicJwks();
  if (!jwks) return null;
  return new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json", "cache-control": JWKS_CACHE_CONTROL } });
}
