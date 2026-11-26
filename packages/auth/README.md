# @freecorps/ember-auth

[Better Auth](https://www.better-auth.com) for [Ember](https://github.com/freecorps/ember), running in a dedicated
`Auth` Durable Object next to its own SQLite. Ember adds the database, the secret and the `bearer()` and `jwt()`
plugins; your functions see the signed-in user through `ctx.auth`, verified from short-lived JWTs (5 minutes) without
a round trip to the `Auth` object.

```sh
npm install @freecorps/ember-auth
```

`npx @freecorps/ember-cli init --auth` writes a starting `ember/auth.config.ts`; the CLI finds that file and wires the
`Auth` Durable Object, `/api/auth/*` and token verification into the Worker it builds.

## Example

From [`examples/files-auth-jobs`](https://github.com/freecorps/ember/tree/main/examples/files-auth-jobs):

```ts
// ember/auth.config.ts
import { defineAuth } from "@freecorps/ember-auth";
import { organization } from "better-auth/plugins";

export default defineAuth({
  emailAndPassword: { enabled: true },
  trustedOrigins: ["http://localhost:5173"],
  plugins: [organization({ teams: { enabled: true }, async sendInvitationEmail() {} })],
  ember: {
    // each organization's Better Auth rows are copied into the shard org:<organizationId> as read-only auth:* tables
    replicate: { organization: true },
  },
});
```

```ts
// in a function
const me = ctx.auth.getUserIdentity();   // { subject, ... } or null (in actions: await it)
const user = ctx.auth.require();         // throws Unauthenticated when signed out
// a function keyed by the active organization: shard: { org: fromAuth("org") }
// a mutation that rechecks the live session: mutation({ sensitive: true, ... })
```

The claims are typed from this file: `ember codegen` prints `ClaimsOf<typeof authConfig>` in
`ember/_generated/claims.d.ts`, and `./_generated/server` types `ctx.auth` and `fromAuth` with it. They are Better
Auth's (`sid`, `email`, `name`, `emailVerified`), `org?` with the `organization()` plugin, and what `ember.claims`
returns, optional (only a JWT carries those; an identity from a session token or the session cookie has Better
Auth's alone):

```ts
export default defineAuth({
  plugins: [organization()],
  ember: { claims: ({ user }) => ({ role: user.role === "admin" ? ("admin" as const) : ("member" as const) }) },
});
// ctx.auth.require().claims?.role: "admin" | "member" | undefined; fromAuth("tenant"): a type error
```

A custom claim that reuses a built-in name (`email`) replaces it in the JWT (`ember.claims` is spread last), so that
name is typed as either value (`string | number` for `email: 123`).

On the client, any Better Auth client works against `/api/auth/*`; `@freecorps/ember-react-native` has
`createEmberAuthClient` (session in SecureStore, JWTs for Ember).

## Entry points

| Import | What it is |
|---|---|
| `@freecorps/ember-auth` | `defineAuth` (value or `(env) => options` form) for `auth.config.ts`, plus the config and codegen helpers the CLI uses |
| `@freecorps/ember-auth/worker` | `emberAuth` (the `Auth` Durable Object and the verify hook), `remoteAuth({ from })` (verify against another project's auth: SSO), `createVerifier`, `turnstileGate`, `doSqliteAdapter` |
| `@freecorps/ember-auth/lazy` | `emberAuthLazy`: what the generated Worker uses, so Better Auth and `auth.config.ts` load only in the `Auth` object and on `/api/auth/*` |
| `@freecorps/ember-auth/remote` | `remoteAuth` alone, with no Better Auth in its import graph: what the generated Worker uses for SSO (`auth.from`) |
| `@freecorps/ember-auth/plugins` | re-export of `better-auth/plugins` |
| `@freecorps/ember-auth/session-lookup` | `signSessionLookup` / `verifySessionLookupRequest`: the origin side of the signed session check a backend you are moving away from answers |

## Better Auth plugins

Ember pins Better Auth to a minor version (`~1.7.28`; tested with 1.7.28). Plugins go in `plugins` as in any Better
Auth app:

```ts
// ember/auth.config.ts
import { defineAuth } from "@freecorps/ember-auth";
import { twoFactor, username } from "@freecorps/ember-auth/plugins"; // = better-auth/plugins, at Ember's version
import { passkey } from "@better-auth/passkey";                        // npm install @better-auth/passkey@~1.7.28

export default defineAuth({
  emailAndPassword: { enabled: true },
  plugins: [twoFactor(), username(), passkey({ rpID: "example.com", rpName: "Example" })],
});
```

- **Versions.** Install `@better-auth/*` packages at the same `~1.7.x` as Ember's `better-auth`. They declare
  `better-auth ^1.7.<patch>` as a peer, and two copies of Better Auth or `better-call` in one bundle break the plugin's
  errors and schema checks.
- **Tables are automatic.** A plugin's tables and fields come from Better Auth's own schema. `ember codegen` types them
  as read-only `auth:<model>` tables (`Doc<"auth:passkey">`), and the `Auth` object creates them on its first boot
  after the deploy. You do not run a migration step. Changes are additive: new tables, new columns and indexes. A
  change that could lose data stops the boot with `AuthMigrationError` and changes nothing. That covers a column's
  type, a removed `NOT NULL` column, a new required column on a non-empty table, and a changed foreign key.
- **What Ember sets, and refuses from you:**
  - `database`, `secret` and `secondaryStorage` are Ember's. Setting one in `auth.config.ts` is an error. Rate limits
    are stored in the `Auth` object's SQLite.
  - Ember adds `jwt()` (5-minute tokens verified in the Worker), so adding your own `jwt()` is an error. Ember also adds
    `bearer()` when you leave it out (yours is kept).
  - `session.cookieCache.strategy: "jwt"` is refused. Use `"compact"` (the default) or `"jwe"`.
    `advanced.cookiePrefix` is the project name.
  - `captcha()` and `ember.json` `auth.turnstile` are mutually exclusive. Prefer `auth.turnstile`: it runs Turnstile in
    the Worker before any password work, with the plugin's routes and responses.

### Compatibility

Every plugin below is tested end to end in workerd. Each test goes through the Ember Worker to a real `Auth` object
with `strictHashing` on, and ends as an Ember identity in `ctx.auth`. The flows and notes for the plugins of
`packages/auth/test/plugins` are in contracts.md,
["Plugins do Better Auth: fluxos testados"](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md#plugins-do-better-auth-fluxos-testados-l3)
(in Portuguese).

| Plugin | Verdict | What to know |
|---|---|---|
| `@better-auth/api-key` | ✅ | With `enableSessionForAPIKeys: true`, a client trades the key for an Ember JWT at `<basePath>/token` |
| `@better-auth/passkey` | ✅ | |
| `@better-auth/sso` (OIDC, SAML) | ✅ | The IdP's endpoints must be in `trustedOrigins`. `samlify` is CommonJS (see below) |
| `@better-auth/oauth-provider` | ✅ | The project as an OAuth 2.1 / OIDC provider. Its tokens do not open `ctx.auth` (`aud` is the client) |
| `@better-auth/scim` | ✅ | Map groups to org roles in `projection.reconcileUser` |
| `@better-auth/stripe` | ✅ | `Stripe.createFetchHttpClient()`; the webhook secret comes from `env` (function form of `defineAuth`) |
| `@better-auth/expo` | ✅ | The app scheme goes in `trustedOrigins` |
| organization, twoFactor, username, phoneNumber, magicLink, emailOTP | ✅ | In `test/flows.test.ts` and `test/passwords.test.ts`. Their password endpoints are hashed in the Worker. Organizations can be copied into org shards (`ember.replicate`) |
| anonymous, admin, multiSession, oneTimeToken, customSession, lastLoginMethod, deviceAuthorization, openAPI, oneTap | ✅ | `customSession` does not affect Ember's own session checks |
| haveIBeenPwned | ✅ | The range API is called from the `Auth` object (outbound `fetch`); a rejected password still costs one hash in the Worker |
| siwe | ✅ | You supply `verifyMessage` (for example with viem). The tests use a fake wallet, so secp256k1 on workerd is not exercised |
| genericOAuth | ✅ | With `discoveryUrl`, discovery no longer holds the `Auth` object at boot: it runs in the background, other auth requests are served at once, and a sign-in through that provider waits for it (up to the shorter of the plugin's own 10 s retry timeout and `ember.fetchTimeoutMs`, then a 502 `OAUTH_DISCOVERY_FAILED`; the next sign-in tries again), as do sign-out, `account-info`, `get-access-token` and `refresh-token` of an account of that provider (at most `ember.fetchTimeoutMs` in total). Setting `authorizationUrl`, `tokenUrl` and `userInfoUrl` instead still works and needs no discovery at all (the id_token is then not checked against the IdP's JWKS) |

### Third-party plugins

- **Password endpoints.** Ember hashes and verifies the passwords of the endpoints it knows (`PASSWORD_RULES`, checked
  against the installed Better Auth by a test). A plugin endpoint that takes a password must be declared, or it hashes
  inside the single `Auth` object (slow, and it serializes every auth request):

  ```ts
  ember: {
    passwordRules: {
      // hash: body fields holding new passwords
      "/my-plugin/set-pin": { hash: ["pin"] },
      // verify: the body field to check, and how the Worker finds the stored hash:
      // by "email" | "username" | "phoneNumber" (read from that body field, or from keyField) | "session"
      "/my-plugin/sign-in": { verify: { field: "secret", by: "email" } },
      "/my-plugin/confirm": { verify: { field: "currentPassword", by: "session" } },
    },
  }
  ```

  A rule for a path Ember already knows replaces the built-in one. `defineAuth` checks the shape and names the bad
  rule.
- **Secret fields on `user`.** Fields marked `returned: false` never leave the `Auth` object. If a plugin keeps a
  secret on the user row without that flag, list it in `ember: { hiddenUserFields: ["myPluginSecret"] }`. It is then
  kept out of the profile sync (`users.sync`) and of the `auth:user` tables (replicas and generated types). Codegen
  rejects a name that is not a field of `user`.
- **Runtime.** The `Auth` object is a Durable Object on workerd with `nodejs_compat`, so a plugin must not need
  Node-only APIs beyond that (native addons, `fs`, raw TCP database drivers). Outbound calls use `fetch`. CommonJS
  dependencies are fine in a deploy, because `ember deploy` bundles the Worker with esbuild. A test runner may still
  need them pre-bundled: `packages/auth/vitest.config.ts` bundles `samlify` (the SAML library of `@better-auth/sso`)
  with esbuild for `@cloudflare/vitest-plugin`.
- **Table names.** App tables may not use the `auth:` prefix or a Better Auth model name (`user`, `session`,
  `organization`, `passkey`, `oauthClient`, `scimUser`… see `RESERVED_AUTH_TABLES`). That holds whether or not the
  plugin is enabled, so enabling one later never collides. A plugin's custom `modelName` is reserved too. Extend users
  with `user.additionalFields`.

### `strictHashing`

`emberAuth(config, { strictHashing: true })` makes the `Auth` object throw `LocalHashError` instead of hashing or
verifying a password itself. Turn it on in tests: if a flow passes, every password in it was hashed in the Worker,
which also catches a plugin endpoint that needs a `passwordRules` entry. Without it, such an endpoint still works but
runs scrypt in the `Auth` object, which shows up in `stats().localHashes`.

### Checking a plugin

Use [`packages/auth/test/plugins`](https://github.com/freecorps/ember/tree/main/packages/auth/test/plugins) as the
pattern. It has a Worker wired like the generated entry (`worker.ts`, with `strictHashing`), one `auth.config.ts`
holding every plugin, fakes for the third parties in the same isolate (`fakes.ts`, intercepting `fetch`, no network),
and tests that drive HTTP as a browser would. Each test ends by checking the Ember JWT in a shard (`ctx.auth`) and
what reached the profile outbox. `schema.test.ts` checks that the tables codegen sees are the ones the `Auth` object
migrated, and that secret fields are hidden.

## Worth knowing

- `ember.json` `auth.from` points a project at another project's auth (SSO): no `Auth` object there, tokens are
  verified through the issuer's JWKS.
- A claim used as a shard key (`fromAuth("org")`, the active organization) holds until the JWT expires; for immediate
  loss of access use `revokeSockets` or a membership check in the shard.
- `sensitive: true` mutations and actions recheck the session in the `Auth` object, so a signed-out session is refused
  even with a JWT that has not expired.
- Passwords are hashed and verified in the Worker, not in the single `Auth` object (scrypt there would serialize every
  sign-in of the app). See [Password endpoints](#third-party-plugins) for plugins Ember does not know.
- Outbound `fetch` from the `Auth` object (IdP discovery, token and JWKS calls, Stripe, haveIBeenPwned) is cut after
  `ember: { fetchTimeoutMs }` in `defineAuth` (default 10000 ms; `0` or `false` turns it off), so a hung third party
  fails that one request with a `TimeoutError` instead of holding it. It is a ceiling: a plugin's own shorter timeout
  still applies, a longer one (the Stripe SDK's 80 s default) is capped. A client that keeps the global `fetch` it finds
  when built (`Stripe.createFetchHttpClient()`) gets the bound when built in `auth.config.ts` after importing
  `defineAuth`; built in a module evaluated earlier, give it `(input, init) => fetch(input, init)`. Only Better Auth's
  calls in the `Auth` object are affected, not your actions or the rest of the Worker.
- Turnstile on sign-up / sign-in: `ember.json` `auth.turnstile`. Rotating keys: `ember keys rotate`.

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese): "Auth", "Turnstile no auth", "Rotação de chaves". Examples:
[`examples/files-auth-jobs`](https://github.com/freecorps/ember/tree/main/examples/files-auth-jobs),
[`apps/example-expo`](https://github.com/freecorps/ember/tree/main/apps/example-expo).

License: MIT.
