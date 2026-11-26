import { createEmberWorker } from "@freecorps/ember-runtime";
import { defineApp } from "@freecorps/ember-server";
import { functionsV1, schemaV1 } from "../../../runtime/test/app.ts";

export { Shard } from "@freecorps/ember-runtime";

export default createEmberWorker({
  schema: schemaV1,
  functions: functionsV1,
  auth: { verify: (token) => (token.startsWith("good:") ? { subject: token.slice(5) } : null) },
  groupCommit: { windowMs: 5, maxBatch: 100 },
  // Ephemeral channels (channels.workerd.test.ts): signed-in rooms, and one only alice may join.
  app: defineApp({
    channels: {
      "room:*": { authorize: (identity) => identity !== null },
      vip: { authorize: (identity) => identity?.subject === "alice" },
    },
  }),
});
