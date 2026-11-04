import { createEmberWorker, type ActionJobMessage, type EmberConfig } from "../src/index.ts";
import { functionsV1, probes as appProbes, schemaV1 } from "./app.ts";

export { Shard, System } from "../src/index.ts";

/** Same isolate as the tests: lets tests observe side effects outside SQL. */
export const probes = {
  ...appProbes,
  actions: [] as ActionJobMessage[],
};

export const config: EmberConfig = {
  schema: schemaV1,
  functions: functionsV1,
  // createEngine omitted: the real @ember/server engine is the default.
  auth: {
    verify(token) {
      const [kind, subject, ms] = token.split(":");
      if (!subject) return null;
      if (kind === "good") return { subject };
      if (kind === "expired") return { subject, exp: 1 };
      // Expires `ms` milliseconds from now (fractional seconds are fine for tests).
      if (kind === "soon") return { subject, exp: (Date.now() + Number(ms ?? 200)) / 1000 };
      return null;
    },
  },
  groupCommit: { windowMs: 5, maxBatch: 100 },
  scheduler: { maxAttempts: 3, backoffBaseMs: 20, backoffMaxMs: 100 },
  changeLogVersions: 5,
  backfillChunk: 2,
  dispatchAction: async (_env, msg) => {
    probes.actions.push(msg);
    if ((msg.args as { fail?: boolean }).fail) throw new Error("queue down");
  },
  crons: [
    { name: "morning", schedule: "0 9 * * *", tz: "America/Sao_Paulo", shard: "org:crons", fn: "jobs:record", args: { label: "morning" } },
    { name: "every-5", schedule: "*/5 * * * *", shard: "org:crons", fn: "jobs:record", args: { label: "every-5" } },
  ],
};

export default createEmberWorker(config);
