/**
 * `defineAuth`'s `ember.passwordRules` / `ember.hiddenUserFields` / `ember.fetchTimeoutMs`: validation, static settings,
 * the hidden rule; and the genericOAuth plugin as `resolveAuthOptions` hands it to Better Auth (`generic-oauth.ts`).
 */
import { describe, expect, it } from "vitest";
import type { BetterAuthPlugin } from "better-auth";
import { authReplicaSpec, authStaticSettings, authTablesManifest, defineAuth, userJournalDDL } from "../../src/index.ts";
import { sameStaticSettings } from "../../src/settings.ts";
import { codegenOptions } from "../../src/codegen.ts";
import { resolveAuthOptions, strictSessionRequest } from "../../src/options.ts";

const secretPlugin = { id: "vault", schema: { user: { fields: { vaultSecret: { type: "string", required: false } } } } } as unknown as BetterAuthPlugin;
const bad = (ember: unknown) => () => defineAuth({ emailAndPassword: { enabled: true }, ember: ember as never });

describe("defineAuth: ember.passwordRules", () => {
  it("accepts rules by email, username, phoneNumber and session, with keyField", () => {
    expect(() =>
      defineAuth({
        ember: {
          passwordRules: {
            "/a": { hash: ["password"] },
            "/b": { verify: { field: "secret", by: "email", keyField: "login" } },
            "/c": { hash: ["newPassword"], verify: { field: "current", by: "session" } },
            "/d": { verify: { field: "pin", by: "username" } },
            "/e": { verify: { field: "pin", by: "phoneNumber" } },
          },
        },
      }),
    ).not.toThrow();
  });

  it("refuses malformed rules with a message naming the entry", () => {
    expect(bad({ passwordRules: [] })).toThrow(/ember\.passwordRules: must be an object of rules by endpoint path/);
    expect(bad({ passwordRules: { "my/sign-in": { hash: ["password"] } } })).toThrow(/rule "my\/sign-in": the key is the endpoint path relative to basePath and starts with "\/"/);
    expect(bad({ passwordRules: { "/x": {} } })).toThrow(/rule "\/x" needs hash and\/or verify/);
    expect(bad({ passwordRules: { "/x": { hash: "password" } } })).toThrow(/rule "\/x": hash must be an array of body field names/);
    expect(bad({ passwordRules: { "/x": { verify: { field: "password", by: "nickname" } } } })).toThrow(/verify\.by must be one of "email", "username", "phoneNumber", "session" \(got "nickname"\)/);
    expect(bad({ passwordRules: { "/x": { verify: { by: "email" } } } })).toThrow(/verify\.field must be the body field holding the password/);
    expect(bad({ passwordRules: { "/x": { verify: { field: "p", by: "email", key: "login" } } } })).toThrow(/verify has an unknown key "key"/);
    expect(bad({ passwordRules: { "/x": { hash: ["p"], check: true } } })).toThrow(/unknown key "check"/);
  });

  it("travels in the static settings (what the CLI embeds) and takes part in the build/runtime comparison", () => {
    const rules = { "/vault/unlock": { verify: { field: "secret", by: "email" as const } } };
    const s = authStaticSettings(defineAuth({ emailAndPassword: { enabled: true }, ember: { passwordRules: rules } }))!;
    expect(s.worker).toEqual({ hasher: "default", passwordRules: rules });
    const without = authStaticSettings(defineAuth({ emailAndPassword: { enabled: true } }))!;
    expect(without.worker).toEqual({ hasher: "default" });
    expect(sameStaticSettings(s, without)).toBe(false);
  });
});

describe("defineAuth: ember.hiddenUserFields", () => {
  it("must be an array of names", () => {
    expect(bad({ hiddenUserFields: "vaultSecret" })).toThrow(/ember\.hiddenUserFields must be an array of user field names/);
    expect(bad({ hiddenUserFields: [""] })).toThrow(/hiddenUserFields/);
  });

  it("hides the field from auth:user and its replica; a name that is not a user field fails at codegen", async () => {
    const { organization } = await import("better-auth/plugins");
    const cfg = defineAuth({ plugins: [organization(), secretPlugin], ember: { hiddenUserFields: ["vaultSecret"], replicate: { organization: true } } });
    const user = authTablesManifest(cfg).find((t) => t.model === "user")!;
    expect(user.fields.find((f) => f.name === "vaultSecret")?.hidden).toBe(true);
    expect(user.fields.find((f) => f.name === "email")?.hidden).toBe(false);
    const replica = authReplicaSpec(cfg)!.tables.find((t) => t.model === "user")!;
    expect(replica.fields.map((f) => f.name)).not.toContain("vaultSecret");
    expect(Object.keys(replica.columns)).not.toContain("vaultSecret");

    const typo = defineAuth({ plugins: [secretPlugin], ember: { hiddenUserFields: ["vault_secret"] } });
    expect(() => authTablesManifest(typo)).toThrow(/hiddenUserFields names "vault_secret", which is not a field of the user model/);
  });

  it("the function form defineAuth((env) => ...) hides it too (auth:user and its replica)", async () => {
    const { organization } = await import("better-auth/plugins");
    const cfg = defineAuth(() => ({ plugins: [organization(), secretPlugin], ember: { hiddenUserFields: ["vaultSecret"], replicate: { organization: true } } }));
    expect(authTablesManifest(cfg).find((t) => t.model === "user")!.fields.find((f) => f.name === "vaultSecret")?.hidden).toBe(true);
    expect(authReplicaSpec(cfg)!.tables.find((t) => t.model === "user")!.fields.map((f) => f.name)).not.toContain("vaultSecret");
  });

  it("the user journal's delete row leaves hidden fields out", () => {
    const options = codegenOptions(defineAuth({ plugins: [secretPlugin] }));
    const plain = userJournalDDL(options).join("\n");
    expect(plain).toContain("'vaultSecret'");
    const hidden = userJournalDDL(options, new Set(["vaultSecret"])).join("\n");
    expect(hidden).not.toContain("vaultSecret");
    expect(hidden).toContain("'email'");
  });
});

describe("resolveAuthOptions: the password hooks", () => {
  const password = { hash: async () => "h", verify: async () => true };
  it("are installed without emailAndPassword (a plugin's password endpoints only), email sign-in staying off", () => {
    const o = resolveAuthOptions(defineAuth({ plugins: [secretPlugin] }), { project: "p", password });
    expect(o.emailAndPassword?.password).toBe(password);
    expect(o.emailAndPassword?.enabled).toBe(false);
  });
  it("keep the app's emailAndPassword settings", () => {
    const o = resolveAuthOptions(defineAuth({ emailAndPassword: { enabled: true, minPasswordLength: 12 } }), { project: "p", password });
    expect(o.emailAndPassword).toMatchObject({ enabled: true, minPasswordLength: 12, password });
  });
  it("leave emailAndPassword alone without a plan", () => {
    expect(resolveAuthOptions(defineAuth({}), { project: "p" }).emailAndPassword).toBeUndefined();
  });
});

describe("strictSessionRequest", () => {
  const flag = (path: string) => new URL(strictSessionRequest(new Request(`https://a.test/api/auth${path}`), "/api/auth").url).searchParams.get("disableCookieCache");
  it("puts disableCookieCache on the routes that mint a JWT, trailing slash included (skipTrailingSlashes)", () => {
    expect(flag("/token")).toBe("true");
    expect(flag("/token/")).toBe("true");
    expect(flag("/get-session/")).toBe("true");
    expect(flag("/sign-in/email")).toBeNull();
  });
});

describe("defineAuth: ember.fetchTimeoutMs", () => {
  it("whole milliseconds from 0, or false; the Auth object's bound defaults to 10 s and 0/false turn it off", async () => {
    const { DEFAULT_FETCH_TIMEOUT_MS, fetchTimeoutOf } = await import("../../src/define.ts");
    for (const v of [-1, 1.5, "1000", Number.NaN, Infinity, 2 ** 31, true]) {
      expect(bad({ fetchTimeoutMs: v }), String(v)).toThrow(/ember\.fetchTimeoutMs must be a whole number of milliseconds from 0 to 2147483647, or false/);
    }
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(fetchTimeoutOf(defineAuth({}))).toBe(10_000);
    expect(fetchTimeoutOf(defineAuth({ ember: { fetchTimeoutMs: 2_500 } }))).toBe(2_500);
    expect(fetchTimeoutOf(defineAuth({ ember: { fetchTimeoutMs: 0 } }))).toBe(0);
    expect(fetchTimeoutOf(defineAuth({ ember: { fetchTimeoutMs: false } }))).toBe(0);
  });
});

describe("genericOAuth: discovery off Better Auth's init", () => {
  it("init returns at once with the discovery providers pending, then the background discovery installs them", async () => {
    const { genericOAuth } = await import("better-auth/plugins");
    const discoveryUrl = "https://idp.example/.well-known/openid-configuration";
    const plugin = genericOAuth({
      config: [
        { providerId: "oidc", clientId: "c", clientSecret: "s", discoveryUrl },
        { providerId: "plain", clientId: "c", clientSecret: "s", authorizationUrl: "https://idp.example/authorize", tokenUrl: "https://idp.example/token" },
      ],
    }) as unknown as BetterAuthPlugin;
    const resolved = resolveAuthOptions(defineAuth({ plugins: [plugin] }), { project: "acme" });
    const wrapped = resolved.plugins!.find((p) => p.id === "generic-oauth")!;
    // Ember's two: the 502 of a provider still pending, and sign-out / account-info waiting on a background discovery.
    expect(wrapped.hooks?.before?.length).toBe((plugin.hooks?.before?.length ?? 0) + 2);

    let answer!: (r: Response) => void;
    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return new Promise<Response>((r) => (answer = r));
    }) as typeof fetch;
    try {
      const errors: string[] = [];
      const ctx = { socialProviders: [] as { id: string }[], logger: { error: (m: string) => errors.push(m), warn() {} }, baseURL: "http://localhost" };
      // The IdP has not answered: init does not wait for it.
      const result = (await wrapped.init!(ctx as never)) as { context: { socialProviders: { id: string }[]; genericOAuthPendingDiscovery: Map<string, unknown> } };
      expect(result.context.socialProviders.map((p) => p.id)).toEqual(["plain"]);
      expect([...result.context.genericOAuthPendingDiscovery.keys()]).toEqual(["oidc"]);
      const tick = () => new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 50 && requested.length === 0; i++) await tick();
      expect(requested).toEqual([discoveryUrl]);
      answer(
        Response.json({
          issuer: "https://idp.example",
          authorization_endpoint: "https://idp.example/authorize",
          token_endpoint: "https://idp.example/token",
          jwks_uri: "https://idp.example/jwks",
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
      for (let i = 0; i < 50 && ctx.socialProviders.length < 2; i++) await tick();
      expect(ctx.socialProviders.map((p) => p.id)).toEqual(["oidc", "plain"]);
      expect(result.context.genericOAuthPendingDiscovery.size).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("fetchTimeoutOf: a config that did not go through defineAuth", () => {
  it("an invalid ember.fetchTimeoutMs is refused, not read as 'off'", async () => {
    const { fetchTimeoutOf } = await import("../../src/define.ts");
    for (const v of [true, "1000", Number.NaN, Infinity, -1, 1.5, null]) {
      expect(() => fetchTimeoutOf({ ember: { fetchTimeoutMs: v } }), String(v)).toThrow(/ember\.fetchTimeoutMs must be a whole number of milliseconds/);
    }
    expect(fetchTimeoutOf({})).toBe(10_000);
    expect(fetchTimeoutOf({ ember: {} })).toBe(10_000);
    expect(fetchTimeoutOf({ ember: { fetchTimeoutMs: 1_234 } })).toBe(1_234);
    expect(fetchTimeoutOf({ ember: { fetchTimeoutMs: false } })).toBe(0);
  });
});

describe("genericOAuth: background discovery and a request's retry", () => {
  const discoveryUrl = "https://idp.example/.well-known/openid-configuration";
  const document = () =>
    Response.json({
      issuer: "https://idp.example",
      authorization_endpoint: "https://idp.example/authorize",
      token_endpoint: "https://idp.example/token",
      jwks_uri: "https://idp.example/jwks",
      id_token_signing_alg_values_supported: ["RS256"],
    });
  type Ctx = { socialProviders: { id: string }[]; genericOAuthPendingDiscovery?: Map<string, unknown>; logger: unknown; baseURL: string };
  type HookArg = { context: Ctx; body?: unknown; query?: unknown; params?: unknown; path?: string };

  async function setup() {
    const { genericOAuth } = await import("better-auth/plugins");
    const plugin = genericOAuth({ config: [{ providerId: "oidc", clientId: "c", clientSecret: "s", discoveryUrl }] }) as unknown as BetterAuthPlugin;
    const wrapped = resolveAuthOptions(defineAuth({ plugins: [plugin] }), { project: "acme" }).plugins!.find((p) => p.id === "generic-oauth")!;
    const answers: Array<(r: Response) => void> = [];
    globalThis.fetch = (() => new Promise<Response>((r) => answers.push(r))) as typeof fetch;
    const errors: string[] = [];
    const ctx: Ctx = { socialProviders: [], logger: { error: (m: string) => errors.push(m), warn() {}, info() {}, debug() {} }, baseURL: "http://localhost" };
    const result = (await wrapped.init!(ctx as never)) as { context: Ctx };
    // What Better Auth does with init's result.
    Object.assign(ctx, result.context);
    const hooks = wrapped.hooks!.before! as unknown as Array<{ matcher: (c: HookArg) => boolean; handler: (c: HookArg) => Promise<unknown> }>;
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await tick();
    };
    return { ctx, hooks, answers, errors, until, tick };
  }

  const realFetch = globalThis.fetch;
  const restore = () => (globalThis.fetch = realFetch);

  for (const first of ["background", "request"] as const) {
    it(`both discoveries in flight, the ${first} one answers first: the provider is installed exactly once`, async () => {
      try {
        const { ctx, hooks, answers, errors, until, tick } = await setup();
        await until(() => answers.length === 1); // the background discovery
        // A sign-in names the pending provider: the plugin's own hook retries the discovery for it.
        const request = { context: ctx, body: { provider: "oidc" }, path: "/sign-in/social" };
        expect(hooks[0]!.matcher(request)).toBe(true);
        const retry = hooks[0]!.handler(request);
        await until(() => answers.length === 2);
        const [background, retried] = answers;
        if (first === "background") {
          background!(document());
          await until(() => ctx.socialProviders.length > 0);
          retried!(document());
        } else {
          retried!(document());
          await retry;
          background!(document());
        }
        await retry;
        for (let i = 0; i < 10; i++) await tick();
        expect(ctx.socialProviders.map((p) => p.id)).toEqual(["oidc"]);
        expect(ctx.genericOAuthPendingDiscovery!.size).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        restore();
      }
    });
  }

  it("the background discovery's probe writes nothing on the live context", async () => {
    try {
      const { ctx, answers, until, tick } = await setup();
      const pending = ctx.genericOAuthPendingDiscovery!;
      const keys = Object.keys(ctx).sort();
      await until(() => answers.length === 1);
      answers[0]!(document());
      await until(() => ctx.socialProviders.length > 0);
      for (let i = 0; i < 5; i++) await tick();
      // Same fields, same pending map (only emptied), the one provider added to the same list.
      expect(Object.keys(ctx).sort()).toEqual(keys);
      expect(ctx.genericOAuthPendingDiscovery).toBe(pending);
      expect(ctx.socialProviders.map((p) => p.id)).toEqual(["oidc"]);
    } finally {
      restore();
    }
  });

  it("the 502 hook answers sign-in style requests; a callback to a pending provider is left to the core's error redirect", async () => {
    try {
      const { ctx, hooks } = await setup();
      const failClearly = hooks[1]!; // after the plugin's own retry hook
      expect(failClearly.matcher({ context: ctx, body: { provider: "oidc" } })).toBe(true);
      expect(failClearly.matcher({ context: ctx, body: { providerId: "oidc" } })).toBe(true);
      expect(failClearly.matcher({ context: ctx, query: { provider: "oidc" } })).toBe(true);
      // The plugin's own retry hook does run on the callback (it reads params.id) ...
      expect(hooks[0]!.matcher({ context: ctx, params: { id: "oidc" }, path: "/callback/:id" })).toBe(true);
      // ... but a browser coming back from the IdP gets the core's redirect with `error`, not a JSON 502.
      expect(failClearly.matcher({ context: ctx, params: { id: "oidc" }, path: "/callback/:id" })).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("genericOAuth: one instance per config", () => {
  it("defineAuth refuses a second genericOAuth plugin (it would replace the first one's pending discoveries)", async () => {
    const { genericOAuth } = await import("better-auth/plugins");
    const oidc = genericOAuth({ config: [{ providerId: "oidc", clientId: "c", clientSecret: "s", discoveryUrl: "https://idp.example/.well-known/openid-configuration" }] });
    const manual = genericOAuth({ config: [{ providerId: "plain", clientId: "c", clientSecret: "s", authorizationUrl: "https://idp.example/a", tokenUrl: "https://idp.example/t" }] });
    expect(() => defineAuth({ plugins: [oidc, manual] as unknown as BetterAuthPlugin[] })).toThrow(/plugin "generic-oauth" is listed twice/);
  });
});
