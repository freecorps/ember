/**
 * genericOAuth with OIDC discovery off the boot path (contracts.md "Plugins do Better Auth: fluxos testados (L3)").
 *
 * Better Auth builds its context once per instance (`betterAuth()` starts `init` at once; every request and
 * `auth.api.*` call awaits that one promise), running each plugin's `init` in turn. genericOAuth's `init` fetches the
 * discovery document of every `discoveryUrl` provider, with no timeout: until the IdP answers, the single `Auth`
 * Durable Object answers no auth request at all, for any user. The plugin already knows how to live without a
 * discovery: a provider whose boot discovery failed is kept in `ctx.genericOAuthPendingDiscovery`, and a before hook
 * retries it (10 s, or `ember.fetchTimeoutMs` if shorter) on the next request that names it (`sign-in/social`, `link-social`, `callback/:id`, ...).
 *
 * So Ember's copy of the plugin starts in that state: its `init` builds only the providers without discovery (no I/O),
 * registers the discovery ones as pending, and starts their discovery in the background (bounded by
 * `ember.fetchTimeoutMs`), which installs each provider when it answers. A request naming a provider still pending
 * waits on the plugin's own retry, and if that fails too, gets a 502 `OAUTH_DISCOVERY_FAILED` instead of "provider
 * not found"; the next one retries (`/callback/:id` keeps the core's redirect with `error`). Sign-out (the IdP's
 * end-session URL) and `account-info` of an account of that provider, which name none, wait for its background
 * discovery while it is in flight; nothing else waits. Should a Better Auth release drop that pending state, the original `init` runs instead
 * (discovery at boot, as upstream does it).
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth, type GenericOAuthConfig, type GenericOAuthOptions } from "better-auth/plugins";
import { currentFetchTimeoutMs, waitAtMost } from "./fetch-timeout.ts";

/** The context fields genericOAuth's `init` sets and its hook reads. */
type DiscoveryContext = {
  socialProviders: Array<{ id: string }>;
  genericOAuthPendingDiscovery?: Map<string, GenericOAuthConfig>;
  /** Ember's: the background discoveries still in flight, by provider id (`awaitAccountDiscovery`). */
  emberGenericOAuthDiscovering?: Map<string, Promise<void>>;
  logger: { error(message: string, ...args: unknown[]): void };
};
type PluginInit = NonNullable<BetterAuthPlugin["init"]>;
type HookContext = { body?: unknown; query?: unknown; context: unknown };
type Hook = NonNullable<NonNullable<BetterAuthPlugin["hooks"]>["before"]>[number];

export const DISCOVERY_FAILED = "OAUTH_DISCOVERY_FAILED";

const pendingOf = (ctx: unknown) => (ctx as Partial<DiscoveryContext> | null)?.genericOAuthPendingDiscovery;
const discoveringOf = (ctx: unknown) => (ctx as Partial<DiscoveryContext> | null)?.emberGenericOAuthDiscovering;
/** Endpoints that use the provider of the caller's stored account without naming it (no retry of the plugin's). */
// Endpoints that use the provider of the caller's account without naming it (Better Auth 1.7.28: `/get-access-token`
// and `/refresh-token` select the account by `accountId` or the account cookie, not by provider).
const ACCOUNT_PATHS = new Set(["/sign-out", "/account-info", "/get-access-token", "/refresh-token"]);

/**
 * The provider a request names in its body or query: `sign-in/social`, `link-social`, the endpoints with `providerId`.
 * Not `params.id`, which the plugin's own retry hook also reads: on `/callback/:id` a provider still pending after that
 * retry is left to the core, which redirects the browser back to the app with `error=oauth_provider_not_found` (a JSON
 * 502 there would strand the user on the API's origin).
 */
function requestedProvider(c: HookContext): string | undefined {
  const body = (c.body ?? {}) as { provider?: unknown; providerId?: unknown };
  const query = (c.query ?? {}) as { provider?: unknown };
  const id = body.provider ?? body.providerId ?? query.provider;
  return typeof id === "string" ? id : undefined;
}

type MiddlewareContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * The user of the session a request carries, read as sign-out reads it (the signed session cookie), or from a bearer
 * token: the bearer plugin's cookie is not visible to other before hooks. Only decides whether to wait, never access.
 */
async function sessionUserId(c: MiddlewareContext): Promise<string | undefined> {
  let token = (await c.getSignedCookie(c.context.authCookies.sessionToken.name, c.context.secret)) || undefined;
  if (!token) {
    const header = c.headers?.get("authorization");
    if (header?.slice(0, 7).toLowerCase() === "bearer ") {
      try {
        token = decodeURIComponent(header.slice(7).trim()).split(".")[0];
      } catch {}
    }
  }
  if (!token) return undefined;
  const found = (await c.context.internalAdapter.findSession(token)) as { user?: { id?: string } } | null;
  return found?.user?.id;
}

/**
 * One provider's discovery, off the request path; installs it unless a request's retry got there first. Whichever
 * discovery (this one, or the plugin's retry on a request naming the provider) answers first takes the provider out of
 * the pending map and installs it; the other finds it gone and drops its copy: the same `pending.delete(id)` guard the
 * plugin's retry uses, and both run synchronously after their `await`, so the provider is installed exactly once.
 */
async function discoverInBackground(options: GenericOAuthOptions, c: GenericOAuthConfig, ctx: DiscoveryContext): Promise<void> {
  try {
    // The plugin's own builder (one config): what its boot would have done. The probe reads the live context (logger,
    // baseURL, also later through the provider's closures) but has its own provider list and pending map, so the
    // result holds only this one and nothing the builder touches is the live state. (A write to the probe lands on the
    // probe: assignment never reaches the prototype.)
    const probe = Object.create(ctx, {
      socialProviders: { value: [], writable: true },
      genericOAuthPendingDiscovery: { value: new Map(), writable: true },
    }) as DiscoveryContext;
    const built = (await genericOAuth({ ...options, config: [c] }).init!(probe as unknown as Parameters<PluginInit>[0])) as
      | { context?: Partial<DiscoveryContext> }
      | undefined;
    const provider = built?.context?.socialProviders?.find((p) => p.id === c.providerId);
    if (provider && ctx.genericOAuthPendingDiscovery?.delete(c.providerId)) ctx.socialProviders.unshift(provider);
  } catch (e) {
    ctx.logger.error(`Discovery failed for "${c.providerId}" (retried on its next sign-in): ${String(e)}`);
  }
}

export function deferGenericOAuthDiscovery(plugin: BetterAuthPlugin): BetterAuthPlugin {
  if (plugin.id !== "generic-oauth" || !plugin.init) return plugin;
  const options = plugin.options as GenericOAuthOptions | undefined;
  if (!options || !Array.isArray(options.config)) return plugin;
  const deferred = options.config.filter((c) => c.discoveryUrl);
  if (deferred.length === 0) return plugin;
  const original = plugin.init;
  const withoutDiscovery = genericOAuth({ ...options, config: options.config.filter((c) => !c.discoveryUrl) });

  type InitContext = Parameters<PluginInit>[0];
  const init = async (ctx: InitContext): Promise<unknown> => {
    const result = (await withoutDiscovery.init!(ctx)) as { context?: Partial<DiscoveryContext> } | undefined;
    const context = result?.context;
    const pending = context?.genericOAuthPendingDiscovery;
    // Not the pending state this file relies on (a Better Auth release changed it): upstream's boot discovery.
    if (!(pending instanceof Map) || !Array.isArray(context?.socialProviders)) return original(ctx);
    for (const c of deferred) pending.set(c.providerId, c);
    const discovering = new Map<string, Promise<void>>();
    (context as Partial<DiscoveryContext>).emberGenericOAuthDiscovering = discovering;
    // What Better Auth does with the result once `init` returns, done now so the background discoveries below (and
    // whichever request retries first) see the same provider list and pending map.
    Object.assign(ctx, context);
    for (const c of deferred) {
      const id = c.providerId;
      discovering.set(id, discoverInBackground(options, c, ctx as unknown as DiscoveryContext).finally(() => discovering.delete(id)));
    }
    return result;
  };

  // After the plugin's retry: a provider still pending is an IdP that did not answer, not an unknown provider.
  const failClearly: Hook = {
    matcher: (c: HookContext) => {
      const id = requestedProvider(c);
      return id !== undefined && pendingOf(c.context)?.has(id) === true;
    },
    handler: createAuthMiddleware(async (c) => {
      const id = requestedProvider(c);
      if (id === undefined || pendingOf(c.context)?.has(id) !== true) return;
      throw new APIError("BAD_GATEWAY", {
        code: DISCOVERY_FAILED,
        message: `OIDC discovery for provider "${id}" failed (its IdP did not answer in time or sent no usable document); the next request retries it`,
      });
    }),
  } as Hook;

  // Sign-out (the IdP's end-session URL), account-info, get-access-token and refresh-token use the provider of the
  // caller's account without naming it,
  // so the plugin's retry does not run for them. Right after a cold start, while that provider's background discovery
  // is still in flight, they wait for it (bounded by `ember.fetchTimeoutMs`) instead of running without the provider;
  // the caller's session is looked up only then, and a caller with no account of such a provider does not wait.
  const awaitAccountDiscovery: Hook = {
    matcher: (c: HookContext & { path?: string }) => ACCOUNT_PATHS.has(c.path ?? "") && (discoveringOf(c.context)?.size ?? 0) > 0,
    handler: createAuthMiddleware(async (c) => {
      const discovering = discoveringOf(c.context);
      if (!discovering?.size) return;
      // A server call (`auth.api.getAccessToken({ body: { accountId, userId } })`) names its user in the body.
      const bodyUser = (c.body as { userId?: unknown } | undefined)?.userId;
      const userId = (await sessionUserId(c)) ?? (typeof bodyUser === "string" ? bodyUser : undefined);
      if (!userId) return;
      const accounts = await c.context.internalAdapter.findAccounts(userId);
      // At most `ember.fetchTimeoutMs` in total (a discovery may be several fetches: redirects); the discovery itself
      // keeps running and installs the provider when it ends.
      await waitAtMost(Promise.all(accounts.map((a) => discovering.get(a.providerId))), currentFetchTimeoutMs());
    }),
  } as Hook;

  return {
    ...plugin,
    init: init as PluginInit,
    hooks: { ...plugin.hooks, before: [...(plugin.hooks?.before ?? []), failClearly, awaitAccountDiscovery] },
  };
}
