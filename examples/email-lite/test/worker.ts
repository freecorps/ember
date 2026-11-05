// Test-only Worker: email-lite on workerd (Miniflare): send_email is simulated, the events queue and R2 are local.
import { createEmberWorker } from "@freecorps/ember-runtime";
import { app, functions, http, schema } from "../src/app.ts";

export { Shard, System } from "@freecorps/ember-runtime";

export default createEmberWorker({ schema, functions, app, http, scheduler: { maxAttempts: 3, backoffBaseMs: 20, backoffMaxMs: 100 }, files: { gcGraceMs: 60_000 } });
