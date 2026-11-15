// Test-only Worker: an Ember app wired the way the generated entry is (functions + the Better Auth Durable Object with
// the profile outbox), with the plugin config of `auth.config.ts`.
import { env } from "cloudflare:workers";
import { authOutbox, createEmberWorker } from "@freecorps/ember-runtime";
import createEngine from "@freecorps/ember-server";
import { emberAuth } from "../../src/worker.ts";
import authConfig, { ember, ORIGIN } from "./auth.config.ts";
import { IDP, idp, interceptFetch } from "./fakes.ts";
import * as app from "./app.ts";

export { Shard, System } from "@freecorps/ember-runtime";

// The sso plugin reaches the IdP with the global fetch, from inside the Auth DO (same isolate).
interceptFetch(IDP, (r) => idp.handle(r));

export const SHARD = "global:main";
const outbox = authOutbox({ shard: SHARD, fn: "users:sync", journalGraceMs: 500, backoffBaseMs: 20, backoffMaxMs: 100 });
export const auth = emberAuth(authConfig, { project: "plug", strictHashing: true, apiKeys: true, onUserChange: outbox.onUserChange });
export const Auth = outbox.wrap(auth.Auth);

const worker = createEmberWorker({ schema: app.schema, functions: { app, users: { sync: app.sync } }, auth, createEngine });
ember.revoke = (match) => worker.revokeSockets(env as never, SHARD, match);

export default worker;
export { ORIGIN };
