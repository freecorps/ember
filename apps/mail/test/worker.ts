// Test-only Worker: the mail app on workerd (Miniflare): send_email is simulated, the events queue and R2 are local.
import { createEmberWorker } from "@freecorps/ember-runtime";
import { mutationGeneric, v } from "@freecorps/ember-server";
import { app, functions, http, schema } from "../src/app.ts";

export { Shard, System } from "@freecorps/ember-runtime";

export default createEmberWorker({
  schema,
  functions: {
    ...functions,
    // Test-only: a domain as `domains:sync` would leave it (the real one calls the Cloudflare API).
    testing: {
      seedDomain: mutationGeneric({
        args: { name: v.string() },
        handler: (ctx: any, { name }: { name: string }) =>
          ctx.runMutation("domains:save", { name, status: "verified", sending: true, receiving: true, records: [], ruleIds: [], notes: [] }),
      }),
    },
  },
  app,
  http,
  auth: {
    // "user:<subject>" tokens stand in for the auth provider (Ember auth / SSO) in tests.
    verify: (token) => (token.startsWith("user:") ? { subject: token.slice(5) } : null),
  },
  scheduler: { maxAttempts: 3, backoffBaseMs: 20, backoffMaxMs: 100 },
  files: { gcGraceMs: 60_000 },
});
