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
 * `ember.fetchTimeoutMs`), which installs each provider when it answers — the end-session URL of sign-out and
 * `account-info` see them as before, without anything waiting on them. A request for a provider still pending waits
 * on the plugin's own retry, and if that fails too, gets a 502 `OAUTH_DISCOVERY_FAILED` instead of "provider not
 * found"; the next one retries. Should a Better Auth release drop that pending state, the original `init` runs instead
 * (discovery at boot, as upstream does it).
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth, type GenericOAuthConfig, type GenericOAuthOptions } from "better-auth/plugins";

/** The context fields genericOAuth's `init` sets and its hook reads. */
type DiscoveryContext = {
  socialProviders: Array<{ id: string }>;
  genericOAuthPendingDiscovery?: Map<string, GenericOAuthConfig>;
  logger: { error(message: string, ...args: unknown[]): void };
};
type PluginInit = NonNullable<BetterAuthPlugin["init"]>;
type HookContext = { body?: unknown; query?: unknown; context: unknown };
type Hook = NonNullable<NonNullable<BetterAuthPlugin["hooks"]>["before"]>[number];

export const DISCOVERY_FAILED = "OAUTH_DISCOVERY_FAILED";

const pendingOf = (ctx: unknown) => (ctx as Partial<DiscoveryContext> | null)?.genericOAuthPendingDiscovery;

/** The provider a request names in its body or query (the plugin's own matcher also reads `params.id`: the callback). */
function requestedProvider(c: HookContext): string | undefined {
  const body = (c.body ?? {}) as { provider?: unknown; providerId?: unknown };
  const query = (c.query ?? {}) as { provider?: unknown };
  const id = body.provider ?? body.providerId ?? query.provider;
  return typeof id === "string" ? id : undefined;
}

/** One provider's discovery, off the request path; installs it unless a request's retry got there first. */
async function discoverInBackground(options: GenericOAuthOptions, c: GenericOAuthConfig, ctx: DiscoveryContext): Promise<void> {
  try {
    // The plugin's own builder (one config): what its boot would have done. The probe inherits the live context
    // (logger, baseURL) with no providers of its own, so the result holds only this one.
    const probe = Object.create(ctx, { socialProviders: { value: [], writable: true } }) as DiscoveryContext;
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
    // What Better Auth does with the result once `init` returns, done now so the background discoveries below (and
    // whichever request retries first) see the same provider list and pending map.
    Object.assign(ctx, context);
    for (const c of deferred) void discoverInBackground(options, c, ctx as unknown as DiscoveryContext);
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

  return { ...plugin, init: init as PluginInit, hooks: { ...plugin.hooks, before: [...(plugin.hooks?.before ?? []), failClearly] } };
}
