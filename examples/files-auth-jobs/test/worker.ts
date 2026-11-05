// Test-only Worker: this app on workerd (Miniflare), wired the way the entry that `ember dev` / `ember deploy`
// generates is: functions + crons + the Better Auth Durable Object.
import { authOutbox, createEmberWorker } from "@freecorps/ember-runtime";
import { emberAuth } from "@freecorps/ember-auth/worker";
import authConfig from "../ember/auth.config.ts";
import crons from "../ember/crons.ts";
import createEngine from "@freecorps/ember-server";
import schema from "../ember/schema.ts";
import * as files from "../ember/files.ts";
import * as users from "../ember/users.ts";
import * as testing from "./testing.ts";

export { Shard, System } from "@freecorps/ember-runtime";

// Profile sync: user changes are forwarded to `internal.users.sync` when the app defines it (this one does not).
const outbox = authOutbox({ shard: "global:main" });
const auth = emberAuth(authConfig, { project: "files-auth-jobs", onUserChange: outbox.onUserChange });
export const Auth = outbox.wrap(auth.Auth);

/** A clock the tests can move (Durable Objects run in the test's isolate): `ctx.now` is `Date.now() + skew`. */
export const clock = { skew: 0 };

export default createEmberWorker({
  schema,
  functions: { files, users, testing },
  crons,
  auth,
  createEngine: (o) => createEngine({ ...o, now: () => Date.now() + clock.skew }),
  scheduler: { maxAttempts: 3, backoffBaseMs: 20, backoffMaxMs: 100 },
  files: { gcGraceMs: 60_000 },
});
