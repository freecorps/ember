/**
 * The workerd test app: no tables or functions of its own, only presence rooms (`room:*`, signed in, typed member
 * state and cursor). Everything else is the real runtime: Worker, Shard DO, hibernatable WebSockets.
 */
import { createEmberWorker } from "@freecorps/ember-runtime";
import { defineApp, defineSchema, defineTable } from "@freecorps/ember-server";
import { v } from "@freecorps/ember-values";
import { presenceChannel } from "../../src/index.ts";

export { Shard } from "@freecorps/ember-runtime";

const schema = defineSchema({ tables: { notes: defineTable({ body: v.string() }) } });

export const app = defineApp({
  channels: {
    "room:*": presenceChannel({
      authorize: (identity) => identity !== null,
      state: v.object({ name: v.string() }),
      cursor: v.object({ x: v.number(), y: v.number() }),
    }),
  },
});

export default createEmberWorker({
  schema,
  functions: {},
  app,
  auth: { verify: (token) => (token.startsWith("good:") ? { subject: token.slice(5) } : null) },
});
