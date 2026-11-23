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

## Worth knowing

- `ember.json` `auth.from` points a project at another project's auth (SSO): no `Auth` object there, tokens are
  verified through the issuer's JWKS.
- A claim used as a shard key (`fromAuth("org")`, the active organization) holds until the JWT expires; for immediate
  loss of access use `revokeSockets` or a membership check in the shard.
- `sensitive: true` mutations and actions recheck the session in the `Auth` object, so a signed-out session is refused
  even with a JWT that has not expired.
- Turnstile on sign-up / sign-in: `ember.json` `auth.turnstile`. Rotating keys: `ember keys rotate`.
- Better Auth plugins tested end to end in workerd: sso, scim, oauthProvider, passkey, apiKey, stripe, expo
  (contracts.md "Plugins do Better Auth: fluxos testados").

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese): "Auth", "Turnstile no auth", "Rotação de chaves". Examples:
[`examples/files-auth-jobs`](https://github.com/freecorps/ember/tree/main/examples/files-auth-jobs),
[`apps/example-expo`](https://github.com/freecorps/ember/tree/main/apps/example-expo).

License: MIT.
