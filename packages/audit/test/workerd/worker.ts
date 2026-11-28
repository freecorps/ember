/**
 * The workerd test app: a `users` table audited by `auditTriggers` (password redacted), the audit component with
 * retention 0 days (every row is past it, so the cron has work at once) and batches of 3, and a query that lists the
 * audit rows through the `Audit` helper. Action jobs are not sent to a Queue: the shard runs them in its alarm.
 */
import { anyComponents, defineApp, defineSchema, defineTable, defineTriggers, mutationGeneric, queryGeneric, v } from "@freecorps/ember-server";
import { createEmberWorker } from "@freecorps/ember-runtime";
import { Audit, audit, auditTriggers } from "../../src/index.ts";

export { Shard, System } from "@freecorps/ember-runtime";

const schema = defineSchema({ tables: { users: defineTable({ name: v.string(), passwordHash: v.string() }) } });
const log = new Audit(anyComponents.audit);
const triggers = defineTriggers({ ...auditTriggers(anyComponents.audit, { tables: { users: { redact: ["passwordHash"] } } }) });

const functions = {
  api: {
    add: mutationGeneric({
      args: { names: v.array(v.string()) },
      handler: (ctx: any, a: { names: string[] }) => a.names.map((name) => ctx.db.insert("users", { name, passwordHash: `h-${name}` })),
    }),
    addThenFail: mutationGeneric({
      args: { name: v.string() },
      handler: (ctx: any, a: { name: string }) => {
        ctx.db.insert("users", { name: a.name, passwordHash: "x" });
        throw new Error("nope");
      },
    }),
    audit: queryGeneric({ args: {}, handler: (ctx: any) => log.list(ctx, { paginationOpts: { numItems: 100, cursor: null } }).page }),
  },
};

export const app = defineApp().use(audit, { config: { retainDays: 0, batchSize: 3 } });

export default createEmberWorker({ schema, functions, app, triggers });
